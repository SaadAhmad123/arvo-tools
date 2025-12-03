import {
  type ArvoEvent,
  ArvoOrchestrationSubject,
  cleanString,
  createArvoEventFactory,
} from 'arvo-core';
import {
  type ArvoTestSuite,
  createSimpleEventBroker,
  runArvoTestSuites,
  SimpleMachineMemory,
} from 'arvo-event-handler';
import { beforeEach, describe, expect, test } from 'vitest';
import { SimplePermissionManager } from '../src/index.js';
import { calculatorAgent, calculatorAgentContract } from './handlers/agent.calculator';
import { calculatorHandler } from './handlers/calculator.handler';
import { HUMAN_INTERACTION_DOMAIN, humanReviewContract } from './handlers/contract.human.review.js';

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
                message: cleanString(`
                  What is x in 2x+5=67. Also in parallel can you help me get start on Astro.
                  Before executing the tools present the whole plan via human review tool and
                  await approval. You are banned from execution any tools before human review tool 
                  Use only one human review tool call at max. 
                `),
                parentSubject$$: null,
              },
              accesscontrol: 'xyz',
            }),
          expectedEvents: (events) => {
            expect(events).toHaveLength(1);
            expect(events[0]?.type).toBe(humanReviewContract.version('1.0.0').accepts.type);
            expect(events[0]?.domain).toBe(HUMAN_INTERACTION_DOMAIN);
            expect(ArvoOrchestrationSubject.parse(events[0]?.subject ?? '').execution.domain).toBe(
              null,
            );
            expect(events[0]?.accesscontrol).toBe('xyz');
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
    {
      name: 'should get permission to call calculator and then go a head',
      steps: [
        {
          input: () =>
            createArvoEventFactory(calculatorAgentContract.version('3.0.0')).accepts({
              source: TEST_EVENT_SOURCE,
              data: {
                message: cleanString(`
                  What is x in 2x+5=67. Also in parallel can you help me get start on Astro.
                  Before executing the tools present the whole plan via human review tool and
                  await approval. You are banned from execution any tools before human review tool
                `),
                parentSubject$$: null,
              },
              accesscontrol: 'xyz',
            }),
          expectedEvents: (events) => {
            expect(events).toHaveLength(1);
            expect(events[0]?.type).toBe(humanReviewContract.version('1.0.0').accepts.type);
            expect(events[0]?.accesscontrol).toBe('xyz');
            return true;
          },
        },
        {
          input: (prev) =>
            createArvoEventFactory(humanReviewContract.version('1.0.0')).emits({
              // Default context passing so that event chains can be stitched
              subject: prev?.[0]?.data?.parentSubject$$ ?? prev?.[0]?.subject ?? undefined,
              parentid: prev?.[0]?.id ?? undefined,
              to: prev?.[0]?.source ?? undefined,
              accesscontrol: prev?.[0]?.accesscontrol ?? undefined,
              // The event data
              type: 'evt.human.review.success',
              source: TEST_EVENT_SOURCE,
              data: {
                response: 'approved',
              },
            }),
          expectedEvents: (events) => {
            expect(events).toHaveLength(1);
            expect(events[0]?.type).toBe(SimplePermissionManager.VERSIONED_CONTRACT.accepts.type);
            expect(events[0]?.accesscontrol).toBe('xyz');
            return true;
          },
        },
        {
          input: (prev) =>
            createArvoEventFactory(SimplePermissionManager.VERSIONED_CONTRACT).emits({
              // Default context passing so that event chains can be stitched
              subject: prev?.[0]?.data?.parentSubject$$ ?? prev?.[0]?.subject ?? undefined,
              parentid: prev?.[0]?.id ?? undefined,
              to: prev?.[0]?.source ?? undefined,
              accesscontrol: prev?.[0]?.accesscontrol ?? undefined,
              // The event data
              type: 'evt.arvo.default.simple.permission.request.success',
              source: TEST_EVENT_SOURCE,
              data: {
                granted: ['service_com_calculator_execute'],
                denied: ['mcp_search_astro_docs'],
              },
            }),
          expectedEvents: (events) => {
            expect(events).toHaveLength(1);
            expect(events[0]?.type).toBe(calculatorAgentContract.metadata.completeEventType);
            expect(events[0]?.accesscontrol).toBe('xyz');
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
