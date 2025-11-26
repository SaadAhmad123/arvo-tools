import { type ArvoEvent, createArvoEventFactory } from 'arvo-core';
import {
  type ArvoTestSuite,
  createSimpleEventBroker,
  runArvoTestSuites,
  SimpleMachineMemory,
} from 'arvo-event-handler';
import { beforeEach, describe, expect, test } from 'vitest';
import { calculatorAgent, calculatorAgentContract } from './handlers/agent.calculator';
import { calculatorHandler } from './handlers/calculator.handler';
import { humanReviewContract } from './handlers/contract.human.review.js';

const TEST_EVENT_SOURCE = 'test.test.test';
const memory = new SimpleMachineMemory();
const tests: ArvoTestSuite = {
  config: {
    fn: async (event: ArvoEvent) => {
      let domainedEvent: ArvoEvent | null = null;
      const result = await createSimpleEventBroker(
        [calculatorAgent({ memory }), calculatorHandler()],
        {
          onDomainedEvents: async ({ event }) => {
            domainedEvent = event;
          },
        },
      ).resolve(event);
      return {
        events: ((result ?? domainedEvent) ? [result ?? domainedEvent] : []) as ArvoEvent[],
      };
    },
  },
  cases: [
    {
      name: 'should just simply respond',
      steps: [
        {
          input: () =>
            createArvoEventFactory(calculatorAgentContract.version('2.0.0')).accepts({
              source: TEST_EVENT_SOURCE,
              data: {
                message:
                  'What is x in 2x+5=67. Also in parallel can you help me get start on Astro',
                parentSubject$$: null,
              },
            }),
          expectedEvents: (events) => {
            expect(events).toHaveLength(1);
            expect(events[0]?.type).toBe(humanReviewContract.version('1.0.0').accepts.type);
            return true;
          },
        },
        // Simuilating a human interaction which can happen via UI/Endpoint/Console/email etc
        {
          input: (prev) =>
            createArvoEventFactory(humanReviewContract.version('1.0.0')).emits({
              // Default context passing so that event chains can be stitched
              subject: prev?.[0]?.data?.parentSubject$$ ?? prev?.[0]?.subject ?? undefined,
              parentid: prev?.[0]?.id ?? undefined,
              to: prev?.[0]?.source ?? undefined,
              // The event data
              type: 'evt.human.review.success',
              source: TEST_EVENT_SOURCE,
              data: {
                response: 'approved',
              },
            }),
          expectedEvents: (events) => {
            expect(events).toHaveLength(1);
            expect(events[0]?.type).toBe(calculatorAgentContract.metadata.completeEventType);
            return true;
          },
        },
      ],
    },
  ],
};

runArvoTestSuites([tests], {
  test: test,
  describe: describe,
  beforeEach: beforeEach,
});
