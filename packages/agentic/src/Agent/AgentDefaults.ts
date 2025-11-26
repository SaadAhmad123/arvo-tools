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

export const AgentDefaults = {
  INIT_SCHEMA: z.object({
    message: z.string().describe('The input message to the agent'),
    imageBase64: z
      .string()
      .array()
      .optional()
      .describe(
        'An optional list of base64 image strings to read. Must not be added by an AI Agent',
      ),
    pdfBase64: z
      .string()
      .array()
      .optional()
      .describe('An optional list of base64 pngs to read. Must not be added by an AI Agent'),
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
              filename: `${v4()}.pdf`,
              filetype: 'pdf',
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
              filename: `${v4()}.png`,
              filetype: 'png',
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
