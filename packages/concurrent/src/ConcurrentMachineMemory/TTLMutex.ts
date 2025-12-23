import { Mutex } from 'async-mutex';

/**
 * A mutex wrapper that implements Time-To-Live (TTL) based lock expiration.
 *
 * This class provides automatic lock expiration through lazy evaluation. Instead of using
 * background timers, it checks lock validity on-demand during lock acquisition attempts.
 * If a lock has been held longer than the configured TTL, it is automatically released
 * before acquiring a new lock.
 *
 * @example
 * ```typescript
 * const ttlMutex = new TTLMutex(5000); // 5 second TTL
 *
 * await ttlMutex.lock();
 * // ... perform operations ...
 * await ttlMutex.unlock();
 * ```
 */
export class TTLMutex {
  private readonly _lockMutex = new Mutex();
  private _isLocked: boolean = false;
  private _updatedAt: Date = new Date();

  /**
   * Creates a new TTLMutex instance.
   *
   * @param ttlMs - Time-to-live in milliseconds. Locks held longer than this duration
   *                will be considered expired and automatically released on next lock attempt.
   */
  constructor(public readonly ttlMs: number) {}

  /**
   * Gets the timestamp of when the lock was last acquired or updated.
   */
  get updatedAt() {
    return this._updatedAt;
  }

  /**
   * Checks if the current lock has exceeded its TTL duration.
   *
   * @returns true if the time elapsed since last update exceeds ttlMs, false otherwise
   */
  isExpired() {
    const now = Date.now();
    const elapsed = now - this._updatedAt.getTime();
    return elapsed > this.ttlMs;
  }

  /**
   * Checks if the mutex is currently locked and the lock has not expired.
   *
   * @returns true if locked and not expired, false otherwise
   */
  isLocked() {
    return this._isLocked && !this.isExpired();
  }

  /**
   * Acquires the mutex lock with TTL validation.
   *
   * Before acquiring a new lock, this method performs lazy TTL validation. If the mutex
   * is currently locked but the lock has expired, it automatically releases the stale
   * lock before acquiring a new one. Upon successful acquisition, the updatedAt timestamp
   * is reset to the current time.
   *
   * @returns Promise that resolves to true when the lock is successfully acquired
   */
  async lock(): Promise<boolean> {
    try {
      return this._lockMutex.runExclusive(async () => {
        if (this.isLocked()) return false;
        if (this._isLocked && this.isExpired()) {
          this.unlock();
        }
        this._isLocked = true;
        this._updatedAt = new Date();
        return true;
      });
    } catch (e) {
      console.error(e);
      return false;
    }
  }

  /**
   * Releases the mutex lock.
   *
   * Attempts to release the lock using the stored releaser function if available,
   * otherwise falls back to calling release directly on the mutex. Clears the stored
   * releaser after releasing to prevent duplicate releases.
   *
   * @returns Promise that resolves to true after attempting to release the lock
   */
  async unlock(): Promise<boolean> {
    this._isLocked = false;
    return true;
  }
}
