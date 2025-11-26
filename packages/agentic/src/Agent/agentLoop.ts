import {
  SemanticConventions as OpenInferenceSemanticConventions,
  OpenInferenceSpanKind,
} from '@arizeai/openinference-semantic-conventions';
import {
  ArvoOpenTelemetry,
  type ArvoSemanticVersion,
  getOtelHeaderFromSpan,
  type VersionedArvoContract,
} from 'arvo-core';
import type z from 'zod';
import type { AgentInternalTool } from '../AgentTool/types.js';
import type { AgentLLMIntegration, AgentLLMIntegrationParam } from '../Integrations/types.js';
import type { IMCPClient } from '../interfaces.mcp.js';
import type { OtelInfoType } from '../types.js';
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
      try {
        let currentToolInteractionCount = param.toolInteraction.current;
        const messages = [...param.messages];
        while (currentToolInteractionCount <= param.toolInteraction.max) {
          const toolQuotaExhausted = !(currentToolInteractionCount < param.toolInteraction.max);
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
            },
            { otelInfo },
          );
          currentToolInteractionCount++;
          executionUnits += response.executionUnits;

          // Update the message seen count by one for all the
          // messages which the LLM has seen
          for (let i = 0; i < messages.length; i++) {
            messages[i].seenCount += 1;
          }

          if (response.type === 'tool_call') {
            const arvoToolCalls: AgentToolCallContent[] = [];
            const mcpToolResultPromises: Promise<AgentToolResultContent>[] = [];
            const internalToolResultPromises: Promise<AgentToolResultContent>[] = [];
            for (const item of prioritizeToolCalls(response.toolRequests, nameToToolMap)) {
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
            if (arvoToolCalls.length) {
              return {
                messages,
                toolCalls: arvoToolCalls,
                toolInteractions: {
                  current: currentToolInteractionCount,
                  max: param.toolInteraction.max,
                },
                executionUnits,
              };
            }
            lifecycle = 'tool_result';
            continue;
          }

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

            return {
              messages,
              output: outputResult.data,
              toolInteractions: {
                current: currentToolInteractionCount,
                max: param.toolInteraction.max,
              },
              executionUnits,
            };
          }
        }
        throw new Error(`Tool calls exhausted the max quota: ${currentToolInteractionCount}`);
      } finally {
        span.end();
      }
    },
  });
