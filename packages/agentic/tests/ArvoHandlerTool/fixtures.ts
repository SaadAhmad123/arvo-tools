import { createArvoContract, createArvoEventFactory } from 'arvo-core';
import { z } from 'zod';
import { ArvoHandlerTool, JsonResultData } from '../../src';

export const addContract = createArvoContract({
  uri: '#/test/calculator/add',
  type: 'com.calculator.add',
  description: 'Adds numbers together',
  versions: {
    '1.0.0': {
      accepts: z.object({
        numbers: z.number().array(),
      }),
      emits: {
        'evt.calculator.add.success': z.object({
          result: z.number(),
        }),
      },
    },
  },
});

export const userCreateContract = createArvoContract({
  uri: '#/test/user/create',
  type: 'com.user.create',
  description: 'Creates a user in the system',
  versions: {
    '1.0.0': {
      accepts: z.object({
        name: z.string(),
        age: z.number(),
      }),
      emits: {
        'evt.user.create.success': z.object({
          created: z.boolean(),
        }),
      },
    },
    '2.0.0': {
      accepts: z.object({
        name: z.string(),
        dob: z.string(),
      }),
      emits: {
        'evt.user.create.success': z.object({
          created: z.boolean(),
        }),
      },
    },
  },
});

export const addContractV1 = addContract.version('1.0.0');
export const userCreateContractV1 = userCreateContract.version('1.0.0');
export const userCreateContractV2 = userCreateContract.version('2.0.0');

export const addEventFactory = createArvoEventFactory(addContractV1);
export const userCreateEventFactoryV1 = createArvoEventFactory(userCreateContractV1);

export const addArvoTool = new ArvoHandlerTool({ contract: addContractV1 });

// Wraps v1 user contract with a custom onResponse that marks the result as processed
export const userCreateArvoTool = new ArvoHandlerTool({
  contract: userCreateContractV1,
  onResponse: async (event) => {
    const data = event as Record<string, unknown>;
    return [
      new JsonResultData((data.id as string) ?? '', { processed: true, ...(data.data as object) }),
    ];
  },
});

export const userCreateArvoToolV2 = new ArvoHandlerTool({ contract: userCreateContractV2 });
