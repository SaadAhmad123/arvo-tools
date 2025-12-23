import type { ArvoEvent } from 'arvo-core';
import { expect, test } from 'vitest';
import { ConcurrentEventBroker } from '../src';

test('ConcurrentEventBroker - subscribe registers handler', () => {
  const broker = new ConcurrentEventBroker({
    errorHandler: () => {},
  });

  const handler = async () => {};
  const unsub = broker.subscribe(handler, { topic: 'test.topic', prefetch: 1 });

  expect(broker.topics.includes('test.topic')).toBe(true);
  unsub();
  expect(broker.topics.includes('test.topic')).toBe(false);
});

test('ConcurrentEventBroker - subscribe throws on duplicate topic', () => {
  const broker = new ConcurrentEventBroker({
    errorHandler: () => {},
  });

  const handler = async () => {};
  broker.subscribe(handler, { topic: 'test.topic', prefetch: 1 });

  expect(() => {
    broker.subscribe(handler, { topic: 'test.topic', prefetch: 1 });
  }).toThrow('Subscription conflict');
});

test('ConcurrentEventBroker - publish throws on missing to field', () => {
  const broker = new ConcurrentEventBroker({
    errorHandler: () => {},
  });

  const event = { id: '1', type: 'test' } as ArvoEvent;

  expect(() => {
    broker.publish(event);
  }).toThrow('Missing required');
});

test('ConcurrentEventBroker - publish calls error handler on missing subscription', () => {
  let errorCalled = false;
  const broker = new ConcurrentEventBroker({
    errorHandler: (error) => {
      errorCalled = true;
      expect(error.message.includes('Routing failed')).toBe(true);
    },
  });

  const event = { id: '1', type: 'test', to: 'unknown.topic' } as ArvoEvent;
  broker.publish(event);

  expect(errorCalled).toBe(true);
});

test('ConcurrentEventBroker - publish routes event to handler', async () => {
  const broker = new ConcurrentEventBroker({
    errorHandler: () => {},
  });

  let handlerCalled = false;
  const handler = async (event: ArvoEvent) => {
    handlerCalled = true;
    expect(event.to).toBe('test.topic');
  };

  broker.subscribe(handler, { topic: 'test.topic', prefetch: 1 });

  const event = { id: '1', type: 'test', to: 'test.topic' } as ArvoEvent;
  broker.publish(event);

  await broker.waitForIdle();
  expect(handlerCalled).toBe(true);
});

test('ConcurrentEventBroker - waitForIdle waits for all work', async () => {
  const broker = new ConcurrentEventBroker({
    errorHandler: () => {},
  });

  let completedCount = 0;
  const handler = async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    completedCount++;
  };

  broker.subscribe(handler, { topic: 'test.topic', prefetch: 2 });

  broker.publish({ id: '1', type: 'test', to: 'test.topic' } as ArvoEvent);
  broker.publish({ id: '2', type: 'test', to: 'test.topic' } as ArvoEvent);
  broker.publish({ id: '3', type: 'test', to: 'test.topic' } as ArvoEvent);

  expect(completedCount).toBe(0);

  await broker.waitForIdle();
  expect(completedCount).toBe(3);
});

test('ConcurrentEventBroker - waitForIdle times out', async () => {
  const broker = new ConcurrentEventBroker({
    errorHandler: () => {},
  });

  let timeout: unknown = null;
  const handler = async () => {
    await new Promise((resolve) => {
      timeout = setTimeout(resolve, 1000);
    });
  };

  broker.subscribe(handler, { topic: 'test.topic', prefetch: 1 });
  broker.publish({ id: '1', type: 'test', to: 'test.topic' } as ArvoEvent);

  await expect(broker.waitForIdle({ timeoutMs: 100 })).rejects.toThrow('timed out');

  // biome-ignore lint/suspicious/noExplicitAny: It is fine
  clearTimeout(timeout as any);
});

test('ConcurrentEventBroker - getStats returns queue info', () => {
  const broker = new ConcurrentEventBroker({
    errorHandler: () => {},
  });

  const handler = async () => {};
  broker.subscribe(handler, { topic: 'test.topic', prefetch: 5 });

  const stats = broker.getStats('test.topic');
  expect(stats?.prefetch).toBe(5);
  expect(stats?.pending).toBe(0);
  expect(stats?.size).toBe(0);
  expect(stats?.inFlight).toBe(0);
});

test('ConcurrentEventBroker - getStats returns null for unknown topic', () => {
  const broker = new ConcurrentEventBroker({
    errorHandler: () => {},
  });

  const stats = broker.getStats('unknown.topic');
  expect(stats).toBe(null);
});

test('ConcurrentEventBroker - stats returns all topics', () => {
  const broker = new ConcurrentEventBroker({
    errorHandler: () => {},
  });

  const handler = async () => {};
  broker.subscribe(handler, { topic: 'topic1', prefetch: 1 });
  broker.subscribe(handler, { topic: 'topic2', prefetch: 2 });

  const stats = broker.stats;
  expect(stats.length).toBe(2);
  expect(stats.some((s) => s.topic === 'topic1')).toBe(true);
  expect(stats.some((s) => s.topic === 'topic2')).toBe(true);
});

test('ConcurrentEventBroker - clear removes all subscriptions', () => {
  const broker = new ConcurrentEventBroker({
    errorHandler: () => {},
  });

  const handler = async () => {};
  broker.subscribe(handler, { topic: 'topic1', prefetch: 1 });
  broker.subscribe(handler, { topic: 'topic2', prefetch: 1 });

  expect(broker.topics.length).toBe(2);

  broker.clear();

  expect(broker.topics.length).toBe(0);
});

test('ConcurrentEventBroker - handler can publish cascading events', async () => {
  const broker = new ConcurrentEventBroker({
    errorHandler: () => {},
  });

  const results: string[] = [];

  broker.subscribe(
    async (_, publish) => {
      results.push('handler1');
      publish({ id: '2', type: 'test', to: 'topic2' } as ArvoEvent);
    },
    { topic: 'topic1', prefetch: 1 },
  );

  broker.subscribe(
    async (_) => {
      results.push('handler2');
    },
    { topic: 'topic2', prefetch: 1 },
  );

  broker.publish({ id: '1', type: 'test', to: 'topic1' } as ArvoEvent);

  await broker.waitForIdle();

  expect(results.length).toBe(2);
  expect(results.includes('handler1')).toBe(true);
  expect(results.includes('handler2')).toBe(true);
});

test('ConcurrentEventBroker - prefetch controls concurrency', async () => {
  const broker = new ConcurrentEventBroker({
    errorHandler: () => {},
  });

  let concurrentCount = 0;
  let maxConcurrent = 0;

  const handler = async () => {
    concurrentCount++;
    maxConcurrent = Math.max(maxConcurrent, concurrentCount);
    await new Promise((resolve) => setTimeout(resolve, 50));
    concurrentCount--;
  };

  broker.subscribe(handler, { topic: 'test.topic', prefetch: 3 });

  for (let i = 0; i < 10; i++) {
    broker.publish({ id: `${i}`, type: 'test', to: 'test.topic' } as ArvoEvent);
  }

  await broker.waitForIdle();

  expect(maxConcurrent).toBe(3);
});

test('ConcurrentEventBroker - error handler called on handler exception', async () => {
  let errorHandlerCalled = false;
  const broker = new ConcurrentEventBroker({
    errorHandler: (error) => {
      errorHandlerCalled = true;
      expect(error.message).toBe('Handler failed');
    },
  });

  const handler = async () => {
    throw new Error('Handler failed');
  };

  broker.subscribe(handler, { topic: 'test.topic', prefetch: 1 });
  broker.publish({ id: '1', type: 'test', to: 'test.topic' } as ArvoEvent);

  await broker.waitForIdle();

  expect(errorHandlerCalled).toBe(true);
});
