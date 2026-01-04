import { type Span, SpanStatusCode } from '@opentelemetry/api';
import { ArvoOpenTelemetry } from 'arvo-core';
import { type IMachineMemory, type MachineMemoryMetadata, Materialized } from 'arvo-event-handler';
import { Pool, type PoolConfig } from 'pg';
import { validateTable } from './schema';
import type { PostgressMachineMemoryV1Param } from './types';

type VersionedData<T extends Record<string, unknown>> = T & {
  __postgres_version_counter_data_$$__: number;
};

/**
 * PostgreSQL-backed implementation of IMachineMemory for distributed workflow state management.
 *
 * This class provides persistent storage for workflow instances using PostgreSQL with the following features:
 * - Optimistic locking via version tracking to prevent concurrent state modifications
 * - Distributed lock management with TTL-based expiration to prevent deadlocks
 * - Hierarchical workflow tracking for parent-child relationship queries
 * - Optional cleanup of completed workflows
 * - Optional OpenTelemetry instrumentation for observability
 *
 * The implementation uses three database tables:
 * - State table: Stores workflow data, versions, execution status, and metadata
 * - Lock table: Manages distributed locks with automatic expiration
 * - Hierarchy table: Tracks workflow parent-child relationships and root subjects
 */
export class PostgressMachineMemoryV1<T extends Record<string, unknown>>
  implements IMachineMemory<T>
{
  private readonly tables: PostgressMachineMemoryV1Param['tables'];
  private readonly lockConfig: Required<
    NonNullable<NonNullable<PostgressMachineMemoryV1Param['config']>['lockConfig']>
  >;
  private readonly enableCleanup: NonNullable<
    NonNullable<PostgressMachineMemoryV1Param['config']>['enableCleanup']
  >;
  private readonly enableOtel: NonNullable<
    NonNullable<PostgressMachineMemoryV1Param['config']>['enableOtel']
  >;
  private readonly pool: Pool;

  constructor(param: PostgressMachineMemoryV1Param) {
    this.tables = param.tables;
    this.lockConfig = {
      maxRetries: param.config?.lockConfig?.maxRetries ?? 3,
      initialDelayMs: param.config?.lockConfig?.initialDelayMs ?? 100,
      backoffExponent: param.config?.lockConfig?.backoffExponent ?? 1.5,
      ttlMs: param.config?.lockConfig?.ttlMs ?? 120000,
    };
    this.enableCleanup = param.config?.enableCleanup ?? false;
    this.enableOtel = param.config?.enableOtel ?? false;
    let poolConfig: PoolConfig;
    if (param.config && 'connectionString' in param.config) {
      poolConfig = {
        connectionString: param.config.connectionString,
        max: param.config.max ?? 10,
        idleTimeoutMillis: param.config.idleTimeoutMillis ?? 30000,
        connectionTimeoutMillis: param.config.connectionTimeoutMillis ?? 5000,
        statement_timeout: param.config.statementTimeoutMillis ?? 30000,
        query_timeout: param.config.queryTimeoutMillis ?? 30000,
      };
    } else {
      const cfg = param.config;
      poolConfig = {
        host: cfg?.host ?? 'localhost',
        port: cfg?.port ?? 5432,
        user: cfg?.user ?? 'postgres',
        password: cfg?.password ?? 'postgres',
        database: cfg?.database ?? 'postgres',
        max: cfg?.max ?? 10,
        idleTimeoutMillis: cfg?.idleTimeoutMillis ?? 30000,
        connectionTimeoutMillis: cfg?.connectionTimeoutMillis ?? 5000,
        statement_timeout: cfg?.statementTimeoutMillis ?? 30000,
        query_timeout: cfg?.queryTimeoutMillis ?? 30000,
      };
    }
    this.pool = new Pool(poolConfig);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async validateTableStructure(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await Promise.all([
        validateTable(client, this.tables.state, 'state'),
        validateTable(client, this.tables.lock, 'lock'),
        validateTable(client, this.tables.hierarchy, 'hierarchy'),
      ]);
    } finally {
      client.release();
    }
  }

  async otel<R>({ name, fn }: { name: string; fn: (span?: Span) => Promise<R> }) {
    if (!this.enableOtel) {
      return await fn();
    }
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: name,
      disableSpanManagement: true,
      fn,
    });
  }

  async read(id: string): Promise<T | null> {
    return await this.otel({
      name: 'PostgresMachineMemory.v1.read',
      fn: async (span) => {
        span?.setStatus({ code: SpanStatusCode.OK });
        span?.setAttribute('subject', id);
        const client = await this.pool.connect();
        try {
          const result = await client.query(
            `SELECT data, version FROM ${this.tables.state} WHERE subject = $1`,
            [id],
          );
          if (!result.rows.length) {
            span?.setAttribute('available', 0);
            return null;
          }
          span?.setAttribute('available', 1);
          return {
            ...(result.rows[0].data ?? ({} as Record<string, unknown>)),
            __postgres_version_counter_data_$$__: result.rows[0].version,
          } as VersionedData<T>;
        } catch (error) {
          span?.setStatus({
            code: SpanStatusCode.ERROR,
            message: (error as Error).message,
          });
          throw error;
        } finally {
          client.release();
          span?.end();
        }
      },
    });
  }

  async write(
    id: string,
    data: T,
    prevData: VersionedData<T> | null,
    { source, initiator }: MachineMemoryMetadata,
  ): Promise<void> {
    return await this.otel({
      name: 'PostgresMachineMemory.v1.write',
      fn: async (span) => {
        span?.setStatus({ code: SpanStatusCode.OK });
        span?.setAttribute('subject', id);
        span?.setAttribute('isNew', prevData === null ? 1 : 0);
        const client = await this.pool.connect();
        const resolvedExectionStatus = data.executionStatus ?? 'unknown';
        try {
          if (prevData === null) {
            try {
              await client.query('BEGIN');
              const resolvedParentSubject = data.parentSubject ?? null;
              const resolvedInitiator = Materialized.isResolved(initiator) ? initiator.value : null;

              await client.query(
                `INSERT INTO ${this.tables.state} (subject, data, version, execution_status, parent_subject, initiator, source, created_at, updated_at)
              VALUES ($1, $2, 1, $3, $4, $5, $6, NOW(), NOW())`,
                [
                  id,
                  JSON.stringify(data),
                  resolvedExectionStatus,
                  resolvedParentSubject,
                  resolvedInitiator,
                  source,
                ],
              );
              let rootSubject: string;
              if (resolvedParentSubject === null) {
                rootSubject = id;
              } else {
                const parentResult = await client.query(
                  `SELECT root_subject FROM ${this.tables.hierarchy} WHERE subject = $1`,
                  [resolvedParentSubject],
                );
                rootSubject = parentResult.rows[0]?.root_subject ?? id;
              }
              await client.query(
                `INSERT INTO ${this.tables.hierarchy} (subject, parent_subject, root_subject, created_at)
              VALUES ($1, $2, $3, NOW())`,
                [id, resolvedParentSubject, rootSubject],
              );
              await client.query('COMMIT');
              return;
            } catch (error) {
              await client.query('ROLLBACK');
              span?.setStatus({
                code: SpanStatusCode.ERROR,
                message: (error as Error).message,
              });
              throw error;
            }
          }
          const currentVersion = prevData.__postgres_version_counter_data_$$__;
          const newVersion = currentVersion + 1;
          span?.setAttribute('version', newVersion);
          const result = await client.query(
            `UPDATE ${this.tables.state}
          SET data = $1, version = $2, execution_status = $3, updated_at = NOW()
          WHERE subject = $4 AND version = $5`,
            [JSON.stringify(data), newVersion, resolvedExectionStatus, id, currentVersion],
          );
          if (result.rowCount === 0) {
            const error = new Error(
              `Data is corrupted due to version mismatch for subject '${id}'. Expected version ${currentVersion} but state has been modified.`,
            );
            span?.setStatus({
              code: SpanStatusCode.ERROR,
              message: error.message,
            });
            throw error;
          }
        } catch (error) {
          span?.setStatus({
            code: SpanStatusCode.ERROR,
            message: (error as Error).message,
          });
          throw error;
        } finally {
          client.release();
          span?.end();
        }
      },
    });
  }

  async lock(id: string): Promise<boolean> {
    return await this.otel({
      name: 'PostgresMachineMemory.v1.lock',
      fn: async (span) => {
        span?.setStatus({ code: SpanStatusCode.OK });
        span?.setAttribute('subject', id);
        const client = await this.pool.connect();
        try {
          for (let attempt = 0; attempt <= this.lockConfig.maxRetries; attempt++) {
            try {
              const result = await client.query(
                `WITH arvo_lock_time AS (SELECT NOW() as now)
            INSERT INTO ${this.tables.lock} (subject, locked_at, expires_at, created_at)
            SELECT $1, now, now + ($2 || ' milliseconds')::INTERVAL, now FROM arvo_lock_time
            ON CONFLICT (subject) 
            DO UPDATE SET 
              locked_at = (SELECT now FROM arvo_lock_time), 
              expires_at = (SELECT now FROM arvo_lock_time) + ($2 || ' milliseconds')::INTERVAL
            WHERE ${this.tables.lock}.expires_at < (SELECT now FROM arvo_lock_time)
            RETURNING subject`,
                [id, this.lockConfig.ttlMs],
              );
              if (result.rowCount && result.rowCount > 0) {
                span?.setAttribute('acquired', 1);
                span?.setAttribute('attempts', attempt + 1);
                return true;
              }
              if (attempt < this.lockConfig.maxRetries) {
                const delayMs =
                  this.lockConfig.initialDelayMs * this.lockConfig.backoffExponent ** attempt;
                await this.delay(delayMs);
              }
            } catch (error) {
              span?.setStatus({
                code: SpanStatusCode.ERROR,
                message: (error as Error).message,
              });
              throw error;
            }
          }
          span?.setAttribute('acquired', 0);
          span?.setAttribute('attempts', this.lockConfig.maxRetries + 1);
          return false;
        } catch (error) {
          span?.setStatus({
            code: SpanStatusCode.ERROR,
            message: (error as Error).message,
          });
          throw error;
        } finally {
          client.release();
          span?.end();
        }
      },
    });
  }

  async unlock(id: string): Promise<boolean> {
    return await this.otel({
      name: 'PostgresMachineMemory.v1.unlock',
      fn: async (span) => {
        span?.setStatus({ code: SpanStatusCode.OK });
        span?.setAttribute('subject', id);
        const client = await this.pool.connect();
        try {
          await client.query(`DELETE FROM ${this.tables.lock} WHERE subject = $1`, [id]);
          return true;
        } catch (error) {
          span?.setStatus({
            code: SpanStatusCode.ERROR,
            message: (error as Error).message,
          });
          return true;
        } finally {
          client.release();
          span?.end();
        }
      },
    });
  }

  async cleanup(id: string): Promise<void> {
    return await this.otel({
      name: 'PostgresMachineMemory.v1.cleanup',
      fn: async (span) => {
        span?.setStatus({ code: SpanStatusCode.OK });
        span?.setAttribute('subject', id);
        if (!this.enableCleanup) {
          span?.setAttribute('skipped', 1);
          span?.end();
          return;
        }
        span?.setAttribute('skipped', 0);
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          await Promise.all([
            client.query(`DELETE FROM ${this.tables.state} WHERE subject = $1`, [id]),
            client.query(`DELETE FROM ${this.tables.lock} WHERE subject = $1`, [id]),
            client.query(`DELETE FROM ${this.tables.hierarchy} WHERE subject = $1`, [id]),
          ]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          span?.setStatus({
            code: SpanStatusCode.ERROR,
            message: (error as Error).message,
          });
          throw error;
        } finally {
          client.release();
          span?.end();
        }
      },
    });
  }

  /**
   * Retrieves all child workflow subjects belonging to a specific root workflow.
   *
   * This method queries the hierarchy table to find all workflows that are descendants
   * of the specified root workflow. The root subject itself is excluded from the results.
   *
   * @param rootSubject - The subject identifier of the root workflow
   * @returns Array of subject identifiers for all child workflows (excluding the root itself)
   *
   * @example
   * ```typescript
   * const subject = 'some_string'
   * const children = await memory.getSubjectsByRoot(subject);
   * console.log(`Found ${children.length} child workflows subjects`);
   * ```
   */
  async getSubjectsByRoot(rootSubject: string): Promise<string[]> {
    return await this.otel({
      name: 'PostgresMachineMemory.v1.getSubjectsByRoot',
      fn: async (span) => {
        span?.setStatus({ code: SpanStatusCode.OK });
        span?.setAttribute('rootSubject', rootSubject);
        const client = await this.pool.connect();
        try {
          const result = await client.query(
            `SELECT subject FROM ${this.tables.hierarchy} WHERE root_subject = $1`,
            [rootSubject],
          );
          const subjects = result.rows
            .map((row) => row.subject)
            .filter((item) => item !== rootSubject);
          span?.setAttribute('count', subjects.length);
          return subjects;
        } catch (error) {
          span?.setStatus({
            code: SpanStatusCode.ERROR,
            message: (error as Error).message,
          });
          throw error;
        } finally {
          client.release();
          span?.end();
        }
      },
    });
  }

  /**
   * Retrieves the root workflow subject for a given workflow instance.
   *
   * This method queries the hierarchy table to find the root workflow subject
   * associated with the specified workflow. Every workflow in the hierarchy has
   * a root_subject field that points to the top-level workflow that initiated
   * the entire workflow tree.
   *
   * @param subject - The subject identifier of the workflow to look up
   * @returns The root subject identifier, or null if the subject is not found in the hierarchy table
   *
   * @example
   * ```typescript
   * const subject = 'some_string'
   * const root = await memory.getRootSubject(subject);
   * if (root) {
   *   console.log(`Root workflow subject: ${root}`);
   *   if (root === subject) {
   *     console.log('This is a root workflow');
   *   } else {
   *     console.log('This is a child workflow');
   *   }
   * } else {
   *   console.log('Workflow not found in hierarchy');
   * }
   * ```
   */
  async getRootSubject(subject: string): Promise<string | null> {
    return await this.otel({
      name: 'PostgresMachineMemory.v1.getRootSubject',
      fn: async (span) => {
        span?.setStatus({ code: SpanStatusCode.OK });
        span?.setAttribute('subject', subject);
        const client = await this.pool.connect();
        try {
          const result = await client.query(
            `SELECT root_subject FROM ${this.tables.hierarchy} WHERE subject = $1`,
            [subject],
          );
          if (!result.rows.length) {
            span?.setAttribute('found', 0);
            return null;
          }
          const rootSubject = result.rows[0].root_subject;
          span?.setAttribute('found', 1);
          span?.setAttribute('isRoot', 0);
          span?.setAttribute('rootSubject', rootSubject);
          return rootSubject;
        } catch (error) {
          span?.setStatus({
            code: SpanStatusCode.ERROR,
            message: (error as Error).message,
          });
          throw error;
        } finally {
          client.release();
          span?.end();
        }
      },
    });
  }
}
