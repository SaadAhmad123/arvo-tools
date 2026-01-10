import type { PostgressConnectionConfig } from '../types';
import type { PostgressMachineMemoryV1 } from '../v1';
import type { PostgressMachineMemoryV1Param } from '../v1/types';

/**
 * Configuration parameters for connecting a PostgreSQL-backed machine memory instance.
 */
export type ConnectPostgresMachineMemoryParam = {
  /**
   * Schema version of the PostgreSQL machine memory implementation.
   * Currently only version 1 is supported.
   */
  version: 1;
  /**
   * Names of the PostgreSQL tables used by the machine memory.
   * These tables must exist and match the expected schema structure.
   */
  tables?: PostgressMachineMemoryV1Param['tables'];
} & {
  /** PostgreSQL connection and behavioral configuration */
  config: PostgressConnectionConfig;
  /**
   * Database migration strategy when connecting to PostgreSQL machine memory.
   *
   * - `'if_tables_dont_exist'`: Creates tables if they don't exist. Safe for production use.
   * - `'dangerousely_force_migration'`: Drops and recreates all tables, destroying existing data. **DANGEROUS** - use only in development/testing.
   * - [DEFAULT] `'noop'`: No migration performed. Tables must already exist with correct schema or connection will fail during validation.
   *
   * @default 'noop'
   */
  migrate?: 'if_tables_dont_exist' | 'dangerousely_force_migration' | 'noop';
};

/**
 * Type alias for PostgreSQL-backed machine memory instances.
 *
 * Provides a version-agnostic interface for PostgreSQL machine memory,
 * abstracting the underlying implementation version from consumers.
 */
export type PostgresMachineMemory<T extends Record<string, unknown> = Record<string, unknown>> =
  PostgressMachineMemoryV1<T>;
