import { SemanticConventions } from '@arizeai/openinference-semantic-conventions';
import { SpanStatusCode } from '@opentelemetry/api';
import { ArvoOpenTelemetry, exceptionToSpan, OpenInferenceSpanKind } from 'arvo-core';
import type OpenAIClient from 'openai';
import type { OpenAI } from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { ResponseCreateParamsBase } from 'openai/resources/responses/responses';
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
 * Construction parameters for {@link OpenAIAgentCore}.
 */
export type OpenAIAgentCoreParam = {
  /**
   * Pre-configured OpenAI SDK client (or AzureOpenAI).
   */
  client: OpenAIClient;
  /**
   * Parameters forwarded directly to `client.responses.create` on every call.
   *
   * The following fields are managed internally and must not be set here:
   * - `input` — built from the conversation history passed to {@link OpenAIAgentCore.stream}
   * - `instructions` — extracted from `system`-role messages in the conversation
   * - `tools` — derived from the `IToolMetaData[]` passed to {@link OpenAIAgentCore.stream}
   * - `stream` — always `true`
   */
  invoke: Omit<ResponseCreateParamsBase, 'input' | 'instructions' | 'tools' | 'stream'>;
};

type ResponseInputContent = OpenAI.Responses.ResponseInputContent;
type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type ResponseFunctionCallOutputItem = OpenAI.Responses.ResponseFunctionCallOutputItem;

/**
 * {@link IAgentCore} implementation backed by the OpenAI Responses API.
 *
 * Supports text, image, and file inputs; text/JSON outputs; and text/image
 * tool results. When `outputSchema` is provided the loop retries until the
 * model produces valid JSON that satisfies the schema, or the budget is
 * exhausted.
 */
export class OpenAIAgentCore implements IAgentCore {
  private readonly client: OpenAIClient;
  private readonly invoke: OpenAIAgentCoreParam['invoke'];

  constructor({ client, invoke }: OpenAIAgentCoreParam) {
    this.client = client;
    this.invoke = invoke;
  }

  private mediaToContent(block: MediaMessageContent): ResponseInputContent {
    if (block.contentType.startsWith('image/')) {
      return {
        type: 'input_image',
        detail: 'auto',
        image_url: `data:${block.contentType};base64,${block.data}`,
      };
    }
    if (block.contentType === 'application/pdf') {
      return {
        type: 'input_file',
        file_data: block.data,
        filename: `document.${block.contentType.split('/')[1]}`,
      };
    }
    if (
      block.contentType === 'application/json' ||
      block.contentType === 'application/xml' ||
      block.contentType.startsWith('text/')
    ) {
      return {
        type: 'input_text',
        text: Buffer.from(block.data, 'base64').toString('utf-8'),
      };
    }
    return { type: 'input_text', text: `Content of type ${block.contentType} is not supported` };
  }

  private toResponsesInput(messages: Message[]): {
    input: ResponseInputItem[];
    instructions: string | undefined;
  } {
    let instructions: string | undefined;
    const input: ResponseInputItem[] = [];

    // Pre-build tool result map so each function_call can be immediately followed
    // by its function_call_output, matching the required call→output→call→output order.
    const toolResultMap = new Map<string, ResponseInputItem>();
    for (const msg of messages) {
      if (msg.role !== 'user') continue;
      for (const block of msg.content) {
        if (block.type !== 'tool_result') continue;
        const outputParts: ResponseFunctionCallOutputItem[] = [];
        for (const c of block.content) {
          if (c.type === 'text') {
            outputParts.push({ type: 'input_text', text: c.text });
          } else if (c.type === 'media') {
            outputParts.push(this.mediaToContent(c) as ResponseFunctionCallOutputItem);
          }
        }
        toolResultMap.set(block.id, {
          type: 'function_call_output',
          call_id: block.id,
          output: outputParts.length
            ? outputParts
            : block.isError
              ? 'Tool call failed with no output.'
              : '',
        } as ResponseInputItem);
      }
    }

    for (const msg of messages) {
      if (msg.role === 'system') {
        const text = msg.content
          .filter((c): c is TextMessageContent => c.type === 'text')
          .map((c) => c.text)
          .join('\n\n');
        instructions = instructions ? `${instructions}\n\n${text}` : text || undefined;
        continue;
      }

      if (msg.role === 'user') {
        const contentParts: ResponseInputContent[] = [];

        for (const block of msg.content) {
          if (block.type === 'tool_result') continue; // emitted inline after each function_call
          if (block.type === 'text') {
            contentParts.push({ type: 'input_text', text: block.text });
          } else if (block.type === 'json') {
            contentParts.push({ type: 'input_text', text: JSON.stringify(block.data) });
          } else if (block.type === 'media') {
            contentParts.push(this.mediaToContent(block));
          }
        }

        if (contentParts.length) {
          input.push({ type: 'message', role: 'user', content: contentParts });
        }
        continue;
      }

      if (msg.role === 'assistant') {
        const toolCalls = msg.content.filter(
          (c): c is ToolCallMessageContent => c.type === 'tool_call',
        );
        const textParts = msg.content.filter((c) => c.type === 'text' || c.type === 'json');

        if (textParts.length) {
          const text = textParts
            .map((c) => (c.type === 'text' ? c.text : JSON.stringify(c.data)))
            .join('\n\n');
          input.push({
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text, annotations: [] }],
          } as unknown as ResponseInputItem);
        }

        for (const tc of toolCalls) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.args),
          } as ResponseInputItem);
          const result = toolResultMap.get(tc.id);
          if (result) input.push(result);
        }
      }
    }

    return { input, instructions };
  }

  private toResponsesTools(tools: IToolMetaData[]): OpenAI.Responses.FunctionTool[] {
    return tools.map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description ?? undefined,
      parameters: t.inputSchema as Record<string, unknown>,
      strict: null,
    }));
  }

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
      name: 'OpenAIAgentCore.stream',
      disableSpanManagement: true,
      context: options?.otelHeaders
        ? { inheritFrom: 'TRACE_HEADERS', traceHeaders: options.otelHeaders }
        : undefined,
      spanOptions: {
        attributes: {
          [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.LLM,
          [SemanticConventions.LLM_SYSTEM]: 'openai',
          [SemanticConventions.LLM_PROVIDER]: 'openai',
          [SemanticConventions.LLM_MODEL_NAME]: this.invoke.model ?? '',
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

            const { input: apiInput, instructions } = this.toResponsesInput(messages);
            const tools = this.toResponsesTools(input.tools);

            const responseStream = await this.client.responses.create({
              ...this.invoke,
              input: apiInput,
              ...(instructions ? { instructions } : {}),
              ...(tools.length ? { tools } : {}),
              stream: true,
              text: {
                ...(this.invoke.text ?? {}),
                ...(input.outputSchema
                  ? {
                      // biome-ignore lint/suspicious/noExplicitAny: needs to be general
                      format: zodTextFormat(input.outputSchema as any, 'event'),
                    }
                  : {}),
              },
            });

            let textAccumulator = '';
            let inputTokens = 0;
            let outputTokens = 0;
            let incomplete = false;
            const completedFunctionCalls: ToolCallMessageContent[] = [];

            for await (const event of responseStream) {
              const e = event as OpenAI.Responses.ResponseStreamEvent;

              if (e.type === 'response.output_text.delta') {
                textAccumulator += e.delta;
                await onEvent({ type: 'text_delta', delta: e.delta });
              }

              if (e.type === 'response.output_item.done') {
                const item = e.item;
                if (item.type === 'function_call') {
                  let args: Record<string, unknown> = {};
                  try {
                    args = JSON.parse(item.arguments || '{}') as Record<string, unknown>;
                  } catch {
                    await onEvent({
                      type: 'error',
                      message: `Failed to parse arguments for tool '${item.name}' (id: ${item.call_id})`,
                    });
                  }
                  const tc: ToolCallMessageContent = {
                    type: 'tool_call',
                    id: item.call_id,
                    name: item.name,
                    args,
                  };
                  completedFunctionCalls.push(tc);
                  await onEvent({ type: 'tool_call', id: item.call_id, name: item.name, args });
                }
              }

              if (e.type === 'response.completed') {
                const usage = e.response.usage;
                if (usage) {
                  inputTokens = usage.input_tokens;
                  outputTokens = usage.output_tokens;
                }
              }

              if (e.type === 'response.incomplete') {
                incomplete = true;
              }

              if (e.type === 'response.failed') {
                throw new Error(e.response.error?.message ?? 'OpenAI response failed');
              }
            }

            totalInputTokens += inputTokens;
            totalOutputTokens += outputTokens;
            input.budget.record({
              iterations: 1,
              tokens: { input: inputTokens, output: outputTokens },
            });

            if (incomplete) {
              if (textAccumulator) {
                messages.push({
                  role: 'assistant',
                  content: [{ type: 'text', text: textAccumulator }],
                });
              }
              return finalise({
                stopReason: 'budget_exhausted',
                error: new Error('OpenAI max_output_tokens limit reached — response truncated'),
                messages,
              });
            }

            if (completedFunctionCalls.length) {
              const assistantContent: MessageContent[] = [];
              if (textAccumulator) assistantContent.push({ type: 'text', text: textAccumulator });
              assistantContent.push(...completedFunctionCalls);
              return finalise({
                stopReason: 'tool_use',
                message: { role: 'assistant', content: assistantContent },
              });
            }

            // Text response (or empty)
            if (!input.outputSchema) {
              return finalise({
                stopReason: 'end_turn',
                message: {
                  role: 'assistant',
                  content: textAccumulator ? [{ type: 'text', text: textAccumulator }] : [],
                },
              });
            }

            // Schema validation loop
            const schemaReminder = JSON.stringify(
              // biome-ignore lint/suspicious/noExplicitAny: required for zod schema coercion
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
                    content: [{ type: 'json', data: parsed }],
                  },
                });
              }
              correctionText = `Your response did not conform to the required output schema. Please correct it.\n\nValidation error: ${validation.error.message}`;
              messages.push({
                role: 'assistant',
                content: [{ type: 'json', data: JSON.parse(textAccumulator) as JsonAble }],
              });
            } catch {
              correctionText =
                'Your response was not valid JSON. Please respond with a valid JSON object matching the required schema.';
              messages.push({
                role: 'assistant',
                content: [{ type: 'text', text: textAccumulator }],
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
