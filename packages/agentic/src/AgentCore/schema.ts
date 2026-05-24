import { z } from 'zod';

export const TextDeltaStreamEventSchema = z.object({
  type: z.literal('text_delta'),
  delta: z.string(),
});

export const ThinkingDeltaStreamEventSchema = z.object({
  type: z.literal('thinking_delta'),
  delta: z.string(),
});

export const ToolCallStreamEventSchema = z.object({
  type: z.literal('tool_call'),
  id: z.string(),
  name: z.string(),
  args: z.record(z.unknown()),
});

export const SchemaRetryStreamEventSchema = z.object({
  type: z.literal('schema_retry'),
  attempt: z.number().int().positive(),
  validationError: z.string(),
});

export const ErrorStreamEventSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
});

export const StreamEventSchema = z.discriminatedUnion('type', [
  TextDeltaStreamEventSchema,
  ThinkingDeltaStreamEventSchema,
  ToolCallStreamEventSchema,
  SchemaRetryStreamEventSchema,
  ErrorStreamEventSchema,
]);
