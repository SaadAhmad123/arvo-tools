import type z from 'zod';
import type { AgentMessage, AgentToolResultContent } from '../Agent/types';
import type { OtelInfoType, PromiseAble } from '../types';

/**
 * Defines the structure of a **Synchronous Internal Tool**.
 *
 * Internal tools are JavaScript/TypeScript functions that execute *inside* the Agent's loop.
 *
 * @remarks
 * **Architectural Note:**
 * Unlike Arvo Services (which trigger a "Suspend & Emit" lifecycle), Internal Tools are atomic.
 * The Agent calls them, awaits the result, and continues reasoning in the same execution tick.
 *
 * **Best Practices:**
 * - Use for **Fast, CPU-bound** logic (Math, Data Transformation, Regex).
 * - Use for **Read-only** operations that don't require distributed consensus.
 * - Do **not** use for long-running tasks, as this blocks the Agent execution.
 */
export type AgentInternalTool<
  // biome-ignore lint/suspicious/noExplicitAny: Needs to general
  TInputSchema extends z.ZodTypeAny = any,
> = {
  /**
   * The unique identifier for this tool (e.g. `calculator`, `get_current_time`).
   * This name is injected into the LLM's system prompt.
   */
  name: string;

  /**
   * This string is critical. It tells the LLM *when* and *why* to use this tool.
   * @example
   * "Calculate the MD5 hash of a string. Use this whenever the user asks for a checksum."
   */
  description: string;

  /**
   * Zod Schema defining the arguments the LLM must provide.
   * Arvo automatically validates the LLM's JSON output against this schema before calling `fn`.
   */
  input: TInputSchema;

  /**
   * If the LLM attempts to call multiple tools in parallel (e.g. `delete_user` + `human_approval`),
   * Arvo sorts calls by priority and **only executes the highest priority batch**.
   * Lower priority calls are silently dropped to enforce safety/auth guardrails.
   *
   * @defaultValue 0
   */
  priority?: number;

  /**
   * The implementation logic.
   *
   * @param input - The validated arguments matching `TInputSchema`. You do not need to re-validate.
   * @param config - Observability context (Span/Headers) to link any internal logging or network calls,
   *                 plus the `toolUseId` for correlation.
   * @returns One of three forms:
   *   - `{ messages }` — Provide full control over the tool result message(s) sent back to the LLM.
   *     Can be a single user message or a tuple starting with a user message followed by additional agent messages.
   *     Use this to supply multimedia data from as user message
   *   - `{ data }` — A simple key-value object that Arvo automatically wraps into a tool result content block.
   *   - `void` — Return nothing; Arvo treats this as a successful no-op (useful for side-effect-only tools).
   */
  fn: (
    input: z.infer<TInputSchema>,
    config: { otelInfo: OtelInfoType; toolUseId: string },
  ) => PromiseAble<
    | {
        messages:
          | {
              role: 'user';
              seenCount: number;
              content: AgentToolResultContent;
            }
          | [
              {
                role: 'user';
                seenCount: number;
                content: AgentToolResultContent;
              },
              ...AgentMessage[],
            ];
      }
    // biome-ignore lint/suspicious/noExplicitAny: Needs to be general
    | { data: Record<string, any> }
    // biome-ignore lint/suspicious/noConfusingVoidType: Better DX
    | void
  >;
};
