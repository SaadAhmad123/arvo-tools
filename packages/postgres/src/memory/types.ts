/**
 * PostgreSQL connection configuration for machine memory.
 *
 * Supports two connection modes:
 * - Connection string: A single URL containing all connection parameters
 * - Individual parameters: Separate host, port, user, password, and database fields
 */
export type PostgressConnectionConfig = (
  | {
      /** PostgreSQL connection string (e.g., "postgresql://user:password@localhost:5432/dbname") */
      connectionString: string;
    }
  | {
      /** Database host address. Defaults to "localhost" */
      host?: string;
      /** Database port. Defaults to 5432 */
      port?: number;
      /** Database user. Defaults to "postgres" */
      user?: string;
      /** Database password. Defaults to "postgres" */
      password?: string;
      /** Database name. Defaults to "postgres" */
      database?: string;
    }
) & {
  /** Maximum number of clients in the connection pool. Defaults to 10 */
  max?: number;
  /** Time in milliseconds a client must sit idle before being removed from pool. Defaults to 30000 (30 seconds) */
  idleTimeoutMillis?: number;
  /** Time in milliseconds to wait for a connection from the pool. Defaults to 5000 (5 seconds) */
  connectionTimeoutMillis?: number;
  /** Time in milliseconds before a statement in a query is cancelled. Optional */
  statementTimeoutMillis?: number;
  /** Time in milliseconds before a query is cancelled. Optional */
  queryTimeoutMillis?: number;
  /** Configuration for distributed locking behavior */
  lockConfig?: {
    /** Maximum number of lock acquisition retry attempts. Defaults to 3 */
    maxRetries?: number;
    /** Initial delay in milliseconds before first retry. Defaults to 100 */
    initialDelayMs?: number;
    /** Exponential backoff multiplier for subsequent retries. Defaults to 1.5 */
    backoffExponent?: number;
    /** Lock time-to-live in milliseconds. Prevents deadlocks via automatic expiration. Defaults to 120000 (2 minutes) */
    ttlMs?: number;
  };
  /** Whether to enable automatic cleanup of completed workflows. Defaults to false */
  enableCleanup?: boolean;
  /** Whether to enable OpenTelemetry tracing. Defaults to false */
  enableOtel?: boolean;
};
