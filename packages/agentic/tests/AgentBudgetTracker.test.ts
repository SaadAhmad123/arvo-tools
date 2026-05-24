import { describe, expect, it } from 'vitest';
import { AgentBudgetTracker } from '../src/AgentBudgetTracker';

describe('AgentBudgetTracker', () => {
  describe('shouldContinue()', () => {
    it('returns true when nothing has been recorded — all limits set', () => {
      const tracker = new AgentBudgetTracker({
        iterations: 5,
        tokens: { input: 1000, output: 1000 },
      });
      expect(tracker.shouldContinue()).toBe(true);
    });

    it('returns false when iteration ceiling is reached', () => {
      const tracker = new AgentBudgetTracker({
        iterations: 2,
        tokens: { input: 1000, output: 1000 },
      });
      tracker.record({ iterations: 2, tokens: { input: 10, output: 10 } });
      expect(tracker.shouldContinue()).toBe(false);
    });

    it('returns false when input token ceiling is reached', () => {
      const tracker = new AgentBudgetTracker({
        iterations: 10,
        tokens: { input: 100, output: 1000 },
      });
      tracker.record({ iterations: 1, tokens: { input: 100, output: 10 } });
      expect(tracker.shouldContinue()).toBe(false);
    });

    it('returns false when output token ceiling is reached', () => {
      const tracker = new AgentBudgetTracker({
        iterations: 10,
        tokens: { input: 1000, output: 50 },
      });
      tracker.record({ iterations: 1, tokens: { input: 10, output: 50 } });
      expect(tracker.shouldContinue()).toBe(false);
    });

    it('returns true when accumulated is just below all ceilings', () => {
      const tracker = new AgentBudgetTracker({
        iterations: 5,
        tokens: { input: 100, output: 100 },
      });
      tracker.record({ iterations: 4, tokens: { input: 99, output: 99 } });
      expect(tracker.shouldContinue()).toBe(true);
    });

    it('accumulates across multiple record calls', () => {
      const tracker = new AgentBudgetTracker({
        iterations: 3,
        tokens: { input: 100, output: 100 },
      });
      tracker.record({ iterations: 1, tokens: { input: 30, output: 30 } });
      tracker.record({ iterations: 1, tokens: { input: 30, output: 30 } });
      expect(tracker.shouldContinue()).toBe(true);
      tracker.record({ iterations: 1, tokens: { input: 30, output: 30 } });
      expect(tracker.shouldContinue()).toBe(false);
    });

    // ── Partial limits ───────────────────────────────────────────────────────

    it('iterations-only: ignores token counts entirely', () => {
      const tracker = new AgentBudgetTracker({ iterations: 2 });
      tracker.record({ iterations: 1, tokens: { input: 999_999, output: 999_999 } });
      expect(tracker.shouldContinue()).toBe(true);
      tracker.record({ iterations: 1, tokens: { input: 0, output: 0 } });
      expect(tracker.shouldContinue()).toBe(false);
    });

    it('output-tokens-only: ignores iterations and input tokens', () => {
      const tracker = new AgentBudgetTracker({ tokens: { output: 100 } });
      tracker.record({ iterations: 999, tokens: { input: 999_999, output: 99 } });
      expect(tracker.shouldContinue()).toBe(true);
      tracker.record({ iterations: 1, tokens: { input: 0, output: 1 } });
      expect(tracker.shouldContinue()).toBe(false);
    });

    it('input-tokens-only: ignores iterations and output tokens', () => {
      const tracker = new AgentBudgetTracker({ tokens: { input: 50 } });
      tracker.record({ iterations: 999, tokens: { input: 49, output: 999_999 } });
      expect(tracker.shouldContinue()).toBe(true);
      tracker.record({ iterations: 1, tokens: { input: 1, output: 0 } });
      expect(tracker.shouldContinue()).toBe(false);
    });

    it('iterations + output-only tokens: ignores input tokens', () => {
      const tracker = new AgentBudgetTracker({ iterations: 5, tokens: { output: 200 } });
      tracker.record({ iterations: 4, tokens: { input: 999_999, output: 199 } });
      expect(tracker.shouldContinue()).toBe(true);
      tracker.record({ iterations: 1, tokens: { input: 0, output: 1 } });
      expect(tracker.shouldContinue()).toBe(false);
    });
  });

  describe('exportState() / fromState()', () => {
    it('exports and restores state correctly — all limits set', () => {
      const tracker = new AgentBudgetTracker({
        iterations: 10,
        tokens: { input: 500, output: 500 },
      });
      tracker.record({ iterations: 3, tokens: { input: 120, output: 80 } });

      const state = tracker.exportState();
      const resumed = AgentBudgetTracker.fromState(state);

      expect(resumed.shouldContinue()).toBe(tracker.shouldContinue());
      expect(resumed.exportState()).toEqual(state);
    });

    it('preserves limits from the original run on resume', () => {
      const tracker = new AgentBudgetTracker({
        iterations: 2,
        tokens: { input: 100, output: 100 },
      });
      tracker.record({ iterations: 2, tokens: { input: 10, output: 10 } });

      const resumed = AgentBudgetTracker.fromState(tracker.exportState());
      expect(resumed.shouldContinue()).toBe(false);
    });

    it('exportState returns a deep copy — mutations do not affect the tracker', () => {
      const tracker = new AgentBudgetTracker({
        iterations: 10,
        tokens: { input: 500, output: 500 },
      });
      const state = tracker.exportState();
      state.accumulated.iterations = 999;
      state.limits.iterations = 1;

      expect(tracker.shouldContinue()).toBe(true);
    });

    it('resumed tracker continues accumulating correctly', () => {
      const tracker = new AgentBudgetTracker({
        iterations: 5,
        tokens: { input: 200, output: 200 },
      });
      tracker.record({ iterations: 3, tokens: { input: 80, output: 80 } });

      const resumed = AgentBudgetTracker.fromState(tracker.exportState());
      resumed.record({ iterations: 2, tokens: { input: 80, output: 80 } });
      expect(resumed.shouldContinue()).toBe(false);
    });

    it('round-trips an iterations-only tracker', () => {
      const tracker = new AgentBudgetTracker({ iterations: 3 });
      tracker.record({ iterations: 1, tokens: { input: 10, output: 10 } });

      const resumed = AgentBudgetTracker.fromState(tracker.exportState());
      expect(resumed.shouldContinue()).toBe(true);
      resumed.record({ iterations: 2, tokens: { input: 0, output: 0 } });
      expect(resumed.shouldContinue()).toBe(false);
    });

    it('round-trips an output-tokens-only tracker', () => {
      const tracker = new AgentBudgetTracker({ tokens: { output: 100 } });
      tracker.record({ iterations: 5, tokens: { input: 999, output: 60 } });

      const resumed = AgentBudgetTracker.fromState(tracker.exportState());
      expect(resumed.shouldContinue()).toBe(true);
      resumed.record({ iterations: 1, tokens: { input: 0, output: 40 } });
      expect(resumed.shouldContinue()).toBe(false);
    });

    it('round-trips a tokens-only tracker with both input and output', () => {
      const tracker = new AgentBudgetTracker({ tokens: { input: 200, output: 100 } });
      tracker.record({ iterations: 99, tokens: { input: 150, output: 50 } });

      const state = tracker.exportState();
      expect(state.limits.iterations).toBeUndefined();

      const resumed = AgentBudgetTracker.fromState(state);
      expect(resumed.shouldContinue()).toBe(true);
      resumed.record({ iterations: 1, tokens: { input: 50, output: 50 } });
      expect(resumed.shouldContinue()).toBe(false);
    });
  });
});
