import { Client } from 'pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  connectPostgresMachineMemory,
  createPostgresMachineMemoryTables,
  releasePostgressMachineMemory,
} from '../src';

const connectionString = process.env.ARVO_POSTGRES_CONNECTION_STRING ?? '';
const testDbConfig = {
  host: process.env.ARVO_POSTGRES_HOST || 'localhost',
  port: Number.parseInt(process.env.ARVO_POSTGRES_PORT || '5432', 10),
  user: process.env.ARVO_POSTGRES_USER || 'arvo',
  password: process.env.ARVO_POSTGRES_PASSWORD || 'arvo',
  database: process.env.ARVO_POSTGRES_DB || 'arvo',
};

const testTables = {
  state: 'machine_memory_state',
  lock: 'machine_memory_lock',
  hierarchy: 'machine_memory_hierarchy',
};

describe('connectPostgresMachineMemory - Connection Factory Tests', () => {
  beforeAll(async () => {
    await createPostgresMachineMemoryTables(connectionString, {
      version: 1,
      tables: testTables,
      dangerouslyDropTablesIfExist: true,
    });
  });

  beforeEach(async () => {
    await createPostgresMachineMemoryTables(connectionString, {
      version: 1,
      tables: testTables,
      dangerouslyDropTablesIfExist: true,
    });
  });

  describe('Connection with connection string', () => {
    it('should successfully connect and return valid memory instance', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: {
          connectionString: connectionString,
        },
      });

      expect(memory).toBeDefined();
      expect(memory.read).toBeDefined();
      expect(memory.write).toBeDefined();
      expect(memory.lock).toBeDefined();
      expect(memory.unlock).toBeDefined();
      expect(memory.cleanup).toBeDefined();

      await releasePostgressMachineMemory(memory);
    });
  });

  describe('Connection with individual config parameters', () => {
    it('should successfully connect with host, port, user, password, database', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: {
          host: testDbConfig.host,
          port: testDbConfig.port,
          user: testDbConfig.user,
          password: testDbConfig.password,
          database: testDbConfig.database,
        },
      });

      expect(memory).toBeDefined();
      expect(memory.read).toBeDefined();
      expect(memory.write).toBeDefined();

      await releasePostgressMachineMemory(memory);
    });
  });

  describe('Table validation', () => {
    it('should validate all three tables exist', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: {
          connectionString: connectionString,
        },
      });

      expect(memory).toBeDefined();
      await releasePostgressMachineMemory(memory);
    });

    it('should fail if state table is missing', async () => {
      const client = new Client({ connectionString: connectionString });
      await client.connect();
      await client.query(`DROP TABLE IF EXISTS ${testTables.state} CASCADE;`);
      await client.end();

      await expect(
        connectPostgresMachineMemory({
          version: 1,
          tables: testTables,
          config: {
            connectionString: connectionString,
          },
        }),
      ).rejects.toThrow(/does not exist/i);
    });

    it('should fail if lock table is missing', async () => {
      const client = new Client({ connectionString: connectionString });
      await client.connect();
      await client.query(`DROP TABLE IF EXISTS ${testTables.lock} CASCADE;`);
      await client.end();

      await expect(
        connectPostgresMachineMemory({
          version: 1,
          tables: testTables,
          config: {
            connectionString: connectionString,
          },
        }),
      ).rejects.toThrow(/does not exist/i);
    });

    it('should fail if hierarchy table is missing', async () => {
      const client = new Client({ connectionString: connectionString });
      await client.connect();
      await client.query(`DROP TABLE IF EXISTS ${testTables.hierarchy} CASCADE;`);
      await client.end();

      await expect(
        connectPostgresMachineMemory({
          version: 1,
          tables: testTables,
          config: {
            connectionString: connectionString,
          },
        }),
      ).rejects.toThrow(/does not exist/i);
    });

    it('should fail if column has wrong data type', async () => {
      const client = new Client({ connectionString: connectionString });
      await client.connect();
      await client.query(`ALTER TABLE ${testTables.state} ALTER COLUMN version TYPE VARCHAR(255);`);
      await client.end();

      await expect(
        connectPostgresMachineMemory({
          version: 1,
          tables: testTables,
          config: {
            connectionString: connectionString,
          },
        }),
      ).rejects.toThrow(/validation failed/i);
    });

    it('should fail if required column is missing', async () => {
      const client = new Client({ connectionString: connectionString });
      await client.connect();
      await client.query(`ALTER TABLE ${testTables.state} DROP COLUMN execution_status;`);
      await client.end();

      await expect(
        connectPostgresMachineMemory({
          version: 1,
          tables: testTables,
          config: {
            connectionString: connectionString,
          },
        }),
      ).rejects.toThrow(/validation failed/i);
    });
  });

  describe('Release connection', () => {
    it('should close connection pool successfully', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: {
          connectionString: connectionString,
        },
      });

      await releasePostgressMachineMemory(memory);

      await expect(memory.read('test-subject')).rejects.toThrow();
    });
  });

  describe('Version support', () => {
    it('should throw error for unsupported version', async () => {
      await expect(
        connectPostgresMachineMemory({
          // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
          version: 999 as any,
          tables: testTables,
          config: {
            connectionString: connectionString,
          },
        }),
      ).rejects.toThrow(/Unsupported PostgreSQL machine memory version/i);
    });
  });

  describe('Default table names', () => {
    it('should use default table names when tables parameter is not provided', async () => {
      await createPostgresMachineMemoryTables(connectionString, {
        version: 1,
        dangerouslyDropTablesIfExist: true,
      });

      const memory = await connectPostgresMachineMemory({
        version: 1,
        config: {
          connectionString: connectionString,
        },
      });

      expect(memory).toBeDefined();

      await releasePostgressMachineMemory(memory);
    });
  });

  describe('Custom configuration', () => {
    it('should accept connection pool config', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: {
          connectionString: connectionString,
          max: 5,
          idleTimeoutMillis: 10000,
          connectionTimeoutMillis: 3000,
        },
      });

      expect(memory).toBeDefined();
      await releasePostgressMachineMemory(memory);
    });

    it('should accept lock config', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: {
          connectionString: connectionString,
          lockConfig: {
            maxRetries: 5,
            initialDelayMs: 50,
            backoffExponent: 2,
            ttlMs: 60000,
          },
        },
      });

      expect(memory).toBeDefined();
      await releasePostgressMachineMemory(memory);
    });

    it('should accept enableCleanup flag', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: {
          connectionString: connectionString,
          enableCleanup: true,
        },
      });

      expect(memory).toBeDefined();
      await releasePostgressMachineMemory(memory);
    });

    it('should accept enableOtel flag', async () => {
      const memory = await connectPostgresMachineMemory({
        version: 1,
        tables: testTables,
        config: {
          connectionString: connectionString,
          enableOtel: true,
        },
      });

      expect(memory).toBeDefined();
      await releasePostgressMachineMemory(memory);
    });
  });
});
