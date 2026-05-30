import type AnthropicClient from '@anthropic-ai/sdk';
import type { Anthropic } from '@anthropic-ai/sdk';
import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema';
import type { MessageCreateParamsBase } from '@anthropic-ai/sdk/resources/messages';
import { SemanticConventions } from '@arizeai/openinference-semantic-conventions';
import { SpanStatusCode } from '@opentelemetry/api';
import { ArvoOpenTelemetry, exceptionToSpan, OpenInferenceSpanKind } from 'arvo-core';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  MediaMessageContent,
  Message,
  MessageContent,
  TextMessageContent,
  ToolCallMessageContent,
} from '../message.types';
import type { IToolMetaData } from '../Tools/interface';
import type { ExecutionMetadataType, JsonAble } from '../types';
import type {
  AgentCoreStreamEvent,
  AgentCoreStreamInput,
  AgentCoreStreamOutput,
  IAgentCore,
} from './interface';
import {
  setInputAttributes,
  setTextOutputAttributes,
  setToolCallOutputAttributes,
  setUsageAttributes,
} from './otelHelpers';

/**
 * Construction parameters for {@link AnthropicAgentCore}.
 */
export type AnthropicAgentCoreParam = {
  /** Pre-configured Anthropic SDK client. */
  client: AnthropicClient;
  /** Parameters forwarded directly to `client.messages.create` on every call. */
  invoke: Omit<MessageCreateParamsBase, 'messages' | 'system' | 'tools' | 'stream'>;
};

/**
 * {@link IAgentCore} implementation backed by the Anthropic Messages API.
 *
 * Streams a single LLM turn, translating the internal {@link Message} format to
 * Anthropic's wire types and back. When `outputSchema` is provided the loop
 * retries until the model produces valid JSON that satisfies the schema, or the
 * budget is exhausted.
 */
export class AnthropicAgentCore implements IAgentCore {
  private readonly client: AnthropicClient;
  private readonly invoke: AnthropicAgentCoreParam['invoke'];

  constructor({ client, invoke }: AnthropicAgentCoreParam) {
    this.client = client;
    this.invoke = invoke;
  }

  private toAnthropicMediaBlockContent(
    block: MediaMessageContent,
  ):
    | Anthropic.Messages.ImageBlockParam
    | Anthropic.Messages.DocumentBlockParam
    | Anthropic.Messages.TextBlockParam {
    if (block.contentType.startsWith('image/')) {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.contentType as Anthropic.Messages.Base64ImageSource['media_type'],
          data: block.data,
        },
      };
    } else if (block.contentType === 'application/pdf') {
      return {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: block.data },
      };
    } else if (
      block.contentType.startsWith('text/') ||
      block.contentType === 'application/json' ||
      block.contentType === 'application/xml'
    ) {
      return {
        type: 'text',
        text: Buffer.from(block.data, 'base64').toString('utf-8'),
      };
    }

    return {
      type: 'text',
      text: `Content of type ${block.contentType} is not supported`,
    };
  }

  private toAnthropicMessages(messages: Message[]): Anthropic.Messages.MessageParam[] {
    const result: Anthropic.Messages.MessageParam[] = [];
    for (const msg of messages) {
      if (msg.role === 'system') continue;
      const content: Anthropic.Messages.ContentBlockParam[] = [];
      for (const block of msg.content) {
        switch (block.type) {
          case 'text':
            content.push({ type: 'text', text: block.text });
            break;
          case 'media':
            content.push(this.toAnthropicMediaBlockContent(block));
            break;
          case 'tool_call':
            content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.args });
            break;
          case 'tool_result': {
            const resultContent: Array<
              | Anthropic.Messages.TextBlockParam
              | Anthropic.Messages.ImageBlockParam
              | Anthropic.Messages.DocumentBlockParam
            > = [];
            for (const c of block.content) {
              if (c.type === 'text') {
                resultContent.push({ type: 'text', text: c.text });
              } else if (c.type === 'media') {
                resultContent.push(this.toAnthropicMediaBlockContent(c));
              }
            }
            content.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: resultContent,
              is_error: block.isError,
            });
            break;
          }
          case 'json':
            content.push({ type: 'text', text: JSON.stringify(block.data) });
            break;
        }
      }
      if (content.length) {
        result.push({ role: msg.role as 'user' | 'assistant', content });
      }
    }
    return result;
  }

  private extractSystemPrompt(messages: Message[]): string | undefined {
    const parts = messages
      .filter((m) => m.role === 'system')
      .flatMap((m) => m.content)
      .filter((c): c is TextMessageContent => c.type === 'text')
      .map((c) => c.text);
    return parts.length ? parts.join('\n\n') : undefined;
  }

  private toAnthropicTools(tools: IToolMetaData[]): Anthropic.Messages.Tool[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Messages.Tool['input_schema'],
    }));
  }

  /**
   * Runs a single streaming LLM turn against the Anthropic Messages API.
   *
   * The method drives an internal retry loop for schema validation: if
   * `input.outputSchema` is set and the model's response is not valid JSON or
   * does not satisfy the schema, the error is fed back as a correction message
   * and the model is called again. Each retry is reported via `options.onEvent` as a
   * `schema_retry` event.
   *
   * The entire call — including any schema-retry iterations — is recorded as a single
   * OpenInference LLM span. Token counts reflect the cumulative total across all iterations.
   *
   * @param input - Conversation history, tools, optional output schema, and budget.
   * @param options - Optional event callback and OTel propagation headers.
   * @returns The final outcome once the model reaches a clean stop or the budget is exhausted.
   */
  async stream(
    input: AgentCoreStreamInput,
    options?: Partial<
      ExecutionMetadataType & {
        onEvent?: (event: AgentCoreStreamEvent) => Promise<void> | void;
      }
    >,
  ): Promise<AgentCoreStreamOutput> {
    const onEvent = options?.onEvent ?? (() => {});

    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: 'AnthropicAgentCore.stream',
      disableSpanManagement: true,
      context: options?.otelHeaders
        ? { inheritFrom: 'TRACE_HEADERS', traceHeaders: options.otelHeaders }
        : undefined,
      spanOptions: {
        attributes: {
          [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.LLM,
          [SemanticConventions.LLM_SYSTEM]: 'anthropic',
          [SemanticConventions.LLM_PROVIDER]: 'anthropic',
          [SemanticConventions.LLM_MODEL_NAME]: this.invoke.model,
          [SemanticConventions.LLM_INVOCATION_PARAMETERS]: JSON.stringify(this.invoke),
        },
      },
      fn: async (span): Promise<AgentCoreStreamOutput> => {
        setInputAttributes(span, input.messages, input.tools);
        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        const finalise = (result: AgentCoreStreamOutput) => {
          setUsageAttributes(span, totalInputTokens, totalOutputTokens);
          if (result.stopReason === 'tool_use') {
            const toolCalls = result.message.content.filter(
              (c): c is ToolCallMessageContent => c.type === 'tool_call',
            );
            setToolCallOutputAttributes(span, toolCalls);
          } else if (result.stopReason === 'end_turn') {
            const out = result.message.content.find((c) => c.type === 'text' || c.type === 'json');
            if (out) {
              setTextOutputAttributes(
                span,
                out.type === 'text' ? out.text : JSON.stringify(out.data),
              );
            }
          }
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        };

        try {
          const messages = [...input.messages];
          let schemaAttempt = 0;

          while (true) {
            if (!input.budget.shouldContinue()) {
              return finalise({
                stopReason: 'budget_exhausted',
                error: new Error('Agent budget exhausted'),
                messages,
              });
            }

            const systemPrompt = this.extractSystemPrompt(messages);
            const anthropicMessages = this.toAnthropicMessages(messages);
            const tools = this.toAnthropicTools(input.tools);

            let inputTokens = 0;
            let outputTokens = 0;
            let stopReason: string | null = null;
            let textAccumulator = '';
            const pendingToolBlocks = new Map<
              number,
              { id: string; name: string; input: string }
            >();
            const toolCalls: ToolCallMessageContent[] = [];
            const assistantContent: MessageContent[] = [];

            const anthropicStream = await this.client.messages.create({
              ...this.invoke,
              messages: anthropicMessages,
              ...(tools.length ? { tools } : {}),
              ...(systemPrompt ? { system: systemPrompt } : {}),
              stream: true,
              output_config: {
                ...(this.invoke.output_config ?? {}),
                ...(input.outputSchema
                  ? {
                      format: {
                        type: 'json_schema',
                        schema: (() => {
                          // biome-ignore lint/correctness/noUnusedVariables: This is fine
                          const { $schema, ...schema } = zodToJsonSchema(
                            // biome-ignore lint/suspicious/noExplicitAny: This is fine and needed here
                            input.outputSchema as any,
                            {
                              definitionPath: '$defs',
                            },
                          );
                          return transformJSONSchema(schema);
                        })(),
                      },
                    }
                  : {}),
              },
            });

            for await (const event of anthropicStream) {
              if (event.type === 'message_start') {
                inputTokens = event.message.usage.input_tokens;
                outputTokens = event.message.usage.output_tokens;
              } else if (event.type === 'content_block_start') {
                if (event.content_block.type === 'tool_use') {
                  pendingToolBlocks.set(event.index, {
                    id: event.content_block.id,
                    name: event.content_block.name,
                    input: '',
                  });
                }
              } else if (event.type === 'content_block_delta') {
                if (event.delta.type === 'text_delta') {
                  textAccumulator += event.delta.text;
                  await onEvent({ type: 'text_delta', delta: event.delta.text });
                } else if (event.delta.type === 'thinking_delta') {
                  await onEvent({ type: 'thinking_delta', delta: event.delta.thinking });
                } else if (event.delta.type === 'input_json_delta') {
                  const block = pendingToolBlocks.get(event.index);
                  if (block) block.input += event.delta.partial_json;
                }
              } else if (event.type === 'content_block_stop') {
                const block = pendingToolBlocks.get(event.index);
                if (block) {
                  try {
                    const args = JSON.parse(block.input || '{}') as Record<string, unknown>;
                    const toolCall: ToolCallMessageContent = {
                      type: 'tool_call',
                      id: block.id,
                      name: block.name,
                      args,
                    };
                    toolCalls.push(toolCall);
                    await onEvent({ type: 'tool_call', id: block.id, name: block.name, args });
                  } catch {
                    await onEvent({
                      type: 'error',
                      message: `Failed to parse arguments for tool '${block.name}' (id: ${block.id})`,
                    });
                  }
                  pendingToolBlocks.delete(event.index);
                }
              } else if (event.type === 'message_delta') {
                stopReason = event.delta.stop_reason ?? stopReason;
                outputTokens += event.usage.output_tokens;
              }
            }

            totalInputTokens += inputTokens;
            totalOutputTokens += outputTokens;
            input.budget.record({
              iterations: 1,
              tokens: { input: inputTokens, output: outputTokens },
            });

            if (stopReason === 'max_tokens') {
              if (textAccumulator)
                messages.push({
                  role: 'assistant',
                  content: [{ type: 'text', text: textAccumulator }],
                });
              return finalise({
                stopReason: 'budget_exhausted',
                error: new Error('Anthropic max_tokens limit reached — response truncated'),
                messages,
              });
            }

            if (stopReason === 'tool_use') {
              if (textAccumulator) assistantContent.push({ type: 'text', text: textAccumulator });
              assistantContent.push(...toolCalls);
              return finalise({
                stopReason: 'tool_use',
                message: { role: 'assistant', content: assistantContent },
              });
            }

            if (textAccumulator) {
              if (!input.outputSchema) {
                return finalise({
                  stopReason: 'end_turn',
                  message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: textAccumulator }],
                  },
                });
              }

              const schemaReminder = JSON.stringify(
                // biome-ignore lint/suspicious/noExplicitAny: This is fine here because otherwise typescript server messes up
                zodToJsonSchema(input.outputSchema as any),
                null,
                2,
              );

              let correctionText: string;
              try {
                const parsed = JSON.parse(textAccumulator) as JsonAble;
                const validation = input.outputSchema.safeParse(parsed);
                if (validation.success) {
                  return finalise({
                    stopReason: 'end_turn',
                    message: {
                      role: 'assistant',
                      content: [{ type: 'json', data: parsed }, ...toolCalls],
                    },
                  });
                }
                correctionText = `Your response did not conform to the required output schema. Please correct it.\n\nValidation error: ${validation.error.message}`;
                messages.push({
                  role: 'assistant',
                  content: [{ type: 'json', data: parsed }, ...toolCalls],
                });
              } catch {
                correctionText =
                  'Your response was not valid JSON. Please respond with a valid JSON object matching the required schema.';
                messages.push({
                  role: 'assistant',
                  content: [{ type: 'text', text: textAccumulator }, ...toolCalls],
                });
              }

              schemaAttempt += 1;
              await onEvent({
                type: 'schema_retry',
                attempt: schemaAttempt,
                validationError: correctionText,
              });
              messages.push({
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: `${correctionText}\n\nRequired schema:\n${schemaReminder}`,
                  },
                ],
              });
              continue;
            }

            return finalise({
              stopReason: 'end_turn',
              message: { role: 'assistant', content: [] },
            });
          }
        } catch (e) {
          exceptionToSpan(e as Error, span);
          span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error)?.message });
          throw e;
        } finally {
          span.end();
        }
      },
    });
  }
}
