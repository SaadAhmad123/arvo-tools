import z from 'zod';

const AgentStartSchema = z.object({
  system: z.string().nullable(),
  messages: z.record(z.string(), z.any()).array(),
  tools: z.string().array(),
  llmResponseType: z.string(),
  toolIteractionCycle: z.object({
    max: z.number(),
    current: z.number(),
    exhausted: z.boolean(),
  }),
});

export const AgentStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('agent.init'),
    data: AgentStartSchema,
  }),
  z.object({
    type: z.literal('agent.resume'),
    data: AgentStartSchema,
  }),
  z.object({
    type: z.literal('agent.self.correction'),
    data: AgentStartSchema,
  }),
  z.object({
    type: z.literal('agent.tool.request'),
    data: z.object({
      tool: z.object({
        kind: z.string(),
        name: z.string(),
        originalName: z.string(),
      }),
      usage: z.object({
        prompt: z.number(),
        completion: z.number(),
      }),
      executionunits: z.number(),
    }),
  }),
  z.object({
    type: z.literal('agent.output.finalization'),
    data: z.object({
      content: z.string(),
      usage: z.object({
        prompt: z.number(),
        completion: z.number(),
      }),
      executionunits: z.number(),
    }),
  }),
  z.object({
    type: z.literal('agent.output'),
    data: z.object({
      content: z.string(),
      usage: z.object({
        prompt: z.number(),
        completion: z.number(),
      }),
      executionunits: z.number(),
    }),
  }),
  z.object({
    type: z.literal('agent.tool.request.delegation'),
    data: z.object({
      tools: z.string().array(),
      usage: z.object({
        prompt: z.number(),
        completion: z.number(),
      }),
      executionunits: z.number(),
    }),
  }),
  z.object({
    type: z.literal('agent.llm.delta'),
    data: z.object({
      finishReason: z.string().nullable(),
      comment: z.string(),
      meta: z.object({
        error: z.string().nullable(),
        token: z.object({
          prompt: z.number(),
          completion: z.number(),
        }),
        otel: z.object({
          traceparent: z.string().nullable(),
          tracestate: z.string().nullable(),
        }),
      }),
    }),
  }),
  z.object({
    type: z.literal('agent.llm.delta.text'),
    data: z.object({
      delta: z.string().nullable(),
      content: z.string(),
      comment: z.string(),
      meta: z.object({
        error: z.string().nullable(),
        token: z.object({
          prompt: z.number(),
          completion: z.number(),
        }),
        otel: z.object({
          traceparent: z.string().nullable(),
          tracestate: z.string().nullable(),
        }),
      }),
    }),
  }),
  z.object({
    type: z.literal('agent.llm.delta.tool'),
    data: z.object({
      comment: z.string(),
      toolname: z.string(),
      toolUseId: z.string(),
      input: z.string(),
      meta: z.object({
        error: z.string().nullable(),
        token: z.object({
          prompt: z.number(),
          completion: z.number(),
        }),
        otel: z.object({
          traceparent: z.string().nullable(),
          tracestate: z.string().nullable(),
        }),
      }),
    }),
  }),
  z.object({
    type: z.literal('agent.tool.permission.blocked'),
    data: z.object({
      tools: z
        .object({
          name: z.string(),
          kind: z.string(),
          originalName: z.string(),
        })
        .array(),
      usage: z.object({
        prompt: z.number(),
        completion: z.number(),
      }),
      executionunits: z.number(),
    }),
  }),
  z.object({
    type: z.literal('agent.tool.permission.requested'),
    data: z.object({
      tools: z
        .object({
          name: z.string(),
          kind: z.string(),
          originalName: z.string(),
        })
        .array(),
      usage: z.object({
        prompt: z.number(),
        completion: z.number(),
      }),
      executionunits: z.number(),
    }),
  }),
]);
