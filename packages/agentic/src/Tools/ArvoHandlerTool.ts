import {
  INPUT_VALUE,
  MimeType,
  OpenInferenceSpanKind,
  OUTPUT_MIME_TYPE,
  OUTPUT_VALUE,
  SemanticConventions,
} from '@arizeai/openinference-semantic-conventions';
import { SpanStatusCode } from '@opentelemetry/api';
import type { VersionedArvoContract } from 'arvo-core';
import { ArvoOpenTelemetry, getOtelHeaderFromSpan, type OpenTelemetryHeaders } from 'arvo-core';
import type ArvoContract from 'arvo-core/dist/ArvoContract';
import type { ArvoSemanticVersion } from 'arvo-core/dist/types';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { setSpanError } from '../helpers';
import type { ExecutionMetadataType, JsonAble } from '../types';
import type { IExternalToolResult, ITool, IToolDispatch, IToolMetaData } from './interface';

export class ArvoHandlerToolResult implements IExternalToolResult {
  public readonly id: string;
  public readonly type = 'external_call' as const;
  private readonly data: JsonAble;

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
  contract: VersionedArvoContract<TContract, TVersion>;
};

export class ArvoHandlerTool<
  TContract extends ArvoContract,
  TVersion extends ArvoSemanticVersion & keyof TContract['versions'],
> implements ITool
{
  public readonly type = 'ArvoHandlerTool' as const;
  public readonly name: string;
  private readonly contract: VersionedArvoContract<TContract, TVersion>;

  constructor({ contract }: ArvoHandlerToolParam<TContract, TVersion>) {
    this.name = contract.accepts.type;
    this.contract = contract;
  }

  init(): void {}
  close(): void {}

  has(toolName: string): boolean {
    return toolName === this.name;
  }

  metadata(): Record<string, IToolMetaData> {
    // biome-ignore lint/suspicious/noExplicitAny: Prevents TS deep nesting calculation overhead
    // biome-ignore lint/correctness/noUnusedVariables: $schema stripped intentionally — not valid in Anthropic/OpenAI tool schemas
    const { $schema, ...inputSchema } = zodToJsonSchema(this.contract.accepts.schema as any);
    return {
      [this.name]: {
        name: this.name,
        description:
          this.contract.description ?? `Arvo handler for contract type '${this.name}'`,
        inputSchema,
      },
    };
  }

  private async singleExecute(
    dispatch: IToolDispatch,
    options: { otelHeaders: OpenTelemetryHeaders },
  ): Promise<ArvoHandlerToolResult[]> {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: `Execute<${dispatch.name}>`,
      disableSpanManagement: true,
      context: {
        inheritFrom: 'TRACE_HEADERS',
        traceHeaders: options.otelHeaders,
      },
      fn: async (span) => {
        try {
          const result = new ArvoHandlerToolResult(dispatch.id, {
            contractType: this.contract.accepts.type,
            contractUri: this.contract.uri,
            contractVersion: this.contract.version,
            dataschema: this.contract.dataschema,
            data: dispatch.args as JsonAble,
          });
          span.setStatus({ code: SpanStatusCode.OK });
          return [result];
        } catch (e) {
          setSpanError(span, e as Error);
          return [];
        } finally {
          span.end();
        }
      },
    });
  }

  async execute(
    dispatches: IToolDispatch[],
    options?: ExecutionMetadataType,
  ): Promise<ArvoHandlerToolResult[]> {
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
            [OUTPUT_VALUE]: JSON.stringify(
              results.map((r) => ({ type: r.type, data: r.body() })),
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
