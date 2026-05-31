import { vi } from 'vitest';
import { JsonResultData, ToolNameEncoder } from '../../src';
import type { AgentState, ToolRequest } from '../../src/Agent/types';
import { AgentBudgetTracker } from '../../src/AgentBudgetTracker';
import type { AgentCoreStreamOutput, IAgentCore } from '../../src/AgentCore/interface';
import type { Message } from '../../src/message.types';
import type {
  IExternalToolResult,
  IJsonResultData,
  IToolMetaData,
} from '../../src/Tools/interface';
import type { IToolset } from '../../src/Toolset/interface';
import type { JsonAble } from '../../src/types';

// ── Tool name constants ────────────────────────────────────────────────────
export const TOOL_KEY = 'fn>add';
export const ENCODED_TOOL_KEY = new ToolNameEncoder().encode(TOOL_KEY);

// ── Budget ─────────────────────────────────────────────────────────────────

export function createBudgetState() {
  return new AgentBudgetTracker({
    iterations: 10,
    tokens: { input: 10_000, output: 10_000 },
  }).exportState();
}

export function exhaustedBudgetState() {
  return new AgentBudgetTracker({
    iterations: 0,
    tokens: { input: 0, output: 0 },
  }).exportState();
}

// ── Message builders ───────────────────────────────────────────────────────

export function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

export function assistantMessage(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

export function toolResultMessage(toolId: string, data: JsonAble, isError = false): Message {
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        id: toolId,
        isError,
        content: [{ type: 'text', text: JSON.stringify(data) }],
      },
    ],
  };
}

// ── Core response builders ─────────────────────────────────────────────────

export function endTurnResponse(text = 'Done!'): AgentCoreStreamOutput {
  return { stopReason: 'end_turn', message: assistantMessage(text) };
}

export function toolUseResponse(
  encodedName: string,
  toolId: string,
  args: Record<string, unknown> = {},
): AgentCoreStreamOutput {
  return {
    stopReason: 'tool_use',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_call', id: toolId, name: encodedName, args }],
    },
  };
}

export function budgetExhaustedResponse(messages: Message[] = []): AgentCoreStreamOutput {
  return {
    stopReason: 'budget_exhausted',
    error: new Error('Budget exhausted'),
    messages,
  };
}

// ── Toolset result builders ────────────────────────────────────────────────

export function jsonResult(id: string, data: JsonAble): IJsonResultData {
  return new JsonResultData(id, data);
}

export function externalCallResult(id: string, body: JsonAble): IExternalToolResult {
  return { id, type: 'external_call', body: () => body };
}

// ── Mock IAgentCore ────────────────────────────────────────────────────────

export function createMockCore(...responses: AgentCoreStreamOutput[]): IAgentCore {
  let callIndex = 0;
  return {
    stream: vi.fn(async () => {
      const response = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return response;
    }),
  };
}

// ── Mock IToolset ──────────────────────────────────────────────────────────

export const defaultMetadata: Record<string, IToolMetaData> = {
  [TOOL_KEY]: { name: TOOL_KEY, description: 'Adds two numbers', inputSchema: {} },
};

export function createMockToolset(
  options: {
    metadata?: Record<string, IToolMetaData>;
    executeResults?: Awaited<ReturnType<IToolset['execute']>>;
    onExternalResponseResults?: Awaited<ReturnType<IToolset['onExternalResponse']>>;
  } = {},
): IToolset {
  const meta = options.metadata ?? defaultMetadata;
  return {
    has: vi.fn((toolName: string) => toolName in meta),
    init: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    metadata: vi.fn(() => meta),
    execute: vi.fn(async () => options.executeResults ?? []),
    onExternalResponse: vi.fn(async () => options.onExternalResponseResults ?? []),
  };
}

// ── AgentState builders ────────────────────────────────────────────────────

export function freshAgentState(messages: Message[] = []): AgentState {
  return { status: 'init', messages, budget: createBudgetState(), toolRequests: [], system: null };
}

export function toolRequestState(
  toolId: string,
  compoundName: string,
  extraRequests: ToolRequest[] = [],
): AgentState {
  const pending: ToolRequest = {
    id: toolId,
    state: 'pending',
    dispatch: { id: toolId, name: compoundName, args: {} },
    request: {
      id: toolId,
      type: 'external_call',
      body: {
        contractType: compoundName,
        contractUri: '#/test',
        contractVersion: '1.0.0',
        dataschema: '#/test/1.0.0',
        data: {},
      },
    },
    response: null,
  };
  return {
    status: 'tool_request',
    messages: [userMessage('start')],
    budget: createBudgetState(),
    toolRequests: [pending, ...extraRequests],
    system: null,
  };
}

export function noMetadataToolRequestState(toolId: string, compoundName: string): AgentState {
  const pending: ToolRequest = {
    id: toolId,
    state: 'pending',
    dispatch: { id: toolId, name: compoundName, args: {} },
    request: null,
    response: null,
  };
  return {
    status: 'tool_request',
    messages: [userMessage('start')],
    budget: createBudgetState(),
    toolRequests: [pending],
    system: null,
  };
}
