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
  tables: PostgressMachineMemoryV1Param['tables'];
} & {
  /** PostgreSQL connection and behavioral configuration. Optional, uses defaults if not provided */
  config?: PostgressConnectionConfig;
};

/**
 * Type alias for PostgreSQL-backed machine memory instances.
 *
 * Provides a version-agnostic interface for PostgreSQL machine memory,
 * abstracting the underlying implementation version from consumers.
 */
export type PostgresMachineMemory<T extends Record<string, unknown> = Record<string, unknown>> =
  PostgressMachineMemoryV1<T>;
