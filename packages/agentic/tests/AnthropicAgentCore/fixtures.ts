import type AnthropicClient from '@anthropic-ai/sdk';

type AnyEvent = Record<string, unknown>;

// ── Low-level event builders ────────────────────────────────────────────────

export const ev = {
  messageStart: (inputTokens = 10, outputTokens = 0): AnyEvent => ({
    type: 'message_start',
    message: { usage: { input_tokens: inputTokens, output_tokens: outputTokens } },
  }),

  textBlockStart: (index: number): AnyEvent => ({
    type: 'content_block_start',
    index,
    content_block: { type: 'text' },
  }),

  textDelta: (index: number, text: string): AnyEvent => ({
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  }),

  thinkingBlockStart: (index: number): AnyEvent => ({
    type: 'content_block_start',
    index,
    content_block: { type: 'thinking' },
  }),

  thinkingDelta: (index: number, thinking: string): AnyEvent => ({
    type: 'content_block_delta',
    index,
    delta: { type: 'thinking_delta', thinking },
  }),

  toolUseBlockStart: (index: number, id: string, name: string): AnyEvent => ({
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id, name },
  }),

  inputJsonDelta: (index: number, partialJson: string): AnyEvent => ({
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: partialJson },
  }),

  blockStop: (index: number): AnyEvent => ({ type: 'content_block_stop', index }),

  messageDelta: (stopReason: string, outputTokens = 20): AnyEvent => ({
    type: 'message_delta',
    delta: { stop_reason: stopReason },
    usage: { output_tokens: outputTokens },
  }),

  messageStop: (): AnyEvent => ({ type: 'message_stop' }),
};

// ── High-level stream sequences ─────────────────────────────────────────────

/** Single text block ending with end_turn. */
export function textStream(text: string): AnyEvent[] {
  return [
    ev.messageStart(),
    ev.textBlockStart(0),
    ev.textDelta(0, text),
    ev.blockStop(0),
    ev.messageDelta('end_turn'),
    ev.messageStop(),
  ];
}

/** Single tool call with no preceding text. */
export function toolUseStream(toolId: string, toolName: string, toolInput: object): AnyEvent[] {
  const json = JSON.stringify(toolInput);
  return [
    ev.messageStart(),
    ev.toolUseBlockStart(0, toolId, toolName),
    ev.inputJsonDelta(0, json),
    ev.blockStop(0),
    ev.messageDelta('tool_use'),
    ev.messageStop(),
  ];
}

/** Text block followed by a tool call. */
export function toolUseWithTextStream(
  text: string,
  toolId: string,
  toolName: string,
  toolInput: object,
): AnyEvent[] {
  return [
    ev.messageStart(),
    ev.textBlockStart(0),
    ev.textDelta(0, text),
    ev.blockStop(0),
    ev.toolUseBlockStart(1, toolId, toolName),
    ev.inputJsonDelta(1, JSON.stringify(toolInput)),
    ev.blockStop(1),
    ev.messageDelta('tool_use'),
    ev.messageStop(),
  ];
}

/** Thinking block followed by a text block. */
export function thinkingStream(thinking: string, text: string): AnyEvent[] {
  return [
    ev.messageStart(),
    ev.thinkingBlockStart(0),
    ev.thinkingDelta(0, thinking),
    ev.blockStop(0),
    ev.textBlockStart(1),
    ev.textDelta(1, text),
    ev.blockStop(1),
    ev.messageDelta('end_turn'),
    ev.messageStop(),
  ];
}

/** Tool use block whose accumulated input is not valid JSON. */
export function corruptedToolUseStream(toolId: string, toolName: string): AnyEvent[] {
  return [
    ev.messageStart(),
    ev.toolUseBlockStart(0, toolId, toolName),
    ev.inputJsonDelta(0, '{ corrupted json'),
    ev.blockStop(0),
    ev.messageDelta('tool_use'),
    ev.messageStop(),
  ];
}

/** Response truncated by token limit. */
export function maxTokensStream(text: string): AnyEvent[] {
  return [
    ev.messageStart(),
    ev.textBlockStart(0),
    ev.textDelta(0, text),
    ev.blockStop(0),
    ev.messageDelta('max_tokens'),
    ev.messageStop(),
  ];
}

/** No content blocks — empty assistant turn. */
export function emptyStream(): AnyEvent[] {
  return [ev.messageStart(), ev.messageDelta('end_turn'), ev.messageStop()];
}

// ── Mock client factory ──────────────────────────────────────────────────────

/**
 * Creates a mock Anthropic client that replays a pre-defined sequence of event
 * arrays — one array per `messages.create` call.
 */
export function makeMockClient(callSequences: AnyEvent[][]): AnthropicClient {
  let callIndex = 0;
  return {
    messages: {
      create: async () => {
        const events = callSequences[callIndex++] ?? [];
        return (async function* () {
          for (const event of events) {
            yield event;
          }
        })();
      },
    },
  } as unknown as AnthropicClient;
}
