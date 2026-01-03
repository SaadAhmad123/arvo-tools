import { context } from '@opentelemetry/api';
import { type ArvoEvent, cleanString } from 'arvo-core';
import PQueue from 'p-queue';
import type { BrokerConfig, EventHandler, Subscription, SubscriptionConfig } from './types';

/**
 * Concurrent in-process event broker with per-topic p-queue management and fire-and-forget publishing.
 * Suitable for single-instance applications requiring event-driven coordination with configurable
 * concurrency control per handler.
 */
export class ConcurrentEventBroker {
  private readonly subscriptions: Map<string, Subscription>;
  private readonly onError: (error: Error, event: ArvoEvent) => void;
  readonly inFlightMap = new Map<string, number>();

  constructor(config: BrokerConfig) {
    this.subscriptions = new Map();
    this.onError = config.errorHandler;
  }

  /**
   * Returns array of all registered topic identifiers
   */
  get topics(): string[] {
    return Array.from(this.subscriptions.keys());
  }

  /**
   * Registers an event handler for a specific topic with concurrency control.
   * Each topic can only have one handler. Attempting to register multiple handlers
   * for the same topic throws an error.
   *
   * @returns Unsubscribe function that removes the handler and clears its queue
   */
  subscribe(handler: EventHandler, config: SubscriptionConfig): () => void {
    const { topic, prefetch = 1 } = config;

    if (this.subscriptions.has(topic)) {
      throw new Error(
        cleanString(`
        Subscription conflict: A handler is already registered for topic '${topic}'.
        Each topic can only have one handler. To replace the existing handler,
        unsubscribe the current handler first.
      `),
      );
    }

    const queue = new PQueue({ concurrency: prefetch });
    const subscription: Subscription = { handler, queue, prefetch };

    this.subscriptions.set(topic, subscription);

    return () => {
      queue.clear();
      this.subscriptions.delete(topic);
    };
  }

  /**
   * Publishes an event to the handler registered for the event's 'to' field.
   * This is a fire-and-forget operation that enqueues the event and returns immediately.
   * Tracks in-flight work for waitForIdle detection.
   */
  publish(event: ArvoEvent): void {
    if (!event.to) {
      throw new Error(
        cleanString(`
        Invalid event: Missing required 'to' field. Events must specify a destination
        topic in the 'to' property to be routable.
      `),
      );
    }

    const subscription = this.subscriptions.get(event.to);

    if (!subscription) {
      this.onError(
        new Error(
          cleanString(`
          Routing failed: No handler registered for topic '${event.to}'.
          Available topics: [${this.topics.join(', ') || 'none'}].
          Register a handler using subscribe() before publishing to this topic.
        `),
        ),
        event,
      );
      return;
    }

    event.to && this.inFlightMap.set(event.to, (this.inFlightMap.get(event.to) ?? 0) + 1);

    const currentContext = context.active();
    subscription.queue.add(async () => {
      return await context.with(currentContext, async () => {
        try {
          await subscription.handler(event, this.publish.bind(this));
        } catch (error) {
          this.onError(error instanceof Error ? error : new Error(String(error)), event);
        } finally {
          if (event.to) {
            this.inFlightMap.set(event.to, (this.inFlightMap.get(event.to) ?? 0) - 1);
            if ((this.inFlightMap.get(event.to) ?? 0) < 1) {
              this.inFlightMap.delete(event.to);
            }
          }
        }
      });
    });
  }

  /**
   * Returns queue statistics for a specific topic including prefetch limit,
   * pending tasks, and queue size. Returns null if topic not found.
   */
  getStats(topic: string) {
    const subscription = this.subscriptions.get(topic);
    if (!subscription) return null;

    return {
      prefetch: subscription.prefetch,
      pending: subscription.queue.pending,
      size: subscription.queue.size,
      inFlight: this.inFlightMap.get(topic) ?? 0,
    };
  }

  /**
   * Returns queue statistics for all registered topics
   */
  get stats() {
    return Array.from(this.subscriptions.entries()).map(([key, subscription]) => ({
      topic: key,
      prefetch: subscription.prefetch,
      pending: subscription.queue.pending,
      size: subscription.queue.size,
      inFlight: this.inFlightMap.get(key) ?? 0,
    }));
  }

  /**
   * Polls until all in-flight work across all handlers completes.
   * Supports configurable timeout and polling interval with optional stat callback
   * for monitoring progress.
   */
  async waitForIdle(param?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    onStat?: (data: ConcurrentEventBroker['stats'], hasInflightWork: boolean) => void;
  }): Promise<void> {
    const startTime = Date.now();
    while (true) {
      const hasInflightWork = Array.from(this.inFlightMap.values()).some((count) => count > 0);
      param?.onStat?.(this.stats, hasInflightWork);
      if (!hasInflightWork) {
        return;
      }
      if (param?.timeoutMs && Date.now() - startTime >= param?.timeoutMs) {
        throw new Error(`waitForIdle timed out after ${param?.timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, param?.pollIntervalMs ?? 10));
    }
  }

  /**
   * Stops all handler queues and removes all subscriptions.
   * Pending tasks in queues are cleared.
   */
  clear(): void {
    for (const subscription of this.subscriptions.values()) {
      subscription.queue.clear();
    }
    this.subscriptions.clear();
  }
}
