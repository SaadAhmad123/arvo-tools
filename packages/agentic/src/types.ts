import type { Span } from '@opentelemetry/api';
import type { OpenTelemetryHeaders } from 'arvo-core';

/**
 * Observability Context.
 *
 * This object acts as the "Trace Baton," passing the active OpenTelemetry Span and
 * Trace Parent headers between functions. Use this to ensure your custom integrations
 * and tools correctly propagate distributed traces.
 */
export type OtelInfoType = {
  /** The active OpenTelemetry Span for the current operation. */
  span: Span;
  /** Trace Headers (traceparent/tracestate) for propagating context across network boundaries. */
  headers: OpenTelemetryHeaders;
};

/** A utility type enforcing that an array contains at least one element. */
export type NonEmptyArray<T> = [T, ...T[]];

/** A utility type representing a value that may be either synchronous (`T`) or asynchronous (`Promise<T>`). */
export type PromiseAble<T> = Promise<T> | T;
