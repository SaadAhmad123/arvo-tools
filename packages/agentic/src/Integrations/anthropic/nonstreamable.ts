import type Anthropic from '@anthropic-ai/sdk';
import type { Span } from '@opentelemetry/api';
import { logToSpan } from 'arvo-core';
import type { AgentToolCallContent } from '../../Agent/types';
import type { AgentLLMIntegrationOutput, LLMExecutionResult } from '../types';

export const nonStreamableAnthropic = async (
  client: Anthropic,
  param: Anthropic.MessageCreateParamsNonStreaming,
  config: {
    span: Span;
  },
): Promise<LLMExecutionResult> => {
  const response = await client.messages.create(param);

  const llmUsage: NonNullable<AgentLLMIntegrationOutput['usage']> = {
    tokens: {
      prompt: response.usage.input_tokens,
      completion: response.usage.output_tokens,
    },
  };

  const toolUseBlocks = response.content.filter(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );

  if (toolUseBlocks.length > 0) {
    const toolRequests: Omit<AgentToolCallContent, 'type'>[] = [];
    for (const toolCall of toolUseBlocks) {
      toolRequests.push({
        toolUseId: toolCall.id,
        name: toolCall.name,
        input: toolCall.input as Record<string, unknown>,
      });
    }
    return {
      toolRequests,
      response: null,
      usage: llmUsage,
    };
  }

  const textBlocks = response.content.filter(
    (block): block is Anthropic.TextBlock => block.type === 'text',
  );
  let content = textBlocks.map((block) => block.text).join('');

  if (response.stop_reason === 'max_tokens') {
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

  return {
    toolRequests: null,
    response: content,
    usage: llmUsage,
  };
};
