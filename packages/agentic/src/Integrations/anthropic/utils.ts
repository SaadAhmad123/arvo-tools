import type Anthropic from '@anthropic-ai/sdk';
import type { AgentToolResultContent } from '../../Agent/types';
import type { AgentLLMIntegrationParam } from '../types';

/**
 * Internal Adapter: Maps Arvo's generic Agent Message format to Anthropic's specific API format.
 *
 * Handles:
 * - Mapping Tool Results to their originating Tool Call IDs.
 * - Multimodal Content (converting Arvo media objects to Anthropic Image source format).
 * - Reconstructs the specific message ordering Anthropic expects (User -> Assistant(ToolUse) -> User(ToolResult)).
 *
 * Note: Anthropic does not use a system message in the messages array - it's passed separately.
 */
export const formatMessagesForAnthropic = (
  messages: AgentLLMIntegrationParam['messages'],
): Anthropic.MessageParam[] => {
  const formattedMessages: Anthropic.MessageParam[] = [];
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
        const { mediaType, base64Data } = parseMediaContent(message.content.content);
        formattedMessages.push({
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType as Anthropic.Base64ImageSource['media_type'],
                data: base64Data,
              },
            },
          ],
        });
      } else if (
        message.content.type === 'media' &&
        message.content.contentType.type === 'file' &&
        message.content.contentType.format === 'base64' &&
        message.content.contentType.mediatype === 'application/pdf'
      ) {
        const { base64Data } = parseMediaContent(message.content.content);
        formattedMessages.push({
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: base64Data,
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
          content: [
            {
              type: 'tool_use',
              id: message.content.toolUseId,
              name: message.content.name,
              input: message.content.input,
            },
          ],
        });
        const toolResult = toolResponseMap[message.content.toolUseId];
        formattedMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.content.toolUseId,
              content: toolResult?.content ?? JSON.stringify({ error: 'No tool response' }),
            },
          ],
        });
      }
    }
  }

  return formattedMessages;
};

/**
 * Parses media content from either a data URL or raw base64 string.
 *
 * @param content - The media content string (data URL or raw base64)
 * @returns Object containing the media type and base64 data
 */
const parseMediaContent = (content: string): { mediaType: string; base64Data: string } => {
  // Check if it's a data URL
  const dataUrlMatch = content.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUrlMatch) {
    return {
      mediaType: dataUrlMatch[1],
      base64Data: dataUrlMatch[2],
    };
  }

  // Assume it's raw base64 with a default media type
  return {
    mediaType: 'image/png',
    base64Data: content,
  };
};
