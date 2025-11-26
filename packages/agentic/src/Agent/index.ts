import { type ArvoSemanticVersion, getOtelHeaderFromSpan } from 'arvo-core';
import {
  type ArvoResumableHandler,
  type ArvoResumableState,
  createArvoResumable,
} from 'arvo-event-handler';
import type { AgentInternalTool } from '../AgentTool/types.js';
import type { NonEmptyArray, OtelInfoType } from '../types.js';
import { agentLoop } from './agentLoop.js';
import type {
  AgentMessage,
  AgentServiceContract,
  AnyArvoOrchestratorContract,
  CreateArvoAgentParam,
} from './types.js';
import {
  generateAgentInternalToolDefinitions,
  generateMcpToolDefinitions,
  generateServiceToolDefinitions,
} from './utils.js';

export type AgentState = {
  currentSubject: string;
  system: string | null;
  messages: AgentMessage[];
  toolInteractions: {
    max: number;
    current: number;
  };
  awaitingToolCalls: Record<string, { type: string; data: Record<string, unknown> | null }>;
  totalExecutionUnits: number;
};

/**
 * Creates a fully-featured AI Agent implemented as an Arvo Resumable Event Handler.
 *
 * This factory transforms a standard Large Language Model (LLM) into a stateful, event-driven
 * participant in your system. Unlike standard chatbots, this Agent can interact with:
 * 1. **Local Tools**: Async/Sync JavaScript functions executed immediately.
 * 2. **MCP Servers**: External data sources via the Model Context Protocol.
 * 3. **Arvo Services**: Other Event Handlers in your Arvo distributed system (Async/Distributed tools).
 *
 * @remarks
 * **The Execution Model:**
 * The Agent operates on a **Start-Stop-Resume** cycle:
 * 1. **Init**: Receives an event -> Builds Context -> Calls LLM.
 * 2. **Action**:
 *    - If the LLM chooses a `tool` or `mcp`, it executes immediately and loops back.
 *    - If the LLM chooses a `service`, the Agent **emits an event** and **suspends execution**.
 *    - The LLM can choose a mix all three modalities at the same time.
 * 3. **Resume**: When the Service replies with an event, the Agent wakes up, restores state from `memory`,
 *    adds the result to its history, and calls the LLM again.
 *
 * **Strict Versioning Compliance:**
 * Arvo enforces that your Agent implementation matches your Contract versions.
 * If your `self` contract defines versions `'1.0.0'` and `'2.0.0'`, you must
 * provide specific `context` (A context builder function which runs at init of the agent
 * execution and is reponsible for building the context of the agent i.e. system promot
 * and messages list, both are optional) and `output` builder, which takes the LLM output
 * and converts it into yor contract compliant structure,for *all* versions
 * in the `handler` parameter.
 *
 *  This allows you to:
 * - Safely evolve prompt engineering strategies (e.g., v1 uses GPT-3.5, v2 uses GPT-4).
 * - Run different tests on Agent behavior within the same deployment.
 * - Retire old Agent behaviors gradually without breaking existing clients.
 *
 * @param param - Configuration object for the Agent.
 *
 * @returns An `ArvoResumable` instance specialised to run as an AI Agent.
 *
 * @example
 * ```typescript
 * export const supportAgent = ({ memory }) => createArvoAgent({
 *   contracts: {
 *     self: supportAgentContract, // The interface for this agent
 *     services: {
 *       // The Agent can "call" this service by emitting an event
 *       // and going to sleep until the billing service replies.
 *       billing: { contract: billingServiceContract.version('1.0.0') }
 *     }
 *   },
 *   tools: {
 *     // The Agent can execute this immediately in-memory
 *     checkTime: createAgentTool({
 *       name: 'check_time',
 *       description: 'Checks current server time',
 *       input: z.object({}),
 *       output: z.object({ time: z.string() }),
 *       fn: async () => ({ time: new Date().toISOString() })
 *     })
 *   },
 *   llm: openaiLLMIntegration(new OpenAI(), { model: 'gpt-4o' }),
 *   memory: memory, // Persists chat history during async calls
 *   handler: {
 *     '1.0.0': {
 *       // Dynamic System Prompt Building
 *       context: AgentDefaults.CONTEXT_BUILDER(async ({ tools }) =>
 *         `You are a support agent. You have access to billing data via the ${tools.services.billing.name} tool.`
 *       ),
 *       output: AgentDefaults.OUTPUT_BUILDER
 *     }
 *   }
 * });
 * ```
 */
export const createArvoAgent = <
  TSelfContract extends AnyArvoOrchestratorContract,
  TServiceContract extends Record<string, AgentServiceContract>,
  TTools extends Record<string, AgentInternalTool>,
>({
  contracts,
  memory,
  handler,
  llm,
  mcp,
  maxToolInteractions = 5,
  llmResponseType = 'text',
  tools,
}: CreateArvoAgentParam<TSelfContract, TServiceContract, TTools>) => {
  const serviceContracts = Object.fromEntries(
    Object.entries(contracts.services).map(([key, { contract }]) => [key, contract]),
  ) as { [K in keyof TServiceContract & string]: TServiceContract[K]['contract'] };

  const serviceTypeToDomainMap = Object.fromEntries(
    Object.values(contracts.services)
      .filter((item) => item.domains?.length)
      .map((item) => [item.contract.accepts.type, item.domains]),
  ) as Record<string, NonEmptyArray<string>>;

  return createArvoResumable({
    contracts: {
      self: contracts.self,
      services: serviceContracts,
    },
    memory,
    types: {
      context: {} as AgentState,
    },
    executionunits: 0,
    handler: Object.fromEntries(
      Object.keys(contracts.self.versions).map((ver) => [
        ver,
        (async ({ span, input, context, service }) => {
          const otelInfo: OtelInfoType = {
            span,
            headers: getOtelHeaderFromSpan(span),
          };
          try {
            const contextBuilder = handler[ver as ArvoSemanticVersion]?.context;
            const outputBuilder = handler[ver as ArvoSemanticVersion]?.output;
            const selfVersionedContract = contracts.self.version(ver as ArvoSemanticVersion);
            const outputFormat =
              selfVersionedContract.emits[selfVersionedContract.metadata.completeEventType];

            await mcp?.connect({ otelInfo });

            const serviceTools = generateServiceToolDefinitions(contracts.services);
            const mcpTools = await generateMcpToolDefinitions(mcp ?? null, { otelInfo });
            const internalTools = generateAgentInternalToolDefinitions<TTools>(tools ?? {});

            const toolInteraction = context?.toolInteractions ?? {
              max: maxToolInteractions,
              current: 0,
            };

            if (input) {
              // biome-ignore lint/correctness/noUnusedVariables: This 'parentSubject$$' needs to be removed
              const { parentSubject$$, ...inputData } = input.data;
              const llmContext =
                (await contextBuilder({
                  lifecycle: 'init',
                  input,
                  tools: { services: serviceTools, mcp: mcpTools, tools: internalTools },
                  span,
                })) ?? null;
              const response = await agentLoop(
                {
                  initLifecycle: 'init',
                  system: llmContext?.system ?? null,
                  messages: (llmContext?.messages?.length
                    ? llmContext.messages
                    : [
                        {
                          role: 'user',
                          content: { type: 'text', content: JSON.stringify(inputData) },
                          seenCount: 0,
                        },
                      ]
                  ).map((item) => ({ ...item, seenCount: item.seenCount ?? 0 })) as AgentMessage[],
                  tools: Object.values({ ...mcpTools, ...serviceTools, ...internalTools }),
                  outputFormat,
                  outputBuilder: outputBuilder,
                  llmResponseType,
                  llm,
                  mcp: mcp ?? null,
                  toolInteraction,
                  currentTotalExecutionUnits: 0,
                },
                { otelInfo },
              );

              const resumableContextToPersist: AgentState = {
                currentSubject: input.subject,
                system: llmContext?.system ?? null,
                messages: response.messages,
                toolInteractions: response.toolInteractions,
                awaitingToolCalls: Object.fromEntries(
                  (response.toolCalls ?? []).map((item) => [
                    item.toolUseId,
                    { type: item.name, data: null },
                  ]),
                ),
                totalExecutionUnits: response.executionUnits,
              };

              if (response.toolCalls) {
                return {
                  context: resumableContextToPersist,
                  services: response.toolCalls.map((item) => ({
                    id: { deduplication: 'DEVELOPER_MANAGED', value: item.toolUseId },
                    type: item.name,
                    data: {
                      ...item.input,
                      parentSubject$$: resumableContextToPersist.currentSubject,
                    },
                    domain: serviceTypeToDomainMap[item.name],
                    executionunits: response.executionUnits,
                  })),
                };
              }

              return {
                context: resumableContextToPersist,
                output: {
                  __executionunits: response.executionUnits,
                  ...response.output,
                },
              };
            }

            if (!context) {
              throw new Error('Context is not properly set. Faulty initialization');
            }

            const resumedContext = { ...context };

            if (service?.parentid && resumedContext.awaitingToolCalls[service.parentid]) {
              // biome-ignore lint/style/noNonNullAssertion: It cannot be null. The if clause does already
              resumedContext.awaitingToolCalls[service.parentid]!.data = service.data;
            }

            if (
              Object.values(resumedContext.awaitingToolCalls).some((item) => item.data === null)
            ) {
              return { context: resumedContext };
            }

            const messages = [...resumedContext.messages];

            for (const [toolUseId, { data }] of Object.entries(resumedContext.awaitingToolCalls)) {
              messages.push({
                role: 'user',
                content: {
                  type: 'tool_result',
                  toolUseId,
                  content: JSON.stringify(data ?? {}),
                },
                seenCount: 0,
              });
            }

            const response = await agentLoop(
              {
                initLifecycle: 'tool_result',
                system: resumedContext.system ?? null,
                messages: messages,
                tools: Object.values({ ...mcpTools, ...serviceTools, ...internalTools }),
                outputFormat,
                outputBuilder: outputBuilder,
                llmResponseType,
                llm,
                mcp: mcp ?? null,
                toolInteraction,
                currentTotalExecutionUnits: resumedContext.totalExecutionUnits,
              },
              { otelInfo },
            );

            const resumableContextToPersist: AgentState = {
              ...resumedContext,
              messages: response.messages,
              toolInteractions: response.toolInteractions,
              awaitingToolCalls: Object.fromEntries(
                (response.toolCalls ?? []).map((item) => [
                  item.toolUseId,
                  { type: item.name, data: null },
                ]),
              ),
              totalExecutionUnits: response.executionUnits,
            };

            if (response.toolCalls) {
              return {
                context: resumableContextToPersist,
                services: response.toolCalls.map((item) => ({
                  id: { deduplication: 'DEVELOPER_MANAGED', value: item.toolUseId },
                  type: item.name,
                  data: {
                    ...item.input,
                    parentSubject$$: resumableContextToPersist.currentSubject,
                  },
                  domain: serviceTypeToDomainMap[item.name],
                  executionunits: response.executionUnits,
                })),
              };
            }

            return {
              context: resumableContextToPersist,
              output: {
                __executionunits: response.executionUnits,
                ...response.output,
              },
            };
          } finally {
            await mcp?.disconnect({ otelInfo })?.catch(console.error);
          }
        }) as ArvoResumableHandler<
          ArvoResumableState<AgentState>,
          TSelfContract,
          typeof serviceContracts
        >[ArvoSemanticVersion],
      ]),
    ) as unknown as ArvoResumableHandler<
      ArvoResumableState<AgentState>,
      TSelfContract,
      typeof serviceContracts
    >,
  });
};
