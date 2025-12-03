import type { Span } from '@opentelemetry/api';
import { logToSpan } from 'arvo-core';
import type OpenAI from 'openai';
import type { AzureOpenAI } from 'openai';
import type { ChatCompletionMessageFunctionToolCall } from 'openai/resources.js';
import type { AgentToolCallContent } from '../../Agent/types';
import type { AgentLLMIntegrationOutput, LLMExecutionResult } from '../types';

export const nonStreamableOpenAI = async <TClient extends OpenAI | AzureOpenAI>(
  client: TClient,
  param: Parameters<TClient['chat']['completions']['create']>[0] & { stream: false },
  config: {
    span: Span;
  },
): Promise<LLMExecutionResult> => {
  const completion = await client.chat.completions.create(param);

  const choice = completion.choices[0];
  const llmUsage: NonNullable<AgentLLMIntegrationOutput['usage']> = {
    tokens: {
      prompt: completion.usage?.prompt_tokens ?? 0,
      completion: completion.usage?.completion_tokens ?? 0,
    },
  };

  if (choice?.message?.tool_calls) {
    const toolRequests: Omit<AgentToolCallContent, 'type'>[] = [];
    for (const toolCall of choice.message.tool_calls as ChatCompletionMessageFunctionToolCall[]) {
      try {
        toolRequests.push({
          toolUseId: toolCall.id,
          name: toolCall.function.name,
          input: JSON.parse(toolCall.function.arguments) as Record<string, unknown>,
        });
      } catch (e) {
        logToSpan(
          {
            level: 'WARNING',
            message: `Failed to parse tool call arguments for tool '${toolCall.function.name}' (id: ${toolCall.id}). Tool call will be dropped. Error: ${(e as Error).message}`,
          },
          config.span,
        );
      }
    }

    if (toolRequests.length) {
      return {
        toolRequests,
        response: null,
        usage: llmUsage,
      };
    }
  }

  let content = choice?.message?.content ?? '';

  if (choice.finish_reason === 'length') {
    content = content
      ? `${content}\n\n[Response truncated: Maximum token limit reached]`
      : '[Response truncated: Maximum token limit reached]';

    logToSpan(
      {
        level: 'WARNING',
        message: 'Max token limit reached. Response truncated',
      },
      config.span,
    );
  }

  if (choice.finish_reason === 'content_filter') {
    content = `${content}\n\n[Request blocked due to OpenAI content filtering policies]`;

    logToSpan(
      {
        level: 'WARNING',
        message: 'Content filtered by OpenAI',
      },
      config.span,
    );
  }

  return {
    toolRequests: null,
    response: content,
    usage: llmUsage,
  };
};
