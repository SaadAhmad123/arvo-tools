import type { ArvoEvent } from 'arvo-core';
import type { Job, QueuePolicy } from 'pg-boss';

/**
 * Job-level options that control how individual jobs are processed by PgBoss.
 * These options are applied when sending jobs to queues.
 */
export type WorkerJobOptions = {
  /** Job priority. Higher numbers have higher priority */
  priority?: number;
  /** Number of retries to complete a job. Default: 2 */
  retryLimit?: number;
  /** Delay between retries of failed jobs, in seconds. Default: 0 */
  retryDelay?: number;
  /** Enables exponential backoff retries based on retryDelay. Default: false */
  retryBackoff?: boolean;
  /** Maximum delay between retries when retryBackoff is true, in seconds */
  retryDelayMax?: number;
  /** How many seconds a job may be in active state before being retried or failed. Default: 15 minutes */
  expireInSeconds?: number;
  /** How many seconds a job may be in created or retry state before deletion. Default: 14 days */
  retentionSeconds?: number;
  /** How long a job should be retained after completion, in seconds. Default: 7 days */
  deleteAfterSeconds?: number;
  /** Delay job execution. Can be seconds (number), ISO 8601 string, or Date object */
  startAfter?: number | string | Date;
  /** Throttle to one job per time slot, in seconds */
  singletonSeconds?: number;
  /** Schedule throttled job for next time slot. Default: false */
  singletonNextSlot?: boolean;
  /** Extend throttling to allow one job per key within the time slot */
  singletonKey?: string;
};

/**
 * Worker-level configuration options that control how the worker processes jobs.
 * These options are not sent with individual jobs.
 */
export type WorkerConfigOptions = {
  /** Polling interval for checking new jobs, in seconds. Default: 2 */
  pollingIntervalSeconds?: number;
  /** Number of concurrent worker instances to spawn for this handler. Default: 1 */
  concurrency?: number;
  /**
   * Error handler callback that determines job retry behavior.
   * @param job - The job that encountered an error
   * @param error - The error that occurred
   * @returns 'RETRY' to retry the job, 'IGNORE' to skip, or 'FAIL' to mark as failed
   */
  onError?: (
    job: Job<ReturnType<ArvoEvent['toJSON']>>,
    error: Error,
  ) => PromiseLike<'RETRY' | 'IGNORE' | 'FAIL'>;
};

/**
 * Combined worker options including both configuration and job-level settings.
 */
export type WorkerOptions = WorkerConfigOptions & WorkerJobOptions;

/**
 * Queue configuration options that define queue behavior and policies.
 */
export type QueueOptions = {
  /** Queue policy determining job uniqueness and processing behavior */
  policy?: QueuePolicy;
  /** Enable queue partitioning for scalability */
  partition?: boolean;
  /** Name of the dead letter queue for failed jobs */
  deadLetter?: string;
  /** Queue size threshold for warnings */
  warningQueueSize?: number;
};

/**
 * Options for registering an event handler with the ArvoPgBoss system.
 */
export type HandlerRegistrationOptions = {
  /** Delete and recreate the queue before registration. Default: false */
  recreateQueue?: boolean;
  /** Queue-level configuration options */
  queue?: QueueOptions;
  /** Worker-level configuration and job options */
  worker?: WorkerOptions;
};
