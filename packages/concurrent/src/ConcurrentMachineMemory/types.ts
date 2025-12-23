/**
 * Configuration options for ConcurrentMachineMemory.
 */
export type ConcurrentMachineMemoryConfig = {
  /**
   * Whether to enable automatic cleanup of memory and locks when cleanup() is called.
   * @default true
   */
  enableCleanup?: boolean;

  /**
   * Maximum number of retry attempts when acquiring a lock.
   * @default 3
   */
  lockMaxRetries?: number;

  /**
   * Initial delay in milliseconds before the first retry attempt.
   * @default 100
   */
  lockInitialDelayMs?: number;

  /**
   * Exponential backoff multiplier for retry delays.
   * Each retry waits lockInitialDelayMs * (lockBackoffExponent ^ attemptNumber).
   * @default 2
   */
  lockBackoffExponent?: number;

  /**
   * Time-to-live in milliseconds for acquired locks.
   * Locks held longer than this duration are considered expired and automatically released.
   * @default 120000 (2 minutes)
   */
  lockTTLMs?: number;
};
