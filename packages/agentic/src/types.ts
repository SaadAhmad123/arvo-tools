import type { OpenTelemetryHeaders } from 'arvo-core';

export type PromiseAble<T> = Promise<T> | T;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonAble = Record<string, JsonValue>;

export type ImageContentType =
  `image/${'jpeg' | 'png' | 'gif' | 'webp' | 'svg+xml' | 'bmp' | 'tiff'}`;
export type AudioContentType = `audio/${'mpeg' | 'mp4' | 'wav' | 'ogg' | 'webm' | 'flac'}`;
export type VideoContentType = `video/${'mp4' | 'webm' | 'ogg' | 'quicktime' | 'x-msvideo'}`;
export type ApplicationContentType =
  `application/${'pdf' | 'json' | 'xml' | 'octet-stream' | 'zip' | 'gzip'}`;
export type TextContentType =
  `text/${'plain' | 'html' | 'css' | 'javascript' | 'csv' | 'xml' | 'markdown'}`;

export type ExecutionMetadataType = {
  otelHeaders: OpenTelemetryHeaders;
};
