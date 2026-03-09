import type { Span } from '@opentelemetry/api';
import type { OpenTelemetryHeaders } from 'arvo-core';

export type OtelInfoType = {
  span: Span;
  headers: OpenTelemetryHeaders;
};

export type NonEmptyArray<T> = [T, ...T[]];

export type PromiseAble<T> = Promise<T> | T;

// biome-ignore lint/suspicious/noExplicitAny: Needs to be general
export type Partialize<T extends Record<string, any>, K extends keyof T> = Omit<T, K> &
  Partial<Pick<T, K>>;
