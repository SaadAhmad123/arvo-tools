import type OpenAIClient from 'openai';
import type { OpenAI } from 'openai';

type StreamEvent = OpenAI.Responses.ResponseStreamEvent;

// ── Low-level event builders ────────────────────────────────────────────────

let seq = 0;
const nextSeq = () => ++seq;

export const ev = {
  textDelta: (delta: string, itemId = 'msg-1'): StreamEvent => ({
    type: 'response.output_text.delta',
    delta,
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    sequence_number: nextSeq(),
    logprobs: [],
  }),

  functionCallDone: (itemId: string, callId: string, name: string, args: object): StreamEvent => ({
    type: 'response.output_item.done',
    item: {
      type: 'function_call',
      id: itemId,
      call_id: callId,
      name,
      arguments: JSON.stringify(args),
      status: 'completed',
    },
    output_index: 0,
    sequence_number: nextSeq(),
  }),

  completed: (inputTokens = 10, outputTokens = 20): StreamEvent => ({
    type: 'response.completed',
    sequence_number: nextSeq(),
    response: {
      id: 'resp-test',
      object: 'response',
      created_at: 0,
      output_text: '',
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      model: 'test-model',
      output: [],
      parallel_tool_calls: false,
      temperature: null,
      tool_choice: 'auto',
      tools: [],
      top_p: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  }),

  incomplete: (): StreamEvent => ({
    type: 'response.incomplete',
    sequence_number: nextSeq(),
    response: {
      id: 'resp-test',
      object: 'response',
      created_at: 0,
      output_text: '',
      error: null,
      incomplete_details: { reason: 'max_output_tokens' },
      instructions: null,
      metadata: null,
      model: 'test-model',
      output: [],
      parallel_tool_calls: false,
      temperature: null,
      tool_choice: 'auto',
      tools: [],
      top_p: null,
    },
  }),

  failed: (message = 'API error'): StreamEvent => ({
    type: 'response.failed',
    sequence_number: nextSeq(),
    response: {
      id: 'resp-test',
      object: 'response',
      created_at: 0,
      output_text: '',
      error: { code: 'server_error', message },
      incomplete_details: null,
      instructions: null,
      metadata: null,
      model: 'test-model',
      output: [],
      parallel_tool_calls: false,
      temperature: null,
      tool_choice: 'auto',
      tools: [],
      top_p: null,
    },
  }),
};

// ── High-level stream sequences ─────────────────────────────────────────────

export function textStream(text: string): StreamEvent[] {
  seq = 0;
  return [ev.textDelta(text), ev.completed()];
}

export function toolUseStream(callId: string, name: string, args: object): StreamEvent[] {
  seq = 0;
  return [ev.functionCallDone('item-1', callId, name, args), ev.completed()];
}

export function toolUseWithTextStream(
  text: string,
  callId: string,
  name: string,
  args: object,
): StreamEvent[] {
  seq = 0;
  return [ev.textDelta(text), ev.functionCallDone('item-1', callId, name, args), ev.completed()];
}

export function corruptedToolUseStream(callId: string, name: string): StreamEvent[] {
  seq = 0;
  const badArgsEvent = {
    type: 'response.output_item.done',
    item: {
      type: 'function_call',
      id: 'item-1',
      call_id: callId,
      name,
      arguments: '{ corrupted json',
      status: 'completed',
    },
    output_index: 0,
    sequence_number: nextSeq(),
  } as unknown as StreamEvent;
  return [badArgsEvent, ev.completed()];
}

export function maxTokensStream(text: string): StreamEvent[] {
  seq = 0;
  return [ev.textDelta(text), ev.incomplete()];
}

export function emptyStream(): StreamEvent[] {
  seq = 0;
  return [ev.completed()];
}

// ── Mock client factory ──────────────────────────────────────────────────────

export function makeMockClient(callSequences: StreamEvent[][]): OpenAIClient {
  let callIndex = 0;
  return {
    responses: {
      create: async () => {
        const events = callSequences[callIndex++] ?? [];
        return (async function* () {
          for (const event of events) {
            yield event;
          }
        })();
      },
    },
  } as unknown as OpenAIClient;
}
