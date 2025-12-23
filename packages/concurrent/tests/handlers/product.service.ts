import { createSimpleArvoContract } from 'arvo-core';
import { createArvoEventHandler, type EventHandlerFactory } from 'arvo-event-handler';
import { z } from 'zod';

export const productContract = createSimpleArvoContract({
  uri: '#/org/amas/calculator/product',
  type: 'calculator.product',
  description: 'This service provides the product of all the numbers provided to it.',
  versions: {
    '1.0.0': {
      accepts: z.object({
        numbers: z.number().array().min(2),
      }),
      emits: z.object({
        result: z.number(),
      }),
    },
  },
});

export const productHandler: EventHandlerFactory = () =>
  createArvoEventHandler({
    contract: productContract,
    handler: {
      '1.0.0': async ({ event }) => {
        await new Promise((res) => setTimeout(res, 500));
        return {
          type: 'evt.calculator.product.success' as const,
          data: {
            result: event.data.numbers.reduce((acc, cur) => acc * cur, 1),
          },
          executionunits: event.data.numbers.length * 1e-6,
        };
      },
    },
  });
