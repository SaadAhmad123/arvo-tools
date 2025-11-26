import { type ArvoEvent, createArvoEventFactory } from 'arvo-core';
import {
  type ArvoTestSuite,
  createSimpleEventBroker,
  runArvoTestSuites,
  SimpleMachineMemory,
} from 'arvo-event-handler';
import { beforeEach, describe, expect, test } from 'vitest';
import { calculatorAgent } from './handlers/agent.calculator.js';
import { operatorAgent, operatorAgentContract } from './handlers/agent.operator.js';
import { calculatorHandler } from './handlers/calculator.handler.js';
import { humanReviewContract } from './handlers/contract.human.review.js';

const TEST_EVENT_SOURCE = 'test.test.test';
const memory = new SimpleMachineMemory();
const prevEvents: ArvoEvent[] = [];
const tests: ArvoTestSuite = {
  config: {
    fn: async (event: ArvoEvent) => {
      const domainedEvents: ArvoEvent[] = [];
      const result = await createSimpleEventBroker(
        [calculatorAgent({ memory }), calculatorHandler(), operatorAgent({ memory })],
        {
          onDomainedEvents: async ({ event }) => {
            domainedEvents.push(event);
          },
        },
      ).resolve(event);
      return {
        events: result ? [result] : domainedEvents,
      };
    },
  },
  cases: [
    {
      name: 'should just simply respond',
      steps: [
        {
          input: () =>
            createArvoEventFactory(operatorAgentContract.version('1.0.0')).accepts({
              source: TEST_EVENT_SOURCE,
              data: {
                message:
                  'What is x in 2x+5=67. Also in parallel can you help me get start on Astro',
                parentSubject$$: null,
              },
            }),
          expectedEvents: (events) => {
            expect(events).toHaveLength(2);
            for (const event of events) {
              expect(event.type).toBe(humanReviewContract.version('1.0.0').accepts.type);
              prevEvents.push(event);
            }
            return true;
          },
        },
        {
          input: () =>
            createArvoEventFactory(humanReviewContract.version('1.0.0')).emits({
              // Default context passing so that event chains can be stitched
              subject: prevEvents[0]?.data?.parentSubject$$ ?? prevEvents[0]?.subject ?? undefined,
              parentid: prevEvents[0]?.id ?? undefined,
              to: prevEvents[0]?.source ?? undefined,
              // The event data
              type: 'evt.human.review.success',
              source: TEST_EVENT_SOURCE,
              data: {
                response: 'approved',
              },
            }),
          expectedEvents: (events) => {
            expect(events).toHaveLength(0);
            return true;
          },
        },
        {
          input: () =>
            createArvoEventFactory(humanReviewContract.version('1.0.0')).emits({
              // Default context passing so that event chains can be stitched
              subject: prevEvents[1]?.data?.parentSubject$$ ?? prevEvents[1]?.subject ?? undefined,
              parentid: prevEvents[1]?.id ?? undefined,
              to: prevEvents[1]?.source ?? undefined,
              // The event data
              type: 'evt.human.review.success',
              source: TEST_EVENT_SOURCE,
              data: {
                response: 'approved',
              },
            }),
          expectedEvents: (events) => {
            expect(events).toHaveLength(1);
            expect(events[0]?.type).toBe(operatorAgentContract.metadata.completeEventType);
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
