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

export type MCPClientParam = {
  url: string;
  toolPriority?: Record<string, number>;
  requestInit?: RequestInit;
  clientConfig?: {
    name?: string;
    version?: string;
  };
};

/**
 * A Production-grade Client for the Model Context Protocol (MCP).
 *
 * This class bridges Arvo Agents with the external MCP ecosystem, allowing agents to
 * interact with filesystem, databases, GitHub, Slack, and other standardized MCP servers.
 *
 * @remarks
 * **Key Features:**
 * - **Auto-Transport Selection:** Automatically chooses between `SSEClientTransport` and
 *   `StreamableHTTPClientTransport` based on the URL pattern (checks for `/mcp` suffix).
 * - **Orchestration Control:** Supports mapping priorities to external tools, allowing
 *   MCP tools to participate in Arvo's **Priority Batch Execution** logic.
 * - **Observability:** Deep integration with Arvo's OpenTelemetry system to trace
 *   connection status and tool execution metrics.
 * - **Tool Caching:** Discovers and caches tool definitions upon connection to minimize latency
 *   during the Agent's reasoning loop.
 *
 * @example
 * ```ts
 * const mcp = new MCPClient({
 *   url: 'http://localhost:8080/mcp',
 *   // Give the 'check_files' tool high priority so it executes before other tools
 *   toolPriority: {
 *     'check_files': 1
 *   }
 * });
 * ```
 */
export class MCPClient implements IMCPClient {
  private client: Client | null;
  private isConnected: boolean;
  private availableTools: Tool[];
  private readonly url: () => string;
  private readonly requestInit: () => RequestInit;
  private readonly toolPriority: () => Record<string, number>;
  private readonly clientConfig: () => Required<NonNullable<MCPClientParam['clientConfig']>>;

  /**
   * Creates a new MCP Client.
   *
   * @param param - Configuration object or a Lazy Configuration function.
   *
   * **Why use a function?**
   * Using a function is recommended if the URL, Auth Headers, or Tool Priorities
   * need to be resolved at **Runtime** (e.g., fetched from a Secrets Manager or Env Var)
   * rather than at **Instantiation time**.
   */
  constructor(param: MCPClientParam | (() => MCPClientParam)) {
    this.client = null;
    this.isConnected = false;
    this.availableTools = [];
    this.url = () => (typeof param === 'function' ? param() : param).url;
    this.requestInit = () => (typeof param === 'function' ? param() : param).requestInit ?? {};
    this.toolPriority = () => (typeof param === 'function' ? param() : param).toolPriority ?? {};
    this.clientConfig = () => ({
      name: 'arvo-tools-agentic-mcp-client',
      version: '1.0.0',
      ...(typeof param === 'function' ? param() : param).clientConfig,
    });
  }

  /**
   * Initializes the connection to the remote MCP Server.
   *
   * This lifecycle method:
   * 1. Resolves the Transport (SSE vs HTTP).
   * 2. Performs the protocol handshake.
   * 3. Fetches the list of available tools immediately (to populate the Agent's context).
   *
   * @param config - Trace context.
   * @throws Error if the connection fails or handshake is rejected.
   */
  async connect(config: { otelInfo: OtelInfoType }): Promise<void> {
    try {
      const url = this.url();
      const requestInit = this.requestInit();
      const transport = url.includes('/mcp')
        ? new StreamableHTTPClientTransport(new URL(url), { requestInit })
        : new SSEClientTransport(new URL(url), { requestInit });

      this.client = new Client({
        name: this.clientConfig().name,
        version: this.clientConfig().version,
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
   * Returns the Tool Definitions discovered during the `connect()` phase.
   *
   * This maps the raw MCP Tool format into Arvo's `AgentToolDefinition` structure
   * so they can be injected into the LLM's context window.
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
   * Executes a tool on the remote MCP Server.
   *
   * Wraps the execution in a dedicated OpenTelemetry Child Span (`MCP.invoke<tool_name>`)
   * to track latency and success/failure rates of the external system.
   *
   * @param param - The tool name and argument payload generated by the LLM.
   * @returns The simplified JSON string result to be fed back to the LLM.
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
   * Terminates the transport session and resets clients state.
   * Safe to call multiple times (idempotent).
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

  /**
   * Retrieves the priority configuration for MCP Tools.
   *
   * This allows external MCP tools to explicitly participate in Arvo's **Priority Batch Execution**.
   */
  async getToolPriority() {
    return this.toolPriority();
  }
}
