import type { ArvoEvent } from 'arvo-core';
import { ConcurrentEventBroker } from './';
import type {
  EventBrokerFactorOptions,
  EventHandlerConfig,
  EventHandlerRetryConfig,
  InputEventHandlerMiddleware,
} from './types';

/**
 * Creates a concurrent in-process event broker with per-handler concurrency control.
 * Suitable for single-instance applications requiring event-driven coordination with
 * configurable retry logic, middleware support, and graceful error handling.
 *
 * @param handlers - Array of event handler configurations with optional prefetch limits
 * @param options - Broker configuration options
 *
 * @returns Object containing the broker instance and resolve method
 * @returns broker - ConcurrentEventBroker instance for direct event publishing and subscription
 * @returns resolve - Convenience method that publishes an event and waits for the final response
 *
 * @example
 * ```typescript
 * const { broker, resolve } = createConcurrentEventBroker([
 *   { handler: myHandler(), prefetch: 5 },
 *   { handler: anotherHandler(), prefetch: 10 }
 * ], {
 *   defaultHandlerConfig: { retry: { maxRetries: 3 } },
 *   onBrokerError: (error, event) => console.error(error)
 * });
 *
 * const result = await resolve(initialEvent);
 * ```
 *
 * @remarks
 * Handler-specific configurations override defaultHandlerConfig completely (no merging).
 * Input middleware executes before handler execution, output middleware after.
 * Middleware returning void preserves the original event unchanged.
 * Errors thrown during execution trigger retry logic based on onError callback response.
 * Errors thrown during middleware execution are surfaced to onBrokerError.
 *
 * Production Readiness: This broker is production-ready for in-process, single-container
 * applications only. It provides robust concurrency control, error handling with retries,
 * middleware support, and proper resource management. However, it is NOT suitable for
 * distributed systems, multi-container deployments, or applications requiring guaranteed
 * message delivery across restarts, as all event queues exists in memory and is lost on process
 * termination.
 */
export const createConcurrentEventBroker = (
  handlers: EventHandlerConfig[],
  options?: EventBrokerFactorOptions,
) => {
  const broker = new ConcurrentEventBroker({
    errorHandler:
      options?.onBrokerError ??
      ((error, event) => {
        console.error('Broker error:', {
          message: error.message,
          eventType: event.to,
          event,
        });
      }),
  });

  for (const { handler, prefetch, middleware, retry, onError } of handlers) {
    broker.subscribe(
      async (_event, publish) => {
        let inputMiddleware: InputEventHandlerMiddleware[] = [];
        const inputMiddlewareConfig =
          middleware?.input ?? options?.defaultHandlerConfig?.middleware?.input ?? null;
        if (inputMiddlewareConfig) {
          if (typeof inputMiddlewareConfig === 'function') {
            inputMiddleware = [inputMiddlewareConfig];
          } else {
            inputMiddleware = inputMiddlewareConfig;
          }
        }

        let event = _event;
        for (const _middleware of inputMiddleware) {
          event = (await _middleware(event)) ?? event;
        }

        const retryConfig: EventHandlerRetryConfig = {
          maxRetries: 3,
          initialDelayMs: 100,
          backoffExponent: 1.5,
          ...(retry ?? options?.defaultHandlerConfig?.retry ?? {}),
        };

        let attempt = 0;
        let error: Error | null = null;
        let events: ArvoEvent[] = [];

        while (attempt <= retryConfig.maxRetries) {
          error = null;
          events = [];
          try {
            const response = await handler.execute(event, {
              inheritFrom: 'EVENT',
            });
            events = response.events;
            break;
          } catch (e) {
            console.log(`[Attempt: ${attempt}] Handler execution error: ${(e as Error).message}`);

            error = e as Error;

            const onErrorResponse = (onError ?? options?.defaultHandlerConfig?.onError)?.(error, {
              ...retryConfig,
              currentAttempt: attempt,
            });

            if (onErrorResponse === 'RETRY') {
              // NOOP
            } else if (onErrorResponse === 'THROW') {
              throw error;
            } else if (onErrorResponse === 'SUPPRESS') {
              error = null;
            }
          }

          if (attempt < retryConfig.maxRetries) {
            const delayMs = retryConfig.initialDelayMs * retryConfig.backoffExponent ** attempt;
            await new Promise((res) => setTimeout(res, delayMs));
          }
          attempt++;
          if (attempt >= retryConfig.maxRetries) {
            break;
          }
        }

        if (error) {
          throw error;
        }

        const outputMiddlewareConfig =
          middleware?.output ?? options?.defaultHandlerConfig?.middleware?.output;
        if (outputMiddlewareConfig) {
          if (typeof outputMiddlewareConfig === 'function') {
            events =
              (await outputMiddlewareConfig({
                input: event,
                output: events,
              })) ?? events;
          } else if (outputMiddlewareConfig.length) {
            for (let i = 0; i < events.length; i++) {
              for (const _middleware of outputMiddlewareConfig) {
                events[i] =
                  (await _middleware({
                    input: event,
                    output: events[i],
                  })) ?? events[i];
              }
            }
          }
        }

        for (const evt of events) {
          if (evt.domain) {
            options?.onDomainedEvents?.({
              domain: evt.domain,
              event: evt,
              broker: broker,
            });
          } else {
            publish(evt);
          }
        }
      },
      {
        topic: handler.source,
        prefetch: prefetch || 1,
      },
    );
  }

  const resolve = async (_event: ArvoEvent): Promise<ArvoEvent | null> => {
    let unsub: (() => void) | null = null;
    try {
      if (broker.topics.includes(_event.source)) {
        throw new Error(
          `The event source cannot be one of the handlers in the broker. Please update the event.source, the given is '${_event.source}'`,
        );
      }
      let resolvedEvent: ArvoEvent | null = null;
      unsub = broker.subscribe(
        async (event) => {
          resolvedEvent = event;
        },
        {
          topic: _event.source,
          prefetch: 1,
        },
      );
      broker.publish(_event);
      await broker.waitForIdle(options?.waitForIdle);
      if (resolvedEvent === null) {
        return null;
      }
      return resolvedEvent;
    } finally {
      unsub?.();
    }
  };

  return {
    broker,
    resolve,
  };
};
