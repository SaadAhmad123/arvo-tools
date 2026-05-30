import type { NestedPartial } from './types';

export type AgentBudgetToken = {
  /** Maximum number of input tokens permitted across all iterations. */
  input: number;
  /** Maximum number of output tokens permitted across all iterations. */
  output: number;
};

export type AgentBudget = {
  /** Number of LLM call iterations. */
  iterations: number;
  tokens: AgentBudgetToken;
};

/**
 * Serializable snapshot of an {@link AgentBudgetTracker}.
 * Contains both the original limits and the accumulated usage,
 * allowing the tracker to be fully restored via {@link AgentBudgetTracker.fromState}.
 */
export type AgentBudgetTrackerState = {
  limits: AgentBudget;
  accumulated: AgentBudget;
};

/**
 * Tracks iteration and token usage against configured limits to determine
 * whether a schema-correction retry loop should execute another attempt.
 *
 * The tracker is the single source of truth for budget decisions — callers
 * record usage after each LLM call and ask `shouldContinue()` before the next.
 *
 * State can be exported and restored so that limits are honoured across
 * resumptions (e.g. after a process restart or a serialised job).
 *
 * @example
 * ```ts
 * const budget = new AgentBudgetTracker({ iterations: 3, tokens: { input: 4000, output: 2000 } });
 *
 * while (budget.shouldContinue()) {
 *   const result = await callLLM();
 *   budget.record({ iterations: 1, tokens: { input: result.inputTokens, output: result.outputTokens } });
 *   if (outputMatchesSchema(result)) break;
 * }
 * ```
 */
export class AgentBudgetTracker {
  private readonly limits: AgentBudget;
  private accumulated: AgentBudget;

  /**
   * Creates a fresh tracker with zeroed accumulated counts.
   *
   * Any field omitted from `param` falls back to the corresponding value in `_default`.
   *
   * @param param - Partial budget overrides. Omitted fields are filled from `_default`.
   * @param _default - Baseline limits used when `param` does not specify a field.
   *   Defaults to 10 iterations and 10000 input/output tokens.
   */
  constructor(
    param: NestedPartial<AgentBudget> = {},
    _default: AgentBudget = {
      iterations: 10,
      tokens: {
        input: 10000,
        output: 10000,
      },
    },
  ) {
    this.limits = {
      iterations: param.iterations ?? _default.iterations,
      tokens: {
        input: param.tokens?.input ?? _default.tokens.input,
        output: param.tokens?.output ?? _default.tokens.output,
      },
    };
    this.accumulated = { iterations: 0, tokens: { input: 0, output: 0 } };
  }

  /**
   * Restores a tracker from a previously exported state.
   * The limits are taken from the state itself — they cannot be overridden on resume.
   *
   * @param state - A state object produced by {@link AgentBudgetTracker.exportState}.
   */
  static fromState(state: AgentBudgetTrackerState): AgentBudgetTracker {
    const tracker = new AgentBudgetTracker(state.limits);
    tracker.accumulated = {
      iterations: state.accumulated.iterations,
      tokens: { ...state.accumulated.tokens },
    };
    return tracker;
  }

  /**
   * Records usage from a completed LLM call, adding to the running totals.
   * As soon as any dimension meets or exceeds its limit, {@link shouldContinue} returns `false`.
   *
   * @param usage - The iterations and tokens consumed by this call.
   */
  record(usage: AgentBudget): void {
    this.accumulated.iterations += usage.iterations;
    this.accumulated.tokens.input += usage.tokens.input;
    this.accumulated.tokens.output += usage.tokens.output;
  }

  /**
   * Returns `true` if every configured limit is still below its ceiling.
   */
  shouldContinue(): boolean {
    return (
      this.accumulated.iterations < this.limits.iterations &&
      this.accumulated.tokens.input < this.limits.tokens.input &&
      this.accumulated.tokens.output < this.limits.tokens.output
    );
  }

  /**
   * Exports a deep-copy snapshot of the current state, including both limits and
   * accumulated usage. Pass this to {@link AgentBudgetTracker.fromState} to resume
   * a tracker in a later execution.
   */
  exportState(): AgentBudgetTrackerState {
    return {
      limits: { iterations: this.limits.iterations, tokens: { ...this.limits.tokens } },
      accumulated: {
        iterations: this.accumulated.iterations,
        tokens: { ...this.accumulated.tokens },
      },
    };
  }
}
