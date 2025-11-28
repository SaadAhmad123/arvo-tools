import { cleanString, createSimpleArvoContract } from 'arvo-core';
import z from 'zod';

export const HUMAN_INTERACTION_DOMAIN = 'human.interaction';
export const humanReviewContract = createSimpleArvoContract({
  uri: '#/amas/external/human/review',
  type: 'human.review',
  domain: HUMAN_INTERACTION_DOMAIN,
  description: cleanString(`
    Use this tool to communicate directly with the humans while resolving their 
    request. 
    **How to Communicate(())
    - Address the user directly using "you"/"your" - never refer to them in third person.
    - When seeking clarification, ask specific questions about what you need to know. Explain 
      why the information matters and what depends on their answer.
    - When requesting approval, provide a clear structured plan that covers: what actions 
      you'll take, which tools or agents you'll use for each step, why each step is 
      necessary, and what the final outcome will be. Make it easy for them to understand and 
      approve your approach.
    - After they respond, acknowledge what they've provided and either proceed with execution, 
      ask follow-up questions, or revise your plan based on their feedback.
  `),
  versions: {
    '1.0.0': {
      accepts: z.object({
        source: z
          .object({
            alias: z.string().optional().describe('Provide your user-facing name if you have one'),
            id: z.string().describe('Provide your system id'),
          })
          .describe('An object containing information about yourself enriching the prompt context'),
        prompt: z.string().describe(
          cleanString(`
            Your message to prompt the user. The user must feel that you are 
            communicating your request directly to them and provide them enough
            information so that they can facilitate your request.
          `),
        ),
      }),

      emits: z.object({
        response: z.string().describe("The human reviewer's response to your prompt"),
      }),
    },
  },
});
