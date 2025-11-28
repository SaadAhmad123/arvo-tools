import {
  SemanticConventions as OpenInferenceSemanticConventions,
  OpenInferenceSpanKind,
} from '@arizeai/openinference-semantic-conventions';
import {
  ArvoOpenTelemetry,
  type ArvoSemanticVersion,
  cleanString,
  getOtelHeaderFromSpan,
  logToSpan,
  type VersionedArvoContract,
} from 'arvo-core';
import { v4 } from 'uuid';
import type z from 'zod';
import type { AgentInternalTool } from '../AgentTool/types.js';
import type { AgentLLMIntegration, AgentLLMIntegrationParam } from '../Integrations/types.js';
import type { IMCPClient } from '../interfaces.mcp.js';
import type {
  IPermissionManager,
  PermissionManagerContext,
} from '../interfaces.permission.manager.js';
import type { OtelInfoType } from '../types.js';
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
    llmResponseType: NonNullable<CreateArvoAgentParam['llmResponseType']>;
    llm: AgentLLMIntegration;
    mcp: IMCPClient | null;
    toolInteraction: {
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
        let currentToolInteractionCount = param.toolInteraction.current;
        const messages = [...param.messages];
        while (currentToolInteractionCount <= param.toolInteraction.max) {
          const toolQuotaExhausted = !(currentToolInteractionCount < param.toolInteraction.max);

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
                max: param.toolInteraction.max,
                current: param.toolInteraction.current,
                exhausted: toolQuotaExhausted,
              },
            },
          });

          const response = await param.llm(
            {
              lifecycle,
              system: param.system,
              messages: messages,
              tools: param.tools,
              toolInteractions: {
                current: currentToolInteractionCount,
                max: param.toolInteraction.max,
                exhausted: toolQuotaExhausted,
              },
              outputFormat: {
                type: param.llmResponseType,
                format: param.outputFormat,
              },
              onStream: param.onStream,
            },
            { otelInfo },
          );
          currentToolInteractionCount++;
          executionUnits += response.executionUnits;
          tokenUsage.completion += response.usage.tokens.completion;
          tokenUsage.prompt += response.usage.tokens.prompt;

          // Update the message seen count by one for all the
          // messages which the LLM has seen
          for (let i = 0; i < messages.length; i++) {
            messages[i].seenCount += 1;
          }

          if (response.type === 'tool_call') {
            const arvoToolCalls: AgentToolCallContent[] = [];
            const mcpToolResultPromises: Promise<AgentToolResultContent>[] = [];
            const internalToolResultPromises: Promise<AgentToolResultContent>[] = [];
            const prioritizedToolCalls = prioritizeToolCalls(response.toolRequests, nameToToolMap);

            const toolPermissionMap: Record<string, boolean> =
              (await param.permissionManager?.get(
                param.permissionManagerContext,
                prioritizedToolCalls
                  .filter((item) => param.permissionPolicy.includes(item.name))
                  .map((item) => nameToToolMap[item.name])
                  .filter(Boolean),
                { otelInfo },
              )) ?? {};

            // biome-ignore lint/suspicious/noExplicitAny: This needs to be general
            const toolsPendingPermission: AgentToolDefinition<any>[] = [];
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

              // Block tool call with no permission and build permission request
              if (toolPermissionMap[item.name] === false) {
                toolsPendingPermission.push(resolvedToolDef);
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
                        type: 'tool_result',
                        toolUseId: item.toolUseId,
                        content: 'Invalid internal tool call',
                      };
                    }

                    const response = await serverConfig.contract
                      .fn(item.input, { otelInfo })
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
                        : 'No response available from the internal tool',
                    };
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
              messages.push({ role: 'user', content: item, seenCount: 0 });
            }
            if (param.permissionManager && toolsPendingPermission.length) {
              const toolPermissionRequest = await param.permissionManager?.requestBuilder(
                param.permissionManagerContext,
                toolsPendingPermission,
                { otelInfo },
              );

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
                    tools: toolsPendingPermission.map((tool) => ({
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
                  tools: toolsPendingPermission.map((tool) => ({
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
                toolInteractions: {
                  current: currentToolInteractionCount,
                  max: param.toolInteraction.max,
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
              toolInteractions: {
                current: currentToolInteractionCount,
                max: param.toolInteraction.max,
              },
              executionUnits,
              tokenUsage,
            };
          }
        }
        throw new Error(`Tool calls exhausted the max quota: ${currentToolInteractionCount}`);
      } finally {
        span.end();
      }
    },
  });
