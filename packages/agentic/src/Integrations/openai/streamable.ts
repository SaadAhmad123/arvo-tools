import type { Span } from '@opentelemetry/api';
import { getOtelHeaderFromSpan, logToSpan } from 'arvo-core';
import type OpenAI from 'openai';
import type { AzureOpenAI } from 'openai';
import type { AgentEventStreamer } from '../../Agent/stream/types';
import type { AgentToolCallContent } from '../../Agent/types';
import type { AgentLLMIntegrationOutput, LLMExecutionResult } from '../types';

export const streamableOpenAI = async <TClient extends OpenAI | AzureOpenAI>(
  client: TClient,
  param: Parameters<TClient['chat']['completions']['create']>[0] & { stream: true },
  config: {
    span: Span;
    onStream: AgentEventStreamer;
  },
): Promise<LLMExecutionResult> => {
  const otelHeaders = getOtelHeaderFromSpan(config.span);
  const stream = await client.chat.completions.create(param);

  const toolRequests: Omit<AgentToolCallContent, 'type'>[] = [];
  let finalResponse = '';
  let finishReason: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  const toolCallsMap: Map<
    number,
    {
      id: string;
      name: string;
      arguments: string;
    }
  > = new Map();

  for await (const chunk of stream) {
    const choice = chunk.choices[0];

    if (chunk.usage) {
      inputTokens += chunk.usage.prompt_tokens ?? 0;
      outputTokens += chunk.usage.completion_tokens ?? 0;
    }

    if (!choice) continue;

    if (choice.delta?.content) {
      finalResponse += choice.delta.content;
      config.onStream({
        type: 'agent.llm.delta.text',
        data: {
          comment: 'Generating response',
          content: finalResponse,
          delta: choice.delta.content,
          meta: {
            error: null,
            token: {
              prompt: inputTokens,
              completion: outputTokens,
            },
            otel: otelHeaders,
          },
        },
      });
    }

    if (choice.delta?.tool_calls) {
      for (const toolCall of choice.delta.tool_calls) {
        const index = toolCall.index;

        const existingCall = toolCallsMap.get(index) ?? {
          id: toolCall.id ?? '',
          name: toolCall.function?.name ?? '',
          arguments: '',
        };

        // This is being built dynamically so need to add these things
        if (toolCall.id) {
          existingCall.id = toolCall.id;
        }

        if (toolCall.function?.name) {
          existingCall.name = toolCall.function.name;
          config.onStream({
            type: 'agent.llm.delta.tool',
            data: {
              comment: `Preparing tool call \`${existingCall.name}\``,
              toolname: existingCall.name,
              toolUseId: existingCall.id,
              input: existingCall.arguments,
              meta: {
                error: null,
                token: {
                  prompt: inputTokens,
                  completion: outputTokens,
                },
                otel: otelHeaders,
              },
            },
          });
        }

        if (toolCall.function?.arguments) {
          existingCall.arguments += toolCall.function.arguments;
          config.onStream({
            type: 'agent.llm.delta.tool',
            data: {
              comment: `Preparing tool call \`${existingCall.name}\``,
              toolname: existingCall.name,
              toolUseId: existingCall.id,
              input: existingCall.arguments,
              meta: {
                error: null,
                token: {
                  prompt: inputTokens,
                  completion: outputTokens,
                },
                otel: otelHeaders,
              },
            },
          });
        }

        toolCallsMap.set(index, existingCall);
      }
    }

    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
      config.onStream({
        type: 'agent.llm.delta',
        data: {
          finishReason,
          comment: 'Generating response',
          meta: {
            error: null,
            token: {
              prompt: inputTokens,
              completion: outputTokens,
            },
            otel: otelHeaders,
          },
        },
      });
    }
  }

  for (const [_, toolCall] of toolCallsMap) {
    try {
      toolRequests.push({
        name: toolCall.name,
        toolUseId: toolCall.id,
        input: JSON.parse(toolCall.arguments) as Record<string, unknown>,
      });
    } catch (e) {
      config.onStream({
        type: 'agent.llm.delta.tool',
        data: {
          comment: `Skipping tool call ${toolCall.name} due to technical issues.`,
          toolname: toolCall.name,
          input: toolCall.arguments,
          toolUseId: toolCall.id,
          meta: {
            error: (e as Error).message,
            token: {
              prompt: inputTokens,
              completion: outputTokens,
            },
            otel: otelHeaders,
          },
        },
      });
      logToSpan(
        {
          level: 'WARNING',
          message: `Failed to parse tool call arguments for tool '${toolCall.name}' (id: ${toolCall.id}). Tool call will be dropped. Error: ${(e as Error).message}`,
        },
        config.span,
      );
    }
  }

  const llmUsage: NonNullable<AgentLLMIntegrationOutput['usage']> = {
    tokens: {
      prompt: inputTokens,
      completion: outputTokens,
    },
  };

  if (toolRequests.length) {
    return {
      toolRequests,
      response: null,
      usage: llmUsage,
    };
  }

  let processedResponse = finalResponse;

  if (finishReason === 'length') {
    logToSpan(
      {
        level: 'WARNING',
        message: 'Max token limit reached. Response truncated',
      },
      config.span,
    );

    if (finalResponse) {
      processedResponse = `${finalResponse}\n\n[Response truncated: Maximum token limit reached]`;
    } else {
      processedResponse = '[Response truncated: Maximum token limit reached]';
    }
  }

  if (finishReason === 'content_filter') {
    logToSpan(
      {
        level: 'WARNING',
        message: 'Content filtered by OpenAI',
      },
      config.span,
    );

    processedResponse = processedResponse
      ? `${processedResponse}\n\n[Request blocked due to OpenAI content filtering policies]`
      : '[Request blocked due to OpenAI content filtering policies]';
  }

  return {
    toolRequests: null,
    response: processedResponse,
    usage: llmUsage,
  };
};
