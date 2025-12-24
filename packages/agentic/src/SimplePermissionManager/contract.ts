import { cleanString, createSimpleArvoContract } from 'arvo-core';
import z from 'zod';

/**
 * Default permission contract for simple approval workflows.
 */
export const simplePermissionContract = createSimpleArvoContract({
  uri: '#/arvo/tools/default/agentic/permission/simple',
  type: 'arvo.default.simple.permission.request',
  description: 'Simple permission request contract for agent tool authorization',
  versions: {
    '1.0.0': {
      accepts: z.object({
        agentId: z.string().describe('The agent requesting permission'),
        requestedTools: z.array(z.string()).describe('Tool names requiring authorization'),
        reason: z.string().describe('Explanation of why these tools are needed'),
        toolMetaData: z.record(
          z.string(),
          z.object({
            name: z.string(),
            originalName: z.string(),
            kind: z.string(),
            requests: z.record(z.any()).array().nullable(),
          }),
        ),
      }),
      emits: z.object({
        commentary: z
          .string()
          .optional()
          .default(
            cleanString(`
              In case the same tool appears in granted and denied list, then consider it denied. 
              If the permission blocked tools does not appear in the granted list, the consider it denied as well   
            `),
          ),
        granted: z.array(z.string()).describe('Tool names that were granted permission'),
        denied: z.array(z.string()).describe('Tool names that were denied permission'),
      }),
    },
  },
});
