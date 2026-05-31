import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../../src/Agent';
import { AgentError } from '../../src/Agent/error';
import type { AgentState } from '../../src/Agent/types';
import {
  budgetExhaustedResponse,
  createMockCore,
  createMockToolset,
  ENCODED_TOOL_KEY,
  endTurnResponse,
  externalCallResult,
  freshAgentState,
  jsonResult,
  noMetadataToolRequestState,
  TOOL_KEY,
  toolRequestState,
  toolResultMessage,
  toolUseResponse,
  userMessage,
} from './fixtures';

function makeAgent(
  options: {
    core?: ReturnType<typeof createMockCore>;
    toolset?: ReturnType<typeof createMockToolset>;
    iterations?: number;
  } = {},
) {
  return new Agent({
    name: 'test-agent',
    core: options.core ?? createMockCore(endTurnResponse()),
    toolset: options.toolset ?? createMockToolset(),
    budget: {
      iterations: options.iterations ?? 10,
      tokens: { input: 10_000, output: 10_000 },
    },
    outputSchema: null,
  });
}

describe('Agent', () => {
  describe('init()', () => {
    it('calls toolset.init()', async () => {
      const toolset = createMockToolset();
      await makeAgent({ toolset }).init();
      expect(toolset.init).toHaveBeenCalledOnce();
    });
  });

  describe('close()', () => {
    it('calls toolset.close()', async () => {
      const toolset = createMockToolset();
      await makeAgent({ toolset }).close();
      expect(toolset.close).toHaveBeenCalledOnce();
    });
  });

  describe('stream() — fresh run (state: null)', () => {
    it('returns done on end_turn', async () => {
      const state = await makeAgent({ core: createMockCore(endTurnResponse('Hello!')) }).stream({
        state: null,
        messages: [userMessage('Hi')],
      });
      expect(state.status).toBe('done');
    });

    it('appends assistant message on end_turn', async () => {
      const state = await makeAgent({ core: createMockCore(endTurnResponse('Hello!')) }).stream({
        state: null,
        messages: [userMessage('Hi')],
      });
      const last = state.messages.at(-1);
      expect(last?.role).toBe('assistant');
      const textBlock = last?.content.find((c) => c.type === 'text');
      expect(textBlock && 'text' in textBlock ? textBlock.text : null).toBe('Hello!');
    });

    it('clears toolRequests on end_turn', async () => {
      const state = await makeAgent({ core: createMockCore(endTurnResponse()) }).stream({
        state: null,
        messages: [userMessage('Hi')],
      });
      expect(state.toolRequests).toHaveLength(0);
    });

    it('returns error on budget_exhausted from core', async () => {
      const state = await makeAgent({ core: createMockCore(budgetExhaustedResponse()) }).stream({
        state: null,
        messages: [userMessage('Hi')],
      });
      expect(state.status).toBe('error');
    });

    it('returns error when budget is already exhausted before loop', async () => {
      const state = await makeAgent({ iterations: 0 }).stream({
        state: null,
        messages: [userMessage('Hi')],
      });
      expect(state.status).toBe('error');
    });

    it('pauses with tool_request when core returns tool_use with an external call', async () => {
      const toolset = createMockToolset({
        executeResults: [externalCallResult('call-1', { contractType: TOOL_KEY })],
      });
      const state = await makeAgent({
        core: createMockCore(toolUseResponse(ENCODED_TOOL_KEY, 'call-1')),
        toolset,
      }).stream({ state: null, messages: [userMessage('Hi')] });
      expect(state.status).toBe('tool_request');
      expect(state.toolRequests).toHaveLength(1);
      expect(state.toolRequests[0]?.state).toBe('pending');
      expect(state.toolRequests[0]?.request).toBeDefined();
    });

    it('decodes encoded tool name back to compound key in toolRequests', async () => {
      const toolset = createMockToolset({
        executeResults: [externalCallResult('call-1', { contractType: TOOL_KEY })],
      });
      const state = await makeAgent({
        core: createMockCore(toolUseResponse(ENCODED_TOOL_KEY, 'call-1')),
        toolset,
      }).stream({ state: null, messages: [userMessage('Hi')] });
      expect(state.toolRequests[0]?.dispatch.name).toBe(TOOL_KEY);
    });

    it('passes encoded tool names to agentCore.stream', async () => {
      const core = createMockCore(endTurnResponse());
      await makeAgent({ core }).stream({ state: null, messages: [userMessage('Hi')] });
      const callArg = vi.mocked(core.stream).mock.calls[0]?.[0];
      expect(callArg?.tools[0]?.name).toBe(ENCODED_TOOL_KEY);
    });

    it('continues loop after internal tool result and returns done on next end_turn', async () => {
      const toolset = createMockToolset({ executeResults: [jsonResult('call-1', { sum: 3 })] });
      const state = await makeAgent({
        core: createMockCore(
          toolUseResponse(ENCODED_TOOL_KEY, 'call-1', { a: 1, b: 2 }),
          endTurnResponse('Result: 3'),
        ),
        toolset,
      }).stream({ state: null, messages: [userMessage('Add 1+2')] });
      expect(state.status).toBe('done');
      expect(vi.mocked(toolset.execute)).toHaveBeenCalledOnce();
    });

    it('appends internal tool result message before continuing loop', async () => {
      const toolset = createMockToolset({ executeResults: [jsonResult('call-1', { sum: 3 })] });
      const state = await makeAgent({
        core: createMockCore(toolUseResponse(ENCODED_TOOL_KEY, 'call-1'), endTurnResponse()),
        toolset,
      }).stream({ state: null, messages: [userMessage('start')] });
      const toolResultMsg = state.messages.find((m) =>
        m.content.some((c) => c.type === 'tool_result'),
      );
      expect(toolResultMsg).toBeDefined();
    });
  });

  describe('stream() — resume (state provided)', () => {
    it('throws AgentError for invalid state', async () => {
      await expect(makeAgent().stream({ state: {} as AgentState, messages: [] })).rejects.toThrow(
        AgentError,
      );
    });

    it('runs loop and returns done when all tool requests fulfilled', async () => {
      const state = toolRequestState('call-1', TOOL_KEY);
      const result = await makeAgent({ core: createMockCore(endTurnResponse()) }).stream({
        state,
        messages: [toolResultMessage('call-1', { result: 42 })],
      });
      expect(result.status).toBe('done');
    });

    it('returns state as-is when not all tool requests fulfilled', async () => {
      const state = toolRequestState('call-1', TOOL_KEY);
      const result = await makeAgent().stream({ state, messages: [] });
      expect(result.status).toBe('tool_request');
      expect(result.toolRequests[0]?.state).toBe('pending');
    });
  });

  describe('buffer()', () => {
    it('throws AgentError for invalid state', () => {
      expect(() => makeAgent().buffer({} as AgentState, [])).toThrow(AgentError);
    });

    it('appends messages to state', () => {
      const { state: updated } = makeAgent().buffer(freshAgentState([userMessage('Hello')]), [
        userMessage('World'),
      ]);
      expect(updated.messages).toHaveLength(2);
    });

    it('does not mutate the input state', () => {
      const state = freshAgentState([userMessage('Hello')]);
      makeAgent().buffer(state, [userMessage('World')]);
      expect(state.messages).toHaveLength(1);
    });

    it('returns shouldResume: false when no tool requests exist', () => {
      const { shouldResume } = makeAgent().buffer(freshAgentState(), []);
      expect(shouldResume).toBe(false);
    });

    it('returns shouldResume: false when some tool requests still pending', () => {
      const { shouldResume } = makeAgent().buffer(toolRequestState('call-1', TOOL_KEY), []);
      expect(shouldResume).toBe(false);
    });

    it('returns shouldResume: true when all tool requests are fulfilled', () => {
      const { shouldResume } = makeAgent().buffer(toolRequestState('call-1', TOOL_KEY), [
        toolResultMessage('call-1', { result: 42 }),
      ]);
      expect(shouldResume).toBe(true);
    });

    it('marks matching tool request as fulfilled', () => {
      const { state: updated } = makeAgent().buffer(toolRequestState('call-1', TOOL_KEY), [
        toolResultMessage('call-1', { result: 42 }),
      ]);
      expect(updated.toolRequests[0]?.state).toBe('fulfilled');
    });

    it('is idempotent for already-fulfilled tool requests', () => {
      const agent = makeAgent();
      const { state: firstPass } = agent.buffer(toolRequestState('call-1', TOOL_KEY), [
        toolResultMessage('call-1', { result: 42 }),
      ]);
      const { state: secondPass } = agent.buffer(firstPass, [
        toolResultMessage('call-1', { result: 99 }),
      ]);
      expect(secondPass.toolRequests[0]?.response).toEqual({ result: 42 });
    });
  });

  describe('onExternalResponse()', () => {
    it('throws AgentError for invalid state', async () => {
      await expect(makeAgent().onExternalResponse({} as AgentState, 'call-1', {})).rejects.toThrow(
        AgentError,
      );
    });

    it('throws AgentError when toolRequestId is not found', async () => {
      await expect(
        makeAgent().onExternalResponse(freshAgentState(), 'nonexistent', {}),
      ).rejects.toThrow(AgentError);
    });

    it('throws AgentError when tool request is already fulfilled', async () => {
      const agent = makeAgent();
      const { state: fulfilled } = agent.buffer(toolRequestState('call-1', TOOL_KEY), [
        toolResultMessage('call-1', { result: 42 }),
      ]);
      await expect(agent.onExternalResponse(fulfilled, 'call-1', {})).rejects.toThrow(AgentError);
    });

    it('throws AgentError when tool request has no external call metadata', async () => {
      await expect(
        makeAgent().onExternalResponse(
          noMetadataToolRequestState('call-1', TOOL_KEY),
          'call-1',
          {},
        ),
      ).rejects.toThrow(AgentError);
    });

    it('routes response through toolset and buffers a tool_result message', async () => {
      const toolset = createMockToolset({
        onExternalResponseResults: [jsonResult('call-1', { processed: true })],
      });
      const { state: updated } = await makeAgent({ toolset }).onExternalResponse(
        toolRequestState('call-1', TOOL_KEY),
        'call-1',
        { event: 'success' },
      );
      const hasToolResult = updated.messages.some((m) =>
        m.content.some((c) => c.type === 'tool_result'),
      );
      expect(hasToolResult).toBe(true);
    });

    it('returns shouldResume: true when fulfilled request was the only pending one', async () => {
      const toolset = createMockToolset({
        onExternalResponseResults: [jsonResult('call-1', { processed: true })],
      });
      const { shouldResume } = await makeAgent({ toolset }).onExternalResponse(
        toolRequestState('call-1', TOOL_KEY),
        'call-1',
        {},
      );
      expect(shouldResume).toBe(true);
    });

    it('calls toolset.onExternalResponse with the correct dispatch', async () => {
      const toolset = createMockToolset({
        onExternalResponseResults: [jsonResult('call-1', { processed: true })],
      });
      await makeAgent({ toolset }).onExternalResponse(
        toolRequestState('call-1', TOOL_KEY),
        'call-1',
        { key: 'val' },
      );
      const [dispatchArg] = vi.mocked(toolset.onExternalResponse).mock.calls[0] ?? [];
      expect(dispatchArg?.name).toBe(TOOL_KEY);
      expect(dispatchArg?.id).toBe('call-1');
    });
  });
});
