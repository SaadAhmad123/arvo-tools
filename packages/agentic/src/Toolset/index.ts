import { ArvoOpenTelemetry, getOtelHeaderFromSpan } from 'arvo-core';
import type { ITool, IToolMetaData } from '../Tools/interface';
import type { ExecutionMetadataType } from '../types';

export class Toolset<T extends Record<string, ITool>> {
  private tools: T;
  private toolMetadata: Record<keyof T, Record<string, IToolMetaData> | null> | null = null;
  private toolIndex: Record<
    string,
    IToolMetaData & { metadata: { tool: keyof T; originalToolName: string } }
  > | null = null;

  constructor(tools: T) {
    this.tools = tools;
  }

  public get metadata(): IToolMetaData[] {
    // todo: Make the error message professional worthy of a library
    if (!this.toolIndex) throw new Error(`Toolset not initialised. Use .init() method to do it.`);
    return Object.values(this.toolIndex).map(({ metadata, ...rest }) => rest);
  }

  private buildToolIndexKey(tool: string, toolName: string, metadata: IToolMetaData): string {
    return `${tool}_${toolName}_${metadata.name}`;
  }

  private buildToolIndex() {
    this.toolIndex = {};
    for (const tool in this.toolMetadata) {
      for (const toolName in this.toolMetadata[tool]) {
        const data = this.toolMetadata[tool][toolName];
        if (!data) continue;
        const toolIndexKey = this.buildToolIndexKey(tool, toolName, data);
        this.toolIndex[toolIndexKey] = {
          ...data,
          name: toolIndexKey,
          metadata: {
            tool,
            originalToolName: data.name,
          },
        };
      }
    }
  }

  async init(options?: ExecutionMetadataType) {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: 'Toolset.init',
      disableSpanManagement: true,
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

          this.toolMetadata = Object.fromEntries(
            await Promise.all(
              Object.entries(this.tools).map(async ([key, tool]) => [
                key,
                await tool.metadata({ otelHeaders }),
              ]),
            ),
          ) as Record<keyof T, Record<string, IToolMetaData> | null>;

          this.buildToolIndex();
        } finally {
          span.end();
        }
      },
    });
  }

  //private createToolIndex() {}

  async close(options?: ExecutionMetadataType) {
    return await ArvoOpenTelemetry.getInstance().startActiveSpan({
      name: 'Toolset.close',
      disableSpanManagement: true,
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
        } finally {
          span.end();
        }
      },
    });
  }
}
