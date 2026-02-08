import {
  ArvoOrchestrationSubject,
  type ArvoSemanticVersion,
  cleanString,
  exceptionToSpan,
  getOtelHeaderFromSpan,
  type VersionedArvoContract,
} from 'arvo-core';
import {
  type ArvoResumableHandler,
  type ArvoResumableState,
  ConfigViolation,
  createArvoResumable,
  SimpleMachineMemory,
} from 'arvo-event-handler';
import { v4 } from 'uuid';
import type { AgentInternalTool } from '../AgentTool/types.js';
import type { PermissionManagerContext } from '../interfaces.permission.manager.js';
import type { NonEmptyArray, OtelInfoType } from '../types.js';
import { AgentDefaults } from './AgentDefaults.js';
import { agentLoop } from './agentLoop.js';
import { AgentStateSchema } from './schema.js';
import type { AgentEventStreamer } from './stream/types.js';
import { createTimestamp } from './stream/utils.js';
import type {
  AgentMessage,
  AgentServiceContract,
  AgentState,
  AnyArvoOrchestratorContract,
  CreateArvoAgentParam,
} from './types.js';
import {
  applyToolEnablement,
  generateAgentInternalToolDefinitions,
  generateMcpToolDefinitions,
  generateServiceToolDefinitions,
} from './utils.js';

/**
 * Creates a fully-featured AI Agent implemented as an Arvo Resumable Event Handler.
 *
 * This factory transforms a Large Language Model into a stateful, event-driven participant
 * in your Arvo system. The resulting agent operates on a start-stop-resume execution model,
 * consuming zero resources between event processing cycles while maintaining conversation
 * state in persistent memory.
 * 
 * @remark
 * **Execution Model:**
 * The agent follows a start-stop-resume pattern. On initialization, it builds context from
 * the input event, then enters a ReAct (Reason+Act) cognitive loop. When calling Arvo services,
 * it persists state to memory and suspends, enabling any worker to resume it later. This
 * eliminates long-running processes and enables horizontal scaling.
 *
 * **Tool Ecosystem:**
 * - **Internal Tools:** Synchronous functions for fast, CPU-bound operations.
 * - **MCP Tools:** External tools via Model Context Protocol (filesystem, databases, APIs).
 * - **Arvo Services:** Asynchronous event-driven services that trigger suspension.
 *
 * Both Internal and MCP tools execute synchronously within the loop, while Arvo service calls
 * cause the agent to emit events and suspend until responses arrive.
 *
 * **Priority Batch Execution:**
 * When the LLM requests multiple tools, they are sorted by priority. Only the highest-priority
 * batch executes; lower-priority calls are dropped. This enforces safety guardrails (e.g.,
 * requiring human approval before destructive actions).
 *
 * **Permission Management:**
 * Tools can be placed under permission policy via `explicitPermissionRequired`. The permission
 * manager evaluates each tool call as APPROVED (execute), DENIED (block permanently), or
 * REQUESTABLE (block and emit permission request). Permission state persists across suspensions.
 *
 * **Self-Correction:**
 * If the LLM's outputs fails contract schema validation, the error is fed back and the
 * agent retries, enabling automatic repair of malformed responses or tools calls.
 * 
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
 *       fn: async () => ({ data: { time: new Date().toISOString() } })
 *     })
 *   },
 *   inferenceConfig: {
 *      llm: openaiLLMIntegration(new OpenAI(), { model: 'gpt-4o' }),
 *   },
 *   memory: memory,
 *   permissionManager: new SimplePermissionManager(),
 *   handler: {
 *     '1.0.0': {
 *       explicitPermissionRequired: async ({ services }) => [
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
  inferenceConfig,
  mcp,
  maxAgentCycles = 5,
  tools,
  onStream,
  permissionManager,
  defaultEventEmissionDomains,
}: CreateArvoAgentParam<TSelfContract, TServiceContract, TTools>) => {
  // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
  const serviceContracts: Record<string, VersionedArvoContract<any, any>> = {};
  const serviceTransformers: Record<string, NonNullable<AgentServiceContract['transformer']>> = {};

  for (const [key, { contract, transformer }] of Object.entries(contracts.services)) {
    serviceContracts[key] = contract;
    if (transformer) {
      serviceTransformers[contract.accepts.type] = transformer;
    }
  }

  const serviceTypeToDomainMap = Object.fromEntries(
    Object.values(contracts.services)
      .filter((item) => item.domains?.length)
      .map((item) => [item.contract.accepts.type, item.domains]),
  ) as Record<string, NonEmptyArray<string>>;

  if ((Object.keys(serviceContracts).length > 0 || permissionManager) && !memory) {
    // If permissions manager or service contracts are defined and
    // memory is not defined then that is not allowed as by adding
    // the permission manager it will automatically imply that sometime in its lifecycle,
    // the Agent will need event-driven coordinations and will create a
    // suspension boundary
    throw new ConfigViolation(
      cleanString(`
          ArvoAgent<${contracts.self.type}> configuration error.

          This agent is configured with capabilities that can introduce a suspension boundary
          (service contracts and/or a permission manager), but no memory backend was provided.

          Why this matters:
          - Service contracts and permission workflows may cause the agent to emit an event and suspend.
          - Suspending requires persisting conversation state so the agent can resume correctly.

          How to fix:
          - Provide a memory backend (e.g. SimpleMachineMemory or any implementation of IMachineMemory), or
          - Remove service contracts and the permission manager if this agent is intended
            to run as a single synchronous execution without suspension.
        `),
    );
  }

  return createArvoResumable({
    contracts: {
      self: contracts.self,
      services: {
        ...serviceContracts,
        ...(permissionManager ? { [`pm-${v4()}`]: permissionManager.contract } : {}),
      },
    },
    memory: memory ?? new SimpleMachineMemory(),
    types: {
      context: {} as AgentState,
    },
    defaultEventEmissionDomains,
    executionunits: 0,
    handler: Object.fromEntries(
      Object.keys(contracts.self.versions).map((ver) => [
        ver,
        (async ({ span, input, context: _context, service }) => {
          const context = _context ? AgentStateSchema.parse(_context) : null;

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
            const contextBuilder =
              handler[ver as ArvoSemanticVersion]?.context ?? AgentDefaults.CONTEXT_BUILDER();
            const outputBuilder =
              handler[ver as ArvoSemanticVersion]?.output ?? AgentDefaults.OUTPUT_BUILDER;
            const thisVersionLlmIntegration =
              handler[ver as ArvoSemanticVersion]?.inferenceConfig?.llm ?? inferenceConfig?.llm;
            const versionLlmResponseType =
              handler[ver as ArvoSemanticVersion]?.inferenceConfig?.responseType ??
              inferenceConfig.responseType ??
              'text';
            const selfVersionedContract = contracts.self.version(ver as ArvoSemanticVersion);
            const outputFormat =
              selfVersionedContract.emits[selfVersionedContract.metadata.completeEventType];
            const permissionManagerContext: PermissionManagerContext = {
              subject: context?.currentSubject ?? input?.subject ?? 'unknown',
              accesscontrol: context?.initEventAccessControl ?? input?.accesscontrol ?? null,
              name: contracts.self.type,
            };
            const preInferenceHook =
              handler[ver as ArvoSemanticVersion]?.inferenceConfig?.hooks?.preInference ??
              inferenceConfig?.hooks?.preInference ??
              null;
            const postInferenceHook =
              handler[ver as ArvoSemanticVersion]?.inferenceConfig?.hooks?.postInference ??
              inferenceConfig?.hooks?.postInference ??
              null;

            await mcp?.connect({ otelInfo });

            const serviceTools = generateServiceToolDefinitions(contracts.services);
            const mcpTools = await generateMcpToolDefinitions(mcp ?? null, { otelInfo });
            const internalTools = generateAgentInternalToolDefinitions<TTools>(tools ?? {});

            const permissionPolicy: string[] =
              (await handler[ver as ArvoSemanticVersion]?.explicitPermissionRequired?.({
                services: serviceTools,
                mcp: mcpTools,
                tools: internalTools,
              })) ?? [];

            const agentCycles = context?.agentCycles ?? {
              max: maxAgentCycles,
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
                  tools: applyToolEnablement(
                    Object.values({ ...mcpTools, ...serviceTools, ...internalTools }),
                    llmContext?.enabledTools ?? {},
                  ),
                  preInferenceHook,
                  postInferenceHook,
                  outputFormat,
                  outputBuilder: outputBuilder,
                  llmResponseType: versionLlmResponseType,
                  llm: thisVersionLlmIntegration,
                  mcp: mcp ?? null,
                  agentCycles,
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
                enabledTools: llmContext?.enabledTools ?? {},
                system: llmContext?.system ?? null,
                messages: response.messages,
                agentCycles: response.agentCycles,
                awaitingToolCalls: Object.fromEntries(
                  (response.toolCalls ?? []).map((item) => [
                    item.toolUseId,
                    { type: item.name, responseEventType: null, data: null },
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

              await permissionManager?.cleanup?.({
                source: permissionManagerContext,
                config: { otelInfo },
              });

              return {
                context: AgentStateSchema.parse(resumableContextToPersist),
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
              // biome-ignore lint/style/noNonNullAssertion: It cannot be null. The if clause does already
              resumedContext.awaitingToolCalls[service.parentid]!.responseEventType = service.type;

              if (service.type === permissionManager?.contract?.emitList?.[0]?.type) {
                await permissionManager?.set({
                  source: permissionManagerContext,
                  // biome-ignore lint/suspicious/noExplicitAny: Type casting here is weird
                  event: service as any,
                  config: { otelInfo },
                });
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
              return { context: AgentStateSchema.parse(resumedContext) };
            }

            let messages = [...resumedContext.messages];

            for (const [toolUseId, { type, responseEventType, data }] of Object.entries(
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
              if (serviceTransformers[type] && responseEventType && data) {
                const transformedResult = await serviceTransformers[type]({
                  type: responseEventType,
                  data,
                  toolUseId,
                });
                if (Array.isArray(transformedResult)) {
                  messages = [...messages, ...transformedResult];
                } else {
                  messages.push(transformedResult);
                }
              } else {
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
            }

            const response = await agentLoop(
              {
                permissionManagerContext,
                initLifecycle: 'tool_result',
                system: resumedContext.system ?? null,
                messages: messages,
                tools: applyToolEnablement(
                  Object.values({ ...mcpTools, ...serviceTools, ...internalTools }),
                  resumedContext.enabledTools,
                ),
                outputFormat,
                preInferenceHook,
                postInferenceHook,
                outputBuilder: outputBuilder,
                llmResponseType: versionLlmResponseType,
                llm: thisVersionLlmIntegration,
                mcp: mcp ?? null,
                agentCycles,
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
              agentCycles: response.agentCycles,
              awaitingToolCalls: Object.fromEntries(
                (response.toolCalls ?? []).map((item) => [
                  item.toolUseId,
                  { type: item.name, data: null, responseEventType: null },
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

            await permissionManager?.cleanup?.({
              source: permissionManagerContext,
              config: { otelInfo },
            });

            return {
              context: AgentStateSchema.parse(resumableContextToPersist),
              output: {
                __executionunits: response.executionUnits,
                ...response.output,
              },
            };
          } catch (e) {
            // Add correct otelinfo object here
            await permissionManager?.cleanup?.({
              source: {
                subject: context?.currentSubject ?? input?.subject ?? service?.subject ?? 'unknown',
                accesscontrol:
                  context?.initEventAccessControl ??
                  input?.accesscontrol ??
                  service?.accesscontrol ??
                  null,
                name: contracts.self.type,
              },
              config: { otelInfo },
            });
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
