import { expect, test } from 'vitest';
import { ConcurrentMachineMemory, TTLMutex } from '../src';

// TTLMutex Tests
test('TTLMutex - basic lock and unlock', async () => {
  const ttlMutex = new TTLMutex(5000);

  const locked = await ttlMutex.lock();
  expect(locked).toBe(true);
  expect(ttlMutex.isLocked()).toBe(true);

  const unlocked = await ttlMutex.unlock();
  expect(unlocked).toBe(true);
  expect(ttlMutex.isLocked()).toBe(false);
});

test('TTLMutex - TTL expiration allows new lock', async () => {
  const ttlMutex = new TTLMutex(100); // 100ms TTL

  await ttlMutex.lock();
  expect(ttlMutex.isLocked()).toBe(true);

  // Wait for TTL to expire
  await new Promise((resolve) => setTimeout(resolve, 150));

  expect(ttlMutex.isExpired()).toBe(true);
  expect(ttlMutex.isLocked()).toBe(false);

  // Should be able to acquire new lock
  const locked = await ttlMutex.lock();
  expect(locked).toBe(true);
  expect(ttlMutex.isLocked()).toBe(true);

  await ttlMutex.unlock();
});

test('TTLMutex - expired lock is released on new acquisition', async () => {
  const ttlMutex = new TTLMutex(100);

  await ttlMutex.lock();

  // Wait for expiration
  await new Promise((resolve) => setTimeout(resolve, 150));

  // New lock acquisition should release expired lock
  await ttlMutex.lock();
  expect(ttlMutex.isLocked()).toBe(true);
  expect(ttlMutex.isExpired()).toBe(false);

  await ttlMutex.unlock();
});

test('TTLMutex - updatedAt timestamp updates on lock', async () => {
  const ttlMutex = new TTLMutex(5000);

  const before = Date.now();
  await ttlMutex.lock();
  const after = Date.now();

  const updatedAt = ttlMutex.updatedAt.getTime();
  expect(updatedAt >= before && updatedAt <= after).toBe(true);

  await ttlMutex.unlock();
});

// ConcurrentMachineMemory Tests
test('ConcurrentMachineMemory - read returns null for non-existent id', async () => {
  const memory = new ConcurrentMachineMemory();
  const result = await memory.read('non-existent');
  expect(result).toBe(null);
});

test('ConcurrentMachineMemory - write and read data', async () => {
  const memory = new ConcurrentMachineMemory<{ count: number }>();

  await memory.write('test-1', { count: 42 });
  const result = await memory.read('test-1');

  expect(result).toEqual({ count: 42 });
});

test('ConcurrentMachineMemory - lock and unlock', async () => {
  const memory = new ConcurrentMachineMemory();

  const locked = await memory.lock('test-1');
  expect(locked).toBe(true);

  const unlocked = await memory.unlock('test-1');
  expect(unlocked).toBe(true);
});

test('ConcurrentMachineMemory - concurrent writes are serialized', async () => {
  const memory = new ConcurrentMachineMemory<{ value: number }>();
  const id = 'test-concurrent';

  const operations = Array.from({ length: 10 }, () => async () => {
    await memory.lock(id);
    const current = await memory.read(id);
    const newValue = (current?.value ?? 0) + 1;
    await memory.write(id, { value: newValue });
    await memory.unlock(id);
  });

  await Promise.all(operations.map((op) => op()));

  const final = await memory.read(id);
  expect(final?.value).toBe(10);
});

test('ConcurrentMachineMemory - different IDs can lock concurrently', async () => {
  const memory = new ConcurrentMachineMemory();
  const results: string[] = [];

  const task1 = async () => {
    await memory.lock('id-1');
    results.push('id-1-start');
    await new Promise((resolve) => setTimeout(resolve, 100));
    results.push('id-1-end');
    await memory.unlock('id-1');
  };

  const task2 = async () => {
    await memory.lock('id-2');
    results.push('id-2-start');
    await new Promise((resolve) => setTimeout(resolve, 100));
    results.push('id-2-end');
    await memory.unlock('id-2');
  };

  await Promise.all([task1(), task2()]);

  // Both tasks should have interleaved since they use different IDs
  expect(results.includes('id-1-start')).toBe(true);
  expect(results.includes('id-2-start')).toBe(true);
  expect(results.includes('id-1-end')).toBe(true);
  expect(results.includes('id-2-end')).toBe(true);
});

test('ConcurrentMachineMemory - lock retry with exponential backoff', async () => {
  const memory = new ConcurrentMachineMemory({
    lockMaxRetries: 3,
    lockInitialDelayMs: 50,
    lockBackoffExponent: 2,
  });

  const id = 'test-retry';

  // Acquire lock in background and hold it
  const holder = (async () => {
    await memory.lock(id);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await memory.unlock(id);
  })();

  // Try to acquire lock (should retry and eventually fail)
  const startTime = Date.now();
  const acquired = await memory.lock(id);
  const elapsed = Date.now() - startTime;

  // Should have retried with backoff delays: 50ms, 100ms, 200ms
  // Total delay should be at least 350ms
  expect(acquired).toBe(false);
  expect(elapsed >= 350).toBe(true);

  await holder;
});

test('ConcurrentMachineMemory - TTL expiration allows lock acquisition', async () => {
  const memory = new ConcurrentMachineMemory({
    lockTTLMs: 100,
  });

  const id = 'test-ttl';

  await memory.lock(id);

  // Wait for TTL to expire
  await new Promise((resolve) => setTimeout(resolve, 150));

  // Should be able to acquire lock again
  const acquired = await memory.lock(id);
  expect(acquired).toBe(true);

  await memory.unlock(id);
});

test('ConcurrentMachineMemory - cleanup removes data and lock', async () => {
  const memory = new ConcurrentMachineMemory<{ data: string }>();

  await memory.write('test-cleanup', { data: 'test' });
  await memory.lock('test-cleanup');

  await memory.cleanup('test-cleanup');

  const data = await memory.read('test-cleanup');
  expect(data).toBe(null);

  // Lock should be removed, so new lock should work immediately
  const locked = await memory.lock('test-cleanup');
  expect(locked).toBe(true);

  await memory.unlock('test-cleanup');
});

test('ConcurrentMachineMemory - cleanup disabled skips deletion', async () => {
  const memory = new ConcurrentMachineMemory<{ data: string }>({
    enableCleanup: false,
  });

  await memory.write('test-no-cleanup', { data: 'test' });
  await memory.cleanup('test-no-cleanup');

  const data = await memory.read('test-no-cleanup');
  expect(data).toEqual({ data: 'test' });
});

test('ConcurrentMachineMemory - clear removes all data and locks', async () => {
  const memory = new ConcurrentMachineMemory<{ value: number }>();

  await memory.write('id-1', { value: 1 });
  await memory.write('id-2', { value: 2 });
  await memory.lock('id-1');

  memory.clear();

  const data1 = await memory.read('id-1');
  const data2 = await memory.read('id-2');

  expect(data1).toBe(null);
  expect(data2).toBe(null);

  // Locks should be cleared
  const locked = await memory.lock('id-1');
  expect(locked).toBe(true);

  await memory.unlock('id-1');
});

test('ConcurrentMachineMemory - empty id throws error on read', async () => {
  const memory = new ConcurrentMachineMemory();

  await expect(memory.read('')).rejects.toThrow('Machine ID is required for read operation');
});

test('ConcurrentMachineMemory - empty id throws error on write', async () => {
  const memory = new ConcurrentMachineMemory();

  await expect(memory.write('', { data: 'test' })).rejects.toThrow(
    'Machine ID is required for write operation',
  );
});

test('ConcurrentMachineMemory - empty id throws error on lock', async () => {
  const memory = new ConcurrentMachineMemory();

  await expect(memory.lock('')).rejects.toThrow('Machine ID is required for lock operation');
});

test('ConcurrentMachineMemory - empty id throws error on unlock', async () => {
  const memory = new ConcurrentMachineMemory();

  await expect(memory.unlock('')).rejects.toThrow('Machine ID is required for unlock operation');
});

test('ConcurrentMachineMemory - stress test with many concurrent operations', async () => {
  const memory = new ConcurrentMachineMemory<{ counter: number }>();
  const numOperations = 50;
  const numIds = 5;

  const operations = Array.from({ length: numOperations }, (_, i) => async () => {
    const id = `stress-${i % numIds}`;
    await memory.lock(id);

    const current = await memory.read(id);
    const newValue = (current?.counter ?? 0) + 1;
    await memory.write(id, { counter: newValue });

    await memory.unlock(id);
  });

  await Promise.all(operations.map((op) => op()));

  // Verify each ID has the correct count
  for (let i = 0; i < numIds; i++) {
    const id = `stress-${i}`;
    const data = await memory.read(id);
    const expected = Math.floor(numOperations / numIds) + (i < numOperations % numIds ? 1 : 0);
    expect(data?.counter).toBe(expected);
  }
});

test('ConcurrentMachineMemory - unlock on non-existent lock returns true', async () => {
  const memory = new ConcurrentMachineMemory();

  const unlocked = await memory.unlock('non-existent');
  expect(unlocked).toBe(true);
});

test('ConcurrentMachineMemory - write creates deep copy of data', async () => {
  const memory = new ConcurrentMachineMemory<{ nested: { value: number } }>();

  const original = { nested: { value: 42 } };
  await memory.write('test-copy', original);

  original.nested.value = 99;

  const stored = await memory.read('test-copy');
  expect(stored?.nested.value).toBe(42);
});
