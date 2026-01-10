import { Client } from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { connectPostgresMachineMemory, releasePostgressMachineMemory } from '../src';

const connectionString = process.env.ARVO_POSTGRES_CONNECTION_STRING ?? '';

const testTables = {
  state: 'machine_memory_state',
  lock: 'machine_memory_lock',
  hierarchy: 'machine_memory_hierarchy',
};

describe('Distributed Locking', () => {
  beforeEach(async () => {
    await connectPostgresMachineMemory({
      version: 1,
      tables: testTables,
      config: {
        connectionString,
      },
      migrate: 'dangerousely_force_migration',
    });
  });

  describe('Lock acquisition', () => {
    it('should acquire lock on unlocked subject', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const result = await memory.lock('test-subject');

      expect(result).toBe(true);

      await releasePostgressMachineMemory(memory);
    });

    it('should fail to acquire lock on already locked subject', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: {
          connectionString,
          lockConfig: {
            maxRetries: 2,
            initialDelayMs: 10,
          },
        },
      });

      await memory.lock('test-subject');

      const result = await memory.lock('test-subject');

      expect(result).toBe(false);

      await releasePostgressMachineMemory(memory);
    });

    it('should respect maxRetries configuration', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: {
          connectionString,
          lockConfig: {
            maxRetries: 1,
            initialDelayMs: 10,
          },
        },
      });

      await memory.lock('test-subject');

      const startTime = Date.now();
      const result = await memory.lock('test-subject');
      const elapsed = Date.now() - startTime;

      expect(result).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(10);
      expect(elapsed).toBeLessThan(100);

      await releasePostgressMachineMemory(memory);
    });

    it('should use exponential backoff for retries', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: {
          connectionString,
          lockConfig: {
            maxRetries: 3,
            initialDelayMs: 50,
            backoffExponent: 2,
          },
        },
      });

      await memory.lock('test-subject');

      const startTime = Date.now();
      const result = await memory.lock('test-subject');
      const elapsed = Date.now() - startTime;

      expect(result).toBe(false);
      // Should wait: 50ms + 100ms + 200ms = 350ms minimum
      expect(elapsed).toBeGreaterThan(300);

      await releasePostgressMachineMemory(memory);
    });
  });

  describe('Lock expiration', () => {
    it('should reacquire lock after TTL expiration', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: {
          connectionString,
          lockConfig: {
            ttlMs: 100,
          },
        },
      });

      const firstLock = await memory.lock('test-subject');
      expect(firstLock).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 150));

      const secondLock = await memory.lock('test-subject');
      expect(secondLock).toBe(true);

      await releasePostgressMachineMemory(memory);
    });

    it('should respect custom TTL configuration', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: {
          connectionString,
          lockConfig: {
            ttlMs: 200,
            maxRetries: 1,
            initialDelayMs: 10,
          },
        },
      });

      await memory.lock('test-subject');

      await new Promise((resolve) => setTimeout(resolve, 100));
      const stillLocked = await memory.lock('test-subject');
      expect(stillLocked).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 150));
      const expired = await memory.lock('test-subject');
      expect(expired).toBe(true);

      await releasePostgressMachineMemory(memory);
    });

    it('should verify lock expiration in database', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: {
          connectionString,
          lockConfig: {
            ttlMs: 100,
          },
        },
      });

      await memory.lock('test-subject');

      const client = new Client({ connectionString });
      await client.connect();

      const beforeExpiry = await client.query(
        `SELECT expires_at > NOW() as is_locked FROM ${testTables.lock} WHERE subject = $1`,
        ['test-subject'],
      );
      expect(beforeExpiry.rows[0].is_locked).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 150));

      const afterExpiry = await client.query(
        `SELECT expires_at > NOW() as is_locked FROM ${testTables.lock} WHERE subject = $1`,
        ['test-subject'],
      );
      expect(afterExpiry.rows[0].is_locked).toBe(false);

      await client.end();
      await releasePostgressMachineMemory(memory);
    });
  });

  describe('Lock release', () => {
    it('should unlock successfully', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      await memory.lock('test-subject');
      const unlockResult = await memory.unlock('test-subject');

      expect(unlockResult).toBe(true);

      const client = new Client({ connectionString });
      await client.connect();
      const result = await client.query(`SELECT * FROM ${testTables.lock} WHERE subject = $1`, [
        'test-subject',
      ]);
      await client.end();

      expect(result.rows.length).toBe(0);

      await releasePostgressMachineMemory(memory);
    });

    it('should allow relock after unlock', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      await memory.lock('test-subject');
      await memory.unlock('test-subject');

      const result = await memory.lock('test-subject');

      expect(result).toBe(true);

      await releasePostgressMachineMemory(memory);
    });

    it('should be idempotent when unlocking non-existent lock', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const result = await memory.unlock('non-existent-subject');

      expect(result).toBe(true);

      await releasePostgressMachineMemory(memory);
    });

    it('should handle multiple unlock calls', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      await memory.lock('test-subject');

      const firstUnlock = await memory.unlock('test-subject');
      const secondUnlock = await memory.unlock('test-subject');

      expect(firstUnlock).toBe(true);
      expect(secondUnlock).toBe(true);

      await releasePostgressMachineMemory(memory);
    });
  });

  describe('Concurrent locking', () => {
    it('should only allow one lock acquisition when concurrent', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: {
          connectionString,
          lockConfig: {
            maxRetries: 1,
            initialDelayMs: 10,
          },
        },
      });

      const lock1 = memory.lock('test-subject');
      const lock2 = memory.lock('test-subject');
      const lock3 = memory.lock('test-subject');

      const results = await Promise.all([lock1, lock2, lock3]);

      const successful = results.filter((r) => r === true);
      const failed = results.filter((r) => r === false);

      expect(successful.length).toBe(1);
      expect(failed.length).toBe(2);

      await releasePostgressMachineMemory(memory);
    });

    it('should handle multiple subjects independently', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const lock1 = await memory.lock('subject-1');
      const lock2 = await memory.lock('subject-2');
      const lock3 = await memory.lock('subject-3');

      expect(lock1).toBe(true);
      expect(lock2).toBe(true);
      expect(lock3).toBe(true);

      await releasePostgressMachineMemory(memory);
    });

    it('should allow sequential locks after unlock', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const lock1 = await memory.lock('test-subject');
      await memory.unlock('test-subject');

      const lock2 = await memory.lock('test-subject');
      await memory.unlock('test-subject');

      const lock3 = await memory.lock('test-subject');

      expect(lock1).toBe(true);
      expect(lock2).toBe(true);
      expect(lock3).toBe(true);

      await releasePostgressMachineMemory(memory);
    });
  });

  describe('Lock metadata', () => {
    it('should store lock timestamps correctly', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: {
          connectionString,
          lockConfig: {
            ttlMs: 5000,
          },
        },
      });

      await memory.lock('test-subject');

      const client = new Client({ connectionString });
      await client.connect();
      const result = await client.query(
        `SELECT locked_at, expires_at, created_at FROM ${testTables.lock} WHERE subject = $1`,
        ['test-subject'],
      );
      await client.end();

      expect(result.rows.length).toBe(1);

      const lockedAt = new Date(result.rows[0].locked_at).getTime();
      const expiresAt = new Date(result.rows[0].expires_at).getTime();

      console.log({ diff: expiresAt - lockedAt });
      expect(expiresAt - lockedAt).toBe(5000);

      await releasePostgressMachineMemory(memory);
    });
  });
});
