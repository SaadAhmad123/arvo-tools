/** biome-ignore-all lint/suspicious/noConfusingVoidType: Better for Dx */

import type z from 'zod';
import type { InferenceMessage } from '../Inference/types';
import type { OtelInfoType, Partialize, PromiseAble } from '../types';

export type AgentFunction<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
> = {
  name: string;
  description: string;
  schema: {
    input: I;
    output?: O;
  };
  fn: (
    data: z.infer<I>,
    options: { otelInfo: OtelInfoType },
  ) => PromiseAble<
    | {
        type: 'data';
        content: z.infer<O>;
      }
    | {
        type: 'messages';
        content: Partialize<InferenceMessage, 'seenCount'>[];
      }
    | void
  >;
};
