import { context, type SpanContext, trace } from '@opentelemetry/api';
import { ArvoEvent } from 'arvo-core';
import type { Job } from 'pg-boss';

export const createArvoEventFromJob = (job: Job<ReturnType<ArvoEvent['toJSON']>>): ArvoEvent => {
  const {
    id,
    source,
    type,
    subject,
    time,
    specversion,
    datacontenttype,
    dataschema,
    to,
    accesscontrol,
    redirectto,
    executionunits,
    parentid,
    domain,
    traceparent,
    tracestate,
    data,
    ...extensions
  } = job.data;
  return new ArvoEvent(
    {
      id,
      source,
      type,
      subject,
      time,
      specversion: specversion as '1.0',
      datacontenttype,
      dataschema,
      to,
      accesscontrol,
      redirectto,
      executionunits,
      parentid,
      domain,
      traceparent,
      tracestate,
    },
    data,
    extensions ?? {},
  );
};

/**
 * Extracts and creates an OpenTelemetry context from an ArvoEvent's traceparent.
 *
 * @param event - The ArvoEvent containing trace information
 * @returns OpenTelemetry context with the event's trace information
 */
export const otelParentContext = (event: ArvoEvent) => {
  let parentContext = context.active();
  if (event.traceparent) {
    const parts = event.traceparent.split('-');
    if (parts.length === 4) {
      const [_, traceId, spanId, traceFlags] = parts;
      const spanContext: SpanContext = {
        traceId,
        spanId,
        traceFlags: Number.parseInt(traceFlags, 10),
      };
      parentContext = trace.setSpanContext(context.active(), spanContext);
    }
  }
  return parentContext;
};
