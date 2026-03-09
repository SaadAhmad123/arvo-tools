import type z from 'zod';
import type { ActionEngine } from '../ActionEngine';
import type {
  InferenceFunction,
  InferenceMediaContent,
  InferenceMessage,
  PostInferenceFunction,
  PreInferenceFunction,
} from '../Inference/types';

export type AgentOutputParam =
  | {
      type: 'text';
    }
  | {
      type: 'json';
      schema: z.ZodTypeAny;
    }
  | {
      type: 'media';
      contenttype: InferenceMediaContent['contenttype'];
    };

export type AgentConstraint =
  | {
      type: 'max_tokens';
      value: number;
    }
  | {
      type: 'max_cycles';
      value: number;
    };

export type AgentParam<T extends ActionEngine> = {
  engine: T;
  inference: InferenceFunction;
  hooks?: Partial<{
    pre: PreInferenceFunction;
    post: PostInferenceFunction;
  }>;
  constraint: AgentConstraint;
  outputFormat: z.ZodTypeAny;
  messages: InferenceMessage[];
};
