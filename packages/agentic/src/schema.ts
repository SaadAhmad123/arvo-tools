import { z } from 'zod';

export const ImageContentTypeSchema = z.enum([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/tiff',
]);

export const AudioContentTypeSchema = z.enum([
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/ogg',
  'audio/webm',
  'audio/flac',
]);

export const VideoContentTypeSchema = z.enum([
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'video/x-msvideo',
]);

export const ApplicationContentTypeSchema = z.enum([
  'application/pdf',
  'application/json',
  'application/xml',
  'application/octet-stream',
  'application/zip',
  'application/gzip',
]);

export const TextContentTypeSchema = z.enum([
  'text/plain',
  'text/html',
  'text/css',
  'text/javascript',
  'text/csv',
  'text/xml',
  'text/markdown',
]);

export const AnyContentTypeSchema = z.union([
  ImageContentTypeSchema,
  AudioContentTypeSchema,
  VideoContentTypeSchema,
  ApplicationContentTypeSchema,
  TextContentTypeSchema,
]);
