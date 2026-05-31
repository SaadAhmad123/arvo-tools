import type { OpenTelemetryHeaders } from 'arvo-core';
import type z from 'zod';
import type {
  AnyContentTypeSchema,
  ApplicationContentTypeSchema,
  AudioContentTypeSchema,
  ImageContentTypeSchema,
  TextContentTypeSchema,
  VideoContentTypeSchema,
} from './schema';

export type PromiseAble<T> = Promise<T> | T;
export type NestedPartial<T> = {
  [K in keyof T]?: T[K] extends object ? NestedPartial<T[K]> : T[K];
};
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonAble = Record<string, JsonValue>;

export type ImageContentType = z.infer<typeof ImageContentTypeSchema>;
export type AudioContentType = z.infer<typeof AudioContentTypeSchema>;
export type VideoContentType = z.infer<typeof VideoContentTypeSchema>;
export type ApplicationContentType = z.infer<typeof ApplicationContentTypeSchema>;
export type TextContentType = z.infer<typeof TextContentTypeSchema>;
export type AnyContentType = z.infer<typeof AnyContentTypeSchema>;

export type ExecutionMetadataType = {
  otelHeaders: OpenTelemetryHeaders;
};
