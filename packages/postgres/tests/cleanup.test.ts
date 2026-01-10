import { Materialized } from 'arvo-event-handler';
import { Client } from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  connectPostgresMachineMemory,
  createPostgresMachineMemoryTables,
  releasePostgressMachineMemory,
} from '../src';

const connectionString = process.env.ARVO_POSTGRES_CONNECTION_STRING ?? '';

const testTables = {
  state: 'machine_memory_state',
  lock: 'machine_memory_lock',
  hierarchy: 'machine_memory_hierarchy',
};

const metadata = {
  source: 'test-source',
  initiator: Materialized.resolved('com.test.test'),
  subject: 'test-subject',
  parentSubject: Materialized.resolved(null),
};

type TestContext = {
  executionStatus: string;
  parentSubject?: string;
};

describe('Cleanup Operations', () => {
  beforeEach(async () => {
    await createPostgresMachineMemoryTables(connectionString, {
      version: 1,
      tables: testTables,
      dangerouslyDropTablesIfExist: true,
    });
  });

  describe('Cleanup disabled (default)', () => {
    it('should not delete records when enableCleanup is false', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: {
          connectionString,
          enableCleanup: false,
        },
      });

      const testData: TestContext = {
        executionStatus: 'pending',
      };

      await memory.write('test-subject', testData, null, metadata);
      await memory.lock('test-subject');
      await memory.cleanup('test-subject');

      const client = new Client({ connectionString });
      await client.connect();

      const stateResult = await client.query(
        `SELECT * FROM ${testTables.state} WHERE subject = $1`,
        ['test-subject'],
      );
      const lockResult = await client.query(`SELECT * FROM ${testTables.lock} WHERE subject = $1`, [
        'test-subject',
      ]);
      const hierarchyResult = await client.query(
        `SELECT * FROM ${testTables.hierarchy} WHERE subject = $1`,
        ['test-subject'],
      );

      await client.end();

      expect(stateResult.rows.length).toBe(1);
      expect(lockResult.rows.length).toBe(1);
      expect(hierarchyResult.rows.length).toBe(1);

      await releasePostgressMachineMemory(memory);
    });

    it('should not delete records when enableCleanup is not specified', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const testData: TestContext = {
        executionStatus: 'pending',
      };

      await memory.write('test-subject', testData, null, metadata);
      await memory.cleanup('test-subject');

      const client = new Client({ connectionString });
      await client.connect();

      const stateResult = await client.query(
        `SELECT * FROM ${testTables.state} WHERE subject = $1`,
        ['test-subject'],
      );

      await client.end();

      expect(stateResult.rows.length).toBe(1);

      await releasePostgressMachineMemory(memory);
    });
  });

  describe('Cleanup enabled', () => {
    it('should delete from state table when enableCleanup is true', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: {
          connectionString,
          enableCleanup: true,
        },
      });

      const testData: TestContext = {
        executionStatus: 'pending',
      };

      await memory.write('test-subject', testData, null, metadata);
      await memory.cleanup('test-subject');

      const client = new Client({ connectionString });
      await client.connect();

      const stateResult = await client.query(
        `SELECT * FROM ${testTables.state} WHERE subject = $1`,
        ['test-subject'],
      );

      await client.end();

      expect(stateResult.rows.length).toBe(0);

      await releasePostgressMachineMemory(memory);
    });

    it('should delete from lock table when enableCleanup is true', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: {
          connectionString,
          enableCleanup: true,
        },
      });

      const testData: TestContext = {
        executionStatus: 'pending',
      };

      await memory.write('test-subject', testData, null, metadata);
      await memory.lock('test-subject');
      await memory.cleanup('test-subject');

      const client = new Client({ connectionString });
      await client.connect();

      const lockResult = await client.query(`SELECT * FROM ${testTables.lock} WHERE subject = $1`, [
        'test-subject',
      ]);

      await client.end();

      expect(lockResult.rows.length).toBe(0);

      await releasePostgressMachineMemory(memory);
    });

    it('should delete from hierarchy table when enableCleanup is true', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: {
          connectionString,
          enableCleanup: true,
        },
      });

      const testData: TestContext = {
        executionStatus: 'pending',
      };

      await memory.write('test-subject', testData, null, metadata);
      await memory.cleanup('test-subject');

      const client = new Client({ connectionString });
      await client.connect();

      const hierarchyResult = await client.query(
        `SELECT * FROM ${testTables.hierarchy} WHERE subject = $1`,
        ['test-subject'],
      );

      await client.end();

      expect(hierarchyResult.rows.length).toBe(0);

      await releasePostgressMachineMemory(memory);
    });

    it('should delete from all tables simultaneously', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: {
          connectionString,
          enableCleanup: true,
        },
      });

      const testData: TestContext = {
        executionStatus: 'pending',
      };

      await memory.write('test-subject', testData, null, metadata);
      await memory.lock('test-subject');
      await memory.cleanup('test-subject');

      const client = new Client({ connectionString });
      await client.connect();

      const stateResult = await client.query(
        `SELECT * FROM ${testTables.state} WHERE subject = $1`,
        ['test-subject'],
      );
      const lockResult = await client.query(`SELECT * FROM ${testTables.lock} WHERE subject = $1`, [
        'test-subject',
      ]);
      const hierarchyResult = await client.query(
        `SELECT * FROM ${testTables.hierarchy} WHERE subject = $1`,
        ['test-subject'],
      );

      await client.end();

      expect(stateResult.rows.length).toBe(0);
      expect(lockResult.rows.length).toBe(0);
      expect(hierarchyResult.rows.length).toBe(0);

      await releasePostgressMachineMemory(memory);
    });
  });

  describe('Cleanup edge cases', () => {
    it('should succeed when cleaning up non-existent subject', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: {
          connectionString,
          enableCleanup: true,
        },
      });

      await expect(memory.cleanup('non-existent-subject')).resolves.not.toThrow();

      await releasePostgressMachineMemory(memory);
    });

    it('should not affect other workflows', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: {
          connectionString,
          enableCleanup: true,
        },
      });

      await memory.write('subject-1', { executionStatus: 'pending' }, null, metadata);

      await memory.write('subject-2', { executionStatus: 'pending' }, null, metadata);

      await memory.write('subject-3', { executionStatus: 'pending' }, null, metadata);

      await memory.cleanup('subject-2');

      const client = new Client({ connectionString });
      await client.connect();

      const subject1 = await client.query(`SELECT * FROM ${testTables.state} WHERE subject = $1`, [
        'subject-1',
      ]);
      const subject2 = await client.query(`SELECT * FROM ${testTables.state} WHERE subject = $1`, [
        'subject-2',
      ]);
      const subject3 = await client.query(`SELECT * FROM ${testTables.state} WHERE subject = $1`, [
        'subject-3',
      ]);

      await client.end();

      expect(subject1.rows.length).toBe(1);
      expect(subject2.rows.length).toBe(0);
      expect(subject3.rows.length).toBe(1);

      await releasePostgressMachineMemory(memory);
    });

    it('should handle cleanup of child workflow without affecting parent', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: {
          connectionString,
          enableCleanup: true,
        },
      });

      await memory.write('root-subject', { executionStatus: 'pending' }, null, metadata);

      await memory.write(
        'child-subject',
        { executionStatus: 'pending', parentSubject: 'root-subject' },
        null,
        metadata,
      );

      await memory.cleanup('child-subject');

      const client = new Client({ connectionString });
      await client.connect();

      const rootResult = await client.query(
        `SELECT * FROM ${testTables.state} WHERE subject = $1`,
        ['root-subject'],
      );
      const childResult = await client.query(
        `SELECT * FROM ${testTables.state} WHERE subject = $1`,
        ['child-subject'],
      );

      await client.end();

      expect(rootResult.rows.length).toBe(1);
      expect(childResult.rows.length).toBe(0);

      await releasePostgressMachineMemory(memory);
    });

    it('should handle cleanup of parent workflow without affecting children', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: {
          connectionString,
          enableCleanup: true,
        },
      });

      await memory.write('root-subject', { executionStatus: 'pending' }, null, metadata);

      await memory.write(
        'child-subject',
        { executionStatus: 'pending', parentSubject: 'root-subject' },
        null,
        metadata,
      );

      await memory.cleanup('root-subject');

      const client = new Client({ connectionString });
      await client.connect();

      const rootResult = await client.query(
        `SELECT * FROM ${testTables.state} WHERE subject = $1`,
        ['root-subject'],
      );
      const childResult = await client.query(
        `SELECT * FROM ${testTables.state} WHERE subject = $1`,
        ['child-subject'],
      );

      await client.end();

      expect(rootResult.rows.length).toBe(0);
      expect(childResult.rows.length).toBe(1);

      await releasePostgressMachineMemory(memory);
    });
  });

  describe('Cleanup idempotency', () => {
    it('should handle multiple cleanup calls on same subject', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: {
          connectionString,
          enableCleanup: true,
        },
      });

      await memory.write('test-subject', { executionStatus: 'pending' }, null, metadata);

      await memory.cleanup('test-subject');
      await memory.cleanup('test-subject');
      await memory.cleanup('test-subject');

      const client = new Client({ connectionString });
      await client.connect();

      const result = await client.query(`SELECT * FROM ${testTables.state} WHERE subject = $1`, [
        'test-subject',
      ]);

      await client.end();

      expect(result.rows.length).toBe(0);

      await releasePostgressMachineMemory(memory);
    });

    it('should handle cleanup after workflow already removed', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: {
          connectionString,
          enableCleanup: true,
        },
      });

      await memory.write('test-subject', { executionStatus: 'pending' }, null, metadata);

      await memory.cleanup('test-subject');

      const client = new Client({ connectionString });
      await client.connect();
      await client.query(`DELETE FROM ${testTables.state} WHERE subject = $1`, ['test-subject']);
      await client.end();

      await expect(memory.cleanup('test-subject')).resolves.not.toThrow();

      await releasePostgressMachineMemory(memory);
    });
  });
});
