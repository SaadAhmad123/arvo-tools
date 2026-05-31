import {
  // INPUT_MIME_TYPE,
  INPUT_VALUE,
  MimeType,
  OpenInferenceSpanKind,
  OUTPUT_MIME_TYPE,
  OUTPUT_VALUE,
  SemanticConventions,
  // TOOL_DESCRIPTION,
  // TOOL_JSON_SCHEMA,
  // TOOL_NAME,
} from '@arizeai/openinference-semantic-conventions';
import { SpanStatusCode } from '@opentelemetry/api';
import { ArvoOpenTelemetry, getOtelHeaderFromSpan, type OpenTelemetryHeaders } from 'arvo-core';
import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { setSpanError } from '../helpers';
import type { ExecutionMetadataType, PromiseAble } from '../types';
import { ToolInputError, ToolNotFoundError } from './error';
import { ErrorResultData, type JsonResultData, type MediaResultData } from './helpers';
import type {
  IErrorResultData,
  IJsonResultData,
  IMediaResultData,
  ITool,
  IToolDispatch,
  IToolMetaData,
} from './interface';

export type FunctionToolParam<T extends z.ZodTypeAny> = {
  /** Unique capability name used for dispatch routing. */
  name: string;
  /** Human-readable description shown to the LLM. */
  description: string;
  /** Zod schema that validates and types the LLM's input arguments. */
  input: T;
  /**
   * The function invoked when the LLM calls this tool.
   * Return `void` or omit the return to produce no output.
   */
  fn: (param: {
    id: string;
    name: string;
    data: Record<string, unknown>;
    // biome-ignore lint/suspicious/noConfusingVoidType: Better DX
  }) => PromiseAble<Array<MediaResultData | JsonResultData> | void>;
};

/**
 * An {@link ITool} implementation that wraps a plain TypeScript function.
 *
 * The LLM's arguments are validated against the provided Zod schema before the
 * function is called. Input errors are surfaced as {@link IErrorResultData} rather
 * than thrown, keeping the agent loop intact.
 *
 * `FunctionTool` never produces external calls, so {@link onExternalResponse}
 * is a no-op returning `[]`.
 */
export class FunctionTool<T extends z.ZodTypeAny = z.ZodTypeAny> implements ITool {
  public readonly type = 'FunctionTool';
  public readonly name: FunctionToolParam<T>['description'];
  public readonly description: FunctionToolParam<T>['description'];
  public readonly input: FunctionToolParam<T>['input'];
  private readonly fn: FunctionToolParam<T>['fn'];

  constructor({ name, description, input, fn }: FunctionToolParam<T>) {
    this.name = name;
    this.description = description;
    this.input = input;
    this.fn = fn;
  }

  /** No-op — `FunctionTool` holds no external resources. */
  init() {}

  /** No-op — `FunctionTool` holds no external resources. */
  close() {}

  /**
   * Returns `true` if `toolName` matches this tool's capability name.
   * @param toolName - Capability name to check.
   */
  has(toolName: string): boolean {
    return toolName === this.name;
  }

  /** Returns the single capability this tool exposes, keyed by name. */
  metadata(): Record<string, IToolMetaData> | null {
    return {
      [this.name]: {
        name: this.name,
        description: this.description,
        // biome-ignore lint/suspicious/noExplicitAny: Preventing deep nesting for typescript inference
        inputSchema: zodToJsonSchema(this.input as any),
      },
    };
  }

  private async singleExecute(
    dispatch: IToolDispatch,
    options: {
      otelHeaders: OpenTelemetryHeaders;
    },
  ): Promise<Array<IJsonResultData | IMediaResultData | IErrorResultData>> {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: `Execute<${dispatch.name}>`,
      disableSpanManagement: true,
      context: {
        inheritFrom: 'TRACE_HEADERS',
        traceHeaders: options.otelHeaders,
      },
      fn: async (span) => {
        try {
          if (dispatch.name !== this.name) {
            throw new ToolNotFoundError(
              `This tools can only service the capability named '${this.name}. Provided is ${dispatch.name}'`,
            );
          }

          const parseResult = this.input.safeParse(dispatch.args);
          if (parseResult.error) {
            throw new ToolInputError(
              `Invalid input arguments for tool ${this.name}. Please provide the correct arguments as per the input schema. Error -> ${parseResult.error.message}`,
            );
          }

          const result = await this.fn({
            id: dispatch.id,
            name: dispatch.name,
            data: parseResult.data,
          });

          const resultItems = result ?? [];
          span.setStatus({ code: SpanStatusCode.OK });
          return resultItems;
        } catch (e) {
          const err = setSpanError(span, e as Error);
          return [new ErrorResultData(dispatch.id, err)];
        } finally {
          span.end();
        }
      },
    });
  }

  /**
   * Validates each dispatch against the input schema and invokes the wrapped function.
   * All dispatches are executed in parallel. Input or function errors are caught and
   * returned as {@link IErrorResultData} rather than thrown.
   */
  async execute(
    dispatches: IToolDispatch[],
    options?: ExecutionMetadataType,
  ): Promise<Array<IJsonResultData | IMediaResultData | IErrorResultData>> {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: `FunctionTool<${this.name}>`,
      disableSpanManagement: true,
      spanOptions: {
        attributes: {
          [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
          [INPUT_VALUE]: JSON.stringify(dispatches),
        },
      },
      context: options?.otelHeaders
        ? {
            inheritFrom: 'TRACE_HEADERS',
            traceHeaders: options.otelHeaders,
          }
        : undefined,
      fn: async (span) => {
        try {
          const otelHeaders = getOtelHeaderFromSpan(span);
          const promises: Promise<Array<IJsonResultData | IMediaResultData | IErrorResultData>>[] =
            [];
          for (const dispatch of dispatches) {
            promises.push(this.singleExecute(dispatch, { otelHeaders }));
          }
          const results = (await Promise.all(promises)).flat();

          span?.setAttributes({
            [OUTPUT_VALUE]: JSON.stringify(
              await Promise.all(
                results.map(async (item) => {
                  if (item.type === 'media')
                    return { type: item.type, metadata: await item.metadata() };
                  return { type: item.type, data: await item.body() };
                }),
              ),
            ),
            [OUTPUT_MIME_TYPE]: MimeType.JSON,
          });

          span.setStatus({ code: SpanStatusCode.OK });
          return results;
        } finally {
          span.end();
        }
      },
    });
  }

  /**
   * No-op — `FunctionTool` never produces external calls.
   * @returns An empty array.
   */
  onExternalResponse(): Array<IJsonResultData | IMediaResultData | IErrorResultData> {
    return [];
  }
}
