import {
  ArvoOrchestrationSubject,
  type ArvoSemanticVersion,
  cleanString,
  exceptionToSpan,
  getOtelHeaderFromSpan,
} from 'arvo-core';
import {
  type ArvoResumableHandler,
  type ArvoResumableState,
  createArvoResumable,
} from 'arvo-event-handler';
import { v4 } from 'uuid';
import type { AgentInternalTool } from '../AgentTool/types.js';
import type { PermissionManagerContext } from '../interfaces.permission.manager.js';
import type { NonEmptyArray, OtelInfoType } from '../types.js';
import { agentLoop } from './agentLoop.js';
import type { AgentEventStreamer } from './stream/types.js';
import { createTimestamp } from './stream/utils.js';
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
  initEventAccessControl: string | null;
  currentSubject: string;
  system: string | null;
  messages: AgentMessage[];
  toolInteractions: {
    max: number;
    current: number;
  };
  awaitingToolCalls: Record<string, { type: string; data: Record<string, unknown> | null }>;
  totalExecutionUnits: number;
  totalTokenUsage: {
    prompt: number;
    completion: number;
  };
};

/**
 * Creates a fully-featured AI Agent implemented as an Arvo Resumable Event Handler.
 *
 * This factory transforms a Large Language Model into a stateful, event-driven participant
 * in your Arvo system. The resulting agent operates on a start-stop-resume execution model,
 * consuming zero resources between event processing cycles while maintaining conversation
 * state in persistent memory.
 *
 * @remarks
 * The agent operates on a start-stop-resume execution model where it receives an event, invokes 
 * the LLM with available tools (internal Typescript functions, MCP external sources, or Arvo services), 
 * and either continues immediately for synchronous tools or suspends execution for service calls 
 * until responses arrive. When the LLM requests multiple tools simultaneously, priority-based orchestration 
 * ensures only the highest-priority batch executes (enabling "human-approval-first" patterns), while contract 
 * versioning enforces that you provide complete handler implementations for all defined versions 
 * (enabling safe evolution of prompts, models, and output schemas across v1, v2, etc.). The optional permission 
 * manager adds deterministic authorization outside the LLM's control—blocked tools trigger permission request events, 
 * the agent suspends until external approval, then retries with updated permissions, creating a security layer 
 * immune to prompt injection.
 
* @param param - Configuration object defining the agent's contracts, tools, memory backend,
 *                 LLM integration, and version-specific behavior handlers.
 *
 * @returns An ArvoResumable instance that participates in the event fabric as a standard
 *          event handler, compatible with any Arvo broker implementation.
 *
 * @example
 * ```typescript
 * export const supportAgent = ({ memory }) => createArvoAgent({
 *   contracts: {
 *     self: supportAgentContract,
 *     services: {
 *       billing: {
 *         contract: billingServiceContract.version('1.0.0'),
 *         priority: 0
 *       },
 *       humanApproval: {
 *         contract: approvalContract.version('1.0.0'),
 *         domains: ['human.interaction'],
 *         priority: 100  // Executes before billing calls
 *       }
 *     }
 *   },
 *   tools: {
 *     checkTime: createAgentTool({
 *       name: 'check_time',
 *       description: 'Returns current server time in ISO format',
 *       input: z.object({}),
 *       output: z.object({ time: z.string() }),
 *       fn: async () => ({ time: new Date().toISOString() })
 *     })
 *   },
 *   llm: openaiLLMIntegration(new OpenAI(), { model: 'gpt-4o' }),
 *   memory: memory,
 *   permissionManager: new ToolPermissionManager(),
 *   handler: {
 *     '1.0.0': {
 *       permissionPolicy: async ({ services }) => [
 *         services.billing.name  // Require permission for billing calls
 *       ],
 *       context: AgentDefaults.CONTEXT_BUILDER(async ({ tools }) =>
 *         `You are a support agent with access to billing data via ${tools.services.billing.name}.
 *          You must request approval via ${tools.services.humanApproval.name} before accessing billing.`
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
  onStream,
  permissionManager,
  defaultEventEmissionDomains,
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
      services: {
        ...serviceContracts,
        ...(permissionManager ? { [v4()]: permissionManager.contract } : {}),
      },
    },
    memory,
    types: {
      context: {} as AgentState,
    },
    defaultEventEmissionDomains,
    executionunits: 0,
    handler: Object.fromEntries(
      Object.keys(contracts.self.versions).map((ver) => [
        ver,
        (async ({ span, input, context, service }) => {
          const otelInfo: OtelInfoType = {
            span,
            headers: getOtelHeaderFromSpan(span),
          };

          const agentEventStreamer: AgentEventStreamer = (event) => {
            try {
              const currentSubject = context?.currentSubject ?? input?.subject ?? null;
              const parsedSubject = currentSubject
                ? ArvoOrchestrationSubject.parse(currentSubject)
                : null;
              onStream?.(
                {
                  ...event,
                  id: v4(),
                  time: createTimestamp(),
                },
                {
                  initiatorId: parsedSubject?.execution.initiator ?? 'unknown',
                  subject: currentSubject ?? 'unknown',
                  selfId: contracts.self.type,
                  selfVersion: ver,
                },
              );
            } catch (e) {
              exceptionToSpan(e as Error, span);
            }
          };

          try {
            const contextBuilder = handler[ver as ArvoSemanticVersion]?.context;
            const outputBuilder = handler[ver as ArvoSemanticVersion]?.output;
            const thisVersionLlmIntegration = handler[ver as ArvoSemanticVersion]?.llm ?? llm;
            const versionLlmResponseType =
              handler[ver as ArvoSemanticVersion]?.llmResponseType ?? llmResponseType;
            const selfVersionedContract = contracts.self.version(ver as ArvoSemanticVersion);
            const outputFormat =
              selfVersionedContract.emits[selfVersionedContract.metadata.completeEventType];
            const permissionManagerContext: PermissionManagerContext = {
              subject: context?.currentSubject ?? input?.subject ?? 'unknown',
              accesscontrol: context?.initEventAccessControl ?? input?.accesscontrol ?? null,
              name: contracts.self.type,
            };

            await mcp?.connect({ otelInfo });

            const serviceTools = generateServiceToolDefinitions(contracts.services);
            const mcpTools = await generateMcpToolDefinitions(mcp ?? null, { otelInfo });
            const internalTools = generateAgentInternalToolDefinitions<TTools>(tools ?? {});

            const permissionPolicy: string[] =
              (await handler[ver as ArvoSemanticVersion]?.explicityPermissionRequired?.({
                services: serviceTools,
                mcp: mcpTools,
                tools: internalTools,
              })) ?? [];

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
                  selfContract: selfVersionedContract,
                })) ?? null;
              const response = await agentLoop(
                {
                  permissionManagerContext,
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
                  llmResponseType: versionLlmResponseType,
                  llm: thisVersionLlmIntegration,
                  mcp: mcp ?? null,
                  toolInteraction,
                  currentTotalExecutionUnits: 0,
                  onStream: agentEventStreamer,
                  currentTotalUsageTokens: {
                    prompt: 0,
                    completion: 0,
                  },
                  permissionManager: permissionManager ?? null,
                  permissionPolicy,
                },
                { otelInfo },
              );

              const resumableContextToPersist: AgentState = {
                initEventAccessControl: input.accesscontrol ?? null,
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
                totalTokenUsage: response.tokenUsage,
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
                    domain:
                      permissionManager?.contract.accepts.type === item.name
                        ? (permissionManager.domains ?? undefined)
                        : serviceTypeToDomainMap[item.name],
                    executionunits: response.executionUnits,
                  })),
                };
              }

              await permissionManager?.cleanup?.(permissionManagerContext, { otelInfo });

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

              if (service.type === permissionManager?.contract?.emitList?.[0]?.type) {
                await permissionManager?.set(
                  permissionManagerContext,
                  // biome-ignore lint/suspicious/noExplicitAny: Type casting here is weird
                  service as any,
                  { otelInfo },
                );
              }

              if (service.type === permissionManager?.contract?.systemError?.type) {
                throw new Error(
                  cleanString(`
                    [Critical] The agent's attempt to request permission via ${permissionManager?.contract?.accepts?.type}
                    failed with error: ${JSON.stringify(service.data)}
                  `),
                );
              }
            }

            if (
              Object.values(resumedContext.awaitingToolCalls).some((item) => item.data === null)
            ) {
              return { context: resumedContext };
            }

            const messages = [...resumedContext.messages];

            for (const [toolUseId, { type, data }] of Object.entries(
              resumedContext.awaitingToolCalls,
            )) {
              if (type === permissionManager?.contract?.accepts?.type) {
                messages.push({
                  role: 'user',
                  content: {
                    type: 'text',
                    content: `The response of the permission request. ${JSON.stringify(data ?? {})}`,
                  },
                  seenCount: 0,
                });
                continue;
              }
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
                permissionManagerContext,
                initLifecycle: 'tool_result',
                system: resumedContext.system ?? null,
                messages: messages,
                tools: Object.values({ ...mcpTools, ...serviceTools, ...internalTools }),
                outputFormat,
                outputBuilder: outputBuilder,
                llmResponseType: versionLlmResponseType,
                llm: thisVersionLlmIntegration,
                mcp: mcp ?? null,
                toolInteraction,
                currentTotalExecutionUnits: resumedContext.totalExecutionUnits,
                onStream: agentEventStreamer,
                currentTotalUsageTokens: resumedContext.totalTokenUsage,
                permissionManager: permissionManager ?? null,
                permissionPolicy,
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
              totalTokenUsage: response.tokenUsage,
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
                  domain:
                    permissionManager?.contract.accepts.type === item.name
                      ? (permissionManager.domains ?? undefined)
                      : serviceTypeToDomainMap[item.name],
                  executionunits: response.executionUnits,
                })),
              };
            }

            await permissionManager?.cleanup?.(permissionManagerContext, { otelInfo });

            return {
              context: resumableContextToPersist,
              output: {
                __executionunits: response.executionUnits,
                ...response.output,
              },
            };
          } catch (e) {
            // Add correct otelinfo object here
            await permissionManager?.cleanup?.(
              {
                subject: context?.currentSubject ?? input?.subject ?? service?.subject ?? 'unknown',
                accesscontrol:
                  context?.initEventAccessControl ??
                  input?.accesscontrol ??
                  service?.accesscontrol ??
                  null,
                name: contracts.self.type,
              },
              { otelInfo },
            );
            throw e;
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
