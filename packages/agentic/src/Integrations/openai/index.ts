import {
  SemanticConventions as OpenInferenceSemanticConventions,
  OpenInferenceSpanKind,
} from '@arizeai/openinference-semantic-conventions';
import { SpanStatusCode } from '@opentelemetry/api';
import { ArvoOpenTelemetry, exceptionToSpan } from 'arvo-core';
import type OpenAI from 'openai';
import type { AzureOpenAI } from 'openai';
import type { ChatCompletionTool } from 'openai/resources/index.mjs';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  setOpenInferenceInputAttr,
  setOpenInferenceResponseOutputAttr,
  setOpenInferenceToolCallOutputAttr,
  setOpenInferenceUsageOutputAttr,
  tryParseJson,
} from '../../Agent/utils';
import { defaultContextTransformer } from '../defaultContextTransformer';
import { DEFAULT_TOOL_LIMIT_PROMPT } from '../prompts';
import type { AgentLLMIntegration, AgentLLMIntegrationOutput, LLMExecutionResult } from '../types';
import { nonStreamableOpenAI } from './nonstreamable';
import { streamableOpenAI } from './streamable';
import type { OpenAILlmIntegrationConfig } from './types';
import { formatMessagesForOpenAI } from './utils';

/**
 * Creates an Arvo-compatible LLM Adapter for OpenAI and compatible models (e.g., Azure OpenAI).
 *
 * This factory configures an integration that bridges the generic `Arvo` agent runner with the specific
 * OpenAI API requirements. It includes built-in features for:
 *
 * - **Structured Outputs:** Automatically converts Zod schemas provided in `outputFormat` to OpenAI's `json_schema` format.
 * - **Token Optimization:** Automatically replaces large media payloads (images/files) with placeholder text in the conversational history after they have been processed once to reduce context window usage.
 * - **Observability:** Instruments calls with OpenInference-compliant OpenTelemetry attributes, including detailed input/output recording and token usage.
 * - **Safety:** Automatically injects a "tool limit reached" system instruction when the agent exhausts its configured tool budget.
 *
 * @param client - An initialized `OpenAI` or `AzureOpenAI` SDK client instance.
 * @param config - Configuration for model parameters (e.g., temperature, max tokens), cost calculations, and telemetry metadata.
 * @returns An `AgentLLMIntegration` function ready for use with `createArvoAgent`.
 */
export const openaiLLMIntegration =
  <TClient extends OpenAI | AzureOpenAI>(
    client: TClient,
    config?: OpenAILlmIntegrationConfig<TClient>,
  ): AgentLLMIntegration =>
  async (
    {
      messages: _messages,
      system: _system,
      tools,
      outputFormat,
      lifecycle,
      toolInteractions,
      onStream,
    },
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
        const llmChatCompletionParams: Required<
          OpenAILlmIntegrationConfig<TClient>['invocationParam']
        > = {
          model: 'gpt-4o',
          max_completion_tokens: 4096,
          temperature: 0,
          stream: true,
          ...(config?.invocationParam ?? {}),
        };

        let { messages, system } = await (config?.contextTransformer ?? defaultContextTransformer)({
          messages: _messages,
          system: _system,
        });

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
              provider: config?.telemetry?.modelProvider ?? 'openai',
              system:
                config?.telemetry?.modelSystem ??
                (config?.telemetry?.modelProvider === 'azure' ? 'azure_openai' : 'openai'),
              model: llmChatCompletionParams?.model,
              invocationParam: llmChatCompletionParams,
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
                    // biome-ignore lint/suspicious/noExplicitAny: Make the typescript compiler ignore
                    schema: zodToJsonSchema(outputFormat.format as any),
                  },
                }
              : undefined;

          const enableStreaming = config?.invocationParam?.stream ?? false;

          const baseParams = {
            ...llmChatCompletionParams,
            tools: toolDef.length ? toolDef : undefined,
            messages: formattedMessages,
            response_format: responseFormat,
            stream_options: enableStreaming ? { include_usage: true } : undefined,
          };

          let result: LLMExecutionResult;

          if (enableStreaming) {
            result = await streamableOpenAI(
              client,
              {
                ...baseParams,
                stream: true,
              },
              { span, onStream },
            );
          } else {
            result = await nonStreamableOpenAI(
              client,
              {
                ...baseParams,
                stream: false,
              },
              { span },
            );
          }

          const llmUsage = result.usage;
          const executionUnits =
            config?.executionunits?.(llmUsage.tokens.prompt, llmUsage.tokens.completion) ??
            llmUsage.tokens.prompt + llmUsage.tokens.completion;

          setOpenInferenceUsageOutputAttr(llmUsage, span);

          if (result.toolRequests && result.toolRequests.length > 0) {
            setOpenInferenceToolCallOutputAttr({ toolCalls: result.toolRequests }, span);
            return {
              type: 'tool_call',
              toolRequests: result.toolRequests,
              usage: llmUsage,
              executionUnits,
            };
          }

          const content = result.response || '';

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
          exceptionToSpan(e as Error, span);
          throw e;
        } finally {
          span.end();
        }
      },
    });
