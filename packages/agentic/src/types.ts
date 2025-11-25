import type { Span } from '@opentelemetry/api';
import type { OpenTelemetryHeaders } from 'arvo-core';

export type OtelInfoType = {
  span: Span;
  headers: OpenTelemetryHeaders;
};
