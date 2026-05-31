import {
  INPUT_VALUE,
  MimeType,
  OpenInferenceSpanKind,
  OUTPUT_MIME_TYPE,
  OUTPUT_VALUE,
  SemanticConventions,
} from '@arizeai/openinference-semantic-conventions';
import { SpanStatusCode } from '@opentelemetry/api';
import type {
  ArvoContract,
  ArvoEvent,
  ArvoSemanticVersion,
  InferVersionedArvoContract,
  OpenTelemetryHeaders,
  VersionedArvoContract,
} from 'arvo-core';
import {
  ArvoOpenTelemetry,
  cleanString,
  createArvoEvent,
  exceptionToSpan,
  getOtelHeaderFromSpan,
} from 'arvo-core';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { setSpanError } from '../helpers';
import type { ExecutionMetadataType, JsonAble, PromiseAble } from '../types';
import { ToolInputError } from './error';
import { ErrorResultData, JsonResultData } from './helpers';
import type {
  IErrorResultData,
  IExternalToolResult,
  IJsonResultData,
  IMediaResultData,
  ITool,
  IToolDispatch,
  IToolMetaData,
} from './interface';

/**
 * Concrete {@link IExternalToolResult} produced by {@link ArvoHandlerTool.execute}.
 *
 * The body carries the contract metadata and the validated LLM arguments so that
 * the external entity receiving this signal has everything it needs to construct
 * an Arvo event without re-reading the contract.
 */
export class ArvoHandlerToolResult implements IExternalToolResult {
  public readonly id: string;
  public readonly type = 'external_call' as const;
  private readonly data: JsonAble;

  /**
   * @param id - Tool call id this result is correlated to.
   * @param data - Contract metadata and validated arguments.
   */
  constructor(id: string, data: JsonAble) {
    this.id = id;
    this.data = data;
  }

  body(): JsonAble {
    return this.data;
  }
}

export type ArvoHandlerToolParam<
  TContract extends ArvoContract,
  TVersion extends ArvoSemanticVersion & keyof TContract['versions'],
> = {
  /** The versioned Arvo contract this tool wraps. */
  contract: VersionedArvoContract<TContract, TVersion>;
  /**
   * Optional callback invoked during {@link ArvoHandlerTool.onExternalResponse} once
   * the incoming Arvo event has been validated against the contract's emit schema.
   *
   * Use this to apply custom transformation or enrichment before the result is fed
   * back to the agent. If omitted, the event's `data` is returned as a plain
   * {@link IJsonResultData}.
   *
   * @param event - The validated emit event or system error event from the contract.
   * @param options - Execution context passed through from {@link ArvoHandlerTool.onExternalResponse}:
   *   - `otelHeaders` — active OTel trace headers for propagating the span context.
   *   - `dispatch` — the original {@link IToolDispatch} from the LLM that triggered this call.
   *   - `request` — the {@link IExternalToolResult} produced when the call was first signalled.
   *   - `response` — the raw response payload received from the external handler.
   */
  onResponse?: (
    event:
      | InferVersionedArvoContract<VersionedArvoContract<TContract, TVersion>>['emitList'][number]
      | InferVersionedArvoContract<VersionedArvoContract<TContract, TVersion>>['systemError'],
    options: ExecutionMetadataType & {
      dispatch: IToolDispatch;
      request: IExternalToolResult;
      // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
      response: Record<string, any>;
    },
  ) => PromiseAble<Array<IJsonResultData | IMediaResultData | IErrorResultData>>;
};

/**
 * An {@link ITool} implementation that wraps a versioned Arvo contract and routes
 * LLM tool calls through the Arvo event-driven infrastructure.
 *
 * ### Execute flow
 * When the LLM invokes this tool, `execute` validates the arguments against the
 * contract's `accepts` schema and returns an {@link ArvoHandlerToolResult} (an
 * `external_call` signal). The agent pauses and hands the pending dispatch to the
 * caller, who is expected to construct and emit the corresponding Arvo event.
 *
 * ### Response flow
 * When the external Arvo handler responds, the caller feeds the response back via
 * {@link onExternalResponse}. The method parses it as an `ArvoEvent`, validates the
 * event type against the contract's declared emit types (including system errors),
 * and returns a typed result the agent can use to continue the conversation.
 */
export class ArvoHandlerTool<
  TContract extends ArvoContract,
  TVersion extends ArvoSemanticVersion & keyof TContract['versions'],
> implements ITool
{
  public readonly type = 'ArvoHandlerTool' as const;
  /** The contract's `accepts.type` — used as the LLM-facing tool name. */
  public readonly name: string;
  private readonly contract: ArvoHandlerToolParam<TContract, TVersion>['contract'];
  private readonly onResponse: NonNullable<
    ArvoHandlerToolParam<TContract, TVersion>['onResponse']
  > | null;

  constructor({ contract, onResponse }: ArvoHandlerToolParam<TContract, TVersion>) {
    this.name = contract.accepts.type;
    this.contract = contract;
    this.onResponse = onResponse ?? null;
  }

  /** No-op — `ArvoHandlerTool` holds no external resources. */
  init(): void {}

  /** No-op — `ArvoHandlerTool` holds no external resources. */
  close(): void {}

  /**
   * Returns `true` if `toolName` matches the contract's `accepts.type`.
   * @param toolName - Capability name to check.
   */
  has(toolName: string): boolean {
    return toolName === this.name;
  }

  /**
   * Returns the single capability this tool exposes, derived from the contract's
   * `accepts` schema. The `$schema` property is stripped so the schema is safe to
   * pass directly to Anthropic and OpenAI tool definitions.
   */
  metadata(): Record<string, IToolMetaData> {
    // biome-ignore lint/suspicious/noExplicitAny: Prevents TS deep nesting calculation overhead
    // biome-ignore lint/correctness/noUnusedVariables: $schema stripped — not valid in LLM tool schemas
    const { $schema, ...inputSchema } = zodToJsonSchema(this.contract.accepts.schema as any);
    return {
      [this.name]: {
        name: this.name,
        description: this.contract.description ?? `Arvo handler for contract type '${this.name}'`,
        inputSchema,
      },
    };
  }

  private async singleExecute(
    dispatch: IToolDispatch,
    options: { otelHeaders: OpenTelemetryHeaders },
  ): Promise<Array<ArvoHandlerToolResult | ErrorResultData>> {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: `Execute<${dispatch.name}>`,
      disableSpanManagement: true,
      context: {
        inheritFrom: 'TRACE_HEADERS',
        traceHeaders: options.otelHeaders,
      },
      fn: async (span) => {
        try {
          const parsed = this.contract.accepts.schema.safeParse(dispatch.args);
          if (parsed.error) {
            throw new ToolInputError(
              `Invalid input for tool '${this.name}': ${parsed.error.message}`,
            );
          }

          const result = new ArvoHandlerToolResult(dispatch.id, {
            contractType: this.contract.accepts.type,
            contractUri: this.contract.uri,
            contractVersion: this.contract.version,
            dataschema: this.contract.dataschema,
            data: parsed.data as JsonAble,
          });
          span.setStatus({ code: SpanStatusCode.OK });
          return [result];
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
   * Validates the LLM's arguments against the contract's `accepts` schema and
   * returns an {@link ArvoHandlerToolResult} for each valid dispatch.
   *
   * Invalid arguments produce an {@link IErrorResultData} with the Zod validation
   * message rather than throwing, so the agent loop remains intact.
   */
  async execute(
    dispatches: IToolDispatch[],
    options?: ExecutionMetadataType,
  ): Promise<Array<ArvoHandlerToolResult | ErrorResultData>> {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: `ArvoHandlerTool<${this.name}>`,
      disableSpanManagement: true,
      spanOptions: {
        attributes: {
          [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
          [INPUT_VALUE]: JSON.stringify(dispatches),
        },
      },
      context: options?.otelHeaders
        ? { inheritFrom: 'TRACE_HEADERS', traceHeaders: options.otelHeaders }
        : undefined,
      fn: async (span) => {
        try {
          const otelHeaders = getOtelHeaderFromSpan(span);
          const results = (
            await Promise.all(
              dispatches
                .filter((d) => d.name === this.name)
                .map((d) => this.singleExecute(d, { otelHeaders })),
            )
          ).flat();

          span.setAttributes({
            [OUTPUT_VALUE]: JSON.stringify(results.map((r) => ({ type: r.type, data: r.body() }))),
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
   * Processes the external Arvo event response for a previously signalled tool call.
   * Any parsing or unexpected error is caught and returned as {@link IErrorResultData}.
   *
   * @param dispatch - The original {@link IToolDispatch} from the LLM, forwarded to
   *   {@link ArvoHandlerToolParam.onResponse} so custom callbacks can correlate results.
   * @param request - The {@link IExternalToolResult} produced by {@link execute} for
   *   this dispatch, used to correlate the result back to the correct tool call id.
   * @param response - The raw Arvo event payload received from the external handler.
   */
  async onExternalResponse(
    dispatch: IToolDispatch,
    request: IExternalToolResult,
    // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
    response: Record<string, any>,
    options?: ExecutionMetadataType,
  ): Promise<Array<IJsonResultData | IMediaResultData | IErrorResultData>> {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: `ArvoHandlerTool<${this.name}>.onExternalResponse`,
      disableSpanManagement: true,
      spanOptions: {
        attributes: {
          [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
          [INPUT_VALUE]: JSON.stringify({ request, response }),
        },
      },
      context: options?.otelHeaders
        ? { inheritFrom: 'TRACE_HEADERS', traceHeaders: options.otelHeaders }
        : undefined,
      fn: async (span) => {
        try {
          span.setStatus({ code: SpanStatusCode.OK });
          const otelHeaders = getOtelHeaderFromSpan(span);

          // Throws if the response cannot be parsed as a valid ArvoEvent
          const event: ArvoEvent = createArvoEvent(
            {
              ...response,
              id: {
                deduplication: 'DEVELOPER_MANAGED',
                value: response.id ?? '',
              },
              // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
            } as any,
            undefined,
            { disable: true },
          );

          const validEmitTypes = [
            ...Object.keys(this.contract.emits),
            this.contract.systemError.type,
          ];

          if (!validEmitTypes.includes(event.type)) {
            throw new Error(
              cleanString(
                `Unexpected event type '${event.type}' received as response for
                ArvoHandlerTool '${this.name}'. Expected one of: ${validEmitTypes.join(', ')}.
                Check the integration logic — the wrong handler may be responding to this call.`,
              ),
            );
          }

          if (this.onResponse) {
            return await this.onResponse(event.toJSON(), {
              otelHeaders,
              dispatch,
              request,
              response,
            });
          }

          return [new JsonResultData(request.id, event.data)];
        } catch (e) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
          exceptionToSpan(e as Error, span);
          return [new ErrorResultData(request.id, e as Error)];
        } finally {
          span.end();
        }
      },
    });
  }
}
