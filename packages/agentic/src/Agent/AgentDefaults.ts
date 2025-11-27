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

export const AgentDefaults = {
  INIT_SCHEMA: z.object({
    message: z.string().describe('The input message to the agent'),
  }),
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
  COMPLETE_SCHEMA: z.object({
    response: z.string().describe('The output response of the agent'),
  }),
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
  OUTPUT_BUILDER: ((param) => {
    return {
      data: {
        response: param.content,
      },
    };
  }) as AgentOutputBuilder,
} as const;
