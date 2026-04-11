import {
  INPUT_MIME_TYPE,
  INPUT_VALUE,
  MimeType,
  OpenInferenceSpanKind,
  OUTPUT_MIME_TYPE,
  OUTPUT_VALUE,
  SemanticConventions,
  TOOL_DESCRIPTION,
  TOOL_JSON_SCHEMA,
  TOOL_NAME,
} from '@arizeai/openinference-semantic-conventions';
import { SpanStatusCode } from '@opentelemetry/api';
import { ArvoOpenTelemetry, getOtelHeaderFromSpan, type OpenTelemetryHeaders } from 'arvo-core';
import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ExecutionMetadataType, PromiseAble } from '../types';
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
  name: string;
  description: string;
  input: T;
  fn: (param: {
    id: string;
    name: string;
    data: Record<string, unknown>;
    // biome-ignore lint/suspicious/noConfusingVoidType: Better DX
  }) => PromiseAble<Array<MediaResultData | JsonResultData> | void>;
};

export class FunctionTool<T extends z.ZodTypeAny = z.ZodTypeAny> implements ITool<'FunctionTool'> {
  public readonly type = 'FunctionTool' as const;
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

  init() {}
  close() {}

  has(toolName: string): boolean {
    return toolName === this.name;
  }

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
      spanOptions: {
        attributes: {
          [TOOL_NAME]: dispatch.name,
          [INPUT_VALUE]: JSON.stringify(dispatch.args),
          [INPUT_MIME_TYPE]: MimeType.JSON,
          [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
        },
      },
      context: {
        inheritFrom: 'TRACE_HEADERS',
        traceHeaders: options.otelHeaders,
      },
      fn: async (span) => {
        try {
          if (dispatch.name !== this.name)
            throw new Error(
              `This tools can only service the capability named '${this.name}. Provided is ${dispatch.name}'`,
            );
          const parseResult = this.input.safeParse(dispatch.args);
          if (parseResult.error) {
            throw new Error(
              `Invalid input arguments for tool ${this.name}. Please provide the correct arguments as per the input schema. Error -> ${parseResult.error.message}`,
            );
          }
          const result = await this.fn({
            id: dispatch.id,
            name: dispatch.name,
            data: parseResult.data,
          });

          const resultItems = result ?? [];
          span?.setAttributes({
            [OUTPUT_VALUE]: JSON.stringify(
              await Promise.all(
                resultItems.map(async (item) => {
                  if (item.type === 'media')
                    return { type: item.type, metadata: await item.metadata() };
                  return { type: item.type, data: await item.body() };
                }),
              ),
            ),
            [OUTPUT_MIME_TYPE]: MimeType.JSON,
          });
          return resultItems;
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
          span.recordException(err);
          return [new ErrorResultData(dispatch.id, err)];
        } finally {
          span.end();
        }
      },
    });
  }

  async execute(
    dispatches: IToolDispatch[],
    options?: ExecutionMetadataType,
  ): Promise<Array<IJsonResultData | IMediaResultData | IErrorResultData>> {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: `FunctionTool<${this.name}>`,
      disableSpanManagement: true,
      spanOptions: {
        attributes: {
          [TOOL_NAME]: this.name,
          [TOOL_DESCRIPTION]: this.description,
          // biome-ignore lint/suspicious/noExplicitAny: Preventing deep nesting for typescript inference
          [TOOL_JSON_SCHEMA]: JSON.stringify(zodToJsonSchema(this.input as any)),
        },
      },
      context: options?.otelHeaders
        ? {
            inheritFrom: 'TRACE_HEADERS',
            traceHeaders: options.otelHeaders,
          }
        : undefined,
      fn: async (span) => {
        const otelHeaders = getOtelHeaderFromSpan(span);
        try {
          return (
            await Promise.all(
              dispatches.map((dispatch) => this.singleExecute(dispatch, { otelHeaders })),
            )
          ).flat();
        } finally {
          span.end();
        }
      },
    });
  }
}
