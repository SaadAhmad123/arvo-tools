import type { z } from 'zod';
import type {
  JsonMessageContentSchema,
  MediaMessageContentSchema,
  MessageContentSchema,
  MessageSchema,
  TextMessageContentSchema,
  ToolCallMessageContentSchema,
  ToolResultMessageContentSchema,
} from './message.schema';
import type { JsonAble } from './types';

export type TextMessageContent = z.infer<typeof TextMessageContentSchema>;
export type MediaMessageContent = z.infer<typeof MediaMessageContentSchema>;
export type ToolCallMessageContent = z.infer<typeof ToolCallMessageContentSchema>;
export type ToolResultMessageContent = z.infer<typeof ToolResultMessageContentSchema>;

/** `data` is inferred as `Record<string, any>` from the schema; cast to {@link JsonAble} at use sites. */
export type JsonMessageContent = Omit<z.infer<typeof JsonMessageContentSchema>, 'data'> & {
  data: JsonAble;
};

export type MessageContent = z.infer<typeof MessageContentSchema>;
export type MessageRole = z.infer<typeof MessageSchema>['role'];
export type Message = z.infer<typeof MessageSchema>;
