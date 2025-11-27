import type { ChatCompletionMessageParam } from 'openai/resources/index.mjs';
import type { AgentToolResultContent } from '../../Agent/types';
import type { AgentLLMIntegrationParam } from '../types';

/**
 * Internal Adapter: Maps Arvo's generic Agent Message format to OpenAI's specific API format.
 *
 * Handles:
 * - System Prompt injection.
 * - Mapping Tool Results to their originating Tool Call IDs.
 * - Multimodal Content (converting Arvo media objects to OpenAI Image/File URLs).
 * - Reconstructs the specific message ordering OpenAI expects (User -> Assistant(ToolCall) -> Tool(Result)).
 */
export const formatMessagesForOpenAI = (
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
      } else if (
        message.content.type === 'media' &&
        message.content.contentType.type === 'image' &&
        message.content.contentType.format === 'base64'
      ) {
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
      } else if (
        message.content.type === 'media' &&
        message.content.contentType.type === 'file' &&
        message.content.contentType.format === 'base64'
      ) {
        formattedMessages.push({
          role: 'user',
          content: [
            {
              type: 'file',
              file: {
                filename: message.content.contentType.name,
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
