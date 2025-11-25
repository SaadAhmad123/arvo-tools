import z from 'zod';

export const AgentTextContentSchema = z.object({
  type: z.literal('text'),
  content: z.string(),
});

export const AgentMediaContentSchema = z.object({
  type: z.literal('media'),
  content: z.string(),
  contentType: z.discriminatedUnion('type', [
    z.object({
      filename: z.string(),
      filetype: z.string(),
      type: z.literal('image'),
      format: z.enum(['base64']),
    }),
    z.object({
      filename: z.string(),
      filetype: z.string(),
      type: z.literal('file'),
      format: z.enum(['base64']),
    }),
  ]),
});

export const AgentToolResultContentSchema = z.object({
  type: z.literal('tool_result'),
  toolUseId: z.string(),
  content: z.string(),
});

export const AgentToolCallContentSchema = z.object({
  type: z.literal('tool_use'),
  toolUseId: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.any()),
});

export const AgentMessageContentSchema = z.discriminatedUnion('type', [
  AgentTextContentSchema,
  AgentMediaContentSchema,
  AgentToolResultContentSchema,
  AgentToolCallContentSchema,
]);

export const AgentMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: AgentMessageContentSchema,
});
