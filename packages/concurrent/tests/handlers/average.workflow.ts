import { ArvoErrorSchema, type ArvoErrorType, createArvoOrchestratorContract } from 'arvo-core';
import {
  createArvoOrchestrator,
  type EventHandlerFactory,
  type IMachineMemory,
  setupArvoMachine,
  xstate,
} from 'arvo-event-handler';
import z from 'zod';
import { addContract } from './add.service.ts';
import { productContract } from './product.service.ts';

export const averageWorkflowContract = createArvoOrchestratorContract({
  uri: '#/org/amas/calculator/average',
  name: 'workflow.average',
  versions: {
    '1.0.0': {
      init: z.object({
        numbers: z.number().array().min(2),
      }),
      complete: z.object({
        success: z.boolean(),
        average: z.number().nullable(),
        errors: ArvoErrorSchema.array().nullable(),
      }),
    },
  },
});

const machineV100 = setupArvoMachine({
  contracts: {
    self: averageWorkflowContract.version('1.0.0'),
    services: {
      add: addContract.version('1.0.0'),
      product: productContract.version('1.0.0'),
    },
  },
  types: {
    context: {} as {
      numbers: number[];
      sum: number | null;
      average: number | null;
      errors: ArvoErrorType[];
    },
  },
}).createMachine({
  id: 'machine',
  context: ({ input }) => ({
    numbers: input.data.numbers,
    sum: null,
    average: null,
    errors: [],
  }),
  output: ({ context }) => ({
    average: context.average,
    errors: context.errors.length ? context.errors : null,
    success: !context.errors.length,
  }),
  initial: 'add',
  states: {
    add: {
      entry: xstate.emit(({ context }) => ({
        type: 'com.calculator.add',
        data: {
          numbers: context.numbers,
        },
      })),
      on: {
        'evt.calculator.add.success': {
          target: 'divide',
          actions: xstate.assign({ sum: ({ event }) => event.data.result }),
        },
        'sys.com.calculator.add.error': {
          target: 'error',
          actions: xstate.assign({
            errors: ({ event, context }) => [...context.errors, event.data],
          }),
        },
      },
    },
    divide: {
      entry: xstate.emit(({ context }) => ({
        type: 'com.calculator.product',
        data: {
          numbers: [context.sum ?? 0, 1 / context.numbers.length],
        },
      })),
      on: {
        'evt.calculator.product.success': {
          target: 'done',
          actions: xstate.assign({ average: ({ event }) => event.data.result }),
        },
        'sys.com.calculator.product.error': {
          target: 'error',
          actions: xstate.assign({
            errors: ({ event, context }) => [...context.errors, event.data],
          }),
        },
      },
    },
    done: {
      type: 'final',
    },
    error: {
      type: 'final',
    },
  },
});

export const averageWorkflow: EventHandlerFactory<{ memory: IMachineMemory }> = ({ memory }) =>
  createArvoOrchestrator({
    machines: [machineV100],
    memory,
  });
