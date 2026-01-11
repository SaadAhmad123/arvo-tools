import { context } from '@opentelemetry/api';
import { type ArvoEvent, cleanString } from 'arvo-core';
import type { IArvoEventHandler } from 'arvo-event-handler';
import { PgBoss, type Queue, type WorkHandler } from 'pg-boss';
import type { HandlerRegistrationOptions } from './types';
import { createArvoEventFromJob, otelParentContext } from './utils';

type PromiseLike<T> = Promise<T> | T;

/**
 * Queue-based event broker for ArvoEvent handlers with automatic routing,
 * retry logic, and full OpenTelemetry tracing support.
 *
 * It manages event-driven workflows by automatically routing events
 * between registered handlers through persistent queues, ensuring reliable
 * delivery with configurable retry policies and failure handling.
 *
 * @example
 * ```typescript
 * const broker = new ArvoPgBoss({ connectionString: 'postgres://...' });
 * await broker.start();
 *
 * // Register event handlers
 * await broker.register(calculatorHandler, {
 *   worker: { concurrency: 5, retryLimit: 3 }
 * });
 *
 * // Set up workflow completion handler
 * await broker.onWorkflowComplete({
 *   source: 'my.workflow',
 *   handler: async (event) => {
 *     console.log('Workflow completed', event);
 *   }
 * });
 *
 * // Dispatch initial event
 * await broker.dispatch(initialEvent);
 * ```
 */
export class ArvoPgBoss extends PgBoss {
  /**
   * Internal registry of handler configurations keyed by handler source.
   */
  private handlers: Record<
    string,
    {
      options?: HandlerRegistrationOptions;
    }
  > = {};

  /**
   * Internal list of all registered queue names.
   */
  private _queues: string[] = [];

  /**
   * List of all registered queue names in the broker.
   */
  public get queues(): string[] {
    return this._queues;
  }

  /**
   * The configured event source for workflow completion.
   */
  private injectionEventSource: string | null = null;

  /**
   * Default callback invoked when an event has no registered destination handler.
   */
  private _onHandlerNotFound: (event: ArvoEvent) => PromiseLike<void> = (event) =>
    console.error('Handler not found for event', event.toString(2));

  /**
   * Callback invoked when a domained event is encountered during routing.
   */
  private _onDomainedEvent: ((event: ArvoEvent) => PromiseLike<void>) | null = (event) =>
    console.log('Domained event encountered', event.toString(2));

  /**
   * Registers a handler for workflow completion events.
   *
   * This sets up the terminal point where events return after flowing through
   * the handler chain. The handler receives events whose 'to' field matches
   * the configured source, typically indicating workflow completion.
   *
   * Sets the injection event source that must match the source of events
   * dispatched via the dispatch() method.
   *
   * @param param - Configuration object
   * @param param.source - Event source identifier for completion events
   * @param param.handler - Callback invoked when completion events are received
   * @param param.options - Optional queue and worker configuration
   *
   * @example
   * ```typescript
   * await broker.onWorkflowComplete({
   *   source: 'test.test.test',
   *   listener: async (event) => {
   *     console.log('Final result:', event.data);
   *   },
   * });
   * ```
   */
  async onWorkflowComplete(param: {
    source: string;
    listener: (event: ArvoEvent) => PromiseLike<void>;
    options?: HandlerRegistrationOptions;
  }) {
    this.injectionEventSource = param.source;
    this.handlers[param.source] = { options: param.options };

    if (param.options?.recreateQueue) {
      await this.deleteQueue(param.source);
    }

    await this.createQueue(param.source, param.options?.queue);

    for (let i = 0; i < Math.max(param.options?.worker?.concurrency ?? 0, 1); i++) {
      await this.work<ReturnType<ArvoEvent['toJSON']>, undefined>(
        param.source,
        {
          pollingIntervalSeconds: param.options?.worker?.pollingIntervalSeconds ?? 2,
          batchSize: 1,
        },
        async ([job]) => {
          try {
            const eventFromJob = createArvoEventFromJob(job);
            await context.with(otelParentContext(eventFromJob), async () => {
              return await param.listener(eventFromJob);
            });
          } catch (error) {
            console.error(`Error in worker handler for ${param.source}`, error);
          }
        },
      );
    }
  }

  /**
   * Sets a custom handler for events with no registered destination.
   *
   * When a handler emits an event whose 'to' field doesn't match any
   * registered handler, this callback is invoked. Useful for logging
   * routing errors or implementing fallback behavior.
   *
   * @param listner - Callback invoked with unroutable events
   *
   * @example
   * ```typescript
   * broker.onHandlerNotFound(async (event) => {
   *   logger.error('No handler for', event.to);
   * });
   * ```
   */
  onHandlerNotFound(listner: (event: ArvoEvent) => PromiseLike<void>) {
    this._onHandlerNotFound = listner;
  }

  /**
   * Sets a custom handler for domained events.
   *
   * @param listner - Callback invoked when domained events are encountered
   *
   * @example
   * ```typescript
   * broker.onDomainedEvent(async (event) => {
   *   if (event.domain === 'notification') {
   *     await alerting.notify(event);
   *   }
   * });
   * ```
   */
  onDomainedEvent(listner: (event: ArvoEvent) => PromiseLike<void>) {
    this._onDomainedEvent = listner;
  }

  /**
   * Creates a queue and tracks it in the internal queue registry.
   * Overrides the base class method to maintain queue tracking.
   *
   * @param name - Queue name
   * @param options - Queue configuration options
   */
  override async createQueue(name: string, options?: Omit<Queue, 'name'>): Promise<void> {
    this._queues.push(name);
    return super.createQueue(name, options);
  }

  /**
   * Registers an event handler with the broker.
   *
   * Creates a dedicated queue for the handler and spawns worker instances
   * to process incoming events. Events emitted by the handler are automatically
   * routed to their destinations based on the 'to' field.
   *
   * @param handler - The ArvoEvent handler to register
   * @param options - Configuration for queue behavior, worker concurrency, and retry policies
   * @throws {Error} If a handler with the same source is already registered
   *
   * @example
   * ```typescript
   * await broker.register(calculatorHandler, {
   *   recreateQueue: true,
   *   queue: { deadLetter: 'dlq' },
   *   worker: {
   *     concurrency: 5,
   *     onError: async (job, error) => {
   *       if (error.message.includes('timeout')) return 'RETRY';
   *       return 'FAIL';
   *     }
   *   }
   * });
   * ```
   */
  async register(handler: IArvoEventHandler, options?: HandlerRegistrationOptions): Promise<void> {
    if (this.handlers[handler.source]) {
      throw new Error(
        cleanString(`
        Handler registration failed: A handler with source '${handler.source}' is already registered. 
        Each handler must have a unique source identifier. Attempted duplicate registration will be 
        ignored to prevent queue conflicts.
      `),
      );
    }

    this.handlers[handler.source] = { options };

    if (options?.recreateQueue) {
      await this.deleteQueue(handler.source);
    }

    await this.createQueue(handler.source, options?.queue);

    const workHandler: WorkHandler<ReturnType<ArvoEvent['toJSON']>, undefined> = async ([job]) => {
      try {
        const eventFromJob = createArvoEventFromJob(job);

        const { events } = await context.with(otelParentContext(eventFromJob), async () => {
          return await handler.execute(eventFromJob, {
            inheritFrom: 'EVENT',
          });
        });

        await Promise.all(
          events.map(async (evt) => {
            if (evt.domain) {
              await this._onDomainedEvent?.(evt);
              return;
            }
            return await this._emitArvoEvent(evt);
          }),
        );
      } catch (error) {
        console.error(`Error in worker handler for ${handler.source}`, error);
        const resp = (await options?.worker?.onError?.(job, error as Error)) ?? 'RETRY';
        if (resp === 'IGNORE') return;
        if (resp === 'FAIL') {
          await this.fail(handler.source, job.id, {
            errorName: (error as Error).name,
            errorMessage: (error as Error).message,
            errorStack: (error as Error).stack,
            errorCause: (error as Error).cause,
          }).catch(console.error);
          return;
        }
        throw error;
      }
    };

    for (let i = 0; i < Math.max(options?.worker?.concurrency ?? 0, 1); i++) {
      await this.work(
        handler.source,
        {
          pollingIntervalSeconds: options?.worker?.pollingIntervalSeconds ?? 2,
          batchSize: 1,
        },
        workHandler,
      );
    }
  }

  /**
   * Routes an ArvoEvent to its destination queue.
   *
   * Internal method that filters out worker configuration options and includes
   * only job-level options when sending the event. This method performs no
   * validation and assumes the event and handler have already been verified.
   *
   * @param event - The ArvoEvent to route
   * @returns Job ID if sent successfully, null if handler not found
   */
  private async _emitArvoEvent(event: ArvoEvent) {
    if (!event.to || !this._queues.includes(event.to)) {
      this._onHandlerNotFound?.(event);
      return null;
    }

    // biome-ignore lint/correctness/noUnusedVariables: This is need sadly
    const { concurrency, pollingIntervalSeconds, onError, ...rest } =
      this.handlers[event.to].options?.worker ?? {};

    return await this.send(event.to, event.toJSON(), {
      ...(rest ?? {}),
    });
  }

  /**
   * Dispatches an ArvoEvent into the broker system with validation.
   *
   * This is the primary entry point for injecting events into the workflow.
   * The event must originate from the source configured in onWorkflowComplete()
   * and target a registered handler.
   *
   * @param event - The ArvoEvent to dispatch
   * @returns Job ID assigned by the queue system
   * @throws {Error} If workflow completion handler is not configured
   * @throws {Error} If event source doesn't match configured workflow source
   * @throws {Error} If target handler is not registered
   *
   * @example
   * ```typescript
   * const event = createArvoEvent({
   *   source: 'my.workflow',
   *   to: 'calculator.handler',
   *   type: 'calculate.request',
   *   data: { operation: 'add', values: [1, 2] }
   * });
   *
   * await broker.dispatch(event);
   * ```
   */
  async dispatch(event: ArvoEvent) {
    if (!this.injectionEventSource) {
      throw new Error(
        cleanString(`
        Workflow completion handler not configured: Cannot dispatch ArvoEvent without setting up 
        the workflow completion handler. Call onWorkflowComplete({ source: string, handler: Function }) 
        to register the completion point before dispatching events into the system.
      `),
      );
    }
    if (this.injectionEventSource !== event.source) {
      throw new Error(
        cleanString(`
        Event source mismatch: The dispatched event source '${event.source}' does not match the 
        configured workflow completion source '${this.injectionEventSource}'. Events dispatched 
        through dispatch() must originate from the source specified in onWorkflowComplete(). 
        Verify the event's source property matches '${this.injectionEventSource}'.
      `),
      );
    }
    if (!this._queues.includes(event.to ?? '')) {
      throw new Error(
        cleanString(`
        Handler not registered: No handler found for destination '${event.to}'. The target handler 
        must be registered using register() before events can be routed to it. Register the required
        handler or verify the event's 'to' property is correct.
      `),
      );
    }
    return await this._emitArvoEvent(event);
  }

  /**
   * Retrieves statistics for all registered queues in the broker.
   *
   * @returns Array of queue statistics including active, queued, and total job counts
   *
   * @example
   * ```typescript
   * const stats = await broker.getStats();
   * stats.forEach(stat => {
   *   console.log(`Queue ${stat.name}: ${stat.activeCount} active, ${stat.queuedCount} queued`);
   * });
   * ```
   */
  async getStats() {
    return await Promise.all(this._queues.map(async (q) => this.getQueueStats(q)));
  }
}
