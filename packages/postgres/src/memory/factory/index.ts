import { PostgressMachineMemoryV1 } from '../v1';
import { createTableV1 } from '../v1/helper';
import type { ConnectPostgresMachineMemoryParam, PostgresMachineMemory } from './type';

/**
 * Connects to and validates a PostgreSQL-backed machine memory instance.
 *
 * This function establishes a PostgreSQL connection pool, validates that the required
 * database tables exist with the correct schema, and returns a ready-to-use machine
 * memory instance for workflow state management.
 *
 * The connection pool will remain open until explicitly closed via `releasePostgressMachineMemory`.
 *
 * @param params - Configuration including version, table names, and connection settings
 * @returns A validated PostgreSQL machine memory instance with an active connection pool
 *
 * @throws Error if the specified version is not supported
 * @throws Error if table validation fails (missing tables or incorrect schema)
 * @throws Error if database connection fails
 *
 * @example
 * ```typescript
 * const memory = await connectPostgresMachineMemory({
 *   version: 1,
 *   tables: {
 *     state: 'machine_memory_state',
 *     lock: 'machine_memory_lock',
 *     hierarchy: 'machine_memory_hierarchy'
 *   },
 *   config: {
 *     connectionString: 'postgresql://user:pass@localhost:5432/mydb',
 *     enableCleanup: true,
 *     lockConfig: {
 *       maxRetries: 3,
 *       ttlMs: 120000
 *     }
 *   }
 * });
 *
 * // Use the memory instance...
 *
 * // Clean up when done
 * await releasePostgressMachineMemory(memory);
 * ```
 */
export const connectPostgresMachineMemory = async <
  T extends Record<string, unknown> = Record<string, unknown>,
>({
  version,
  tables,
  config,
}: ConnectPostgresMachineMemoryParam): Promise<PostgresMachineMemory<T>> => {
  if (version === 1) {
    const memory = new PostgressMachineMemoryV1<T>({
      tables,
      config,
    });
    await memory.validateTableStructure();
    return memory;
  }
  throw new Error(`Unsupported PostgreSQL machine memory version: ${version}`);
};

/**
 * Releases all resources held by a PostgreSQL machine memory instance.
 *
 * This function gracefully closes the underlying connection pool, releasing all database
 * connections and terminating any idle connections. Should be called when the machine
 * memory instance is no longer needed to prevent connection leaks and ensure proper
 * resource cleanup.
 *
 * After calling this function, the memory instance should not be used for any further operations.
 *
 * @param memory - The PostgreSQL machine memory instance to release
 */
export const releasePostgressMachineMemory = async (memory: PostgresMachineMemory) => {
  await memory.close();
};

/**
 * Dangerously migrates PostgreSQL machine memory tables to the specified version schema.
 *
 * ⚠️ **WARNING**: This function can DROP existing tables and all their data if `dropIfExist` is true.
 * Use with extreme caution, and never use it in production environments.
 *
 * This utility function creates the required database tables for the PostgreSQL machine memory
 * implementation. It supports version-specific schema creation and optionally drops existing
 * tables before recreating them.
 *
 * @param connectionString - PostgreSQL connection string (e.g., "postgresql://user:pass@localhost:5432/mydb")
 * @param config - Migration configuration
 *
 * @throws Error if the specified version is not supported
 * @throws Error if database connection fails
 * @throws Error if table creation fails
 */
export const dangerouslyMigratePostgresMachineMemory = async (
  connectionString: string,
  config: {
    version: ConnectPostgresMachineMemoryParam['version'];
    dropIfExist?: boolean;
  },
) => {
  if (config.version === 1) {
    createTableV1(connectionString, { dropIfExist: config.dropIfExist });
  }
  throw new Error(`Unsupported PostgreSQL machine memory version: ${config.version}`);
};
