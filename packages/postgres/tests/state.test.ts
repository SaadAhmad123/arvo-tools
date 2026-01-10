import { Materialized } from 'arvo-event-handler';
import { Client } from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { connectPostgresMachineMemory, releasePostgressMachineMemory } from '../src';

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
  numbers: number[];
  sum: number | null;
  average: number | null;
  executionStatus?: string;
  parentSubject?: string;
};

describe('State Management - Read/Write Operations', () => {
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

  describe('Read operations', () => {
    it('should return null for non-existent subject', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const result = await memory.read('non-existent-subject');

      expect(result).toBeNull();

      await releasePostgressMachineMemory(memory);
    });

    it('should return data with version for existing subject', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const testData: TestContext = {
        numbers: [1, 2, 3],
        sum: null,
        average: null,
        executionStatus: 'pending',
      };

      await memory.write('test-subject', testData, null, metadata);

      const result = await memory.read('test-subject');

      expect(result).toBeDefined();
      expect(result?.numbers).toEqual([1, 2, 3]);
      expect(result?.sum).toBeNull();
      expect(result?.average).toBeNull();
      // biome-ignore lint/suspicious/noExplicitAny: Need to be general
      expect((result as any).__postgres_version_counter_data_$$__).toBe(1);

      await releasePostgressMachineMemory(memory);
    });
  });

  describe('Write operations - Insert', () => {
    it('should create new workflow with prevData = null', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const testData: TestContext = {
        numbers: [1, 2, 3],
        sum: null,
        average: null,
        executionStatus: 'pending',
      };

      await memory.write('test-subject', testData, null, metadata);

      const result = await memory.read('test-subject');

      expect(result).toBeDefined();
      expect(result?.numbers).toEqual([1, 2, 3]);

      await releasePostgressMachineMemory(memory);
    });

    it('should store execution_status correctly', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const testData: TestContext = {
        numbers: [1, 2, 3],
        sum: null,
        average: null,
        executionStatus: 'running',
      };

      await memory.write('test-subject', testData, null, metadata);

      const client = new Client({ connectionString });
      await client.connect();
      const result = await client.query(
        `SELECT execution_status FROM ${testTables.state} WHERE subject = $1`,
        ['test-subject'],
      );
      await client.end();

      expect(result.rows[0].execution_status).toBe('running');

      await releasePostgressMachineMemory(memory);
    });

    it('should store parent_subject as null for root workflow', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const testData: TestContext = {
        numbers: [1, 2, 3],
        sum: null,
        average: null,
        executionStatus: 'pending',
      };

      await memory.write('root-subject', testData, null, metadata);

      const client = new Client({ connectionString });
      await client.connect();
      const result = await client.query(
        `SELECT parent_subject FROM ${testTables.state} WHERE subject = $1`,
        ['root-subject'],
      );
      await client.end();

      expect(result.rows[0].parent_subject).toBeNull();

      await releasePostgressMachineMemory(memory);
    });

    it('should store parent_subject correctly for child workflow', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const testData: TestContext = {
        numbers: [1, 2, 3],
        sum: null,
        average: null,
        executionStatus: 'pending',
        parentSubject: 'parent-subject',
      };

      await memory.write('child-subject', testData, null, metadata);

      const client = new Client({ connectionString });
      await client.connect();
      const result = await client.query(
        `SELECT parent_subject FROM ${testTables.state} WHERE subject = $1`,
        ['child-subject'],
      );
      await client.end();

      expect(result.rows[0].parent_subject).toBe('parent-subject');

      await releasePostgressMachineMemory(memory);
    });

    it('should store initiator when resolved', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const testData: TestContext = {
        numbers: [1, 2, 3],
        sum: null,
        average: null,
        executionStatus: 'pending',
      };

      await memory.write('test-subject', testData, null, {
        ...metadata,
        initiator: Materialized.resolved('user-123'),
      });

      const client = new Client({ connectionString });
      await client.connect();
      const result = await client.query(
        `SELECT initiator FROM ${testTables.state} WHERE subject = $1`,
        ['test-subject'],
      );
      await client.end();

      expect(result.rows[0].initiator).toBe('user-123');

      await releasePostgressMachineMemory(memory);
    });

    it('should store initiator as null when unresolved', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const testData: TestContext = {
        numbers: [1, 2, 3],
        sum: null,
        average: null,
        executionStatus: 'pending',
      };

      await memory.write('test-subject', testData, null, {
        ...metadata,
        initiator: Materialized.pending(),
      });

      const client = new Client({ connectionString });
      await client.connect();
      const result = await client.query(
        `SELECT initiator FROM ${testTables.state} WHERE subject = $1`,
        ['test-subject'],
      );
      await client.end();

      expect(result.rows[0].initiator).toBeNull();

      await releasePostgressMachineMemory(memory);
    });

    it('should store source correctly', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const testData: TestContext = {
        numbers: [1, 2, 3],
        sum: null,
        average: null,
        executionStatus: 'pending',
      };

      await memory.write('test-subject', testData, null, {
        ...metadata,
        source: 'my-orchestrator',
      });

      const client = new Client({ connectionString });
      await client.connect();
      const result = await client.query(
        `SELECT source FROM ${testTables.state} WHERE subject = $1`,
        ['test-subject'],
      );
      await client.end();

      expect(result.rows[0].source).toBe('my-orchestrator');

      await releasePostgressMachineMemory(memory);
    });
  });

  describe('Write operations - Update', () => {
    it('should update existing workflow and increment version', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const initialData: TestContext = {
        numbers: [1, 2, 3],
        sum: null,
        average: null,
        executionStatus: 'pending',
      };

      await memory.write('test-subject', initialData, null, metadata);

      const readData = await memory.read('test-subject');

      const updatedData: TestContext = {
        ...initialData,
        sum: 6,
        executionStatus: 'completed',
      };

      // biome-ignore lint/suspicious/noExplicitAny: Need to be general
      await memory.write('test-subject', updatedData, readData as any, metadata);

      const finalData = await memory.read('test-subject');

      expect(finalData?.sum).toBe(6);
      expect(finalData?.executionStatus).toBe('completed');
      // biome-ignore lint/suspicious/noExplicitAny: Need to be general
      expect((finalData as any).__postgres_version_counter_data_$$__).toBe(2);

      await releasePostgressMachineMemory(memory);
    });

    it('should throw error with stale version (optimistic locking)', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const initialData: TestContext = {
        numbers: [1, 2, 3],
        sum: null,
        average: null,
        executionStatus: 'pending',
      };

      await memory.write('test-subject', initialData, null, metadata);

      const readData1 = await memory.read('test-subject');
      const readData2 = await memory.read('test-subject');

      // biome-ignore lint/suspicious/noExplicitAny: Need to be general
      await memory.write('test-subject', { ...initialData, sum: 6 }, readData1 as any, metadata);

      await expect(
        // biome-ignore lint/suspicious/noExplicitAny: Need to be general
        memory.write('test-subject', { ...initialData, sum: 10 }, readData2 as any, metadata),
      ).rejects.toThrow(/version mismatch/i);

      await releasePostgressMachineMemory(memory);
    });

    it('should handle concurrent writes - second write fails', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const initialData: TestContext = {
        numbers: [1, 2, 3],
        sum: null,
        average: null,
        executionStatus: 'pending',
      };

      await memory.write('test-subject', initialData, null, metadata);

      const readData = await memory.read('test-subject');

      const write1 = memory.write(
        'test-subject',
        { ...initialData, sum: 6 },
        // biome-ignore lint/suspicious/noExplicitAny: Need to be general
        readData as any,
        metadata,
      );

      const write2 = memory.write(
        'test-subject',
        { ...initialData, sum: 10 },
        // biome-ignore lint/suspicious/noExplicitAny: Need to be general
        readData as any,
        metadata,
      );

      const results = await Promise.allSettled([write1, write2]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      await releasePostgressMachineMemory(memory);
    });
  });

  describe('Complex data serialization', () => {
    it('should handle complex nested JSONB objects', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const complexData = {
        nested: {
          deep: {
            value: 123,
            array: [1, 2, 3],
            object: { key: 'value' },
          },
        },
        nullValue: null,
        boolValue: true,
        stringValue: 'test',
        executionStatus: 'pending',
      };

      await memory.write('complex-subject', complexData, null, metadata);

      const result = await memory.read('complex-subject');

      // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
      expect((result?.nested as any).deep.value).toBe(123);
      // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
      expect((result?.nested as any).deep.array).toEqual([1, 2, 3]);
      // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
      expect((result?.nested as any).deep.object).toEqual({ key: 'value' });
      expect(result?.nullValue).toBeNull();
      expect(result?.boolValue).toBe(true);
      expect(result?.stringValue).toBe('test');

      await releasePostgressMachineMemory(memory);
    });

    it('should handle empty object', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const emptyData = {
        executionStatus: 'pending',
      };

      await memory.write('empty-subject', emptyData, null, metadata);

      const result = await memory.read('empty-subject');

      expect(result).toBeDefined();
      expect(result?.executionStatus).toBe('pending');

      await releasePostgressMachineMemory(memory);
    });
  });
});
