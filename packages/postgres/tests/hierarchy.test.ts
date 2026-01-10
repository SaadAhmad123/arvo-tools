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
  executionStatus: string;
  parentSubject?: string;
};

describe('Hierarchy Tracking', () => {
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

  describe('Hierarchy creation', () => {
    it('should create hierarchy with root_subject = subject for root workflow', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const testData: TestContext = {
        executionStatus: 'pending',
      };

      await memory.write('root-subject', testData, null, metadata);

      const client = new Client({ connectionString });
      await client.connect();
      const result = await client.query(
        `SELECT root_subject FROM ${testTables.hierarchy} WHERE subject = $1`,
        ['root-subject'],
      );
      await client.end();

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].root_subject).toBe('root-subject');

      await releasePostgressMachineMemory(memory);
    });

    it('should have parent_subject = null for root workflow in hierarchy', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const testData: TestContext = {
        executionStatus: 'pending',
      };

      await memory.write('root-subject', testData, null, metadata);

      const client = new Client({ connectionString });
      await client.connect();
      const result = await client.query(
        `SELECT parent_subject FROM ${testTables.hierarchy} WHERE subject = $1`,
        ['root-subject'],
      );
      await client.end();

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].parent_subject).toBeNull();

      await releasePostgressMachineMemory(memory);
    });

    it('should inherit root_subject from parent for child workflow', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const rootData: TestContext = {
        executionStatus: 'pending',
      };

      await memory.write('root-subject', rootData, null, metadata);

      const childData: TestContext = {
        executionStatus: 'pending',
        parentSubject: 'root-subject',
      };

      await memory.write('child-subject', childData, null, metadata);

      const client = new Client({ connectionString });
      await client.connect();
      const result = await client.query(
        `SELECT root_subject FROM ${testTables.hierarchy} WHERE subject = $1`,
        ['child-subject'],
      );
      await client.end();

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].root_subject).toBe('root-subject');

      await releasePostgressMachineMemory(memory);
    });

    it('should set parent_subject correctly for child workflow', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const rootData: TestContext = {
        executionStatus: 'pending',
      };

      await memory.write('root-subject', rootData, null, metadata);

      const childData: TestContext = {
        executionStatus: 'pending',
        parentSubject: 'root-subject',
      };

      await memory.write('child-subject', childData, null, metadata);

      const client = new Client({ connectionString });
      await client.connect();
      const result = await client.query(
        `SELECT parent_subject FROM ${testTables.hierarchy} WHERE subject = $1`,
        ['child-subject'],
      );
      await client.end();

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].parent_subject).toBe('root-subject');

      await releasePostgressMachineMemory(memory);
    });

    it('should track root_subject correctly for grandchild (3 levels)', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      await memory.write('root-subject', { executionStatus: 'pending' }, null, metadata);

      await memory.write(
        'child-subject',
        { executionStatus: 'pending', parentSubject: 'root-subject' },
        null,
        metadata,
      );

      await memory.write(
        'grandchild-subject',
        { executionStatus: 'pending', parentSubject: 'child-subject' },
        null,
        metadata,
      );

      const client = new Client({ connectionString });
      await client.connect();
      const result = await client.query(
        `SELECT root_subject, parent_subject FROM ${testTables.hierarchy} WHERE subject = $1`,
        ['grandchild-subject'],
      );
      await client.end();

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].root_subject).toBe('root-subject');
      expect(result.rows[0].parent_subject).toBe('child-subject');

      await releasePostgressMachineMemory(memory);
    });
  });

  describe('getRootSubject', () => {
    it('should return root subject for child workflow', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      await memory.write('root-subject', { executionStatus: 'pending' }, null, metadata);

      await memory.write(
        'child-subject',
        { executionStatus: 'pending', parentSubject: 'root-subject' },
        null,
        metadata,
      );

      const rootSubject = await memory.getRootSubject('child-subject');

      expect(rootSubject).toBe('root-subject');

      await releasePostgressMachineMemory(memory);
    });

    it('should return itself for root workflow', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      await memory.write('root-subject', { executionStatus: 'pending' }, null, metadata);

      const rootSubject = await memory.getRootSubject('root-subject');

      expect(rootSubject).toBe('root-subject');

      await releasePostgressMachineMemory(memory);
    });

    it('should return null for non-existent subject', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const rootSubject = await memory.getRootSubject('non-existent-subject');

      expect(rootSubject).toBeNull();

      await releasePostgressMachineMemory(memory);
    });

    it('should return root for deeply nested workflow', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      await memory.write('root-subject', { executionStatus: 'pending' }, null, metadata);

      await memory.write(
        'child-subject',
        { executionStatus: 'pending', parentSubject: 'root-subject' },
        null,
        metadata,
      );

      await memory.write(
        'grandchild-subject',
        { executionStatus: 'pending', parentSubject: 'child-subject' },
        null,
        metadata,
      );

      await memory.write(
        'great-grandchild-subject',
        { executionStatus: 'pending', parentSubject: 'grandchild-subject' },
        null,
        metadata,
      );

      const rootSubject = await memory.getRootSubject('great-grandchild-subject');

      expect(rootSubject).toBe('root-subject');

      await releasePostgressMachineMemory(memory);
    });
  });

  describe('getSubjectsByRoot', () => {
    it('should return all children excluding root itself', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      await memory.write('root-subject', { executionStatus: 'pending' }, null, metadata);

      await memory.write(
        'child-1',
        { executionStatus: 'pending', parentSubject: 'root-subject' },
        null,
        metadata,
      );

      await memory.write(
        'child-2',
        { executionStatus: 'pending', parentSubject: 'root-subject' },
        null,
        metadata,
      );

      const children = await memory.getSubjectsByRoot('root-subject');

      expect(children).toHaveLength(2);
      expect(children).toContain('child-1');
      expect(children).toContain('child-2');
      expect(children).not.toContain('root-subject');

      await releasePostgressMachineMemory(memory);
    });

    it('should return empty array for childless root', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      await memory.write('root-subject', { executionStatus: 'pending' }, null, metadata);

      const children = await memory.getSubjectsByRoot('root-subject');

      expect(children).toHaveLength(0);

      await releasePostgressMachineMemory(memory);
    });

    it('should return all descendants in multi-level tree', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      await memory.write('root-subject', { executionStatus: 'pending' }, null, metadata);

      await memory.write(
        'child-1',
        { executionStatus: 'pending', parentSubject: 'root-subject' },
        null,
        metadata,
      );

      await memory.write(
        'child-2',
        { executionStatus: 'pending', parentSubject: 'root-subject' },
        null,
        metadata,
      );

      await memory.write(
        'grandchild-1-1',
        { executionStatus: 'pending', parentSubject: 'child-1' },
        null,
        metadata,
      );

      await memory.write(
        'grandchild-1-2',
        { executionStatus: 'pending', parentSubject: 'child-1' },
        null,
        metadata,
      );

      await memory.write(
        'grandchild-2-1',
        { executionStatus: 'pending', parentSubject: 'child-2' },
        null,
        metadata,
      );

      const descendants = await memory.getSubjectsByRoot('root-subject');

      expect(descendants).toHaveLength(5);
      expect(descendants).toContain('child-1');
      expect(descendants).toContain('child-2');
      expect(descendants).toContain('grandchild-1-1');
      expect(descendants).toContain('grandchild-1-2');
      expect(descendants).toContain('grandchild-2-1');
      expect(descendants).not.toContain('root-subject');

      await releasePostgressMachineMemory(memory);
    });

    it('should return empty array for non-existent root', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      const children = await memory.getSubjectsByRoot('non-existent-root');

      expect(children).toHaveLength(0);

      await releasePostgressMachineMemory(memory);
    });
  });

  describe('Multiple siblings', () => {
    it('should share same root_subject for multiple siblings', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      await memory.write('root-subject', { executionStatus: 'pending' }, null, metadata);

      await memory.write(
        'sibling-1',
        { executionStatus: 'pending', parentSubject: 'root-subject' },
        null,
        metadata,
      );

      await memory.write(
        'sibling-2',
        { executionStatus: 'pending', parentSubject: 'root-subject' },
        null,
        metadata,
      );

      await memory.write(
        'sibling-3',
        { executionStatus: 'pending', parentSubject: 'root-subject' },
        null,
        metadata,
      );

      const client = new Client({ connectionString });
      await client.connect();
      const result = await client.query(
        `SELECT subject, root_subject FROM ${testTables.hierarchy} WHERE parent_subject = $1`,
        ['root-subject'],
      );
      await client.end();

      expect(result.rows).toHaveLength(3);
      expect(result.rows.every((row) => row.root_subject === 'root-subject')).toBe(true);

      await releasePostgressMachineMemory(memory);
    });

    it('should maintain correct parent-child relationships with multiple siblings', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      await memory.write('root-subject', { executionStatus: 'pending' }, null, metadata);

      await memory.write(
        'child-1',
        { executionStatus: 'pending', parentSubject: 'root-subject' },
        null,
        metadata,
      );

      await memory.write(
        'child-2',
        { executionStatus: 'pending', parentSubject: 'root-subject' },
        null,
        metadata,
      );

      await memory.write(
        'grandchild-1-1',
        { executionStatus: 'pending', parentSubject: 'child-1' },
        null,
        metadata,
      );

      await memory.write(
        'grandchild-2-1',
        { executionStatus: 'pending', parentSubject: 'child-2' },
        null,
        metadata,
      );

      const root1 = await memory.getRootSubject('grandchild-1-1');
      const root2 = await memory.getRootSubject('grandchild-2-1');

      expect(root1).toBe('root-subject');
      expect(root2).toBe('root-subject');

      await releasePostgressMachineMemory(memory);
    });
  });

  describe('Hierarchy isolation', () => {
    it('should isolate different workflow trees', async () => {
      const memory = await connectPostgresMachineMemory<TestContext>({
        version: 1,
        tables: testTables,
        config: { connectionString },
      });

      await memory.write('root-1', { executionStatus: 'pending' }, null, metadata);

      await memory.write(
        'child-1-1',
        { executionStatus: 'pending', parentSubject: 'root-1' },
        null,
        metadata,
      );

      await memory.write('root-2', { executionStatus: 'pending' }, null, metadata);

      await memory.write(
        'child-2-1',
        { executionStatus: 'pending', parentSubject: 'root-2' },
        null,
        metadata,
      );

      const tree1 = await memory.getSubjectsByRoot('root-1');
      const tree2 = await memory.getSubjectsByRoot('root-2');

      expect(tree1).toHaveLength(1);
      expect(tree1).toContain('child-1-1');
      expect(tree1).not.toContain('child-2-1');

      expect(tree2).toHaveLength(1);
      expect(tree2).toContain('child-2-1');
      expect(tree2).not.toContain('child-1-1');

      await releasePostgressMachineMemory(memory);
    });
  });
});
