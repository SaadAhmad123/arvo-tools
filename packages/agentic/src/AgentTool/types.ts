import type z from 'zod';
import type { OtelInfoType, PromiseAble } from '../types';

/**
 * Defines a Synchronous Internal Tool.
 *
 * Internal tools are standard JavaScript functions that run within the Agent's process.
 * Unlike Services, the Agent **does not suspend** when calling these. They are awaited immediately.
 *
 * Use cases: Mathematical calculations, Date/Time checks, Regex validation, lightweight logic.
 */
export type AgentInternalTool<
  // biome-ignore lint/suspicious/noExplicitAny: Needs to general
  TInputSchema extends z.ZodTypeAny = any,
  // biome-ignore lint/suspicious/noExplicitAny: Needs to general
  TOutputSchema extends z.ZodTypeAny = any,
> = {
  name: string;
  description: string;
  input: TInputSchema;
  output: TOutputSchema;
  priority?: number;
  fn: (
    input: z.infer<TInputSchema>,
    config: { otelInfo: OtelInfoType },
  ) => PromiseAble<z.infer<TOutputSchema>>;
};
