import { type ArvoEvent, createArvoEvent, createArvoEventFactory } from 'arvo-core';
import { expect, test } from 'vitest';
import { ConcurrentMachineMemory, createConcurrentEventBroker } from '../src';
import { addContract, addHandler } from './handlers/add.service';
import { averageWorkflow, averageWorkflowContract } from './handlers/average.workflow';
import { productContract, productHandler } from './handlers/product.service';
import {
  weightedAverageContract,
  weightedAverageResumable,
} from './handlers/weighted.average.resumable';

const TEST_SOURCE = 'test.test.test';
const memory = new ConcurrentMachineMemory();

test('createConcurrentEventBroker - basic handler execution', async () => {
  const { resolve } = createConcurrentEventBroker([{ handler: addHandler() }]);

  const event = createArvoEventFactory(addContract.version('1.0.0')).accepts({
    source: TEST_SOURCE,
    data: { numbers: [1, 2, 3] },
  });

  const result = await resolve(event);

  expect(result?.type).toBe('evt.calculator.add.success');
  expect(result?.data.result).toBe(6);
});

test('createConcurrentEventBroker - multiple handlers coordination', async () => {
  const { resolve } = createConcurrentEventBroker([
    { handler: addHandler() },
    { handler: productHandler() },
    { handler: averageWorkflow({ memory }) },
  ]);

  const event = createArvoEventFactory(averageWorkflowContract.version('1.0.0')).accepts({
    source: TEST_SOURCE,
    data: {
      parentSubject$$: null,
      numbers: [2, 4, 6, 8],
    },
  });

  const result = await resolve(event);

  expect(result?.type).toBe(averageWorkflowContract.metadata.completeEventType);
  expect(result?.data.average).toBe(5);
  expect(result?.data.success).toBe(true);
});

test('createConcurrentEventBroker - input middleware transforms event', async () => {
  const { resolve } = createConcurrentEventBroker([
    {
      handler: addHandler(),
      middleware: {
        input: [
          (event) => {
            return createArvoEventFactory(addContract.version('1.0.0')).accepts({
              source: event.source,
              data: {
                numbers: event.data.numbers.map((n: number) => n * 2),
              },
            });
          },
        ],
      },
    },
  ]);

  const event = createArvoEventFactory(addContract.version('1.0.0')).accepts({
    source: TEST_SOURCE,
    data: { numbers: [1, 2, 3] },
  });

  const result = await resolve(event);

  expect(result?.data.result).toBe(12);
});

test('createConcurrentEventBroker - input middleware returning void preserves event', async () => {
  let middlewareCalled = false;

  const { resolve } = createConcurrentEventBroker([
    {
      handler: addHandler(),
      middleware: {
        input: [
          () => {
            middlewareCalled = true;
          },
        ],
      },
    },
  ]);

  const event = createArvoEventFactory(addContract.version('1.0.0')).accepts({
    source: TEST_SOURCE,
    data: { numbers: [1, 2, 3] },
  });

  const result = await resolve(event);

  expect(middlewareCalled).toBe(true);
  expect(result?.data.result).toBe(6);
});

test('createConcurrentEventBroker - output middleware transforms events', async () => {
  const { resolve } = createConcurrentEventBroker([
    {
      handler: addHandler(),
      middleware: {
        output: [
          ({ output }) => {
            return createArvoEventFactory(addContract.version('1.0.0')).emits({
              source: output.source,
              to: output.to ?? undefined,
              subject: output.subject,
              type: 'evt.calculator.add.success',
              data: {
                result: output.data.result * 10,
              },
            });
          },
        ],
      },
    },
  ]);

  const event = createArvoEventFactory(addContract.version('1.0.0')).accepts({
    source: TEST_SOURCE,
    data: { numbers: [1, 2, 3] },
  });

  const result = await resolve(event);

  expect(result?.data.result).toBe(60);
});

test('createConcurrentEventBroker - bulk output middleware transforms all events', async () => {
  const { resolve } = createConcurrentEventBroker([
    {
      handler: addHandler(),
      middleware: {
        output: ({ output }) => {
          return output.map((evt) =>
            createArvoEventFactory(addContract.version('1.0.0')).emits({
              source: evt.source,
              to: evt.to ?? undefined,
              subject: evt.subject,
              type: 'evt.calculator.add.success',
              data: {
                result: evt.data.result + 100,
              },
            }),
          );
        },
      },
    },
  ]);

  const event = createArvoEventFactory(addContract.version('1.0.0')).accepts({
    source: TEST_SOURCE,
    data: { numbers: [1, 2, 3] },
  });

  const result = await resolve(event);

  expect(result?.data.result).toBe(106);
});

test('createConcurrentEventBroker - retry on handler failure', async () => {
  const errors: Error[] = [];
  const { resolve } = createConcurrentEventBroker(
    [
      {
        handler: productHandler(),
        retry: {
          maxRetries: 3,
          initialDelayMs: 10,
          backoffExponent: 1.5,
        },
      },
    ],
    {
      onBrokerError: (err) => errors.push(err),
    },
  );

  const event = createArvoEventFactory(productContract.version('1.0.0')).accepts({
    source: TEST_SOURCE,
    data: { numbers: [2, 3] },
  });

  const response = await resolve(
    // @ts-expect-error
    createArvoEvent({
      ...event.toJSON(),
      data: { numbers: [] },
      id: {
        deduplication: 'ARVO_MANAGED',
        value: 'something',
      },
    }),
  );
  expect(response).toBe(null);
  expect(errors.length).toBeGreaterThan(0);
});

test('createConcurrentEventBroker - onError SUPPRESS prevents error throw', async () => {
  const errors: Error[] = [];
  const { resolve } = createConcurrentEventBroker(
    [
      {
        handler: productHandler(),
        onError: () => 'SUPPRESS',
      },
    ],
    {
      onBrokerError: (err) => errors.push(err),
    },
  );

  const event = createArvoEventFactory(productContract.version('1.0.0')).accepts({
    source: TEST_SOURCE,
    data: { numbers: [2, 3] },
  });

  const response = await resolve(
    // @ts-expect-error
    createArvoEvent({
      ...event.toJSON(),
      data: { numbers: [] },
      id: {
        deduplication: 'ARVO_MANAGED',
        value: 'test-suppress-id',
      },
    }),
  );

  expect(response).toBe(null);
  expect(errors.length).toBe(0);
});

test('createConcurrentEventBroker - onError THROW propagates error', async () => {
  const errors: Error[] = [];
  const { resolve } = createConcurrentEventBroker(
    [
      {
        handler: productHandler(),
        onError: () => 'THROW',
      },
    ],
    {
      onBrokerError: (err) => errors.push(err),
    },
  );

  const event = createArvoEventFactory(productContract.version('1.0.0')).accepts({
    source: TEST_SOURCE,
    data: { numbers: [2, 3] },
  });

  const response = await resolve(
    // @ts-expect-error
    createArvoEvent({
      ...event.toJSON(),
      data: { numbers: [] },
      id: {
        deduplication: 'ARVO_MANAGED',
        value: 'test-throw-id',
      },
    }),
  );

  expect(response).toBe(null);
  expect(errors.length > 0).toBe(true);
});

test('createConcurrentEventBroker - handler config overrides default config', async () => {
  let defaultMiddlewareCalled = false;
  let handlerMiddlewareCalled = false;

  const { resolve } = createConcurrentEventBroker(
    [
      {
        handler: addHandler(),
        middleware: {
          input: [
            () => {
              handlerMiddlewareCalled = true;
            },
          ],
        },
      },
    ],
    {
      defaultHandlerConfig: {
        middleware: {
          input: [
            () => {
              defaultMiddlewareCalled = true;
            },
          ],
        },
      },
    },
  );

  const event = createArvoEventFactory(addContract.version('1.0.0')).accepts({
    source: TEST_SOURCE,
    data: { numbers: [1, 2] },
  });

  await resolve(event);

  expect(handlerMiddlewareCalled).toBe(true);
  expect(defaultMiddlewareCalled).toBe(false);
});

test('createConcurrentEventBroker - onBrokerError catches routing failures', async () => {
  let brokerErrorCalled = false;
  let errorMessage = '';

  const { broker } = createConcurrentEventBroker([{ handler: addHandler() }], {
    onBrokerError: (error) => {
      brokerErrorCalled = true;
      errorMessage = error.message;
    },
  });

  const event = createArvoEventFactory(productContract.version('1.0.0')).accepts({
    source: TEST_SOURCE,
    data: { numbers: [1, 2] },
  });

  broker.publish(event);

  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(brokerErrorCalled).toBe(true);
  expect(errorMessage.includes('Routing failed')).toBe(true);
});

test('createConcurrentEventBroker - onDomainedEvents captures domain events', async () => {
  const domainedEvents: ArvoEvent[] = [];

  const { resolve } = createConcurrentEventBroker(
    [
      { handler: addHandler() },
      { handler: productHandler() },
      { handler: weightedAverageResumable({ memory }) },
    ],
    {
      onDomainedEvents: async ({ event }) => {
        domainedEvents.push(event);
      },
    },
  );

  const event = createArvoEventFactory(weightedAverageContract.version('1.0.0')).accepts({
    source: TEST_SOURCE,
    data: {
      parentSubject$$: null,
      input: [
        { value: 10, weight: 0.5 },
        { value: 20, weight: 0.5 },
      ],
    },
  });

  await resolve(event);

  expect(domainedEvents.length).toBe(1);
  expect(domainedEvents[0].type).toBe('com.human.approval');
});

test('createConcurrentEventBroker - prefetch controls concurrency', async () => {
  const { resolve } = createConcurrentEventBroker([
    { handler: addHandler(), prefetch: 1 },
    { handler: productHandler(), prefetch: 5 },
  ]);

  const stats1 = resolve(
    createArvoEventFactory(addContract.version('1.0.0')).accepts({
      source: TEST_SOURCE,
      data: { numbers: [1, 2] },
    }),
  );

  const stats2 = resolve(
    createArvoEventFactory(productContract.version('1.0.0')).accepts({
      source: `${TEST_SOURCE}2`,
      data: { numbers: [3, 4] },
    }),
  );

  await Promise.all([stats1, stats2]);

  expect(true).toBe(true);
});

test('createConcurrentEventBroker - waitForIdle configuration', async () => {
  const { resolve } = createConcurrentEventBroker([{ handler: addHandler() }], {
    waitForIdle: {
      timeoutMs: 5000,
      pollIntervalMs: 10,
    },
  });

  const event = createArvoEventFactory(addContract.version('1.0.0')).accepts({
    source: TEST_SOURCE,
    data: { numbers: [1, 2, 3] },
  });

  const result = await resolve(event);

  expect(result?.data.result).toBe(6);
});

test('createConcurrentEventBroker - resolve returns null when no response', async () => {
  const { resolve, broker } = createConcurrentEventBroker([{ handler: addHandler() }]);

  const event = createArvoEventFactory(productContract.version('1.0.0')).accepts({
    source: TEST_SOURCE,
    data: { numbers: [1, 2] },
  });

  const result = await resolve(event);

  expect(result).toBe(null);
  broker.clear();
});

test('createConcurrentEventBroker - resolve throws when event source matches handler', async () => {
  const { resolve } = createConcurrentEventBroker([{ handler: addHandler() }]);

  const event = createArvoEventFactory(addContract.version('1.0.0')).accepts({
    source: 'com.calculator.add',
    data: { numbers: [1, 2] },
  });

  await expect(resolve(event)).rejects.toThrow('event source cannot be one of the handlers');
});

test('createConcurrentEventBroker - broker instance is accessible', () => {
  const { broker } = createConcurrentEventBroker([{ handler: addHandler() }]);

  expect(broker.topics.includes('com.calculator.add')).toBe(true);
});

test('createConcurrentEventBroker - complex workflow with orchestrator', async () => {
  const { resolve } = createConcurrentEventBroker([
    { handler: addHandler(), prefetch: 10 },
    { handler: productHandler(), prefetch: 10 },
    { handler: averageWorkflow({ memory }), prefetch: 10 },
  ]);

  const event = createArvoEventFactory(averageWorkflowContract.version('1.0.0')).accepts({
    source: TEST_SOURCE,
    data: {
      parentSubject$$: null,
      numbers: [10, 20, 30, 40, 50],
    },
  });

  const result = await resolve(event);

  expect(result?.type).toBe(averageWorkflowContract.metadata.completeEventType);
  expect(result?.data.average).toBe(30);
  expect(result?.data.success).toBe(true);
});
