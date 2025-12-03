import type Anthropic from '@anthropic-ai/sdk';
import type { Span } from '@opentelemetry/api';
import { getOtelHeaderFromSpan, logToSpan } from 'arvo-core';
import type { AgentEventStreamer } from '../../Agent/stream/types';
import type { AgentToolCallContent } from '../../Agent/types';
import type { AgentLLMIntegrationOutput, LLMExecutionResult } from '../types';

export const streamableAnthropic = async (
  client: Anthropic,
  param: Anthropic.MessageCreateParamsStreaming,
  config: {
    span: Span;
    onStream: AgentEventStreamer;
  },
): Promise<LLMExecutionResult> => {
  const otelHeaders = getOtelHeaderFromSpan(config.span);
  const stream = await client.messages.create(param);

  const toolRequests: Omit<AgentToolCallContent, 'type'>[] = [];
  let finalResponse = '';
  let stopReason: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  const toolUseBlocks: Map<number, { id: string; name: string; input: string }> = new Map();

  for await (const event of stream) {
    if (event.type === 'message_start') {
      inputTokens = event.message.usage.input_tokens;
      outputTokens = event.message.usage.output_tokens;
    } else if (event.type === 'content_block_start') {
      if (event.content_block.type === 'tool_use') {
        toolUseBlocks.set(event.index, {
          id: event.content_block.id,
          name: event.content_block.name,
          input: '',
        });
      }
    } else if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        finalResponse += event.delta.text;
        config.onStream({
          type: 'agent.llm.delta.text',
          data: {
            comment: 'Generating response',
            content: finalResponse,
            delta: event.delta.text,
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
      } else if (event.delta.type === 'input_json_delta') {
        const block = toolUseBlocks.get(event.index);
        if (block) {
          block.input += event.delta.partial_json;
          config.onStream({
            type: 'agent.llm.delta.tool',
            data: {
              comment: `Preparing tool call \`${block.name}\``,
              toolname: block.name,
              toolUseId: block.id,
              input: block.input,
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
    } else if (event.type === 'content_block_stop') {
      const block = toolUseBlocks.get(event.index);
      if (block) {
        try {
          toolRequests.push({
            name: block.name,
            toolUseId: block.id,
            input: JSON.parse(block.input) as object,
          });
        } catch (e) {
          config.onStream({
            type: 'agent.llm.delta.tool',
            data: {
              comment: `Skipping tool call ${block.name} due to technical issues.`,
              toolname: block.name,
              input: block.input,
              toolUseId: block.id,
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
              message: `Failed to parse tool call input for tool '${block.name}' (id: ${block.id}). Tool call will be dropped. Error: ${(e as Error).message}`,
            },
            config.span,
          );
        }
        toolUseBlocks.delete(event.index);
      }
    } else if (event.type === 'message_delta') {
      stopReason = event.delta.stop_reason ?? stopReason;
      outputTokens += event.usage.output_tokens;
      config.onStream({
        type: 'agent.llm.delta',
        data: {
          comment: 'Generating response',
          finishReason: stopReason,
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

  if (stopReason === 'max_tokens') {
    logToSpan(
      {
        level: 'WARNING',
        message: 'Max token limit reached. Response truncated',
      },
      config.span,
    );
  }

  if (stopReason === 'max_tokens' && finalResponse) {
    processedResponse = `${finalResponse}\n\n[Response truncated: Maximum token limit reached]`;
  } else if (!finalResponse && stopReason === 'max_tokens') {
    processedResponse = '[Response truncated: Maximum token limit reached]';
  }

  return {
    toolRequests: null,
    response: processedResponse,
    usage: llmUsage,
  };
};
