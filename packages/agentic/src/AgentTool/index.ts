import {
  SemanticConventions as OpenInferenceSemanticConventions,
  OpenInferenceSpanKind,
} from '@arizeai/openinference-semantic-conventions';
import { SpanStatusCode } from '@opentelemetry/api';
import { ArvoOpenTelemetry, getOtelHeaderFromSpan } from 'arvo-core';
import type z from 'zod/v3/external.cjs';
import type { OtelInfoType } from '../types';
import type { AgentInternalTool } from './types';

/**
 * Factory function to create an Instrumented Agent Tool.
 *
 * Wraps your raw tool logic with **OpenTelemetry Auto-Instrumentation** and **Input Validation**.
 *
 * **Why use this instead of a raw object?**
 * 1. **Observability:** Automatically creates a child Span (`OpenInferenceSpanKind.TOOL`).
 *    It records input arguments, output values, and execution duration to your tracing backend.
 * 2. **Safety:** Automatically validates `input` against the Zod schema *before* your function runs.
 *    Throws a clear error if the LLM hallucinated invalid arguments.
 * 3. **Type Safety:** Infers generic types for `input` and `output` automatically.
 *
 * @param param - The tool definition.
 * @returns The wrapped, production-ready tool.
 *
 * @example
 * ```ts
 * const timeTool = createAgentTool({
 *   name: 'get_time',
 *   description: 'Returns current server time',
 *   input: z.object({}),
 *   output: z.object({ time: z.string() }),
 *   fn: () => ({ time: new Date().toISOString() })
 * });
 * ```
 */
export const createAgentTool = <
  TInputSchema extends z.ZodTypeAny,
  TOutputSchema extends z.ZodTypeAny,
>(
  param: AgentInternalTool<TInputSchema, TOutputSchema>,
) =>
  ({
    ...param,
    fn: async (input: z.infer<TInputSchema>, config: { otelInfo: OtelInfoType }) =>
      await ArvoOpenTelemetry.getInstance().startActiveSpan({
        name: `AgentTool<${param.name}>.execute`,
        disableSpanManagement: true,
        context: {
          inheritFrom: 'TRACE_HEADERS',
          traceHeaders: config.otelInfo.headers,
        },
        spanOptions: {
          attributes: {
            [OpenInferenceSemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
          },
        },
        fn: async (span) => {
          try {
            span.setAttribute(OpenInferenceSemanticConventions.TOOL_CALL_FUNCTION_NAME, param.name);
            span.setAttribute(
              OpenInferenceSemanticConventions.TOOL_CALL_FUNCTION_ARGUMENTS_JSON,
              JSON.stringify(input),
            );
            span.setAttribute(OpenInferenceSemanticConventions.INPUT_VALUE, JSON.stringify(input));
            const inputValidation = param.input.safeParse(input);
            if (inputValidation.error)
              throw new Error(
                `Invalid tool input data. Please send the correct data and its structure as per the input schema. ${inputValidation.error.toString()}`,
              );
            const result = await param.fn(inputValidation.data, {
              otelInfo: {
                span,
                headers: getOtelHeaderFromSpan(span),
              },
            });
            span.setAttribute(
              OpenInferenceSemanticConventions.OUTPUT_VALUE,
              JSON.stringify(result),
            );
            return result;
          } catch (err) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
            throw err;
          } finally {
            span.end();
          }
        },
      }),
  }) as AgentInternalTool<TInputSchema, TOutputSchema>;
