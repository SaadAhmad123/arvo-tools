import type { z } from 'zod';
import type { AgentBudget } from '../AgentBudgetTracker';
import type { AgentCoreStreamEvent, IAgentCore } from '../AgentCore/interface';
import type { Message } from '../message.types';
import type { IToolset } from '../Toolset/interface';
import type { ExecutionMetadataType, NestedPartial, PromiseAble } from '../types';
import type {
  AgentBudgetTrackerStateSchema,
  AgentStateSchema,
  AgentStatusSchema,
  ToolRequestSchema,
} from './schema';

export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type ToolRequest = z.infer<typeof ToolRequestSchema>;
export type AgentBudgetTrackerState = z.infer<typeof AgentBudgetTrackerStateSchema>;
export type AgentState = z.infer<typeof AgentStateSchema>;

export type AgentSystemContext = {
  /**
   * Builds and encodes a compound tool key for use in the system prompt.
   * The resulting string is the exact name the LLM sees in its tool list.
   *
   * @example
   * tool('fn', 'add')             // encoded form of 'fn>add'
   * tool('arvo', 'com.calc.add')  // encoded form of 'arvo>com.calc.add'
   */
  tool: (...parts: [string, ...string[]]) => string;
};

export type AgentParam = {
  /** Display name for this agent instance. */
  name: string;
  core: IAgentCore;
  toolset: IToolset;
  budget: NestedPartial<AgentBudget>;
  outputSchema: z.ZodTypeAny | null;
  system?: string | ((ctx: AgentSystemContext) => string);
};

export type AgentStreamParam = {
  state: AgentState | null;
  messages: Message[];
  options?: Partial<
    ExecutionMetadataType & {
      onEvent: (event: AgentCoreStreamEvent) => PromiseAble<void>;
    }
  >;
};

export type BufferResult = {
  state: AgentState;
  shouldResume: boolean;
};
