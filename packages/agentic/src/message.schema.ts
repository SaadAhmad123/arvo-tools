import { z } from 'zod';
import { AnyContentTypeSchema } from './schema';

export const TextMessageContentSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const MediaMessageContentSchema = z.object({
  type: z.literal('media'),
  contentType: AnyContentTypeSchema,
  source: z.literal('base64'),
  data: z.string(),
});

export const ToolCallMessageContentSchema = z.object({
  type: z.literal('tool_call'),
  id: z.string(),
  name: z.string(),
  args: z.record(z.unknown()),
});

export const ToolResultMessageContentSchema = z.object({
  type: z.literal('tool_result'),
  id: z.string(),
  isError: z.boolean(),
  content: z.array(z.union([TextMessageContentSchema, MediaMessageContentSchema])),
});

export const JsonMessageContentSchema = z.object({
  type: z.literal('json'),
  data: z.record(z.any()),
});

export const MessageContentSchema = z.discriminatedUnion('type', [
  TextMessageContentSchema,
  MediaMessageContentSchema,
  ToolCallMessageContentSchema,
  ToolResultMessageContentSchema,
  JsonMessageContentSchema,
]);

export const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.array(MessageContentSchema),
});
