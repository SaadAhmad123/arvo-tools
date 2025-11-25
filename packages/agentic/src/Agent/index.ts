import { type ArvoSemanticVersion, getOtelHeaderFromSpan } from 'arvo-core';
import {
  type ArvoResumableHandler,
  type ArvoResumableState,
  createArvoResumable,
} from 'arvo-event-handler';
import type { OtelInfoType } from '../types.js';
import { agentLoop } from './agentLoop.js';
import type {
  AgentInternalTool,
  AgentMessage,
  AgentServiceContract,
  AnyArvoOrchestratorContract,
  CreateArvoAgentParam,
  NonEmptyArray,
} from './types.js';
import {
  generateAgentInternalToolDefinitions,
  generateMcpToolDefinitions,
  generateServiceToolDefinitions,
} from './utils.js';

type AgentState = {
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
                  messages: llmContext?.messages?.length
                    ? llmContext.messages
                    : [
                        {
                          role: 'user',
                          content: { type: 'text', content: JSON.stringify(inputData) },
                        },
                      ],
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
