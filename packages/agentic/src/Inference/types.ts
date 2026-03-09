/** biome-ignore-all lint/suspicious/noConfusingVoidType: Better for the DX */

import type z from 'zod';
import type { InferenceStreamEvent } from '../Stream/type';
import type { OtelInfoType, PromiseAble } from '../types';
import type {
  InferenceJsonContentSchema,
  InferenceMediaContentSchema,
  InferenceMessageContentSchema,
  InferenceMessageSchema,
  InferenceOutputSchema,
  InferenceTextContentSchema,
  InferenceToolCallContentSchema,
  InferenceToolResultContentSchema,
} from './schema';

export type InferenceJsonContent = z.infer<typeof InferenceJsonContentSchema>;
export type InferenceTextContent = z.infer<typeof InferenceTextContentSchema>;
export type InferenceMediaContent = z.infer<typeof InferenceMediaContentSchema>;
export type InferenceToolResultContent = z.infer<typeof InferenceToolResultContentSchema>;
export type InferenceToolCallContent = z.infer<typeof InferenceToolCallContentSchema>;
export type InferenceMessageContent = z.infer<typeof InferenceMessageContentSchema>;
export type InferenceMessage = z.infer<typeof InferenceMessageSchema>;

export type InferenceLifecycle = 'init' | 'tool_result' | 'output_error_feedback';

export type InferenceParam = {
  lifecycle: InferenceLifecycle;
  outputFormat: z.ZodTypeAny;
  messages: InferenceMessage[];
};

export type InferenceOutput = z.infer<typeof InferenceOutputSchema>;

export type InferenceFunction = (
  param: InferenceParam,
  options: { otelInfo: OtelInfoType },
) => AsyncGenerator<
  | { type: 'processing'; data: InferenceStreamEvent }
  | { type: 'complete'; data: InferenceOutput }
  | { type: 'error'; data: Error }
>;

export type PreInferenceFunction = (
  param: InferenceParam,
  options: { otelInfo: OtelInfoType },
) => PromiseAble<InferenceParam | void>;

export type PostInferenceFunction = (
  param: InferenceOutput,
  options: { otelInfo: OtelInfoType },
) => PromiseAble<InferenceOutput | void>;
