import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Toolset } from '../../src';
import { AgentBudgetTracker } from '../../src/AgentBudgetTracker';
import { AnthropicAgentCore } from '../../src/AgentCore/anthropic';
import type { AgentCoreStreamEvent } from '../../src/AgentCore/interface';
import type { IToolMetaData } from '../../src/Tools/interface';
import { addTool, greetTool } from '../FunctionTool/tools';
import {
  corruptedToolUseStream,
  emptyStream,
  makeMockClient,
  maxTokensStream,
  textStream,
  thinkingStream,
  toolUseStream,
  toolUseWithTextStream,
} from './fixtures';

// ── Shared toolset ───────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: Needs to be general
let toolset: Toolset<any>;
let tools: IToolMetaData[];

beforeAll(async () => {
  toolset = new Toolset({ greet: greetTool, add: addTool });
  await toolset.init();
  tools = Object.values(toolset.metadata());
});

afterAll(async () => {
  await toolset.close();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeBudget() {
  return new AgentBudgetTracker({ iterations: 10, tokens: { input: 100_000, output: 100_000 } });
}

function collectEvents(events: AgentCoreStreamEvent[]) {
  return async (e: AgentCoreStreamEvent) => {
    events.push(e);
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AnthropicAgentCore', () => {
  describe('stream() — end_turn, no schema', () => {
    it('returns end_turn with a text content block', async () => {
      const core = new AnthropicAgentCore({
        client: makeMockClient([textStream('Hello world')]),
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      const result = await core.stream({
        messages: [],
        tools,
        outputSchema: null,
        budget: makeBudget(),
      });

      expect(result.stopReason).toBe('end_turn');
      if (result.stopReason !== 'end_turn') return;
      expect(result.message.content).toEqual([{ type: 'text', text: 'Hello world' }]);
    });

    it('returns end_turn with empty content when model produces no text', async () => {
      const core = new AnthropicAgentCore({
        client: makeMockClient([emptyStream()]),
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      const result = await core.stream({
        messages: [],
        tools,
        outputSchema: null,
        budget: makeBudget(),
      });

      expect(result.stopReason).toBe('end_turn');
      if (result.stopReason !== 'end_turn') return;
      expect(result.message.content).toEqual([]);
    });

    it('sets message role to assistant', async () => {
      const core = new AnthropicAgentCore({
        client: makeMockClient([textStream('hi')]),
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      const result = await core.stream({
        messages: [],
        tools,
        outputSchema: null,
        budget: makeBudget(),
      });

      if (result.stopReason !== 'end_turn') return;
      expect(result.message.role).toBe('assistant');
    });
  });

  describe('stream() — end_turn, with schema', () => {
    it('returns a json content block when the response matches the schema', async () => {
      const schema = z.object({ name: z.string(), score: z.number() });
      const core = new AnthropicAgentCore({
        client: makeMockClient([textStream('{"name":"Alice","score":42}')]),
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      const result = await core.stream({
        messages: [],
        tools,
        outputSchema: schema,
        budget: makeBudget(),
      });

      expect(result.stopReason).toBe('end_turn');
      if (result.stopReason !== 'end_turn') return;
      expect(result.message.content).toEqual([
        { type: 'json', data: { name: 'Alice', score: 42 } },
      ]);
    });

    it('emits schema_retry and retries when response is not valid JSON', async () => {
      const schema = z.object({ value: z.number() });
      const events: AgentCoreStreamEvent[] = [];
      const core = new AnthropicAgentCore({
        client: makeMockClient([textStream('not json at all'), textStream('{"value":7}')]),
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      const result = await core.stream(
        { messages: [], tools, outputSchema: schema, budget: makeBudget() },
        { onEvent: collectEvents(events) },
      );

      expect(events.some((e) => e.type === 'schema_retry')).toBe(true);
      expect(result.stopReason).toBe('end_turn');
      if (result.stopReason !== 'end_turn') return;
      expect(result.message.content[0]).toMatchObject({ type: 'json', data: { value: 7 } });
    });

    it('schema_retry event carries attempt number and validationError', async () => {
      const schema = z.object({ value: z.number() });
      const events: AgentCoreStreamEvent[] = [];
      const core = new AnthropicAgentCore({
        client: makeMockClient([textStream('bad json'), textStream('{"value":1}')]),
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      await core.stream(
        { messages: [], tools, outputSchema: schema, budget: makeBudget() },
        { onEvent: collectEvents(events) },
      );

      const retry = events.find((e) => e.type === 'schema_retry');
      expect(retry).toBeDefined();
      if (retry?.type !== 'schema_retry') return;
      expect(retry.attempt).toBe(1);
      expect(retry.validationError).toContain('JSON');
    });

    it('emits schema_retry when JSON parses but Zod validation fails', async () => {
      const schema = z.object({ count: z.number() });
      const events: AgentCoreStreamEvent[] = [];
      const core = new AnthropicAgentCore({
        client: makeMockClient([textStream('{"count":"not-a-number"}'), textStream('{"count":5}')]),
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      await core.stream(
        { messages: [], tools, outputSchema: schema, budget: makeBudget() },
        { onEvent: collectEvents(events) },
      );

      const retry = events.find((e) => e.type === 'schema_retry');
      expect(retry).toBeDefined();
      if (retry?.type !== 'schema_retry') return;
      expect(retry.validationError).not.toContain('JSON');
    });
  });

  describe('stream() — tool_use', () => {
    it('returns tool_use with the tool call in message content', async () => {
      const core = new AnthropicAgentCore({
        client: makeMockClient([toolUseStream('call-1', 'greet>greet', { name: 'Alice' })]),
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      const result = await core.stream({
        messages: [],
        tools,
        outputSchema: null,
        budget: makeBudget(),
      });

      expect(result.stopReason).toBe('tool_use');
      if (result.stopReason !== 'tool_use') return;
      expect(result.message.content).toContainEqual({
        type: 'tool_call',
        id: 'call-1',
        name: 'greet>greet',
        args: { name: 'Alice' },
      });
    });

    it('includes preceding text alongside the tool call', async () => {
      const core = new AnthropicAgentCore({
        client: makeMockClient([
          toolUseWithTextStream('Let me greet them.', 'call-2', 'greet>greet', { name: 'Bob' }),
        ]),
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      const result = await core.stream({
        messages: [],
        tools,
        outputSchema: null,
        budget: makeBudget(),
      });

      if (result.stopReason !== 'tool_use') return;
      expect(result.message.content).toContainEqual({ type: 'text', text: 'Let me greet them.' });
      expect(result.message.content).toContainEqual(
        expect.objectContaining({ type: 'tool_call', name: 'greet>greet' }),
      );
    });

    it('does not include a text block when there is no preceding text', async () => {
      const core = new AnthropicAgentCore({
        client: makeMockClient([toolUseStream('call-3', 'add>add', { a: 1, b: 2 })]),
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      const result = await core.stream({
        messages: [],
        tools,
        outputSchema: null,
        budget: makeBudget(),
      });

      if (result.stopReason !== 'tool_use') return;
      expect(result.message.content.some((c) => c.type === 'text')).toBe(false);
    });
  });

  describe('stream() — budget', () => {
    it('returns budget_exhausted with messages when budget is already spent', async () => {
      const budget = new AgentBudgetTracker({ iterations: 1, tokens: { input: 100, output: 100 } });
      budget.record({ iterations: 1, tokens: { input: 10, output: 10 } });

      const createSpy = vi.fn();
      const core = new AnthropicAgentCore({
        // biome-ignore lint/suspicious/noExplicitAny: This is fine
        client: { messages: { create: createSpy } } as any,
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      const result = await core.stream({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools,
        outputSchema: null,
        budget,
      });

      expect(result.stopReason).toBe('budget_exhausted');
      expect(createSpy).not.toHaveBeenCalled();
      if (result.stopReason !== 'budget_exhausted') return;
      expect(result.messages).toHaveLength(1);
    });

    it('returns budget_exhausted with messages when the model hits max_tokens', async () => {
      const core = new AnthropicAgentCore({
        client: makeMockClient([maxTokensStream('partial response')]),
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      const result = await core.stream({
        messages: [],
        tools,
        outputSchema: null,
        budget: makeBudget(),
      });

      expect(result.stopReason).toBe('budget_exhausted');
      if (result.stopReason !== 'budget_exhausted') return;
      expect(result.messages.at(-1)).toMatchObject({
        role: 'assistant',
        content: [{ type: 'text', text: 'partial response' }],
      });
    });

    it('budget_exhausted during schema retry includes the retry conversation in messages', async () => {
      const schema = z.object({ value: z.number() });
      const budget = new AgentBudgetTracker({
        iterations: 1,
        tokens: { input: 100_000, output: 100_000 },
      });
      const core = new AnthropicAgentCore({
        client: makeMockClient([textStream('bad json')]),
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      const result = await core.stream({ messages: [], tools, outputSchema: schema, budget });

      expect(result.stopReason).toBe('budget_exhausted');
      if (result.stopReason !== 'budget_exhausted') return;
      // messages must contain the bad assistant response + the correction user message
      expect(result.messages.length).toBeGreaterThanOrEqual(2);
      expect(result.messages.at(-1)?.role).toBe('user');
    });

    it('records token usage after each call', async () => {
      const budget = makeBudget();
      const core = new AnthropicAgentCore({
        client: makeMockClient([textStream('hi')]),
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      await core.stream({ messages: [], tools, outputSchema: null, budget });

      const state = budget.exportState();
      expect(state.accumulated.iterations).toBe(1);
      expect(state.accumulated.tokens.input).toBeGreaterThan(0);
      expect(state.accumulated.tokens.output).toBeGreaterThan(0);
    });
  });

  describe('stream() — events', () => {
    it('forwards text_delta events as they arrive', async () => {
      const events: AgentCoreStreamEvent[] = [];
      const core = new AnthropicAgentCore({
        client: makeMockClient([textStream('Hello')]),
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      await core.stream(
        { messages: [], tools, outputSchema: null, budget: makeBudget() },
        { onEvent: collectEvents(events) },
      );

      expect(events).toContainEqual({ type: 'text_delta', delta: 'Hello' });
    });

    it('forwards tool_call events when a tool block is complete', async () => {
      const events: AgentCoreStreamEvent[] = [];
      const core = new AnthropicAgentCore({
        client: makeMockClient([toolUseStream('id-1', 'greet>greet', { name: 'Eve' })]),
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      await core.stream(
        { messages: [], tools, outputSchema: null, budget: makeBudget() },
        { onEvent: collectEvents(events) },
      );

      expect(events).toContainEqual({
        type: 'tool_call',
        id: 'id-1',
        name: 'greet>greet',
        args: { name: 'Eve' },
      });
    });

    it('forwards thinking_delta events', async () => {
      const events: AgentCoreStreamEvent[] = [];
      const core = new AnthropicAgentCore({
        client: makeMockClient([thinkingStream('deep thought', 'result')]),
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      await core.stream(
        { messages: [], tools, outputSchema: null, budget: makeBudget() },
        { onEvent: collectEvents(events) },
      );

      expect(events).toContainEqual({ type: 'thinking_delta', delta: 'deep thought' });
    });

    it('emits an error event when tool argument JSON cannot be parsed', async () => {
      const events: AgentCoreStreamEvent[] = [];
      const core = new AnthropicAgentCore({
        client: makeMockClient([corruptedToolUseStream('bad-id', 'greet>greet')]),
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      await core.stream(
        { messages: [], tools, outputSchema: null, budget: makeBudget() },
        { onEvent: collectEvents(events) },
      );

      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      if (errorEvent?.type !== 'error') return;
      expect(errorEvent.message).toContain('greet>greet');
    });
  });

  describe('stream() — message conversion', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64');

    it('processes a system message into the system prompt', async () => {
      const core = new AnthropicAgentCore({
        client: makeMockClient([textStream('ok')]),
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      const result = await core.stream({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'You are a helpful assistant.' }] },
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        ],
        tools,
        outputSchema: null,
        budget: makeBudget(),
      });

      expect(result.stopReason).toBe('end_turn');
    });

    it('processes a user message containing an image media block', async () => {
      const core = new AnthropicAgentCore({
        client: makeMockClient([textStream('ok')]),
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      const result = await core.stream({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'media', contentType: 'image/png', source: 'base64', data: b64('img') },
            ],
          },
        ],
        tools,
        outputSchema: null,
        budget: makeBudget(),
      });

      expect(result.stopReason).toBe('end_turn');
    });

    it('processes a user message containing a PDF media block', async () => {
      const core = new AnthropicAgentCore({
        client: makeMockClient([textStream('ok')]),
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      const result = await core.stream({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'media',
                contentType: 'application/pdf',
                source: 'base64',
                data: b64('pdf'),
              },
            ],
          },
        ],
        tools,
        outputSchema: null,
        budget: makeBudget(),
      });

      expect(result.stopReason).toBe('end_turn');
    });

    it('processes a user message containing a text/* media block', async () => {
      const core = new AnthropicAgentCore({
        client: makeMockClient([textStream('ok')]),
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      const result = await core.stream({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'media',
                contentType: 'text/plain',
                source: 'base64',
                data: b64('hello text'),
              },
            ],
          },
        ],
        tools,
        outputSchema: null,
        budget: makeBudget(),
      });

      expect(result.stopReason).toBe('end_turn');
    });

    it('processes a user message containing an unsupported media type', async () => {
      const core = new AnthropicAgentCore({
        client: makeMockClient([textStream('ok')]),
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      const result = await core.stream({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'media',
                contentType: 'video/mp4',
                source: 'base64',
                data: b64('video'),
              },
            ],
          },
        ],
        tools,
        outputSchema: null,
        budget: makeBudget(),
      });

      expect(result.stopReason).toBe('end_turn');
    });

    it('processes a user message containing a tool_result block', async () => {
      const core = new AnthropicAgentCore({
        client: makeMockClient([textStream('ok')]),
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      const result = await core.stream({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                id: 'call-1',
                isError: false,
                content: [{ type: 'text', text: 'result text' }],
              },
            ],
          },
        ],
        tools,
        outputSchema: null,
        budget: makeBudget(),
      });

      expect(result.stopReason).toBe('end_turn');
    });

    it('processes a tool_result block containing a media sub-block', async () => {
      const core = new AnthropicAgentCore({
        client: makeMockClient([textStream('ok')]),
        invoke: { model: 'test-model', max_tokens: 1024 },
      });

      const result = await core.stream({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                id: 'call-2',
                isError: false,
                content: [
                  {
                    type: 'media',
                    contentType: 'image/jpeg',
                    source: 'base64',
                    data: b64('img'),
                  },
                ],
              },
            ],
          },
        ],
        tools,
        outputSchema: null,
        budget: makeBudget(),
      });

      expect(result.stopReason).toBe('end_turn');
    });
  });
});
