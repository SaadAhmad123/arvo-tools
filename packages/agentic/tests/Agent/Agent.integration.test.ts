/**
 * Integration tests for the Agent class against the live Anthropic API.
 *
 * These tests are skipped by default. To run them set ANTHROPIC_API_KEY in the environment:
 *
 *   ANTHROPIC_API_KEY=sk-ant-... pnpm test -- tests/Agent/Agent.integration.test.ts
 */

import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Toolset } from '../../src';
import { Agent } from '../../src/Agent';
import { AnthropicAgentCore } from '../../src/AgentCore/anthropic';
import { addArvoTool, addContractV1, addEventFactory } from '../ArvoHandlerTool/fixtures';
import { addTool, greetTool } from '../FunctionTool/tools';

const apiKey = process.env.ANTHROPIC_API_KEY;

describe.skipIf(!apiKey)('Agent — integration', () => {
  function makeCore() {
    return new AnthropicAgentCore({
      client: new Anthropic({ apiKey }),
      invoke: { model: 'claude-haiku-4-5', max_tokens: 2048 },
    });
  }

  // ── Simple text response ───────────────────────────────────────────────────

  describe('text response (no tools)', () => {
    it('returns done with an assistant text message', async () => {
      const toolset = new Toolset({});
      await toolset.init();
      const agent = new Agent({
        name: 'integration-agent',
        core: makeCore(),
        toolset,
        budget: { iterations: 5, tokens: { input: 10_000, output: 1_000 } },
        outputSchema: null,
      });

      const state = await agent.stream({
        state: null,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Reply with exactly: hello' }] },
        ],
      });

      await toolset.close();

      expect(state.status).toBe('done');
      const lastMessage = state.messages.at(-1);
      expect(lastMessage?.role).toBe('assistant');
      expect(lastMessage?.content.some((c) => c.type === 'text')).toBe(true);
    });
  });

  // ── FunctionTool (internal tool) ───────────────────────────────────────────

  describe('FunctionTool (internal tool call)', () => {
    it('executes add tool and returns done after loop continues', async () => {
      const toolset = new Toolset({ fn: addTool });
      await toolset.init();
      const agent = new Agent({
        name: 'integration-agent',
        core: makeCore(),
        toolset,
        budget: { iterations: 10, tokens: { input: 20_000, output: 4_000 } },
        outputSchema: null,
      });

      const state = await agent.stream({
        state: null,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'What is 17 plus 25? Use the add tool.' }],
          },
        ],
      });

      await toolset.close();

      expect(state.status).toBe('done');
      const hasToolResult = state.messages.some((m) =>
        m.content.some((c) => c.type === 'tool_result'),
      );
      expect(hasToolResult).toBe(true);
    });

    it('executes multiple different FunctionTools in a single run', async () => {
      const toolset = new Toolset({ fn: addTool, greet: greetTool });
      await toolset.init();
      const agent = new Agent({
        name: 'integration-agent',
        core: makeCore(),
        toolset,
        budget: { iterations: 10, tokens: { input: 20_000, output: 4_000 } },
        outputSchema: null,
      });

      const state = await agent.stream({
        state: null,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Use the add tool to compute 5+3, then use the greet tool for the name "Alice". Report both results.',
              },
            ],
          },
        ],
      });

      await toolset.close();

      expect(state.status).toBe('done');
    });
  });

  // ── outputSchema ───────────────────────────────────────────────────────────

  describe('outputSchema', () => {
    it('returns done with JSON content conforming to a simple schema', async () => {
      const schema = z.object({
        answer: z.number(),
        explanation: z.string(),
      });

      const toolset = new Toolset({});
      await toolset.init();
      const agent = new Agent({
        name: 'integration-agent',
        core: makeCore(),
        toolset,
        budget: { iterations: 10, tokens: { input: 10_000, output: 2_000 } },
        outputSchema: schema,
      });

      const state = await agent.stream({
        state: null,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is 12 multiplied by 8? Provide a brief explanation.' },
            ],
          },
        ],
      });

      await toolset.close();

      expect(state.status).toBe('done');
      const jsonBlock = state.messages.at(-1)?.content.find((c) => c.type === 'json');
      expect(jsonBlock).toBeDefined();
      if (jsonBlock?.type !== 'json') return;
      expect(schema.safeParse(jsonBlock.data).success).toBe(true);
    });

    it('returns done with JSON conforming to a nested schema', async () => {
      const schema = z.object({
        city: z.string(),
        country: z.string(),
        population: z.number().int().positive(),
        knownFor: z.array(z.string()).min(1).max(5),
      });

      const toolset = new Toolset({});
      await toolset.init();
      const agent = new Agent({
        name: 'integration-agent',
        core: makeCore(),
        toolset,
        budget: { iterations: 10, tokens: { input: 10_000, output: 2_000 } },
        outputSchema: schema,
      });

      const state = await agent.stream({
        state: null,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Give me information about Paris, France.' }],
          },
        ],
      });

      await toolset.close();

      expect(state.status).toBe('done');
      const jsonBlock = state.messages.at(-1)?.content.find((c) => c.type === 'json');
      expect(jsonBlock).toBeDefined();
      if (jsonBlock?.type !== 'json') return;
      const parsed = schema.safeParse(jsonBlock.data);
      expect(parsed.success).toBe(true);
    });
  });

  // ── ArvoHandlerTool (external tool call + onExternalResponse + resume) ─────

  describe('ArvoHandlerTool (external tool call)', () => {
    it('pauses at tool_request, resumes via onExternalResponse + stream, returns done', async () => {
      const toolset = new Toolset({ arvo: addArvoTool });
      await toolset.init();
      const agent = new Agent({
        name: 'integration-agent',
        core: makeCore(),
        toolset,
        budget: { iterations: 10, tokens: { input: 20_000, output: 4_000 } },
        outputSchema: null,
      });

      // Phase 1: start — model should call the ArvoHandlerTool
      const pausedState = await agent.stream({
        state: null,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Use the ${addContractV1.accepts.type} tool to add the numbers [1, 2, 3]. Wait for the result before responding.`,
              },
            ],
          },
        ],
        options: {
          onEvent: (e) => console.log(JSON.stringify(e, null, 2)),
        },
      });

      expect(pausedState.status).toBe('tool_request');
      expect(pausedState.toolRequests.length).toBeGreaterThan(0);

      const pendingRequest = pausedState.toolRequests.find((r) => r.state === 'pending');
      expect(pendingRequest).toBeDefined();
      if (!pendingRequest) return;

      // Phase 2: simulate the external Arvo handler responding with the result
      const arvoResponse = addEventFactory
        .emits({
          type: 'evt.calculator.add.success',
          source: addContractV1.accepts.type,
          data: { result: 6 },
        })
        .toJSON();

      const { state: bufferedState, shouldResume } = await agent.onExternalResponse(
        pausedState,
        pendingRequest.id,
        arvoResponse as Record<string, unknown>,
      );

      expect(shouldResume).toBe(true);

      // Phase 3: resume the loop
      const finalState = await agent.stream({
        state: bufferedState,
        messages: [],
        options: {
          onEvent: (e) => console.log(JSON.stringify(e, null, 2)),
        },
      });

      await toolset.close();

      expect(finalState.status).toBe('done');
      // The agent's final assistant message should mention the result
      const lastMessage = finalState.messages.at(-1);
      expect(lastMessage?.role).toBe('assistant');
    });

    it('partial buffer flow: fill one request at a time, then stream to resume', async () => {
      const toolset = new Toolset({ arvo: addArvoTool });
      await toolset.init();
      const agent = new Agent({
        name: 'integration-agent',
        core: makeCore(),
        toolset,
        budget: { iterations: 10, tokens: { input: 20_000, output: 4_000 } },
        outputSchema: null,
      });

      const pausedState = await agent.stream({
        state: null,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Use the ${addContractV1.accepts.type} tool to add [10, 20]. Then tell me the result.`,
              },
            ],
          },
        ],
      });

      if (pausedState.status !== 'tool_request') {
        await toolset.close();
        return;
      }

      const pendingRequest = pausedState.toolRequests[0];
      if (!pendingRequest) {
        await toolset.close();
        return;
      }

      const arvoResponse = addEventFactory
        .emits({
          type: 'evt.calculator.add.success',
          source: addContractV1.accepts.type,
          data: { result: 30 },
        })
        .toJSON();

      // Use buffer first, then stream
      const { state: afterBuffer, shouldResume } = await agent.onExternalResponse(
        pausedState,
        pendingRequest.id,
        arvoResponse as Record<string, unknown>,
      );

      expect(afterBuffer.toolRequests.every((r) => r.state === 'fulfilled')).toBe(true);
      expect(shouldResume).toBe(true);

      const finalState = await agent.stream({ state: afterBuffer, messages: [] });

      await toolset.close();

      expect(finalState.status).toBe('done');
    });
  });

  // ── Mixed toolset: FunctionTool + ArvoHandlerTool ──────────────────────────

  describe('mixed toolset (FunctionTool + ArvoHandlerTool)', () => {
    it('handles a run where the model may call either tool type', async () => {
      const toolset = new Toolset({ fn: addTool, arvo: addArvoTool });
      await toolset.init();
      const agent = new Agent({
        name: 'integration-agent',
        core: makeCore(),
        toolset,
        budget: { iterations: 10, tokens: { input: 20_000, output: 4_000 } },
        outputSchema: null,
      });

      const state = await agent.stream({
        state: null,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Use the add tool (fn>add) to compute 4 + 6 and report the result.',
              },
            ],
          },
        ],
      });

      if (state.status === 'tool_request') {
        // ArvoHandlerTool was called — fulfill and resume
        const pending = state.toolRequests.find((r) => r.state === 'pending');
        if (pending) {
          const arvoResponse = addEventFactory
            .emits({
              type: 'evt.calculator.add.success',
              source: addContractV1.accepts.type,
              data: { result: 10 },
            })
            .toJSON();
          const { state: buffered } = await agent.onExternalResponse(
            state,
            pending.id,
            arvoResponse as Record<string, unknown>,
          );
          const finalState = await agent.stream({ state: buffered, messages: [] });
          await toolset.close();
          expect(finalState.status).toBe('done');
          return;
        }
      }

      await toolset.close();
      expect(state.status).toBe('done');
    });
  });

  // ── Budget exhaustion ──────────────────────────────────────────────────────

  describe('budget exhaustion', () => {
    it('returns error when the iteration budget is already at zero', async () => {
      const toolset = new Toolset({});
      await toolset.init();
      const agent = new Agent({
        name: 'integration-agent',
        core: makeCore(),
        toolset,
        budget: { iterations: 0, tokens: { input: 10_000, output: 1_000 } },
        outputSchema: null,
      });

      const state = await agent.stream({
        state: null,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hello.' }] }],
      });

      await toolset.close();

      expect(state.status).toBe('error');
    });

    it('returns error when core exhausts the token budget', async () => {
      const tinyCore = new AnthropicAgentCore({
        client: new Anthropic({ apiKey }),
        invoke: { model: 'claude-haiku-4-5', max_tokens: 5 },
      });
      const toolset = new Toolset({});
      await toolset.init();
      const agent = new Agent({
        name: 'tiny',
        core: tinyCore,
        toolset,
        budget: { iterations: 5, tokens: { input: 10_000, output: 10_000 } },
        outputSchema: null,
      });

      const state = await agent.stream({
        state: null,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Write a 500-word essay about the history of computing.' },
            ],
          },
        ],
      });

      await toolset.close();

      expect(state.status).toBe('error');
    });
  });
});
