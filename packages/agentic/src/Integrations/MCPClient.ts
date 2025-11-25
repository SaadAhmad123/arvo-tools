import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ListToolsResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  ArvoOpenTelemetry,
  exceptionToSpan,
  logToSpan,
  OpenInference,
  OpenInferenceSpanKind,
} from 'arvo-core';
import type { IMCPClient } from '../interfaces.mcp.js';
import type { OtelInfoType } from '../types.js';

/**
 * Model Context Protocol (MCP) client implementation for connecting to and interacting with MCP servers.
 *
 * This client provides a robust interface for establishing connections to MCP servers,
 * discovering available tools, invoking those tools with arguments, and managing the
 * connection lifecycle. It supports both Server-Sent Events (SSE) and streamable HTTP
 * transport protocols, automatically selecting the appropriate transport based on the URL.
 */
export class MCPClient implements IMCPClient {
  private client: Client | null;
  private isConnected: boolean;
  private availableTools: Tool[];
  private readonly url: () => string;
  private readonly requestInit: () => RequestInit;

  constructor(
    param:
      | { url: string; requestInit?: RequestInit }
      | (() => { url: string; requestInit?: RequestInit }),
  ) {
    this.client = null;
    this.isConnected = false;
    this.availableTools = [];
    this.url = () => (typeof param === 'function' ? param() : param).url;
    this.requestInit = () => (typeof param === 'function' ? param() : param).requestInit ?? {};
  }

  /**
   * Establishes a connection to the MCP server and discovers available tools.
   *
   * This method performs the following operations:
   * 1. Selects the appropriate transport (SSE or HTTP streaming) based on URL
   * 2. Creates and configures the MCP client with capabilities
   * 3. Establishes the connection to the server
   * 4. Retrieves and caches the list of available tools
   * 5. Logs all operations to the provided OpenTelemetry span
   *
   * @returns Promise that resolves when connection is established and tools are discovered
   * @throws {Error} Throws an error if connection fails, with details logged to the span
   */
  async connect(config: { otelInfo: OtelInfoType }): Promise<void> {
    try {
      const url = this.url();
      const requestInit = this.requestInit();
      const transport = url.includes('/mcp')
        ? new StreamableHTTPClientTransport(new URL(url), { requestInit })
        : new SSEClientTransport(new URL(url), { requestInit });

      this.client = new Client({
        name: 'arvo-tools-agentic-mcp-client',
        version: '1.0.0',
      });

      await this.client.connect(transport);

      logToSpan(
        {
          level: 'INFO',
          message: `Connected to MCP Server@${url}`,
        },
        config.otelInfo.span,
      );

      const tools: ListToolsResult = await this.client.listTools();
      this.availableTools = tools.tools;
      this.isConnected = true;

      logToSpan(
        {
          level: 'INFO',
          message: 'Available MCP tools:',
          tools: JSON.stringify(
            this.availableTools.map((t: Tool) => ({ name: t.name, description: t.description })),
          ),
        },
        config.otelInfo.span,
      );
    } catch (error) {
      exceptionToSpan(error as Error, config.otelInfo.span);
      this.isConnected = false;
      throw new Error(`Unable to connect to the MCP Server@${this.url()}`);
    }
  }

  /**
   * Retrieves the list of available tool definitions from the connected MCP server.
   *
   * Transforms the cached MCP tools into the AgentToolDefinition format required
   * by the agent system. Tools listed in restrictedTools will have requires_approval set to true.
   * This method returns an empty array if not connected.
   */
  async getTools(config: { otelInfo: OtelInfoType }): Promise<
    {
      name: string;
      description: string;
      // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
      inputSchema: Record<string, any>;
    }[]
  > {
    const toolDef: {
      name: string;
      description: string;
      // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
      inputSchema: Record<string, any>;
    }[] = [];

    if (!this.isConnected) {
      logToSpan(
        {
          level: 'WARNING',
          message: `Cannot get tools - not connected to MCP Server@${this.url()}`,
        },
        config.otelInfo.span,
      );
      return toolDef;
    }

    for (const item of this.availableTools) {
      toolDef.push({
        name: item.name,
        description: item.description ?? '',
        inputSchema: item.inputSchema,
      });
    }

    logToSpan(
      {
        level: 'INFO',
        message: `Retrieved ${toolDef.length} tool definitions from MCP Server@${this.url()}`,
      },
      config.otelInfo.span,
    );

    return toolDef;
  }

  /**
   * Invokes a specific tool on the MCP server with the provided arguments.
   *
   * This method sends a tool invocation request to the connected MCP server and
   * returns the result. All operations are logged to the OpenTelemetry span for
   * observability. If an error occurs during invocation, it returns an error message
   * rather than throwing, allowing the agent to handle tool failures gracefully.
   */
  async invokeTool(
    param: { name: string; arguments?: Record<string, unknown> | null },
    config: { otelInfo: OtelInfoType },
  ): Promise<string> {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: `MCP.invoke<${param.name}>`,
      disableSpanManagement: true,
      context: {
        inheritFrom: 'TRACE_HEADERS',
        traceHeaders: config.otelInfo.headers,
      },
      fn: async (span) => {
        try {
          span.setAttribute(OpenInference.ATTR_SPAN_KIND, OpenInferenceSpanKind.TOOL);
          span.setStatus({
            code: SpanStatusCode.OK,
          });

          logToSpan(
            {
              level: 'INFO',
              message: `Invoking tool<${param.name}> with arguments on MCP Server@${this.url()}`,
              param: JSON.stringify(param),
            },
            span,
          );

          if (!this.isConnected || !this.client) {
            throw new Error(`MCP Server@${this.url()} not connected`);
          }

          const result = await this.client.callTool({
            name: param.name,
            arguments: param.arguments ?? undefined,
          });

          logToSpan(
            {
              level: 'INFO',
              message: `Successfully invoked tool<${param.name}> on MCP Server@${this.url()}`,
            },
            span,
          );

          return JSON.stringify(result);
        } catch (error) {
          const err = new Error(
            `Error occurred while invoking MCP tool <${param.name}@${this.url()}> -> ${(error as Error)?.message ?? 'Something went wrong'}`,
          );

          exceptionToSpan(err, span);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err.message,
          });

          return err.message;
        } finally {
          span.end();
        }
      },
    });
  }

  /**
   * Gracefully disconnects from the MCP server and cleans up resources.
   *
   * This method safely closes the connection to the MCP server if one exists,
   * resets the connection state, and clears cached data. It's safe to call
   * multiple times - subsequent calls will be no-ops if already disconnected.
   */
  async disconnect(config: { otelInfo: OtelInfoType }): Promise<void> {
    if (this.client && this.isConnected) {
      await this.client.close();
      this.isConnected = false;
      this.availableTools = [];
      this.client = null;

      logToSpan(
        {
          level: 'INFO',
          message: `Disconnected from MCP Server@${this.url()}`,
        },
        config.otelInfo.span,
      );
    } else {
      logToSpan(
        {
          level: 'INFO',
          message: `MCP Server@${this.url()} already disconnected`,
        },
        config.otelInfo.span,
      );
    }
  }
  async getToolPriority() {
    return {};
  }
}
