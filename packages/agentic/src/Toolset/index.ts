import {
  INPUT_VALUE,
  MimeType,
  OUTPUT_MIME_TYPE,
  OUTPUT_VALUE,
  SemanticConventions,
} from '@arizeai/openinference-semantic-conventions';
import { SpanStatusCode } from '@opentelemetry/api';
import { ArvoOpenTelemetry, getOtelHeaderFromSpan, OpenInferenceSpanKind } from 'arvo-core';
import { setSpanError } from '../helpers';
import { ErrorResultData } from '../Tools/helpers';
import type {
  IErrorResultData,
  IJsonResultData,
  IMediaResultData,
  ITool,
  IToolDispatch,
  IToolMetaData,
} from '../Tools/interface';
import type { ExecutionMetadataType } from '../types';
import { ToolNotExist } from './helpers';
import type { IToolNotExist } from './interface';

export class Toolset<T extends Record<string, ITool>> {
  private tools: T;
  private toolIndex: Record<
    string,
    {
      metadata: IToolMetaData;
      internal: {
        toolsKey: keyof T;
        indexKey: string;
      };
    }
  > = {};

  constructor(tools: T) {
    this.tools = tools;
  }

  private async buildIndex() {
    const sourceData = await Promise.all(
      Object.entries(this.tools).map(async ([toolKey, tool]) => ({
        toolKey,
        toolMetaData: (await tool.metadata()) ?? {},
      })),
    );
    for (const { toolKey, toolMetaData } of sourceData) {
      if (Object.keys(toolMetaData).length === 0) continue;
      for (const [key, value] of Object.entries(toolMetaData)) {
        const toolIndexKey = `${toolKey}>${key}`;
        this.toolIndex[toolIndexKey] = {
          metadata: value,
          internal: {
            toolsKey: toolKey,
            indexKey: toolIndexKey,
          },
        };
      }
    }
  }

  async init(options?: ExecutionMetadataType) {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: 'Toolset.init',
      disableSpanManagement: true,
      spanOptions: {
        attributes: {
          [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
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
          await Promise.all(
            Object.values(this.tools).map(async (tool) => await tool.init({ otelHeaders })),
          );
          await this.buildIndex();
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (e) {
          setSpanError(span, e as Error);
        } finally {
          span.end();
        }
      },
    });
  }

  async close(options?: ExecutionMetadataType) {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: 'Toolset.close',
      disableSpanManagement: true,
      spanOptions: {
        attributes: {
          [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
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
          await Promise.all(
            Object.values(this.tools).map(async (tool) => await tool.close({ otelHeaders })),
          );
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (e) {
          setSpanError(span, e as Error);
        } finally {
          span.end();
        }
      },
    });
  }

  metadata() {
    const data: Record<string, IToolMetaData> = {};
    for (const [key, value] of Object.entries(this.toolIndex)) {
      data[key] = { ...value.metadata, name: value.internal.indexKey };
    }
    return data;
  }

  async execute(
    dispatches: IToolDispatch[],
    options?: ExecutionMetadataType,
  ): Promise<Array<IJsonResultData | IMediaResultData | IErrorResultData | IToolNotExist>> {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: `Toolset.execute`,
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
          const promises: Promise<
            Array<IJsonResultData | IMediaResultData | IErrorResultData | IToolNotExist>
          >[] = [];

          for (const dispatch of dispatches) {
            promises.push(
              (async () => {
                const toolData = this.toolIndex[dispatch.name];
                if (!toolData) {
                  return [new ToolNotExist(dispatch.id, dispatch)];
                }
                try {
                  return await this.tools[toolData.internal.toolsKey].execute(
                    [{ ...dispatch, name: toolData.metadata.name }],
                    { otelHeaders },
                  );
                } catch (e) {
                  return [new ErrorResultData(dispatch.id, e as Error)];
                }
              })(),
            );
          }

          const results = (await Promise.all(promises)).flat();

          span?.setAttributes({
            [OUTPUT_VALUE]: JSON.stringify(
              await Promise.all(
                results.map(async (item) => {
                  if (item.type === 'tool_not_exist') {
                    return { type: item.type, toolname: (await item.body()).name };
                  }
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
}
