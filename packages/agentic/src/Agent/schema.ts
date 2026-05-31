import { z } from 'zod';
import { MessageSchema } from '../message.schema';

export const AgentStatusSchema = z.enum(['init', 'resume', 'tool_request', 'done', 'error']);

export const ToolRequestSchema = z.object({
  id: z.string(),
  state: z.enum(['pending', 'fulfilled']),
  dispatch: z.object({
    id: z.string(),
    name: z.string(),
    args: z.record(z.unknown()),
  }),
  request: z
    .object({
      id: z.string(),
      type: z.string(),
      body: z.record(z.unknown()),
    })
    .nullable(),
  response: z.record(z.unknown()).nullable(),
});

export const AgentBudgetTrackerStateSchema = z.object({
  limits: z.object({
    iterations: z.number(),
    tokens: z.object({ input: z.number(), output: z.number() }),
  }),
  accumulated: z.object({
    iterations: z.number(),
    tokens: z.object({ input: z.number(), output: z.number() }),
  }),
});

export const AgentStateSchema = z.object({
  status: AgentStatusSchema,
  messages: z.array(MessageSchema),
  budget: AgentBudgetTrackerStateSchema,
  toolRequests: z.array(ToolRequestSchema),
  system: z.string().nullable(),
});
