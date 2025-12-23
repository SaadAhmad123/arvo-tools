import { createSimpleArvoContract } from 'arvo-core';
import z from 'zod';

export const humanApprovalContract = createSimpleArvoContract({
  uri: '#/org/amas/external/human_approval',
  type: 'human.approval',
  domain: 'human.interaction',
  description: 'This is a service which gets approval from the human based on the provided prompt',
  versions: {
    '1.0.0': {
      accepts: z.object({
        prompt: z.string(),
      }),
      emits: z.object({
        approval: z.boolean(),
      }),
    },
  },
});
