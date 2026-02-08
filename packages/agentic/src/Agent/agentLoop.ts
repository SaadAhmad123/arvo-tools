import {
  SemanticConventions as OpenInferenceSemanticConventions,
  OpenInferenceSpanKind,
} from '@arizeai/openinference-semantic-conventions';
import {
  ArvoOpenTelemetry,
  type ArvoSemanticVersion,
  cleanString,
  exceptionToSpan,
  getOtelHeaderFromSpan,
  logToSpan,
  type VersionedArvoContract,
} from 'arvo-core';
import { v4 } from 'uuid';
import type z from 'zod';
import type { AgentInternalTool } from '../AgentTool/types.js';
import type { AgentLLMIntegrationParam } from '../Integrations/types.js';
import { AgentLLMIntegrationOutputSchema } from '../Integrations/types.js';
import type { IMCPClient } from '../interfaces.mcp.js';
import type {
  IPermissionManager,
  PermissionManagerContext,
  ToolAuthorizationState,
} from '../interfaces.permission.manager.js';
import type { OtelInfoType } from '../types.js';
import { AgentMessageSchema } from './schema.js';
import type { AgentEventStreamer } from './stream/types.js';
import type {
  AgentMessage,
  AgentOutputBuilder,
  AgentToolCallContent,
  AgentToolDefinition,
  AgentToolResultContent,
  AnyArvoContract,
  CreateArvoAgentParam,
} from './types.js';
import { prioritizeToolCalls } from './utils';

/**
 * The Core Cognitive Loop of the Arvo Agent.
 *
 * This function implements the **ReAct (Reason + Act)** pattern, orchestrating the interactive
 * session between the Large Language Model (LLM) and the available Tool ecosystem.
 *
 * @remarks
 * **Hybrid Execution Strategy:**
 * The loop handles two types of tool executions differently:
 * 1. **Synchronous Tools (Internal & MCP):** These are executed **immediately** within the loop.
 *    The results are added to the history, and the LLM is called again in the same tick.
 * 2. **Asynchronous Tools (Arvo Services):** These interrupt the loop. The function returns
 *    the tool call definition, signaling the parent `ArvoResumable` to **emit an event and suspend**.
 *
 * **Self-Correction:**
 * If the LLM's final output fails the Contract's Output Schema validation (via `outputBuilder`),
 * the loop catches the error and feeds it back to the LLM for auto-correction.
 */
export const agentLoop = async (
  param: {
    initLifecycle: AgentLLMIntegrationParam['lifecycle'];
    system: string | null;
    messages: AgentMessage[];
    tools: AgentToolDefinition[];
    outputFormat: z.ZodTypeAny;
    outputBuilder: AgentOutputBuilder;
    llmResponseType: NonNullable<
      NonNullable<CreateArvoAgentParam['inferenceConfig']>['responseType']
    >;
    llm: NonNullable<NonNullable<CreateArvoAgentParam['inferenceConfig']>['llm']>;
    preInferenceHook: NonNullable<
      NonNullable<NonNullable<CreateArvoAgentParam['inferenceConfig']>['hooks']>['preInference']
    > | null;
    postInferenceHook: NonNullable<
      NonNullable<NonNullable<CreateArvoAgentParam['inferenceConfig']>['hooks']>['postInference']
    > | null;
    mcp: IMCPClient | null;
    agentCycles: {
      current: number;
      max: number;
    };
    currentTotalExecutionUnits: number;
    currentTotalUsageTokens: {
      prompt: number;
      completion: number;
    };
    onStream: AgentEventStreamer;
    permissionPolicy: string[];
    permissionManager: IPermissionManager | null;
    permissionManagerContext: PermissionManagerContext;
  },
  config: { otelInfo: OtelInfoType },
) =>
  await ArvoOpenTelemetry.getInstance().startActiveSpan({
    name: 'AgentLoop',
    context: {
      inheritFrom: 'TRACE_HEADERS',
      traceHeaders: config.otelInfo.headers,
    },
    disableSpanManagement: true,
    spanOptions: {
      attributes: {
        [OpenInferenceSemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT,
      },
    },
    fn: async (span) => {
      const otelInfo: OtelInfoType = {
        span,
        headers: getOtelHeaderFromSpan(span),
      };
      const nameToToolMap: Record<string, AgentToolDefinition> = Object.fromEntries(
        param.tools.map((item) => [item.name, item]),
      );
      let lifecycle: typeof param.initLifecycle = param.initLifecycle;
      let executionUnits = param.currentTotalExecutionUnits;
      const tokenUsage = param.currentTotalUsageTokens;
      try {
        let currentAgentCycleCount = param.agentCycles.current;
        let messages = [...param.messages];
        while (currentAgentCycleCount <= param.agentCycles.max) {
          const agentCycleQuotaExhausted = !(currentAgentCycleCount < param.agentCycles.max);

          try {
            messages = AgentMessageSchema.array().parse(
              (await param.preInferenceHook?.({
                messages,
                system: param.system,
                tools: param.tools,
                span,
                agentCycles: {
                  current: currentAgentCycleCount,
                  max: param.agentCycles.max,
                  exhausted: agentCycleQuotaExhausted,
                },
                tokenUsage,
              })) ?? messages,
            );
          } catch (err) {
            logToSpan(
              {
                level: 'INFO',
                message: 'Error thrown by the preInferenceHook',
              },
              span,
            );
            exceptionToSpan(err as Error, span);
          }

          param.onStream({
            type:
              lifecycle === 'init'
                ? 'agent.init'
                : lifecycle === 'tool_result'
                  ? 'agent.resume'
                  : 'agent.self.correction',
            data: {
              system: param.system,
              messages: messages,
              tools: param.tools.map((item) => item.name),
              llmResponseType: param.llmResponseType,
              toolIteractionCycle: {
                max: param.agentCycles.max,
                current: param.agentCycles.current,
                exhausted: agentCycleQuotaExhausted,
              },
            },
          });

          const response = AgentLLMIntegrationOutputSchema.parse(
            await param.llm(
              {
                lifecycle,
                system: param.system,
                messages: messages,
                tools: param.tools,
                agentCycles: {
                  current: currentAgentCycleCount,
                  max: param.agentCycles.max,
                  exhausted: agentCycleQuotaExhausted,
                },
                outputFormat: {
                  type: param.llmResponseType,
                  format: param.outputFormat,
                },
                onStream: param.onStream,
              },
              { otelInfo },
            ),
          );
          currentAgentCycleCount++;
          executionUnits += response.executionUnits;
          tokenUsage.completion += response.usage.tokens.completion;
          tokenUsage.prompt += response.usage.tokens.prompt;

          if (param.postInferenceHook) {
            let pihResult: Awaited<ReturnType<typeof param.postInferenceHook>> | undefined;
            try {
              pihResult =
                (await param.postInferenceHook({
                  inference: response,
                  span,
                  agentCycles: {
                    current: currentAgentCycleCount,
                    max: param.agentCycles.max,
                    exhausted: agentCycleQuotaExhausted,
                  },
                  tokenUsage,
                })) ?? undefined;
            } catch (err) {
              logToSpan(
                {
                  level: 'INFO',
                  message: 'Error thrown by the postInferenceHook',
                },
                span,
              );
              exceptionToSpan(err as Error, span);
            }
            if (pihResult?.action === 'RETRY') {
              logToSpan(
                {
                  level: 'INFO',
                  message: `RETRY actions issued by the postInferenceHook. Dropping all inference and re-doing inference`,
                },
                span,
              );
              continue;
            }
            if (pihResult?.action === 'CIRCUIT_BREAK') {
              logToSpan(
                {
                  level: 'INFO',
                  message: `CIRCUIT_BREAK actions issued by the postInferenceHook. Dropping all inference and throwing the error issues by the hook`,
                },
                span,
              );
              throw pihResult.error;
            }
          }

          // Update the message seen count by one for all the
          // messages which the LLM has seen
          for (let i = 0; i < messages.length; i++) {
            messages[i].seenCount += 1;
          }

          if (response.type === 'tool_call') {
            const arvoToolCalls: AgentToolCallContent[] = [];
            const mcpToolResultPromises: Promise<AgentToolResultContent>[] = [];
            const internalToolResultPromises: Promise<AgentMessage | AgentMessage[]>[] = [];
            const prioritizedToolCalls = prioritizeToolCalls(response.toolRequests, nameToToolMap);

            const toolPermissionRequest: Parameters<IPermissionManager['get']>[0]['tools'] = {};
            for (const item of prioritizedToolCalls) {
              if (!param.permissionPolicy.includes(item.name)) continue;
              if (!toolPermissionRequest[item.name]) {
                toolPermissionRequest[item.name] = {
                  definition: nameToToolMap[item.name],
                  requests: [],
                };
              }
              toolPermissionRequest[item.name].requests.push(item);
            }

            const toolPermissionMap: Record<string, ToolAuthorizationState> =
              (await param.permissionManager?.get({
                source: param.permissionManagerContext,
                tools: toolPermissionRequest,
                config: { otelInfo },
              })) ?? {};

            const toolsPendingPermission: Parameters<
              IPermissionManager['requestBuilder']
            >[0]['tools'] = {};
            for (const item of prioritizedToolCalls) {
              param.onStream({
                type: 'agent.tool.request',
                data: {
                  tool: {
                    name: item.name,
                    kind: nameToToolMap[item.name]?.serverConfig?.kind ?? 'unknown',
                    originalName: nameToToolMap[item.name]?.serverConfig?.name ?? 'unknown',
                  },
                  usage: tokenUsage,
                  executionunits: executionUnits,
                },
              });

              const toolCallContent: AgentToolCallContent = {
                type: 'tool_use',
                toolUseId: item.toolUseId,
                name: item.name,
                input: item.input,
              };

              messages.push({
                role: 'assistant',
                content: toolCallContent,
                // This has been viewed by the LLM as it was generated by it
                seenCount: 1,
              });

              const resolvedToolDef = nameToToolMap[item.name] as
                | AgentToolDefinition<VersionedArvoContract<
                    AnyArvoContract,
                    ArvoSemanticVersion
                  > | null>
                | undefined;

              if (!resolvedToolDef) {
                messages.push({
                  role: 'user',
                  content: {
                    type: 'tool_result',
                    toolUseId: item.toolUseId,
                    content: `The tool ${item.name} does not exist. Please check if you are using the correct tool and don't call this tool again till you have confirmed the existance of the correct tool`,
                  },
                  seenCount: 0,
                });
                continue;
              }

              // Block tool call with explicit deny
              if (toolPermissionMap[item.name] === 'DENIED') {
                messages.push({
                  role: 'user',
                  content: {
                    type: 'tool_result',
                    toolUseId: item.toolUseId,
                    content: cleanString(`
                      [Critical] You don't have the permission to call this tool "${item.name}".
                      You were explicitly denied from calling this tool by the authorization 
                      system.
                    `),
                  },
                  seenCount: 0,
                });

                logToSpan(
                  {
                    level: 'INFO',
                    message: `Tool "${item.name}" permission denied`,
                    tool: JSON.stringify({
                      name: item.name,
                      kind: resolvedToolDef.serverConfig.kind,
                      originalName: resolvedToolDef.serverConfig.name,
                      toolUseId: item.toolUseId,
                    }),
                    context: JSON.stringify({
                      accessControl: param.permissionManagerContext.accesscontrol,
                      agent: param.permissionManagerContext.name,
                    }),
                  },
                  span,
                );

                param.onStream({
                  type: 'agent.tool.permission.denied',
                  data: {
                    tools: [
                      {
                        name: item.name,
                        kind: resolvedToolDef.serverConfig.kind,
                        originalName: resolvedToolDef.serverConfig.name,
                      },
                    ],
                    usage: tokenUsage,
                    executionunits: executionUnits,
                  },
                });
                continue;
              }

              // Block tool call and build permission request
              if (toolPermissionMap[item.name] === 'REQUESTABLE') {
                if (!toolsPendingPermission[item.name]) {
                  toolsPendingPermission[item.name] = {
                    definition: resolvedToolDef,
                    requests: [],
                  };
                }
                toolsPendingPermission[item.name].requests.push(item);
                messages.push({
                  role: 'user',
                  content: {
                    type: 'tool_result',
                    toolUseId: item.toolUseId,
                    content: cleanString(`
                      [Critical] The tool "${item.name}" call was blocked this time as it required external permissions. 
                      The permission request has been lodged and responded to. Please try again.
                      You can request any tool call, the system is here to facilitate with the permission 
                      acquiry. You as an AI Agent don't have to concern yourself with tool permission details.
                    `),
                  },
                  seenCount: 0,
                });

                logToSpan(
                  {
                    level: 'WARNING',
                    message: `Tool "${item.name}" blocked - permission required`,
                    tool: JSON.stringify({
                      name: item.name,
                      kind: resolvedToolDef.serverConfig.kind,
                      originalName: resolvedToolDef.serverConfig.name,
                      toolUseId: item.toolUseId,
                    }),
                    context: JSON.stringify({
                      accessControl: param.permissionManagerContext.accesscontrol,
                      agent: param.permissionManagerContext.name,
                    }),
                  },
                  span,
                );

                param.onStream({
                  type: 'agent.tool.permission.blocked',
                  data: {
                    tools: [
                      {
                        name: item.name,
                        kind: resolvedToolDef.serverConfig.kind,
                        originalName: resolvedToolDef.serverConfig.name,
                      },
                    ],
                    usage: tokenUsage,
                    executionunits: executionUnits,
                  },
                });
                continue;
              }

              if (resolvedToolDef.serverConfig.kind === 'mcp') {
                mcpToolResultPromises.push(
                  (async () => {
                    const response = await param.mcp
                      ?.invokeTool(
                        { name: resolvedToolDef.serverConfig.name, arguments: item.input },
                        { otelInfo },
                      )
                      ?.catch((err: Error) => ({
                        type: 'error',
                        name: err.name,
                        message: err.message,
                      }));
                    return {
                      type: 'tool_result',
                      toolUseId: item.toolUseId,
                      content: response
                        ? JSON.stringify(response)
                        : 'No response available from the MCP',
                    };
                  })(),
                );
              } else if (resolvedToolDef.serverConfig.kind === 'internal') {
                internalToolResultPromises.push(
                  (async () => {
                    const serverConfig = (
                      resolvedToolDef as unknown as AgentToolDefinition<AgentInternalTool>
                    ).serverConfig;

                    if (
                      !(
                        'fn' in serverConfig.contract &&
                        serverConfig.contract.fn &&
                        typeof serverConfig.contract.fn === 'function'
                      )
                    ) {
                      return {
                        role: 'user' as const,
                        seenCount: 0,
                        content: {
                          type: 'tool_result',
                          toolUseId: item.toolUseId,
                          content: 'Invalid internal tool call',
                        },
                      };
                    }

                    try {
                      const response =
                        (await serverConfig.contract.fn(item.input, {
                          otelInfo,
                          toolUseId: item.toolUseId,
                        })) ?? null;

                      if (response && 'messages' in response) {
                        return response.messages;
                      }

                      if (response && 'data' in response) {
                        return {
                          role: 'user' as const,
                          seenCount: 0,
                          content: {
                            type: 'tool_result',
                            toolUseId: item.toolUseId,
                            content: JSON.stringify(response.data),
                          },
                        };
                      }

                      return {
                        role: 'user',
                        seenCount: 0,
                        content: {
                          type: 'tool_result',
                          toolUseId: item.toolUseId,
                          content: 'Tool executed successfully.',
                        },
                      };
                    } catch (err) {
                      return {
                        role: 'user' as const,
                        seenCount: 0,
                        content: {
                          type: 'tool_result',
                          toolUseId: item.toolUseId,
                          content: JSON.stringify({
                            type: 'error',
                            name: (err as Error).name,
                            message: (err as Error).message,
                          }),
                        },
                      };
                    }
                  })(),
                );
              } else if (resolvedToolDef.serverConfig.kind === 'arvo') {
                const zodParseResult = (
                  resolvedToolDef.serverConfig.contract?.accepts.schema as z.ZodTypeAny
                ).safeParse({
                  ...item.input,
                  parentSubject$$: null,
                });
                if (zodParseResult?.error) {
                  messages.push({
                    role: 'user',
                    content: {
                      type: 'tool_result',
                      toolUseId: item.toolUseId,
                      content: JSON.stringify({
                        type: 'error',
                        name: `${zodParseResult.error.name} Please refer to the tool definition for '${item.name}'`,
                        message: zodParseResult.error.message,
                      }),
                    },
                    seenCount: 0,
                  });
                } else {
                  arvoToolCalls.push({
                    ...toolCallContent,
                    input: zodParseResult.data,
                    name:
                      resolvedToolDef.serverConfig.contract?.accepts.type ??
                      resolvedToolDef.serverConfig.name,
                  });
                }
              }
            }
            for (const item of await Promise.all(mcpToolResultPromises)) {
              messages.push({ role: 'user', content: item, seenCount: 0 });
            }
            for (const item of await Promise.all(internalToolResultPromises)) {
              if (Array.isArray(item)) {
                item.forEach((i) => {
                  messages.push(i);
                });
              } else {
                messages.push(item);
              }
            }
            if (param.permissionManager && Object.keys(toolsPendingPermission).length) {
              const toolPermissionRequest = await param.permissionManager?.requestBuilder({
                source: param.permissionManagerContext,
                tools: toolsPendingPermission,
                config: { otelInfo },
              });

              arvoToolCalls.push({
                type: 'tool_use',
                name: param.permissionManager.contract.accepts.type,
                toolUseId: v4(),
                input: toolPermissionRequest,
              });

              logToSpan(
                {
                  level: 'INFO',
                  message: `Permission request created for ${toolsPendingPermission.length} blocked tool(s)`,
                  permissionRequest: JSON.stringify({
                    contractType: param.permissionManager.contract.accepts.type,
                    toolCount: toolsPendingPermission.length,
                    tools: Object.values(toolsPendingPermission).map(({ definition: tool }) => ({
                      name: tool.name,
                      kind: tool.serverConfig.kind,
                      originalName: tool.serverConfig.name,
                    })),
                  }),
                  context: JSON.stringify({
                    accessControl: param.permissionManagerContext.accesscontrol,
                    agent: param.permissionManagerContext.name,
                  }),
                },
                span,
              );

              param.onStream({
                type: 'agent.tool.permission.requested',
                data: {
                  tools: Object.values(toolsPendingPermission).map(({ definition: tool }) => ({
                    name: tool.name,
                    kind: tool.serverConfig.kind,
                    originalName: tool.serverConfig.name,
                  })),
                  usage: tokenUsage,
                  executionunits: executionUnits,
                },
              });
            }
            if (arvoToolCalls.length) {
              param.onStream({
                type: 'agent.tool.request.delegation',
                data: {
                  tools: arvoToolCalls.map((item) => item.name),
                  executionunits: executionUnits,
                  usage: tokenUsage,
                },
              });

              return {
                messages,
                toolCalls: arvoToolCalls,
                agentCycles: {
                  current: currentAgentCycleCount,
                  max: param.agentCycles.max,
                },
                executionUnits,
                tokenUsage,
              };
            }
            lifecycle = 'tool_result';
            continue;
          }

          param.onStream({
            type: 'agent.output.finalization',
            data: {
              content: response.content,
              usage: tokenUsage,
              executionunits: executionUnits,
            },
          });

          const outputResult = await param.outputBuilder({
            ...response,
            outputFormat: param.outputFormat,
            span,
          });
          if ('error' in outputResult && outputResult.error) {
            messages.push({
              role: 'assistant',
              content: {
                type: 'text' as const,
                content:
                  'content' in response && response.content ? response.content : 'No response',
              },
              // This has been viewed by the LLM as it was generated by it
              seenCount: 1,
            });
            messages.push({
              role: 'user',
              content: {
                type: 'text',
                content: JSON.stringify({
                  type: 'error',
                  name: outputResult.error.name,
                  message: outputResult.error.message,
                }),
              },
              seenCount: 0,
            });
            lifecycle = 'output_error_feedback';
            continue;
          }

          if ('data' in outputResult && outputResult.data) {
            messages.push({
              role: 'assistant',
              content: {
                type: 'text',
                content: JSON.stringify(outputResult.data),
              },
              // This has been viewed by the LLM as it was generated by it
              seenCount: 1,
            });

            param.onStream({
              type: 'agent.output',
              data: {
                content: JSON.stringify(outputResult.data),
                usage: tokenUsage,
                executionunits: executionUnits,
              },
            });

            return {
              messages,
              output: outputResult.data,
              agentCycles: {
                current: currentAgentCycleCount,
                max: param.agentCycles.max,
              },
              executionUnits,
              tokenUsage,
            };
          }
        }
        throw new Error(`Tool calls exhausted the max quota: ${currentAgentCycleCount}`);
      } finally {
        span.end();
      }
    },
  });
