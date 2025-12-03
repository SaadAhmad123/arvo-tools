import type { AgentMessage } from '../Agent/types';
import type { CommonIntegrationConfig } from './types';

export const defaultContextTransformer: NonNullable<
  CommonIntegrationConfig['contextTransformer']
> = async ({ messages, system }) => ({
  messages: messages.map((item) => {
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
  system: system,
});
