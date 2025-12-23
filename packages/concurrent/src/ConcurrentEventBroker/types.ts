import type { ArvoEvent } from 'arvo-core';
import type { IArvoEventHandler } from 'arvo-event-handler';
import type PQueue from 'p-queue';
import type { ConcurrentEventBroker } from './';

/**
 * Function signature for event handlers that process events and optionally publish new ones
 */
export type EventHandler = (event: ArvoEvent, publish: (event: ArvoEvent) => void) => Promise<void>;

/**
 * Configuration for subscribing a handler to a specific topic with concurrency control
 */
export type SubscriptionConfig = {
  /**
   * The topic identifier that this handler will subscribe to
   */
  topic: string;

  /**
   * Maximum number of concurrent events this handler can process
   */
  prefetch: number;
};

/**
 * Core configuration for the ConcurrentEventBroker instance
 */
export type BrokerConfig = {
  /**
   * Handler invoked when routing errors or unhandled exceptions occur
   */
  errorHandler: (error: Error, event: ArvoEvent) => void;
};

/**
 * Internal subscription entry tracking a handler, its queue, and concurrency settings
 */
export type Subscription = {
  handler: EventHandler;
  queue: PQueue;
  prefetch: number;
};

/**
 * Generic middleware function that transforms or validates input events
 */
export type EventHandlerMiddleware<T, R = T> = (event: T) => Promise<R> | R;

/**
 * Operations that can be returned by error handlers to control retry behavior
 */
export type EventHandlerErrorOperations = 'RETRY' | 'SUPPRESS' | 'THROW';

/**
 * Configuration for exponential backoff retry logic
 */
export type EventHandlerRetryConfig = {
  /**
   * Maximum number of retry attempts before giving up
   */
  maxRetries: number;

  /**
   * Initial delay in milliseconds before the first retry
   */
  initialDelayMs: number;

  /**
   * Multiplier applied to delay after each retry attempt
   */
  backoffExponent: number;
};

/**
 * Callback function invoked on handler execution errors to determine retry behavior
 */
export type EventHandlerOnError = (
  error: Error,
  metadata: EventHandlerRetryConfig & {
    currentAttempt: number;
  },
) => Promise<EventHandlerErrorOperations> | EventHandlerErrorOperations;

/**
 * Middleware that transforms or validates input events before handler execution.
 * Returning void preserves the original event.
 */
export type InputEventHandlerMiddleware = EventHandlerMiddleware<
  ArvoEvent,
  // biome-ignore lint/suspicious/noConfusingVoidType: This is ergonomic
  ArvoEvent | void
>;

/**
 * Middleware that transforms individual output events after handler execution.
 * Returning void preserves the original event.
 */
export type OutputEventHandlerMiddleware = EventHandlerMiddleware<
  {
    input: ArvoEvent;
    output: ArvoEvent;
  },
  // biome-ignore lint/suspicious/noConfusingVoidType: This is ergonomic
  ArvoEvent | void
>;

/**
 * Middleware that transforms all output events in bulk after handler execution.
 * Returning void preserves the original events array.
 */
export type BulkOutputEventHandlerMiddleware = EventHandlerMiddleware<
  {
    input: ArvoEvent;
    output: ArvoEvent[];
  },
  // biome-ignore lint/suspicious/noConfusingVoidType: This is ergonomic
  ArvoEvent[] | void
>;

/**
 * Configuration for an individual event handler including concurrency limits,
 * middleware, retry behavior, and error handling strategy.
 */
export type EventHandlerConfig = {
  /**
   * The Arvo event handler instance to register with the broker
   */
  handler: IArvoEventHandler;

  /**
   * Maximum number of concurrent events this handler can process simultaneously
   * @default 1
   */
  prefetch?: number;

  /**
   * Optional middleware for transforming events before and after handler execution
   */
  middleware?: {
    /**
     * Middleware functions that transform or validate events before handler execution.
     * Executed in array order. Returning void preserves the original event.
     */
    input?: InputEventHandlerMiddleware[];

    /**
     * Middleware for transforming output events. Can be an array of per-event transformers
     * or a single bulk transformer that processes all output events together.
     */
    output?: OutputEventHandlerMiddleware[] | BulkOutputEventHandlerMiddleware;
  };

  /**
   * Retry configuration for handler execution failures
   * @default { maxRetries: 2, initialDelayMs: 100, backoffExponent: 1.5 }
   */
  retry?: Partial<EventHandlerRetryConfig>;

  /**
   * Callback invoked on handler execution errors to determine retry behavior.
   * Return 'RETRY' to retry, 'THROW' to propagate error, or 'SUPPRESS' to ignore.
   */
  onError?: EventHandlerOnError;
};

/**
 * Global configuration options for the event broker factory including default handler settings,
 * idle detection behavior, and handlers for broker-level errors and domain events.
 */
export type EventBrokerFactorOptions = {
  /**
   * Default configuration applied to all handlers unless overridden at the handler level.
   * Handler-specific config completely replaces defaults (no merging).
   */
  defaultHandlerConfig?: Omit<EventHandlerConfig, 'handler'>;

  /**
   * Configuration for the waitForIdle method including timeout and polling interval
   */
  waitForIdle?: NonNullable<Parameters<ConcurrentEventBroker['waitForIdle']>[0]>;

  /**
   * Error handler for broker-level errors including routing failures and middleware errors
   */
  onBrokerError?: (error: Error, event: ArvoEvent) => void;

  /**
   * Handler for events with domain fields that bypass standard broker routing
   */
  onDomainedEvents?: (param: {
    domain: string;
    event: ArvoEvent;
    broker: ConcurrentEventBroker;
  }) => Promise<void>;
};
