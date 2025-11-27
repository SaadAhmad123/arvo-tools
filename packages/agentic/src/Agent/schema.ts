import z from 'zod';

/** Zod schema for standard text content within a message. */
export const AgentTextContentSchema = z.object({
  type: z.literal('text'),
  content: z.string(),
});

/** Zod schema for multimodal inputs (Images, PDFs, Files) encoded as Base64. */
export const AgentMediaContentSchema = z.object({
  type: z.literal('media'),
  content: z.string(),
  contentType: z.discriminatedUnion('type', [
    z.object({
      name: z.string(),
      mediatype: z.string(),
      type: z.literal('image'),
      format: z.enum(['base64']),
    }),
    z.object({
      name: z.string(),
      mediatype: z.string(),
      type: z.literal('file'),
      format: z.enum(['base64']),
    }),
  ]),
});

/** Zod schema for the output of a tool execution, correlated by ID to a specific tool call. */
export const AgentToolResultContentSchema = z.object({
  type: z.literal('tool_result'),
  toolUseId: z.string(),
  content: z.string(),
});

/** Zod schema representing an LLM's request to execute a named tool with specific arguments. */
export const AgentToolCallContentSchema = z.object({
  type: z.literal('tool_use'),
  toolUseId: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.any()),
});

/** Discriminated union of all valid payload types (Text, Media, Tool Calls, and Results). */
export const AgentMessageContentSchema = z.discriminatedUnion('type', [
  AgentTextContentSchema,
  AgentMediaContentSchema,
  AgentToolResultContentSchema,
  AgentToolCallContentSchema,
]);

/** The primary data structure representing a single turn in the Agent's conversation history. */
export const AgentMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: AgentMessageContentSchema,
  seenCount: z.number().describe('Then number of time the LLM integration has seen this message'),
});
