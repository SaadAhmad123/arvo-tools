import {
  SemanticConventions as OpenInferenceSemanticConventions,
  OpenInferenceSpanKind,
} from '@arizeai/openinference-semantic-conventions';
import { SpanStatusCode } from '@opentelemetry/api';
import { ArvoOpenTelemetry, exceptionToSpan } from 'arvo-core';
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/index.mjs';
import type { ChatModel } from 'openai/resources/shared.mjs';
import type { ChatCompletionMessageFunctionToolCall } from 'openai/resources.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AgentMessage, AgentToolCallContent, AgentToolResultContent } from '../../Agent/types';
import {
  setOpenInferenceInputAttr,
  setOpenInferenceResponseOutputAttr,
  setOpenInferenceToolCallOutputAttr,
  setOpenInferenceUsageOutputAttr,
  tryParseJson,
} from '../../Agent/utils';
import { DEFAULT_TOOL_LIMIT_PROMPT } from '../prompts';
import type {
  AgentLLMIntegration,
  AgentLLMIntegrationOutput,
  AgentLLMIntegrationParam,
} from '../types';

/**
 * Internal Adapter: Maps Arvo's generic Agent Message format to OpenAI's specific API format.
 *
 * Handles:
 * - System Prompt injection.
 * - Mapping Tool Results to their originating Tool Call IDs.
 * - Multimodal Content (converting Arvo media objects to OpenAI Image/File URLs).
 * - Reconstructs the specific message ordering OpenAI expects (User -> Assistant(ToolCall) -> Tool(Result)).
 */
const formatMessagesForOpenAI = (
  messages: AgentLLMIntegrationParam['messages'],
  systemPrompt: string | null,
): ChatCompletionMessageParam[] => {
  const formattedMessages: ChatCompletionMessageParam[] = [];

  if (systemPrompt) {
    formattedMessages.push({
      role: 'system',
      content: systemPrompt,
    });
  }

  const toolResponseMap: Record<string, AgentToolResultContent> = {};
  for (const message of messages) {
    if (message.role === 'user' && message.content.type === 'tool_result') {
      toolResponseMap[message.content.toolUseId] = message.content;
    }
  }

  for (const message of messages) {
    if (message.role === 'user') {
      if (message.content.type === 'text') {
        formattedMessages.push({
          role: 'user',
          content: message.content.content,
        });
      } else if (message.content.type === 'media' && message.content.contentType.type === 'image') {
        formattedMessages.push({
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: message.content.content,
              },
            },
          ],
        });
      } else if (message.content.type === 'media' && message.content.contentType.type === 'file') {
        formattedMessages.push({
          role: 'user',
          content: [
            {
              type: 'file',
              file: {
                filename: message.content.contentType.filename,
                file_data: message.content.content,
              },
            },
          ],
        });
      }
    } else if (message.role === 'assistant') {
      if (message.content.type === 'text') {
        formattedMessages.push({
          role: 'assistant',
          content: message.content.content,
        });
      } else if (message.content.type === 'tool_use') {
        formattedMessages.push({
          role: 'assistant',
          tool_calls: [
            {
              type: 'function',
              id: message.content.toolUseId,
              function: {
                name: message.content.name,
                arguments: JSON.stringify(message.content.input),
              },
            },
          ],
        });
        const toolResult = toolResponseMap[message.content.toolUseId];
        formattedMessages.push({
          role: 'tool',
          tool_call_id: message.content.toolUseId,
          content: toolResult?.content ?? JSON.stringify({ error: 'No tool response' }),
        });
      }
    }
  }

  return formattedMessages;
};

/**
 * Creates an Arvo-compatible LLM Adapter for OpenAI models (GPT-4, GPT-3.5, etc.).
 *
 * This integration handles the complexity of:
 * 1. **Structured Outputs:** Automatically converts Zod schemas to OpenAI `json_schema` format when required.
 * 2. **Context Optimization:** Automatically strips large media payloads (images/files) from the history during resume/tool-result cycles to save tokens.
 * 3. **Observability:** Instruments every call with OpenInference-compliant OpenTelemetry attributes.
 * 4. **Safety:** Injects a tool limit prompt when the Agent exhausts its tool budget (customizable via `toolLimitPrompt`).
 *
 * @param client - An initialized `OpenAI` SDK client instance.
 * @param config - Configuration for model behavior (Model ID, Temperature, Max Tokens) and cost calculation logic.
 * @param config.toolLimitPrompt - Custom system instruction to inject when `maxToolInteractions` logic is triggered. useful for guiding the model to summarize or fail gracefully.
 * @returns An `AgentLLMIntegration` function ready to be passed to `createArvoAgent`.
 */
export const openaiLLMIntegration =
  (
    client: OpenAI,
    config?: {
      model?: ChatModel;
      temperature?: number;
      maxTokens?: number;
      executionunits?: (prompt: number, completion: number) => number;
      toolLimitPrompt?: (toolInteractions: AgentLLMIntegrationParam['toolInteractions']) => string;
    },
  ): AgentLLMIntegration =>
  async (
    { messages: _messages, system: _system, tools, outputFormat, lifecycle, toolInteractions },
    { otelInfo },
  ) =>
    await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: `LLM.invoke<${lifecycle === 'init' ? 'init' : lifecycle === 'tool_result' ? 'resume' : 'output_validation_feedback'}>`,
      disableSpanManagement: true,
      context: {
        inheritFrom: 'TRACE_HEADERS',
        traceHeaders: otelInfo.headers,
      },
      spanOptions: {
        attributes: {
          [OpenInferenceSemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.LLM,
        },
      },
      fn: async (span): Promise<AgentLLMIntegrationOutput> => {
        const llmModel: ChatModel = config?.model ?? 'gpt-4o';
        const llmInvocationParams = {
          temperature: config?.temperature ?? 0,
          maxTokens: config?.maxTokens ?? 4096,
        };

        const messages: AgentMessage[] = _messages.map((item) => {
          if (item.content.type === 'media' && item.seenCount > 0) {
            return {
              role: item.role,
              content: {
                type: 'text',
                content: `Media file (type: ${item.content.contentType.type}@${item.content.contentType.format}) already parsed and looked at. No need for you to look at it again`,
              },
              seenCount: item.seenCount,
            };
          }
          return item;
        });
        let system = _system;

        if (toolInteractions.exhausted) {
          const limitMessage =
            config?.toolLimitPrompt?.(toolInteractions) ?? DEFAULT_TOOL_LIMIT_PROMPT;
          messages.push({
            role: 'user',
            content: {
              type: 'text',
              content: limitMessage,
            },
            seenCount: 0,
          });
          system = `${system}\n\n${limitMessage}`;
        }

        setOpenInferenceInputAttr(
          {
            llm: {
              provider: 'openai',
              system: 'openai',
              model: llmModel,
              invocationParam: llmInvocationParams,
            },
            messages,
            system,
            tools,
          },
          span,
        );

        try {
          const toolDef: ChatCompletionTool[] = [];
          for (const tool of tools) {
            toolDef.push({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            });
          }

          const formattedMessages = formatMessagesForOpenAI(messages, system);

          const responseFormat =
            outputFormat.type === 'json'
              ? {
                  type: 'json_schema' as const,
                  json_schema: {
                    name: 'response_schema',
                    description: 'The required response schema',
                    // biome-ignore lint/suspicious/noExplicitAny: Make the typescript compiler ignore. Otherwise, it emits error "Type instantiation is excessively deep and possibly infinite. ts(2589)"
                    schema: zodToJsonSchema(outputFormat.format as any),
                  },
                }
              : undefined;

          const completion = await client.chat.completions.create({
            model: llmModel,
            ...(llmModel.includes('gpt-5')
              ? { max_completion_tokens: llmInvocationParams.maxTokens }
              : { max_tokens: llmInvocationParams.maxTokens }),
            temperature: llmModel.includes('gpt-5') ? 1 : llmInvocationParams.temperature,
            tools: toolDef.length ? toolDef : undefined,
            messages: formattedMessages,
            response_format: responseFormat,
          });

          const choice = completion.choices[0];
          const llmUsage: NonNullable<AgentLLMIntegrationOutput['usage']> = {
            tokens: {
              prompt: completion.usage?.prompt_tokens ?? 0,
              completion: completion.usage?.completion_tokens ?? 0,
            },
          };
          const executionUnits =
            config?.executionunits?.(llmUsage.tokens.prompt, llmUsage.tokens.completion) ??
            llmUsage.tokens.prompt + llmUsage.tokens.completion;

          setOpenInferenceUsageOutputAttr(llmUsage, span);

          if (choice?.message?.tool_calls) {
            const toolRequests: Omit<AgentToolCallContent, 'type'>[] = [];
            for (const toolCall of choice.message
              .tool_calls as ChatCompletionMessageFunctionToolCall[]) {
              try {
                toolRequests.push({
                  toolUseId: toolCall.id,
                  name: toolCall.function.name,
                  input: JSON.parse(toolCall.function.arguments) as Record<string, unknown>,
                });
              } catch (err) {
                exceptionToSpan(err as Error, span);
              }
            }

            if (toolRequests.length) {
              setOpenInferenceToolCallOutputAttr({ toolCalls: toolRequests }, span);
              return {
                type: 'tool_call',
                toolRequests,
                usage: llmUsage,
                executionUnits,
              };
            }
          }

          let content = choice?.message?.content ?? '';
          if (choice.finish_reason === 'length') {
            content = `${content} [Max response token limit ${llmInvocationParams.maxTokens} reached]`;
          }
          if (choice.finish_reason === 'content_filter') {
            content = `${content} [Request blocked due to OpenAI content filtering policies]`;
          }
          setOpenInferenceResponseOutputAttr({ response: content }, span);
          if (outputFormat.type === 'json') {
            return {
              type: 'json',
              content: content || '{}',
              parsedContent: tryParseJson(content || '{}'),
              usage: llmUsage,
              executionUnits,
            };
          }

          return {
            type: 'text',
            content,
            usage: llmUsage,
            executionUnits,
          };
        } catch (e) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error)?.message });
          throw e;
        } finally {
          span.end();
        }
      },
    });
