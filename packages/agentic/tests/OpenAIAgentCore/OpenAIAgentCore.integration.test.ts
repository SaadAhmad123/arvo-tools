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
      results.map(async (r) => ({
        type: 'tool_result' as const,
        id: r.id,
        isError: r.type !== 'json',
        content: [
          {
            type: 'text' as const,
            text: r.type === 'json' ? JSON.stringify(await r.body()) : 'Tool execution failed',
          },
        ],
      })),
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

  it('produces a deeply nested JSON report conforming to a complex schema', async () => {
    const projectReportSchema = z.object({
      projectOverview: z.object({
        codeName: z.string().min(2).max(50),
        status: z.enum(['planning', 'in_progress', 'on_hold', 'completed']),
        healthScore: z.number().int().min(1).max(10),
        completionPercent: z.number().min(0).max(100),
        startDate: z.string(),
        projectedEndDate: z.string(),
      }),
      teamComposition: z
        .array(
          z.object({
            role: z.enum(['lead', 'senior_engineer', 'engineer', 'designer', 'qa', 'devops', 'pm']),
            headcount: z.number().int().min(1),
            currentUtilization: z.number().min(0).max(100),
            keyResponsibilities: z.array(z.string()).min(1).max(5),
          }),
        )
        .min(2),
      riskRegister: z
        .array(
          z.object({
            riskId: z.string(),
            title: z.string(),
            category: z.enum(['technical', 'resource', 'schedule', 'budget', 'external']),
            likelihood: z.enum(['low', 'medium', 'high']),
            impact: z.enum(['low', 'medium', 'high', 'critical']),
            mitigations: z.array(z.string()).min(1),
            status: z.enum(['open', 'mitigating', 'closed']),
          }),
        )
        .min(2),
      sprintVelocity: z.object({
        averagePointsPerSprint: z.number().positive(),
        trend: z.enum(['improving', 'stable', 'declining']),
        last3Sprints: z
          .array(
            z.object({
              sprintNumber: z.number().int().positive(),
              plannedPoints: z.number().int().min(0),
              completedPoints: z.number().int().min(0),
            }),
          )
          .min(3)
          .max(3),
      }),
      technicalDebt: z.object({
        estimatedHours: z.number().min(0),
        severity: z.enum(['low', 'medium', 'high', 'critical']),
        topAreas: z
          .array(
            z.object({
              area: z.string(),
              description: z.string(),
              estimatedHoursToResolve: z.number().min(0),
            }),
          )
          .min(2)
          .max(5),
      }),
      recommendations: z
        .array(
          z.object({
            priority: z.enum(['p0', 'p1', 'p2', 'p3']),
            title: z.string().min(10),
            description: z.string().min(20),
            estimatedEffortDays: z.number().int().min(1),
            expectedOutcome: z.string().min(10),
          }),
        )
        .min(3),
      executiveSummary: z.string().min(100),
    });

    const result = await makeCore().stream({
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: 'You are a senior engineering manager producing structured project health reports. Always respond with a single valid JSON object — no markdown, no explanation.',
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Produce a project health report for a fictional mid-sized e-commerce platform migration called "Phoenix" that is 40% complete and running slightly behind schedule due to infrastructure unknowns. The team has 8 engineers across multiple disciplines. Include at least 2 real risks, exactly 3 sprint velocity entries, at least 2 technical debt areas, and at least 3 prioritised recommendations. The executive summary must be at least 100 characters.',
            },
          ],
        },
      ],
      tools: [],
      outputSchema: projectReportSchema,
      budget: new AgentBudgetTracker({
        iterations: 5,
        tokens: { input: 20_000, output: 8_000 },
      }),
    });

    expect(result.stopReason).toBe('end_turn');
    if (result.stopReason !== 'end_turn') return;

    const json = result.message.content.find((c) => c.type === 'json');
    expect(json).toBeDefined();
    if (json?.type !== 'json') return;

    const parsed = projectReportSchema.safeParse(json.data);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const data = parsed.data;
    expect(data.teamComposition.length).toBeGreaterThanOrEqual(2);
    expect(data.riskRegister.length).toBeGreaterThanOrEqual(2);
    expect(data.sprintVelocity.last3Sprints).toHaveLength(3);
    expect(data.technicalDebt.topAreas.length).toBeGreaterThanOrEqual(2);
    expect(data.recommendations.length).toBeGreaterThanOrEqual(3);
    expect(data.executiveSummary.length).toBeGreaterThanOrEqual(100);
    expect(data.projectOverview.completionPercent).toBeGreaterThanOrEqual(0);
    expect(data.projectOverview.completionPercent).toBeLessThanOrEqual(100);
  });

  describe('budget exhaustion', () => {
    it('returns budget_exhausted when the API max_output_tokens limit truncates the response', async () => {
      const core = new OpenAIAgentCore({
        client: new OpenAI({ apiKey }),
        // 10 tokens is far too small to complete any response — forces incomplete stop reason
        invoke: { model: MODEL, max_output_tokens: 17 },
      });

      const result = await core.stream({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Write a 500-word essay about the history of computing.' },
            ],
          },
        ],
        tools: [],
        outputSchema: null,
        budget: new AgentBudgetTracker({
          iterations: 5,
          tokens: { input: 10_000, output: 10_000 },
        }),
      });

      expect(result.stopReason).toBe('budget_exhausted');
      if (result.stopReason !== 'budget_exhausted') return;
      expect(result.error.message).toMatch(/max_output_tokens/i);
      expect(result.messages.length).toBeGreaterThan(0);
    });

    it('returns budget_exhausted immediately when the tracker iteration limit is already spent', async () => {
      const result = await makeCore().stream({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hello.' }] }],
        tools: [],
        outputSchema: null,
        // 0 iterations → shouldContinue() is false before the first API call
        budget: new AgentBudgetTracker({
          iterations: 0,
          tokens: { input: 10_000, output: 10_000 },
        }),
      });

      expect(result.stopReason).toBe('budget_exhausted');
      if (result.stopReason !== 'budget_exhausted') return;
      expect(result.error).toBeDefined();
    });
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
