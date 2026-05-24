import { SemanticConventions } from '@arizeai/openinference-semantic-conventions';
import type { Span } from '@opentelemetry/api';
import type { Message, TextMessageContent, ToolCallMessageContent } from '../message.types';
import type { IToolMetaData } from '../Tools/interface';

/** Truncates base64/long strings so they don't bloat trace storage. */
export const clampStr = (s: string, len: number) => (s.length > len ? `${s.slice(0, len)}...` : s);

/**
 * Sets OpenInference LLM input attributes on a span from the internal message format.
 *
 * Records:
 * - Tool definitions (`llm.tools.{i}.tool.json_schema`)
 * - System prompt as message 0 when present
 * - All non-system messages with role, text, media, tool_call, and tool_result blocks
 */
export function setInputAttributes(span: Span, messages: Message[], tools: IToolMetaData[]): void {
  for (const [i, tool] of tools.entries()) {
    span.setAttribute(
      `${SemanticConventions.LLM_TOOLS}.${i}.${SemanticConventions.TOOL_JSON_SCHEMA}`,
      JSON.stringify({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }),
    );
  }

  const systemText =
    messages
      .filter((m) => m.role === 'system')
      .flatMap((m) => m.content)
      .filter((c): c is TextMessageContent => c.type === 'text')
      .map((c) => c.text)
      .join('\n\n') || null;

  let msgIdx = 0;
  if (systemText) {
    span.setAttributes({
      [`${SemanticConventions.LLM_INPUT_MESSAGES}.0.${SemanticConventions.MESSAGE_ROLE}`]: 'system',
      [`${SemanticConventions.LLM_INPUT_MESSAGES}.0.${SemanticConventions.MESSAGE_CONTENTS}.0.${SemanticConventions.MESSAGE_CONTENT_TYPE}`]:
        'text',
      [`${SemanticConventions.LLM_INPUT_MESSAGES}.0.${SemanticConventions.MESSAGE_CONTENTS}.0.${SemanticConventions.MESSAGE_CONTENT_TEXT}`]:
        systemText,
    });
    msgIdx = 1;
  }

  for (const msg of messages.filter((m) => m.role !== 'system')) {
    const mBase = `${SemanticConventions.LLM_INPUT_MESSAGES}.${msgIdx}`;
    span.setAttribute(`${mBase}.${SemanticConventions.MESSAGE_ROLE}`, msg.role);

    let contentIdx = 0;
    let toolCallIdx = 0;
    for (const block of msg.content) {
      const cBase = `${mBase}.${SemanticConventions.MESSAGE_CONTENTS}.${contentIdx}`;
      const tcBase = `${mBase}.${SemanticConventions.MESSAGE_TOOL_CALLS}.${toolCallIdx}`;

      if (block.type === 'text') {
        span.setAttributes({
          [`${cBase}.${SemanticConventions.MESSAGE_CONTENT_TYPE}`]: 'text',
          [`${cBase}.${SemanticConventions.MESSAGE_CONTENT_TEXT}`]: block.text,
        });
        contentIdx++;
      } else if (block.type === 'json') {
        span.setAttributes({
          [`${cBase}.${SemanticConventions.MESSAGE_CONTENT_TYPE}`]: 'text',
          [`${cBase}.${SemanticConventions.MESSAGE_CONTENT_TEXT}`]: JSON.stringify(block.data),
        });
        contentIdx++;
      } else if (block.type === 'media') {
        const label = block.contentType.startsWith('image/')
          ? 'IMAGE'
          : block.contentType === 'application/pdf'
            ? 'PDF'
            : 'FILE';
        span.setAttributes({
          [`${cBase}.${SemanticConventions.MESSAGE_CONTENT_TYPE}`]: 'text',
          [`${cBase}.${SemanticConventions.MESSAGE_CONTENT_TEXT}`]: `${label}: ${clampStr(block.data, 100)}`,
        });
        contentIdx++;
      } else if (block.type === 'tool_call') {
        span.setAttributes({
          [`${tcBase}.${SemanticConventions.TOOL_CALL_FUNCTION_NAME}`]: block.name,
          [`${tcBase}.${SemanticConventions.TOOL_CALL_FUNCTION_ARGUMENTS_JSON}`]: JSON.stringify(
            block.args,
          ),
        });
        toolCallIdx++;
      } else if (block.type === 'tool_result') {
        span.setAttributes({
          [`${cBase}.${SemanticConventions.MESSAGE_CONTENT_TYPE}`]: 'text',
          [`${cBase}.${SemanticConventions.MESSAGE_CONTENT_TEXT}`]: JSON.stringify({
            tool_use_id: block.id,
            is_error: block.isError,
            content: block.content
              .map((c) =>
                c.type === 'text'
                  ? c.text
                  : `[${c.contentType.toUpperCase()}: ${clampStr(c.data, 50)}]`,
              )
              .join('\n'),
          }),
        });
        contentIdx++;
      }
    }
    msgIdx++;
  }
}

/**
 * Sets OpenInference output attributes for a tool-call response.
 * Records each tool call's function name and JSON arguments.
 */
export function setToolCallOutputAttributes(span: Span, toolCalls: ToolCallMessageContent[]): void {
  span.setAttribute(
    `${SemanticConventions.LLM_OUTPUT_MESSAGES}.0.${SemanticConventions.MESSAGE_ROLE}`,
    'assistant',
  );
  for (const [i, call] of toolCalls.entries()) {
    span.setAttributes({
      [`${SemanticConventions.LLM_OUTPUT_MESSAGES}.0.${SemanticConventions.MESSAGE_TOOL_CALLS}.${i}.${SemanticConventions.TOOL_CALL_FUNCTION_NAME}`]:
        call.name,
      [`${SemanticConventions.LLM_OUTPUT_MESSAGES}.0.${SemanticConventions.MESSAGE_TOOL_CALLS}.${i}.${SemanticConventions.TOOL_CALL_FUNCTION_ARGUMENTS_JSON}`]:
        JSON.stringify(call.args),
    });
  }
}

/**
 * Sets OpenInference output attributes for a text or JSON response.
 */
export function setTextOutputAttributes(span: Span, text: string): void {
  span.setAttributes({
    [`${SemanticConventions.LLM_OUTPUT_MESSAGES}.0.${SemanticConventions.MESSAGE_ROLE}`]:
      'assistant',
    [`${SemanticConventions.LLM_OUTPUT_MESSAGES}.0.${SemanticConventions.MESSAGE_CONTENT}`]: text,
  });
}

/**
 * Sets OpenInference token usage attributes (prompt, completion, total).
 */
export function setUsageAttributes(span: Span, inputTokens: number, outputTokens: number): void {
  span.setAttributes({
    [SemanticConventions.LLM_TOKEN_COUNT_PROMPT]: inputTokens,
    [SemanticConventions.LLM_TOKEN_COUNT_COMPLETION]: outputTokens,
    [SemanticConventions.LLM_TOKEN_COUNT_TOTAL]: inputTokens + outputTokens,
  });
}
