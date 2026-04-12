import {
  INPUT_VALUE,
  MimeType,
  OUTPUT_MIME_TYPE,
  OUTPUT_VALUE,
  SemanticConventions,
} from '@arizeai/openinference-semantic-conventions';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  ArvoOpenTelemetry,
  getOtelHeaderFromSpan,
  OpenInferenceSpanKind,
  type OpenTelemetryHeaders,
} from 'arvo-core';
import { setSpanError } from '../helpers';
import type { AudioContentType, ExecutionMetadataType, ImageContentType, JsonAble } from '../types';
import { ErrorResultData, JsonResultData, MediaResultData } from './helpers';
import type {
  IErrorResultData,
  IJsonResultData,
  IMediaResultData,
  ITool,
  IToolDispatch,
  IToolMetaData,
} from './interface';

export type MCPClientParam = {
  name: string;
  clientConfig?: {
    name?: string;
    version?: string;
  };
} & (
  | {
      transport: {
        type: 'http';
        url: string;
        requestInit?: RequestInit;
      };
    }
  | {
      transport: {
        type: 'stdio';
        command: string;
        args?: string[];
        env?: Record<string, string>;
      };
    }
);

export class MCPClient implements ITool {
  public readonly type = 'MCPClient';
  public readonly name: string;
  private readonly param: MCPClientParam;
  private client: Client | null = null;
  private cachedMetadata: Record<string, IToolMetaData> = {};

  constructor(param: MCPClientParam) {
    this.name = param.name;
    this.param = param;
  }

  private resolveClientConfig() {
    return {
      name: this.param.clientConfig?.name ?? 'arvo-tools-agentic-mcp-tool',
      version: this.param.clientConfig?.version ?? '1.0.0',
    };
  }

  private createTransport() {
    const { transport } = this.param;
    if (transport.type === 'stdio') {
      return new StdioClientTransport({
        command: transport.command,
        args: transport.args,
        env: transport.env,
      });
    }
    const url = new URL(transport.url);
    if (transport.url.includes('/mcp')) {
      return new StreamableHTTPClientTransport(url, { requestInit: transport.requestInit });
    }
    return new SSEClientTransport(url, { requestInit: transport.requestInit });
  }

  async init(options?: ExecutionMetadataType): Promise<void> {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: `MCPClient<${this.name}>.init`,
      disableSpanManagement: true,
      spanOptions: {
        attributes: {
          [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
        },
      },
      context: options?.otelHeaders
        ? { inheritFrom: 'TRACE_HEADERS', traceHeaders: options.otelHeaders }
        : undefined,
      fn: async (span) => {
        try {
          this.client = new Client(this.resolveClientConfig());
          await this.client.connect(this.createTransport());
          const { tools } = await this.client.listTools();
          this.cachedMetadata = {};
          for (const tool of tools) {
            this.cachedMetadata[tool.name] = {
              name: tool.name,
              description: tool.description ?? '',
              inputSchema: tool.inputSchema as Record<string, unknown>,
            };
          }
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

  async close(options?: ExecutionMetadataType): Promise<void> {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: `MCPClient<${this.name}>.close`,
      disableSpanManagement: true,
      spanOptions: {
        attributes: {
          [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
        },
      },
      context: options?.otelHeaders
        ? { inheritFrom: 'TRACE_HEADERS', traceHeaders: options.otelHeaders }
        : undefined,
      fn: async (span) => {
        try {
          if (this.client) {
            await this.client.close();
            this.client = null;
            this.cachedMetadata = {};
          }
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (e) {
          setSpanError(span, e as Error);
        } finally {
          span.end();
        }
      },
    });
  }

  has(toolName: string): boolean {
    return toolName in this.cachedMetadata;
  }

  metadata(): Record<string, IToolMetaData> {
    return { ...this.cachedMetadata };
  }

  private async singleExecute(
    dispatch: IToolDispatch,
    options: { otelHeaders: OpenTelemetryHeaders },
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
          if (!this.client) {
            throw new Error(`MCPClient<${this.name}> is not initialized. Call init() first.`);
          }
          if (!this.has(dispatch.name)) {
            throw new Error(`Tool '${dispatch.name}' not found in MCPClient<${this.name}>`);
          }

          const result = await this.client.callTool({
            name: dispatch.name,
            arguments: dispatch.args,
          });

          if (result.isError) {
            throw new Error(
              `MCP tool '${dispatch.name}' returned an error: ${JSON.stringify(result.content)}`,
            );
          }

          const items: Array<IJsonResultData | IMediaResultData> = [];
          for (const item of result.content as Array<Record<string, unknown>>) {
            if (item.type === 'image') {
              items.push(
                new MediaResultData(dispatch.id, {
                  name: null,
                  mediatype: 'image',
                  contenttype: item.mimeType as ImageContentType,
                  data: item.data as string,
                }),
              );
            } else if (item.type === 'audio') {
              items.push(
                new MediaResultData(dispatch.id, {
                  name: null,
                  mediatype: 'audio',
                  contenttype: item.mimeType as AudioContentType,
                  data: item.data as string,
                }),
              );
            } else {
              items.push(new JsonResultData(dispatch.id, item as JsonAble));
            }
          }

          span.setStatus({ code: SpanStatusCode.OK });
          return items;
        } catch (e) {
          const err = setSpanError(span, e as Error);
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
      name: `MCPClient<${this.name}>`,
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
            await Promise.all(dispatches.map((d) => this.singleExecute(d, { otelHeaders })))
          ).flat();

          span.setAttributes({
            [OUTPUT_VALUE]: JSON.stringify(
              await Promise.all(
                results.map(async (item) => {
                  if (item.type === 'media')
                    return {
                      type: item.type,
                      metadata: await (item as IMediaResultData).metadata(),
                    };
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
