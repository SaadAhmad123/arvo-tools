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

    // ── Default value merging ─────────────────────────────────────────────────

    it('no-arg constructor applies all defaults (10 iterations, 10 000 tokens each)', () => {
      const tracker = new AgentBudgetTracker();
      expect(tracker.shouldContinue()).toBe(true);
      tracker.record({ iterations: 10, tokens: { input: 1, output: 1 } });
      expect(tracker.shouldContinue()).toBe(false);
    });

    it('omitting iterations falls back to the default (10)', () => {
      const tracker = new AgentBudgetTracker({ tokens: { input: 1000, output: 1000 } });
      tracker.record({ iterations: 9, tokens: { input: 1, output: 1 } });
      expect(tracker.shouldContinue()).toBe(true);
      tracker.record({ iterations: 1, tokens: { input: 1, output: 1 } });
      expect(tracker.shouldContinue()).toBe(false);
    });

    it('omitting tokens falls back to defaults (10 000 input and output)', () => {
      const tracker = new AgentBudgetTracker({ iterations: 5 });
      tracker.record({ iterations: 1, tokens: { input: 9999, output: 9999 } });
      expect(tracker.shouldContinue()).toBe(true);
      tracker.record({ iterations: 1, tokens: { input: 1, output: 1 } });
      expect(tracker.shouldContinue()).toBe(false);
    });

    it('omitting tokens.input falls back to the default (10 000)', () => {
      const tracker = new AgentBudgetTracker({ iterations: 5, tokens: { output: 200 } });
      tracker.record({ iterations: 1, tokens: { input: 9999, output: 100 } });
      expect(tracker.shouldContinue()).toBe(true);
      tracker.record({ iterations: 1, tokens: { input: 1, output: 100 } });
      expect(tracker.shouldContinue()).toBe(false);
    });

    it('omitting tokens.output falls back to the default (10 000)', () => {
      const tracker = new AgentBudgetTracker({ iterations: 5, tokens: { input: 200 } });
      tracker.record({ iterations: 1, tokens: { input: 100, output: 9999 } });
      expect(tracker.shouldContinue()).toBe(true);
      tracker.record({ iterations: 1, tokens: { input: 100, output: 1 } });
      expect(tracker.shouldContinue()).toBe(false);
    });

    it('custom _default overrides the built-in defaults', () => {
      const tracker = new AgentBudgetTracker(
        {},
        { iterations: 3, tokens: { input: 50, output: 50 } },
      );
      tracker.record({ iterations: 2, tokens: { input: 49, output: 49 } });
      expect(tracker.shouldContinue()).toBe(true);
      tracker.record({ iterations: 1, tokens: { input: 1, output: 1 } });
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

    it('round-trips a tracker with partial overrides — default-filled limits are preserved', () => {
      const tracker = new AgentBudgetTracker({ iterations: 3 });
      tracker.record({ iterations: 1, tokens: { input: 10, output: 10 } });

      const state = tracker.exportState();
      expect(state.limits.iterations).toBe(3);
      expect(state.limits.tokens.input).toBe(10000);
      expect(state.limits.tokens.output).toBe(10000);

      const resumed = AgentBudgetTracker.fromState(state);
      expect(resumed.shouldContinue()).toBe(true);
      resumed.record({ iterations: 2, tokens: { input: 0, output: 0 } });
      expect(resumed.shouldContinue()).toBe(false);
    });

    it('round-trips a tracker with output token override', () => {
      const tracker = new AgentBudgetTracker({ tokens: { output: 100 } });
      tracker.record({ iterations: 1, tokens: { input: 1, output: 60 } });

      const resumed = AgentBudgetTracker.fromState(tracker.exportState());
      expect(resumed.shouldContinue()).toBe(true);
      resumed.record({ iterations: 1, tokens: { input: 0, output: 40 } });
      expect(resumed.shouldContinue()).toBe(false);
    });

    it('round-trips a tracker with explicit input and output token overrides', () => {
      const tracker = new AgentBudgetTracker({ tokens: { input: 200, output: 100 } });
      tracker.record({ iterations: 1, tokens: { input: 150, output: 50 } });

      const state = tracker.exportState();
      expect(state.limits.iterations).toBe(10);
      expect(state.limits.tokens.input).toBe(200);
      expect(state.limits.tokens.output).toBe(100);

      const resumed = AgentBudgetTracker.fromState(state);
      expect(resumed.shouldContinue()).toBe(true);
      resumed.record({ iterations: 1, tokens: { input: 50, output: 50 } });
      expect(resumed.shouldContinue()).toBe(false);
    });
  });
});
