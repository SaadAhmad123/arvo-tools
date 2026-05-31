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
  IExternalToolResult,
  IJsonResultData,
  IMediaResultData,
  ITool,
  IToolDispatch,
  IToolMetaData,
} from '../Tools/interface';
import type { ExecutionMetadataType } from '../types';
import { ToolNotExist } from './helpers';
import type { IToolNotExist } from './interface';

/**
 * Aggregates multiple {@link ITool} implementations into a single dispatchable unit.
 *
 * Each tool is registered under a caller-chosen key. The internal index maps every
 * capability exposed by every tool to a compound key of the form `toolKey>toolName`,
 * which is used as the tool name surfaced to the LLM via {@link metadata}.
 *
 * ### Lifecycle
 * Call {@link init} once before using {@link metadata} or {@link execute}.
 * Call {@link close} when the toolset is no longer needed to release underlying resources.
 *
 * @template T - A record mapping string keys to {@link ITool} implementations.
 */
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

  /**
   * @param tools - A record of named {@link ITool} instances to aggregate.
   */
  constructor(tools: T) {
    this.tools = tools;
  }

  /**
   * Builds a compound index key from one or more parts joined by `>`.
   *
   * @example
   * Toolset.buildKey('fn', 'add')          // 'fn>add'
   * Toolset.buildKey('arvo', 'com.calc.add') // 'arvo>com.calc.add'
   */
  static buildKey(...parts: [string, ...string[]]): string {
    return parts.join('>');
  }

  /**
   * Returns `true` if the given compound tool name exists in the current index.
   * Always returns `false` before {@link init} is called.
   *
   * @param toolName - Compound index key of the form `toolKey>toolName`.
   */
  has(toolName: string) {
    return toolName in this.toolIndex;
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
        const toolIndexKey = Toolset.buildKey(toolKey, key);
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

  /**
   * Initialises all registered tools in parallel and builds the dispatch index.
   * Must be called before {@link metadata} or {@link execute}.
   *
   * @throws If any underlying tool's `init` throws, the error is re-thrown after
   *   recording it on the active OTel span.
   */
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
          throw e;
        } finally {
          span.end();
        }
      },
    });
  }

  /**
   * Closes all registered tools in parallel and clears the dispatch index.
   * Errors from individual tools are recorded on the OTel span but do not re-throw,
   * so all tools are always attempted regardless of partial failures.
   */
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
          this.toolIndex = {};
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (e) {
          setSpanError(span, e as Error);
        } finally {
          span.end();
        }
      },
    });
  }

  /**
   * Returns the metadata for every capability in the index, keyed by compound name
   * (`toolKey>toolName`). The `name` field within each entry is set to the compound
   * key so the LLM receives a globally unique, routable tool name.
   *
   * Returns an empty object before {@link init} is called or after {@link close}.
   */
  metadata() {
    const data: Record<string, IToolMetaData> = {};
    for (const [key, value] of Object.entries(this.toolIndex)) {
      data[key] = { ...value.metadata, name: value.internal.indexKey };
    }
    return data;
  }

  /**
   * Routes each dispatch to the correct underlying tool and returns one result per dispatch.
   *
   * Dispatches are executed in parallel. For each dispatch:
   * - If the compound name is not in the index, a {@link IToolNotExist} result is returned.
   * - If the underlying tool throws, an {@link IErrorResultData} result is returned.
   * - Otherwise the tool's own result (`json`, `media`, `error`, or `external_call`) is forwarded.
   *
   * The entire call is recorded as a single OpenInference `TOOL` span.
   *
   * @param dispatches - Tool call descriptors from the LLM, using compound index keys as names.
   */
  async execute(
    dispatches: IToolDispatch[],
    options?: ExecutionMetadataType,
  ): Promise<
    Array<
      IJsonResultData | IMediaResultData | IErrorResultData | IExternalToolResult | IToolNotExist
    >
  > {
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
            Array<
              | IJsonResultData
              | IMediaResultData
              | IErrorResultData
              | IToolNotExist
              | IExternalToolResult
            >
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

  /**
   * Routes an external response back to the tool that originally produced the
   * {@link IExternalToolResult} and returns its processed result.
   *
   * Uses the compound index key on `dispatch.name` to locate the correct tool,
   * then calls {@link ITool.onExternalResponse} with the original tool capability name.
   * Returns {@link IToolNotExist} if the compound key is not in the index.
   */
  async onExternalResponse(
    dispatch: IToolDispatch,
    request: IExternalToolResult,
    response: Record<string, unknown>,
    options?: ExecutionMetadataType,
  ): Promise<Array<IJsonResultData | IMediaResultData | IErrorResultData | IToolNotExist>> {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: `Toolset.onExternalResponse`,
      disableSpanManagement: true,
      spanOptions: {
        attributes: {
          [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
          [INPUT_VALUE]: JSON.stringify({ dispatch, request: await request.body() }),
        },
      },
      context: options?.otelHeaders
        ? { inheritFrom: 'TRACE_HEADERS', traceHeaders: options.otelHeaders }
        : undefined,
      fn: async (span) => {
        try {
          const otelHeaders = getOtelHeaderFromSpan(span);
          const toolData = this.toolIndex[dispatch.name];

          if (!toolData) {
            span.setStatus({ code: SpanStatusCode.OK });
            return [new ToolNotExist(dispatch.id, dispatch)];
          }

          const results = await this.tools[toolData.internal.toolsKey].onExternalResponse(
            dispatch,
            request,
            response,
            { otelHeaders },
          );

          span.setAttributes({
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
        } catch (e) {
          setSpanError(span, e as Error);
          return [new ErrorResultData(dispatch.id, e as Error)];
        } finally {
          span.end();
        }
      },
    });
  }
}
