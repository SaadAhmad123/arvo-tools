/**
 * Integration tests against the live OpenAI API.
 *
 * These tests are skipped by default. To run them set OPENAI_API_KEY in the environment:
 *
 *   OPENAI_API_KEY=sk-... pnpm test -- tests/OpenAIAgentCore/OpenAIAgentCore.integration.test.ts
 */

import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FunctionTool, MediaResultData, ToolNameEncoder, Toolset } from '../../src';
import { AgentBudgetTracker } from '../../src/AgentBudgetTracker';
import type { AgentCoreStreamEvent } from '../../src/AgentCore/interface';
import { OpenAIAgentCore } from '../../src/AgentCore/openai';
import { addTool } from '../FunctionTool/tools';

// Minimal 1x1 red PNG — valid base64, no data URL prefix
const RED_PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

const captureImageTool = new FunctionTool({
  name: 'capture_image',
  description: 'Captures the current screen and returns it as a PNG image',
  input: z.object({}),
  fn: ({ id }) => [
    new MediaResultData(id, {
      name: 'screen.png',
      mediatype: 'image',
      contenttype: 'image/png',
      data: RED_PNG_1X1,
    }),
  ],
});

const apiKey = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_TEST_MODEL ?? 'gpt-4o-mini';

describe.skipIf(!apiKey)('OpenAIAgentCore — integration', () => {
  function makeCore() {
    return new OpenAIAgentCore({
      client: new OpenAI({ apiKey }),
      invoke: { model: MODEL, max_output_tokens: 2048 },
    });
  }

  function makeBudget() {
    return new AgentBudgetTracker({ iterations: 5, tokens: { input: 10_000, output: 2_000 } });
  }

  it('returns end_turn with a non-empty text response', async () => {
    const events: AgentCoreStreamEvent[] = [];
    const result = await makeCore().stream(
      {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Reply with exactly: hello' }] },
        ],
        tools: [],
        outputSchema: null,
        budget: makeBudget(),
      },
      {
        onEvent: (e) => {
          events.push(e);
        },
      },
    );

    expect(result.stopReason).toBe('end_turn');
    if (result.stopReason !== 'end_turn') return;
    const text = result.message.content.find((c) => c.type === 'text');
    expect(text).toBeDefined();
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
  });

  it('produces a valid JSON response when outputSchema is set', async () => {
    const schema = z.object({ answer: z.string(), confidence: z.number().min(0).max(1) });
    const result = await makeCore().stream({
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: 'You respond only with raw JSON. No markdown, no code blocks, no explanation — just the JSON object.',
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'What is 2+2? Reply with a JSON object with fields "answer" (string) and "confidence" (number 0-1).',
            },
          ],
        },
      ],
      tools: [],
      outputSchema: schema,
      budget: new AgentBudgetTracker({
        iterations: 10,
        tokens: { input: 10_000, output: 2_000 },
      }),
    });

    expect(result.stopReason).toBe('end_turn');
    if (result.stopReason !== 'end_turn') return;
    const json = result.message.content.find((c) => c.type === 'json');
    expect(json).toBeDefined();
    if (json?.type !== 'json') return;
    expect(schema.safeParse(json.data).success).toBe(true);
  });

  it('requests a tool call when a relevant tool is advertised', async () => {
    const toolset = new Toolset({ add: addTool });
    await toolset.init();
    const encoder = new ToolNameEncoder();
    const tools = Object.values(toolset.metadata()).map((t) => ({
      ...t,
      name: encoder.encode(t.name),
    }));

    const result = await makeCore().stream({
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'What is 17 plus 25? Use the add tool.' }],
        },
      ],
      tools,
      outputSchema: null,
      budget: makeBudget(),
    });

    await toolset.close();

    expect(result.stopReason).toBe('tool_use');
    if (result.stopReason !== 'tool_use') return;
    const toolCall = result.message.content.find((c) => c.type === 'tool_call');
    expect(toolCall).toBeDefined();
  });

  it('describes an image passed as a base64 media block', async () => {
    const result = await makeCore().stream({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'media',
              contentType: 'image/png',
              source: 'base64',
              data: RED_PNG_1X1,
            },
            { type: 'text', text: 'What colour is this image? Reply in one word.' },
          ],
        },
      ],
      tools: [],
      outputSchema: null,
      budget: makeBudget(),
    });

    expect(result.stopReason).toBe('end_turn');
    if (result.stopReason !== 'end_turn') return;
    const text = result.message.content.find((c) => c.type === 'text');
    expect(text).toBeDefined();
    if (text?.type !== 'text') return;
    expect(text.text.toLowerCase()).toContain('red');
  });

  it('describes an image returned as a tool result media block', async () => {
    const toolset = new Toolset({ capture_image: captureImageTool });
    await toolset.init();
    const encoder = new ToolNameEncoder();
    const tools = Object.values(toolset.metadata()).map((t) => ({
      ...t,
      name: encoder.encode(t.name),
    }));
    const core = makeCore();

    const userMessage = {
      role: 'user' as const,
      content: [
        {
          type: 'text' as const,
          text: `Use the ${encoder.encode('capture_image>capture_image')} tool, then tell me in one word what colour the image is.`,
        },
      ],
    };

    // Turn 1: model calls the tool
    const turn1 = await core.stream({
      messages: [userMessage],
      tools,
      outputSchema: null,
      budget: makeBudget(),
    });

    expect(turn1.stopReason).toBe('tool_use');
    if (turn1.stopReason !== 'tool_use') {
      await toolset.close();
      return;
    }

    const toolCall = turn1.message.content.find((c) => c.type === 'tool_call');
    expect(toolCall).toBeDefined();
    if (toolCall?.type !== 'tool_call') {
      await toolset.close();
      return;
    }

    // Execute the tool — decode the name back to the compound key before dispatching
    const results = await toolset.execute([
      { id: toolCall.id, name: encoder.decode(toolCall.name), args: toolCall.args },
    ]);
    expect(results).toHaveLength(1);
    const mediaResult = results[0];
    expect(mediaResult.type).toBe('media');
    if (mediaResult.type !== 'media') {
      await toolset.close();
      return;
    }

    const meta = await mediaResult.metadata();
    const body = await mediaResult.body();

    // Turn 2: feed the image back as a tool result and ask the model to describe it.
    // No tools passed — forces end_turn text response instead of another tool call.
    const turn2 = await core.stream({
      messages: [
        userMessage,
        turn1.message,
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              id: toolCall.id,
              isError: false,
              content: [
                {
                  type: 'media',
                  contentType: meta.contenttype,
                  source: 'base64',
                  data: body,
                },
              ],
            },
          ],
        },
      ],
      tools: [],
      outputSchema: null,
      budget: makeBudget(),
    });

    await toolset.close();

    expect(turn2.stopReason).toBe('end_turn');
    if (turn2.stopReason !== 'end_turn') return;
    const text = turn2.message.content.find((c) => c.type === 'text');
    expect(text).toBeDefined();
    if (text?.type !== 'text') return;
    expect(text.text.toLowerCase()).toContain('red');
  });

  it('handles multiple parallel tool calls and feeds all results back', async () => {
    const toolset = new Toolset({ add: addTool });
    await toolset.init();
    const encoder = new ToolNameEncoder();
    const tools = Object.values(toolset.metadata()).map((t) => ({
      ...t,
      name: encoder.encode(t.name),
    }));
    const core = makeCore();

    const userMessage = {
      role: 'user' as const,
      content: [
        {
          type: 'text' as const,
          text: 'Use the add tool to compute both 17+25 and 10+30. Call it once for each pair.',
        },
      ],
    };

    const turn1 = await core.stream({
      messages: [userMessage],
      tools,
      outputSchema: null,
      budget: makeBudget(),
    });

    expect(turn1.stopReason).toBe('tool_use');
    if (turn1.stopReason !== 'tool_use') {
      await toolset.close();
      return;
    }

    const toolCalls = turn1.message.content.filter((c) => c.type === 'tool_call');
    expect(toolCalls.length).toBeGreaterThanOrEqual(2);

    const dispatches = toolCalls
      .filter((c) => c.type === 'tool_call')
      .map((c) => {
        if (c.type !== 'tool_call') throw new Error('impossible');
        return { id: c.id, name: encoder.decode(c.name), args: c.args };
      });

    const results = await toolset.execute(dispatches);
    await toolset.close();

    const toolResultContent = await Promise.all(
      dispatches.map(async (dispatch, i) => {
        const r = results[i];
        return {
          type: 'tool_result' as const,
          id: dispatch.id,
          isError: r?.type !== 'json',
          content: [
            {
              type: 'text' as const,
              text: r?.type === 'json' ? JSON.stringify(await r.body()) : 'Tool execution failed',
            },
          ],
        };
      }),
    );

    const turn2 = await core.stream({
      messages: [userMessage, turn1.message, { role: 'user', content: toolResultContent }],
      tools: [],
      outputSchema: null,
      budget: makeBudget(),
    });

    expect(turn2.stopReason).toBe('end_turn');
    if (turn2.stopReason !== 'end_turn') return;
    const text = turn2.message.content.find((c) => c.type === 'text');
    expect(text).toBeDefined();
  });

  it('records token usage in the budget after a call', async () => {
    const budget = makeBudget();
    await makeCore().stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hi.' }] }],
      tools: [],
      outputSchema: null,
      budget,
    });

    const state = budget.exportState();
    expect(state.accumulated.iterations).toBe(1);
    expect(state.accumulated.tokens.input).toBeGreaterThan(0);
    expect(state.accumulated.tokens.output).toBeGreaterThan(0);
  });
});
