import { type Span, SpanStatusCode } from '@opentelemetry/api';

export const setSpanError = (span: Span, error: Error | string) => {
  const err = error instanceof Error ? error : new Error(String(error));
  span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  span.recordException(err);
  return err;
};
