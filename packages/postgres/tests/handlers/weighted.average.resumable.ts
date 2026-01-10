import {
  cleanString,
  createArvoOrchestratorContract,
  type InferVersionedArvoContract,
  type VersionedArvoContract,
} from 'arvo-core';
import {
  ArvoDomain,
  createArvoResumable,
  type EventHandlerFactory,
  type IMachineMemory,
} from 'arvo-event-handler';
import z from 'zod';
import { addContract } from './add.service.ts';
import { humanApprovalContract } from './human.approval.contract.ts';
import { productContract } from './product.service.ts';

export const weightedAverageContract = createArvoOrchestratorContract({
  uri: '#/org/amas/resumable/weighted_average',
  name: 'weighted.average',
  description: cleanString(`
    A service which calculates the weighted average of the input
  `),
  versions: {
    '1.0.0': {
      init: z.object({
        input: z
          .object({
            value: z.number(),
            weight: z.number().min(0).max(1),
          })
          .array()
          .min(2),
      }),
      complete: z.object({
        output: z.number().nullable(),
      }),
    },
  },
});

export const weightedAverageResumable: EventHandlerFactory<{ memory: IMachineMemory }> = ({
  memory,
}) =>
  createArvoResumable({
    contracts: {
      self: weightedAverageContract,
      services: {
        add: addContract.version('1.0.0'),
        product: productContract.version('1.0.0'),
        humanApproval: humanApprovalContract.version('1.0.0'),
      },
    },
    memory,
    types: {
      context: {} as {
        currentSubject: string;
        inputItems: InferVersionedArvoContract<
          VersionedArvoContract<typeof weightedAverageContract, '1.0.0'>
        >['accepts']['data']['input'];
        humanApproval: boolean | null;
        isWaitingAllProducts: boolean;
      },
    },
    handler: {
      '1.0.0': async ({ input, context, service, collectedEvents }) => {
        if (input) {
          return {
            context: {
              currentSubject: input.subject,
              inputItems: input.data.input,
              humanApproval: null,
              isWaitingAllProducts: false,
            },
            services: [
              {
                type: 'com.human.approval' as const,
                domain: [ArvoDomain.FROM_EVENT_CONTRACT],
                data: {
                  prompt: cleanString(`
                    To calculate the weighted average we will
                    emit ${input.data.input.length} events to generate
                    the products and then emit add event to add them all
                    and then emit a final product event to calculate 
                    average and then emit the final output event. 
                    
                    Do you approve?
                  `),
                },
              },
            ],
          };
        }

        if (!context) {
          throw new Error('Context not set. Something went wrong...');
        }

        if (
          service?.type === 'sys.com.calculator.add.error' ||
          service?.type === 'sys.com.calculator.product.error' ||
          service?.type === 'sys.com.human.approval.error'
        ) {
          throw new Error(`Something went wrong. ${service.data.errorMessage}`);
        }

        if (service?.type === 'evt.human.approval.success') {
          if (!service.data.approval) {
            throw new Error('Unable to obtain human approval');
          }

          return {
            context: {
              ...context,
              humanApproval: service.data.approval,
              isWaitingAllProducts: true,
            },

            services: context.inputItems.map(({ value, weight }) => ({
              type: 'com.calculator.product' as const,
              data: {
                numbers: [value, weight],
              },
            })),
          };
        }

        if (context.isWaitingAllProducts) {
          if (
            (collectedEvents['evt.calculator.product.success']?.length ?? 0) !==
            context.inputItems.length
          ) {
            return;
          }

          await new Promise((res) => setTimeout(res, 100));
          return {
            context: {
              ...context,
              isWaitingAllProducts: false,
            },
            services: [
              {
                type: 'com.calculator.add' as const,
                data: {
                  numbers: (collectedEvents['evt.calculator.product.success'] ?? []).map(
                    (item) => item.data.result,
                  ),
                },
              },
            ],
          };
        }

        if (service?.type === 'evt.calculator.add.success') {
          return {
            services: [
              {
                type: 'com.calculator.product' as const,
                data: {
                  numbers: [service.data.result, 1 / context.inputItems.length],
                },
              },
            ],
          };
        }

        if (service?.type === 'evt.calculator.product.success') {
          return {
            output: {
              output: service.data.result,
            },
          };
        }
      },
    },
  });
