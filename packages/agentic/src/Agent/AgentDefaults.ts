import type { ArvoSemanticVersion } from 'arvo-core';
import { v4 } from 'uuid';
import z from 'zod';
import type { AgentInternalTool } from '../AgentTool/types.js';
import type { PromiseAble } from '../types.js';
import type {
  AgentContextBuilder,
  AgentMessage,
  AgentOutputBuilder,
  AgentServiceContract,
  AnyArvoOrchestratorContract,
} from './types.js';

/**
 * Creates a Zod schema validator for base64-encoded data URLs with MIME type restrictions.
 *
 * Validates that strings match the data URL format (data:mime/type;base64,encodedContent)
 * and optionally restricts to specific MIME types.
 *
 * @example
 * ```typescript
 * const imageSchema = dataUrlString(['image/jpeg', 'image/png']);
 * imageSchema.parse('data:image/jpeg;base64,/9j/4AAQ...'); // Valid
 * imageSchema.parse('data:application/pdf;base64,...');     // Throws - wrong MIME type
 * ```
 */
export const dataUrlString = (allowedMimeTypes: string[]) =>
  z.string().refine(
    (val) => {
      const match = val.match(/^data:([^;]+);base64,/);
      if (!match) return false;
      if (allowedMimeTypes && !allowedMimeTypes.includes(match[1])) return false;
      return true;
    },
    {
      message: allowedMimeTypes
        ? `Must be a valid data URL with one of these MIME types: ${allowedMimeTypes.join(', ')}`
        : 'Must be a valid data URL (e.g., data:<mime-type>;base64,...)',
    },
  );

/**
 * Default schemas and builders for common agent patterns.
 *
 * Provides ready-to-use implementations for typical agent configurations,
 * reducing boilerplate while remaining customizable. Use these defaults
 * to get started quickly, then customize as needed for specific use cases.
 */
export const AgentDefaults = {
  /**
   * Default initialization schema accepting a simple text message.
   *
   * Use for basic conversational agents that only need text input.
   */
  INIT_SCHEMA: z.object({
    message: z.string().describe('The input message to the agent'),
  }),
  /**
   * Multimodal initialization schema supporting text, images, and PDFs.
   *
   * Accepts base64-encoded images (JPEG, PNG, GIF, WebP) and PDF documents
   * alongside the text message. Media content is visible to the LLM only once
   * and should be extracted into conversation history via internal tools
   * if needed for later reference.
   *
   * @remarks
   * The media masking optimization automatically replaces viewed media with
   * placeholder text in subsequent LLM calls to reduce token consumption.
   */
  INIT_MULTIMODAL_SCHEMA: z.object({
    message: z.string().describe('The input message to the agent'),
    imageBase64: dataUrlString(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
      .array()
      .optional()
      .describe(
        'An optional list of base64 image strings to read. An AI Agent must not send data via this field',
      ),
    pdfBase64: dataUrlString(['application/pdf'])
      .array()
      .optional()
      .describe(
        'An optional list of base64 pdfs to read. An AI Agent must not send data via this field',
      ),
  }),
  /**
   * Default completion schema outputting a simple text response.
   *
   * Use when agents produce conversational text rather than structured data.
   */
  COMPLETE_SCHEMA: z.object({
    response: z.string().describe('The output response of the agent'),
  }),
  /**
   * Default context builder transforming initialization events into LLM context.
   *
   * Converts the message field into a user message and processes any attached
   * media (images, PDFs) into the conversation history (Assumes the media
   * content to be base64 - ArvoAgent always assumes this internally). Accepts an optional
   * system prompt builder function that receives initialization parameters
   * and available tools for dynamic prompt construction.
   *
   * @param systemPromptBuilder - Optional function returning the system prompt.
   *                              Receives input event, tools catalog, and contract reference.
   *
   * @returns Context builder function compatible with agent handler configuration
   *
   * @example
   * ```typescript
   * context: AgentDefaults.CONTEXT_BUILDER(({ tools, input }) =>
   *   `You are a helpful agent. Use ${tools.tools.dateTool.name} for dates.`
   * )
   * ```
   */
  CONTEXT_BUILDER:
    <
      T extends AnyArvoOrchestratorContract,
      V extends ArvoSemanticVersion,
      TServiceContract extends Record<string, AgentServiceContract>,
      TTools extends Record<string, AgentInternalTool>,
    >(
      systemPromptBuilder?: (
        param: Parameters<AgentContextBuilder<T, V, TServiceContract, TTools>>[0],
      ) => PromiseAble<string>,
    ): AgentContextBuilder<T, V, TServiceContract, TTools> =>
    async (param) => {
      const messages: AgentMessage[] = [
        {
          role: 'user',
          content: { type: 'text', content: param.input.data.message },
          seenCount: 0,
        },
      ];

      for (const item of param.input.data.pdfBase64 ?? []) {
        messages.push({
          seenCount: 0,
          role: 'user',
          content: {
            type: 'media',
            content: item,
            contentType: {
              format: 'base64',
              type: 'file',
              name: `${v4()}.pdf`,
              mediatype: 'application/pdf',
            },
          },
        });
      }

      for (const item of param.input.data.imageBase64 ?? []) {
        messages.push({
          seenCount: 0,
          role: 'user',
          content: {
            type: 'media',
            content: item,
            contentType: {
              format: 'base64',
              type: 'image',
              name: `${v4()}.png`,
              mediatype: 'image/png',
            },
          },
        });
      }

      return {
        system: (await systemPromptBuilder?.(param)) ?? null,
        messages,
      };
    },
  /**
   * Default output builder validating agent responses against contract schemas.
   *
   * Handles both text and JSON output modes. For text mode, wraps the LLM's
   * response in the default complete schema structure. For JSON mode, validates
   * parsed content against the output format schema.
   *
   * @remarks
   * Returns either `{ data: validatedOutput }` on success or `{ error: validationError }`
   * on failure. Validation errors trigger the feedback manager's self-correction loop,
   * allowing the LLM to fix malformed outputs.
   */
  OUTPUT_BUILDER: ((param) => {
    if (param.type === 'json') {
      const { error, data } = param.outputFormat.safeParse(param.parsedContent ?? {});
      return error ? { error } : { data };
    }
    if (param.type === 'text') {
      return {
        data: {
          response: param.content,
        },
      };
    }
    return { error: new Error('The final output must be output format compliant only') };
  }) as AgentOutputBuilder,
} as const;
