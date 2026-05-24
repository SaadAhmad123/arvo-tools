export type AgentBudgetLimitToken =
  | {
      /** Maximum number of input tokens permitted across all iterations. */
      input?: number;
      /** Maximum number of output tokens permitted across all iterations. */
      output: number;
    }
  | {
      /** Maximum number of input tokens permitted across all iterations. */
      input: number;
      /** Maximum number of output tokens permitted across all iterations. */
      output?: number;
    };

/**
 * The maximum allowed values for the tracked dimensions.
 * Must define `iterations`, `tokens`, or both — an empty object is not valid.
 */
export type AgentBudgetLimits =
  | {
      /** Maximum number of LLM call iterations permitted. */
      iterations: number;
      tokens?: AgentBudgetLimitToken;
    }
  | {
      iterations?: number;
      tokens: AgentBudgetLimitToken;
    };

/** Running totals accumulated across all recorded LLM calls. */
export type AgentBudgetAccumulated = {
  /** Number of iterations recorded so far. */
  iterations: number;
  tokens: {
    /** Input tokens consumed so far. */
    input: number;
    /** Output tokens consumed so far. */
    output: number;
  };
};

/**
 * Serializable snapshot of an {@link AgentBudgetTracker}.
 * Contains both the original limits and the accumulated usage,
 * allowing the tracker to be fully restored via {@link AgentBudgetTracker.fromState}.
 */
export type AgentBudgetTrackerState = {
  limits: AgentBudgetLimits;
  accumulated: AgentBudgetAccumulated;
};

/** Usage to record after a single LLM call. */
export type AgentBudgetRecordParam = {
  /** Number of iterations consumed by this call (typically 1). */
  iterations: number;
  tokens: {
    /** Input tokens consumed by this call. */
    input: number;
    /** Output tokens consumed by this call. */
    output: number;
  };
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
  private readonly limits: AgentBudgetLimits;
  private accumulated: AgentBudgetAccumulated;

  /**
   * Creates a fresh tracker with zeroed accumulated counts.
   * @param limits - The ceiling values for iterations and tokens.
   */
  constructor(limits: AgentBudgetLimits) {
    this.limits = limits;
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
      tokens: {
        input: state.accumulated.tokens.input,
        output: state.accumulated.tokens.output,
      },
    };
    return tracker;
  }

  /**
   * Records usage from a completed LLM call, adding to the running totals.
   * As soon as any dimension meets or exceeds its limit, {@link shouldContinue} returns `false`.
   *
   * @param usage - The iterations and tokens consumed by this call.
   */
  record(usage: AgentBudgetRecordParam): void {
    this.accumulated.iterations += usage.iterations;
    this.accumulated.tokens.input += usage.tokens.input;
    this.accumulated.tokens.output += usage.tokens.output;
  }

  /**
   * Returns `true` if every configured limit is still below its ceiling.
   * Only the dimensions that were supplied at construction time are checked —
   * unset dimensions are ignored.
   */
  shouldContinue(): boolean {
    if (
      this.limits.iterations !== undefined &&
      this.accumulated.iterations >= this.limits.iterations
    ) {
      return false;
    }
    if (this.limits.tokens !== undefined) {
      if (
        this.limits.tokens.input !== undefined &&
        this.accumulated.tokens.input >= this.limits.tokens.input
      ) {
        return false;
      }
      if (
        this.limits.tokens.output !== undefined &&
        this.accumulated.tokens.output >= this.limits.tokens.output
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Exports a deep-copy snapshot of the current state, including both limits and
   * accumulated usage. Pass this to {@link AgentBudgetTracker.fromState} to resume
   * a tracker in a later execution.
   */
  exportState(): AgentBudgetTrackerState {
    const tokensLimit = this.limits.tokens;
    return {
      limits: {
        ...(this.limits.iterations !== undefined && { iterations: this.limits.iterations }),
        ...(tokensLimit !== undefined && {
          tokens: {
            ...(tokensLimit.input !== undefined && { input: tokensLimit.input }),
            ...(tokensLimit.output !== undefined && { output: tokensLimit.output }),
          } as AgentBudgetLimitToken,
        }),
      } as AgentBudgetLimits,
      accumulated: {
        ...this.accumulated,
        tokens: { ...this.accumulated.tokens },
      },
    };
  }
}
