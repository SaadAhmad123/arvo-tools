import type { OtelInfoType } from './types';

export interface IMCPClient {
  connect: (config: { otelInfo: OtelInfoType }) => Promise<void>;
  invokeTool: (
    param: { name: string; arguments?: Record<string, unknown> | null },
    config: { otelInfo: OtelInfoType },
  ) => Promise<string>;
  disconnect: (config: { otelInfo: OtelInfoType }) => Promise<void>;
  getTools: (config: { otelInfo: OtelInfoType }) => Promise<
    {
      name: string;
      description: string;
      // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
      inputSchema: Record<string, any>;
    }[]
  >;
  getToolPriority(config: { otelInfo: OtelInfoType }): Promise<Record<string, number>>;
}
