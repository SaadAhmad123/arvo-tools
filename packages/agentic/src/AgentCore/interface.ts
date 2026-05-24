import type { z } from 'zod';
import type { AgentBudgetTracker } from '../AgentBudgetTracker';
import type { Message } from '../message.types';
import type { IToolMetaData } from '../Tools/interface';
import type { ExecutionMetadataType, PromiseAble } from '../types';
import type { StreamEventSchema } from './schema';

/** Input to {@link IAgentCore.stream}. */
export type AgentCoreStreamInput = {
  /** Full conversation history to send to the model. */
  messages: Message[];
  /** Tool capabilities advertised to the model for this call. */
  tools: IToolMetaData[];
  /** When non-null, the model output must conform to this schema. When null the output is accepted as-is. */
  outputSchema: z.ZodTypeAny | null;
  /** Controls how many iterations and tokens the stream may consume. */
  budget: AgentBudgetTracker;
};

/** Stream ended with a model response — either a natural end turn or a tool use request. */
export type MessageStreamOutput = {
  stopReason: 'end_turn' | 'tool_use';
  message: Message;
};

/**
 * The iteration or token budget was exhausted before the stream reached a clean end.
 *
 * `messages` contains the full conversation at the point of exhaustion — including
 * any schema-retry history — so the caller can persist it alongside
 * {@link AgentBudgetTracker.exportState} and resume in a later invocation.
 */
export type BudgetExhaustedStreamOutput = {
  stopReason: 'budget_exhausted';
  error: Error;
  /** Conversation history up to and including the last message produced before exhaustion. */
  messages: Message[];
};

/** Discriminated union of all possible outcomes from {@link IAgentCore.stream}. */
export type AgentCoreStreamOutput = MessageStreamOutput | BudgetExhaustedStreamOutput;

/** Ephemeral notification events yielded during streaming — for display and logging only. */
export type AgentCoreStreamEvent = z.infer<typeof StreamEventSchema>;

/**
 * Represents a single streaming LLM interaction.
 *
 * Implementations of this interface are responsible for communicating with an
 * underlying language model and surfacing its response as an async stream.
 *
 * ### Implementor contract
 *
 * - **Events** — {@link AgentCoreStreamEvent} notifications must be yielded
 *   progressively throughout execution to allow callers to display real-time feedback.
 * - **Tool calls** — when the model requests tool execution, implementations must
 *   surface the requests in the output and return `stopReason: 'tool_use'`. Tool
 *   calls must never be executed by the implementation itself.
 * - **End turn** — `stopReason: 'end_turn'` must only be returned when the model
 *   has produced a complete response with no pending tool calls, and that response
 *   satisfies `outputSchema` when one is provided.
 * - **Budget** — the provided {@link AgentBudgetTracker} must be consulted before
 *   each attempt and updated after each model response. When the budget is exhausted,
 *   the implementation must return `stopReason: 'budget_exhausted'` with a descriptive
 *   `error` and the full `messages` history at that point, rather than throwing. The
 *   caller may persist `messages` alongside `budget.exportState()` to resume later.
 */
export interface IAgentCore {
  /**
   * Initiates a streaming LLM call and returns an async generator.
   *
   * @param input - The conversation history, available tools, optional output schema,
   * and budget governing this call.
   * @returns An async generator that yields {@link AgentCoreStreamEvent} notifications
   * during execution and resolves to an {@link AgentCoreStreamOutput} upon completion.
   */
  stream(
    input: AgentCoreStreamInput,
    options?: ExecutionMetadataType & { onEvent?: (event: AgentCoreStreamEvent) => PromiseAble<void> },
  ): Promise<AgentCoreStreamOutput>;
}
