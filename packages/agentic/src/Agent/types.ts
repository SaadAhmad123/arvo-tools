import type { Span } from '@opentelemetry/api';
import type {
  ArvoContract,
  ArvoOrchestratorContract,
  ArvoSemanticVersion,
  CreateArvoEvent,
  InferVersionedArvoContract,
  VersionedArvoContract,
} from 'arvo-core';
import type { IMachineMemory } from 'arvo-event-handler';
import type z from 'zod';
import type { IMCPClient } from '../interfaces.mcp';
import type { OtelInfoType } from '../types';
import type {
  AgentMediaContentSchema,
  AgentMessageContentSchema,
  AgentMessageSchema,
  AgentTextContentSchema,
  AgentToolCallContentSchema,
  AgentToolResultContentSchema,
} from './schema';

export type AgentTextContent = z.infer<typeof AgentTextContentSchema>;
export type AgentMediaContent = z.infer<typeof AgentMediaContentSchema>;
export type AgentToolResultContent = z.infer<typeof AgentToolResultContentSchema>;
export type AgentToolCallContent = z.infer<typeof AgentToolCallContentSchema>;
export type AgentMessageContent = z.infer<typeof AgentMessageContentSchema>;
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

// biome-ignore lint/suspicious/noExplicitAny: Needs to be general
export type AnyArvoOrchestratorContract = ArvoOrchestratorContract<any, any>;

// biome-ignore lint/suspicious/noExplicitAny: Needs to be genral
export type AnyArvoContract = ArvoContract<any, any, any>;

export type NonEmptyArray<T> = [T, ...T[]];

export type PromiseLike<T> = Promise<T> | T;

export type AgentServiceContract = {
  // biome-ignore lint/suspicious/noExplicitAny: Needs to general
  contract: VersionedArvoContract<any, any>;
  domains?: NonEmptyArray<string>;
  priority?: number;
};

export type AgentToolDefinition<
  T extends
    | VersionedArvoContract<AnyArvoContract, ArvoSemanticVersion>
    | AgentInternalTool
    | null = null,
> = {
  name: string;
  description: string;
  // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
  inputSchema: Record<string, any>;
  serverConfig: {
    kind: 'arvo' | 'mcp' | 'internal';
    name: string;
    contract: T;
    priority: number;
  };
};

export type AgentLLMContext<
  TServiceContract extends Record<string, AgentServiceContract> = Record<
    string,
    AgentServiceContract
  >,
  TTools extends Record<string, AgentInternalTool> = Record<string, AgentInternalTool>,
> = {
  system: string | null;
  messages: AgentMessage[];
  tools: {
    services: {
      [K in keyof TServiceContract]: AgentToolDefinition<TServiceContract[K]['contract']>;
    };
    mcp: Record<string, AgentToolDefinition<null>>;
    tools: { [K in keyof TTools]: AgentToolDefinition<TTools[K]> };
  };
  toolInteractions: {
    max: number;
    current: number;
  };
};

export type AgentLLMIntegrationParam = {
  lifecycle: 'init' | 'tool_result' | 'output_error_feedback';
  messages: AgentMessage[];
  system: string | null;
  tools: AgentToolDefinition[];
  toolInteractions: AgentLLMContext['toolInteractions'] & {
    exhausted: boolean;
  };
  outputFormat:
    | {
        type: 'text' | 'media';
      }
    | {
        type: 'json';
        format: z.ZodTypeAny;
      };
};

export type AgentLLMIntegrationOutput = {
  usage: {
    tokens: {
      prompt: number;
      completion: number;
    };
  };
  executionUnits: number;
} & (
  | {
      type: 'tool_call';
      toolRequests: Omit<AgentToolCallContent, 'type'>[];
    }
  | {
      type: 'text';
      content: string;
    }
  | { type: 'json'; content: string; parsedContent: Record<string, unknown> | null }
);

export type AgentInternalTool<
  // biome-ignore lint/suspicious/noExplicitAny: Needs to general
  TInputSchema extends z.ZodTypeAny = any,
  // biome-ignore lint/suspicious/noExplicitAny: Needs to general
  TOutputSchema extends z.ZodTypeAny = any,
> = {
  name: string;
  description: string;
  input: TInputSchema;
  output: TOutputSchema;
  priority?: number;
  fn: (
    input: z.infer<TInputSchema>,
    config: { otelInfo: OtelInfoType },
  ) => PromiseLike<z.infer<TOutputSchema>>;
};

export type AgentLLMIntegration = (
  param: AgentLLMIntegrationParam,
  config: { otelInfo: OtelInfoType },
) => Promise<AgentLLMIntegrationOutput>;

export type AgentContextBuilder<
  T extends AnyArvoOrchestratorContract = AnyArvoOrchestratorContract,
  V extends ArvoSemanticVersion = ArvoSemanticVersion,
  TServiceContract extends Record<string, AgentServiceContract> = Record<
    string,
    AgentServiceContract
  >,
  TTools extends Record<string, AgentInternalTool> = Record<string, AgentInternalTool>,
> = (param: {
  lifecycle: AgentLLMIntegrationParam['lifecycle'];
  input: InferVersionedArvoContract<VersionedArvoContract<T, V>>['accepts'];
  tools: AgentLLMContext<TServiceContract, TTools>['tools'];
  span: Span;
  // biome-ignore lint/suspicious/noConfusingVoidType: This is better for UX
}) => PromiseLike<Partial<Pick<AgentLLMContext<TServiceContract>, 'messages' | 'system'>> | void>;

export type AgentOutputBuilder<
  T extends AnyArvoOrchestratorContract = AnyArvoOrchestratorContract,
  V extends ArvoSemanticVersion = ArvoSemanticVersion,
> = (
  param: Extract<AgentLLMIntegrationOutput, { type: 'text' | 'json' }> & {
    outputFormat: z.ZodTypeAny;
    span: Span;
  },
) => PromiseLike<
  | {
      data: InferVersionedArvoContract<
        VersionedArvoContract<T, V>
      >['emits'][T['metadata']['completeEventType']]['data'] & {
        __id?: CreateArvoEvent<Record<string, unknown>, string>['id'];
        __executionunits?: CreateArvoEvent<Record<string, unknown>, string>['executionunits'];
      };
    }
  | { error: Error }
>;

export type CreateArvoAgentParam<
  TSelfContract extends AnyArvoOrchestratorContract = AnyArvoOrchestratorContract,
  TServiceContract extends Record<string, AgentServiceContract> = Record<
    string,
    AgentServiceContract
  >,
  TTools extends Record<string, AgentInternalTool> = Record<string, AgentInternalTool>,
> = {
  contracts: {
    self: TSelfContract;
    services: TServiceContract;
  };
  memory: IMachineMemory<Record<string, unknown>>;
  maxToolInteractions?: number;
  mcp?: IMCPClient;
  tools?: TTools;
  llmResponseType?: AgentLLMIntegrationParam['outputFormat']['type'];
  llm: AgentLLMIntegration;
  handler: {
    [K in keyof TSelfContract['versions'] & ArvoSemanticVersion]: {
      context: AgentContextBuilder<TSelfContract, K, TServiceContract, TTools>;
      output: AgentOutputBuilder<TSelfContract, K>;
    };
  };
};
