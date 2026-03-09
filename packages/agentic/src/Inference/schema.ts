import { cleanString } from 'arvo-core';
import z from 'zod';

export const InferenceJsonContentSchema = z.object({
  type: z.literal('json'),
  content: z.string(),
  parsed: z.string().nullable(),
  error: z
    .string()
    .nullable()
    .describe(
      cleanString(`
      Return the error if the content returned by the 
      inference in not a valid JSON so that this error 
      can be fed back into the agent loop.
    `),
    ),
});

export const InferenceTextContentSchema = z.object({
  type: z.literal('text'),
  content: z.string(),
});

export const InferenceMediaContentSchema = z.object({
  type: z.literal('media'),
  content: z.string(),
  name: z.string(),
  mediatype: z.string(),
  contenttype: z.enum(['image', 'video', 'audio', 'file']),
  format: z.literal('base64'),
});

export const InferenceToolResultContentSchema = z.object({
  type: z.literal('tool_result'),
  toolUseId: z.string(),
  content: z.string(),
});

export const InferenceToolCallContentSchema = z.object({
  type: z.literal('tool_use'),
  toolUseId: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.any()),
});

export const InferenceMessageContentSchema = z.discriminatedUnion('type', [
  InferenceJsonContentSchema,
  InferenceTextContentSchema,
  InferenceMediaContentSchema,
  InferenceToolResultContentSchema,
  InferenceToolCallContentSchema,
]);

export const InferenceMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: InferenceMessageContentSchema,
  seenCount: z.number().describe('Then number of time the LLM integration has seen this message'),
});

export const InferenceOutputSchema = z.object({
  toolcalls: InferenceToolCallContentSchema.array(),
  complete: z
    .discriminatedUnion('type', [
      InferenceJsonContentSchema,
      InferenceTextContentSchema,
      InferenceMediaContentSchema,
    ])
    .nullable(),
  tokens: z.object({
    prompt: z.number(),
    completion: z.number(),
  }),
});
