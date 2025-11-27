import type Anthropic from '@anthropic-ai/sdk';
import {
  SemanticConventions as OpenInferenceSemanticConventions,
  OpenInferenceSpanKind,
} from '@arizeai/openinference-semantic-conventions';
import { SpanStatusCode } from '@opentelemetry/api';
import { ArvoOpenTelemetry, exceptionToSpan } from 'arvo-core';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AgentMessage, AgentToolCallContent } from '../../Agent/types';
import {
  setOpenInferenceInputAttr,
  setOpenInferenceResponseOutputAttr,
  setOpenInferenceToolCallOutputAttr,
  setOpenInferenceUsageOutputAttr,
  tryParseJson,
} from '../../Agent/utils';
import { DEFAULT_TOOL_LIMIT_PROMPT, jsonPrompt } from '../prompts';
import type { AgentLLMIntegration, AgentLLMIntegrationOutput } from '../types';
import type { AnthropicLlmIntegrationConfig } from './types';
import { formatMessagesForAnthropic } from './utils';

/**
 * Creates an Arvo-compatible LLM Adapter for Anthropic Claude models.
 *
 * This factory configures an integration that bridges the generic `Arvo` agent runner with the specific
 * Anthropic API requirements. It includes built-in features for:
 *
 * - **Structured Outputs:** Automatically converts Zod schemas to JSON schema format and instructs
 *   Claude to respond with valid JSON matching the schema.
 * - **Token Optimization:** Automatically replaces large media payloads (images/files) with placeholder
 *   text in the conversational history after they have been processed once to reduce context window usage.
 * - **Observability:** Instruments calls with OpenInference-compliant OpenTelemetry attributes,
 *   including detailed input/output recording and token usage.
 * - **Safety:** Automatically injects a "tool limit reached" system instruction when the agent
 *   exhausts its configured tool budget.
 *
 * @param client - An initialized `Anthropic` SDK client instance.
 * @param config - Configuration for model parameters (e.g., temperature, max tokens), cost calculations, and telemetry metadata.
 * @returns An `AgentLLMIntegration` function ready for use with `createArvoAgent`.
 */
export const anthropicLLMIntegration =
  (client: Anthropic, config?: AnthropicLlmIntegrationConfig): AgentLLMIntegration =>
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
        const messageCreateParams: AnthropicLlmIntegrationConfig['invocationParam'] =
          config?.invocationParam ?? {
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4096,
            temperature: 0,
          };

        let { messages, system } = (await config?.contextTransformer?.({
          messages: _messages,
          system: _system,
        })) ?? {
          messages: _messages.map((item) => {
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
          }) as AgentMessage[],
          system: _system,
        };

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

        // For JSON output format, append schema instructions to the system prompt
        if (outputFormat.type === 'json') {
          // biome-ignore lint/suspicious/noExplicitAny: Make the typescript compiler ignore
          const jsonSchema = zodToJsonSchema(outputFormat.format as any);
          const schemaInstruction = jsonPrompt(JSON.stringify(jsonSchema));
          system = system ? `${system}${schemaInstruction}` : schemaInstruction;
        }

        setOpenInferenceInputAttr(
          {
            llm: {
              provider: 'anthropic',
              system: 'anthropic',
              model: messageCreateParams?.model,
              invocationParam: messageCreateParams,
            },
            messages,
            system: system,
            tools,
          },
          span,
        );

        try {
          const toolDef: Anthropic.Tool[] = [];
          for (const tool of tools) {
            toolDef.push({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
            });
          }

          const formattedMessages = formatMessagesForAnthropic(messages);

          const response = await client.messages.create({
            ...messageCreateParams,
            system: system ?? undefined,
            tools: toolDef.length ? toolDef : undefined,
            messages: formattedMessages,
          });

          const llmUsage: NonNullable<AgentLLMIntegrationOutput['usage']> = {
            tokens: {
              prompt: response.usage.input_tokens,
              completion: response.usage.output_tokens,
            },
          };
          const executionUnits =
            config?.executionunits?.(llmUsage.tokens.prompt, llmUsage.tokens.completion) ??
            llmUsage.tokens.prompt + llmUsage.tokens.completion;

          setOpenInferenceUsageOutputAttr(llmUsage, span);

          // Check for tool use in response
          const toolUseBlocks = response.content.filter(
            (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
          );

          if (toolUseBlocks.length > 0) {
            const toolRequests: Omit<AgentToolCallContent, 'type'>[] = [];
            for (const toolCall of toolUseBlocks) {
              try {
                toolRequests.push({
                  toolUseId: toolCall.id,
                  name: toolCall.name,
                  input: toolCall.input as Record<string, unknown>,
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

          // Extract text content from response
          const textBlocks = response.content.filter(
            (block): block is Anthropic.TextBlock => block.type === 'text',
          );
          let content = textBlocks.map((block) => block.text).join('');

          // Handle stop reasons
          if (response.stop_reason === 'max_tokens') {
            content = `${content} [Max response token limit (<= ${messageCreateParams.max_tokens}) reached]`;
            throw new Error(`Agent reached max token limit. The partial response is "${content}"`);
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
