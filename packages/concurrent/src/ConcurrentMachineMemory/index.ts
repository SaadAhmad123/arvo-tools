import { logToSpan } from 'arvo-core';
import type { IMachineMemory } from 'arvo-event-handler';
import { TTLMutex } from './TTLMutex';
import type { ConcurrentMachineMemoryConfig } from './types';

/**
 * In-process concurrent machine memory implementation with TTL-based locking.
 *
 * Provides concurrency-safe state management for workflow instances using TTL mutexes
 * to prevent race conditions during concurrent access. Each workflow instance is
 * identified by a unique ID and has isolated state and lock management.
 *
 * Key features include exponential backoff retry logic for lock acquisition, automatic
 * lock expiration via TTL to prevent deadlocks, deep cloning of stored data to prevent
 * unintended mutations, and per-instance lock isolation allowing concurrent execution
 * of different workflow instances.
 *
 * This implementation is designed for in-process concurrency only and does not provide
 * distributed locking across multiple processes or servers.
 *
 * @template T - The structure of workflow state data stored per instance
 *
 * @example
 * ```typescript
 * const memory = new ConcurrentMachineMemory({
 *   lockMaxRetries: 5,
 *   lockInitialDelayMs: 50,
 *   lockTTLMs: 300000
 * });
 *
 * // Acquire lock, modify state, release lock
 * const acquired = await memory.lock('workflow-123');
 * if (acquired) {
 *   const state = await memory.read('workflow-123');
 *   await memory.write('workflow-123', { ...state, updated: true });
 *   await memory.unlock('workflow-123');
 * }
 * ```
 */
export class ConcurrentMachineMemory<
  // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
  T extends Record<string, any> = Record<string, any>,
> implements IMachineMemory<T>
{
  private readonly memoryMap: Map<string, T> = new Map();
  private readonly lockMap: Map<string, TTLMutex> = new Map();
  readonly enableCleanup: boolean;
  readonly lockMaxRetries: number;
  readonly lockInitialDelayMs: number;
  readonly lockBackoffExponent: number;
  readonly lockTTLMs: number;

  /**
   * Creates a new ConcurrentMachineMemory instance.
   *
   * @param config - Configuration options for lock behavior and cleanup
   */
  constructor(config?: ConcurrentMachineMemoryConfig) {
    this.enableCleanup = config?.enableCleanup ?? true;
    this.lockMaxRetries = config?.lockMaxRetries ?? 3;
    this.lockInitialDelayMs = config?.lockInitialDelayMs ?? 100;
    this.lockBackoffExponent = config?.lockBackoffExponent ?? 1.5;
    this.lockTTLMs = config?.lockTTLMs ?? 120000;
  }

  /**
   * Retrieves or creates a TTLMutex for the specified workflow instance ID.
   */
  private getTTLMutex(id: string) {
    if (!this.lockMap.has(id)) {
      logToSpan({
        level: 'INFO',
        message: `Creating new TTLMutex for id: ${id}`,
      });
      this.lockMap.set(id, new TTLMutex(this.lockTTLMs));
    }
    // biome-ignore lint/style/noNonNullAssertion: This is fine
    return this.lockMap.get(id)!;
  }

  /**
   * Delays execution for the specified duration.
   */
  private async delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Retrieves persisted state for a specific workflow instance.
   *
   * Returns the stored state for the given workflow instance ID, or null if no
   * state exists. The returned data is the original stored reference, not a copy.
   */
  async read(id: string): Promise<T | null> {
    if (!id) {
      throw new Error('Machine ID is required for read operation');
    }

    const data = this.memoryMap.get(id) ?? null;
    logToSpan({
      level: 'INFO',
      message: `Read operation for id: ${id}, found: ${data !== null}`,
    });

    return data === null ? null : structuredClone(data);
  }

  /**
   * Persists updated state for a specific workflow instance.
   *
   * Stores a deep clone of the provided data to ensure isolation from external
   * mutations. The data is stored using structuredClone for complete deep copying
   * that preserves complex types like Date, Map, and Set.
   */
  async write(id: string, data: T): Promise<void> {
    if (!id) {
      throw new Error('Machine ID is required for write operation');
    }

    this.memoryMap.set(id, structuredClone(data));

    logToSpan({
      level: 'INFO',
      message: `Write operation completed for id: ${id}`,
    });
  }

  /**
   * Acquires exclusive execution lock for a workflow instance.
   *
   * Attempts to acquire a lock with exponential backoff retry logic. The lock
   * prevents concurrent processing of the same workflow instance across different
   * execution contexts. Implements a "fail fast" approach after exhausting retries.
   *
   * The method will retry up to lockMaxRetries times with exponentially increasing
   * delays between attempts. If the lock cannot be acquired after all retries,
   * returns false. TTL-based expiration ensures stale locks are automatically
   * released during acquisition attempts.
   *
   * @example
   * ```typescript
   * try {
   *    const acquired = await memory.lock('workflow-123');
   *    if (!acquired) {
   *      console.log('Could not acquire lock after retries');
   *      return;
   *    }
   *   // Perform locked operations
   * } finally {
   *   await memory.unlock('workflow-123');
   * }
   * ```
   */
  async lock(id: string): Promise<boolean> {
    if (!id) {
      throw new Error('Machine ID is required for lock operation');
    }

    logToSpan({
      level: 'INFO',
      message: `Attempting to acquire lock for id: ${id}`,
    });

    const ttlMutex = this.getTTLMutex(id);
    let attempt = 0;

    while (attempt <= this.lockMaxRetries) {
      try {
        const acquired = await ttlMutex.lock();
        if (acquired) {
          logToSpan({
            level: 'INFO',
            message: `Lock acquired for id: ${id} on attempt: ${attempt}`,
          });
          return true;
        }

        logToSpan({
          level: 'WARNING',
          message: `Lock not acquired for id: ${id} on attempt: ${attempt}`,
        });
      } catch (e) {
        logToSpan({
          level: 'ERROR',
          message: `[Attempt: ${attempt}] Unable to acquire lock for id: ${id}: ${
            (e as Error).message
          }`,
        });
      }

      if (attempt < this.lockMaxRetries) {
        const delayMs = this.lockInitialDelayMs * this.lockBackoffExponent ** attempt;

        logToSpan({
          level: 'INFO',
          message: `Retrying lock acquisition for id: ${id} after ${delayMs}ms delay`,
        });

        await this.delay(delayMs);
      }
      attempt++;

      if (attempt >= this.lockMaxRetries) {
        break;
      }
    }

    logToSpan({
      level: 'ERROR',
      message: `Failed to acquire lock for id: ${id} after ${this.lockMaxRetries} attempts`,
    });

    return false;
  }

  /**
   * Releases execution lock for a workflow instance.
   *
   * Releases the lock held for the specified workflow instance. This method is
   * tolerant of failures, always returning true even if the unlock operation fails,
   * since TTL-based expiration provides automatic recovery.
   *
   * @example
   * ```typescript
   * await memory.unlock('workflow-123');
   * ```
   */
  async unlock(id: string): Promise<boolean> {
    if (!id) {
      throw new Error('Machine ID is required for unlock operation');
    }

    const ttlMutex = this.lockMap.get(id);
    if (!ttlMutex) {
      logToSpan({
        level: 'INFO',
        message: `No lock found for id: ${id}, considering it already unlocked`,
      });
      return true;
    }

    try {
      const result = await ttlMutex.unlock();
      logToSpan({
        level: 'INFO',
        message: `Lock released for id: ${id}`,
      });
      return result;
    } catch (e) {
      logToSpan({
        level: 'WARNING',
        message: `Failed to release lock for id: ${id}: ${(e as Error).message}`,
      });
      return true;
    }
  }

  /**
   * Cleanup hook invoked during workflow completion.
   *
   * Removes the persisted state and lock for a completed workflow instance if
   * cleanup is enabled. This method is typically called automatically by the
   * orchestrator after a workflow reaches its final state.
   *
   * If enableCleanup is false, this method logs a message and returns without
   * performing any cleanup.
   */
  async cleanup(id: string): Promise<void> {
    if (!this.enableCleanup) {
      logToSpan({
        level: 'INFO',
        message: `Skipping cleanup for id: ${id} due to config setting`,
      });
      return;
    }

    this.memoryMap.delete(id);
    this.lockMap.delete(id);

    logToSpan({
      level: 'INFO',
      message: `Cleanup completed for id: ${id}`,
    });
  }

  /**
   * Clears all stored data and locks.
   *
   * Removes all workflow state and locks from memory. This is useful for testing
   * or complete system resets. This operation cannot be undone.
   */
  clear() {
    const memoryCount = this.memoryMap.size;
    const lockCount = this.lockMap.size;

    this.memoryMap.clear();
    this.lockMap.clear();

    logToSpan({
      level: 'INFO',
      message: `Cleared all data: ${memoryCount} memory entries and ${lockCount} locks removed`,
    });
  }
}
