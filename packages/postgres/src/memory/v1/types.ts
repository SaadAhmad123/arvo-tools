import type { PostgressConnectionConfig } from '../types';

/**
 * Configuration parameters for PostgreSQL machine memory version 1 implementation.
 *
 * Defines the database table names and connection settings required to instantiate
 * a PostgreSQL-backed workflow state management system with distributed locking
 * and hierarchical workflow tracking capabilities.
 */
export type PostgressMachineMemoryV1Param = {
  /**
   * Names of the PostgreSQL tables used by the machine memory system.
   * These tables must exist in the database and conform to the expected schema.
   */
  tables: {
    /** Table name for storing workflow state and metadata */
    state: string;
    /** Table name for managing distributed locks */
    lock: string;
    /** Table name for tracking workflow hierarchy relationships */
    hierarchy: string;
  };
  /**
   * Optional PostgreSQL connection and behavioral configuration.
   * If not provided, defaults will be used for all settings.
   */
  config?: PostgressConnectionConfig;
};
