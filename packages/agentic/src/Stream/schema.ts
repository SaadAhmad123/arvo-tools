import z from 'zod';

export const AgentStartSchema = z.object({
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

export const AgentInitEventSchema = z.object({
  type: z.literal('agent.init'),
  data: AgentStartSchema,
});

export const AgentResumeEventSchema = z.object({
  type: z.literal('agent.resume'),
  data: AgentStartSchema,
});

export const AgentSelfCorrectionEventSchema = z.object({
  type: z.literal('agent.self.correction'),
  data: AgentStartSchema,
});

export const AgentToolRequestEventSchema = z.object({
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
  }),
});

export const AgentOutputFinalizationEventSchema = z.object({
  type: z.literal('agent.output.finalization'),
  data: z.object({
    content: z.string(),
    usage: z.object({
      prompt: z.number(),
      completion: z.number(),
    }),
  }),
});

export const AgentOutputEventSchema = z.object({
  type: z.literal('agent.output'),
  data: z.object({
    content: z.string(),
    usage: z.object({
      prompt: z.number(),
      completion: z.number(),
    }),
  }),
});

export const AgentToolRequestDelegationEventSchema = z.object({
  type: z.literal('agent.tool.request.delegation'),
  data: z.object({
    tools: z.string().array(),
    usage: z.object({
      prompt: z.number(),
      completion: z.number(),
    }),
  }),
});

export const AgentInferenceDeltaEventSchema = z.object({
  type: z.literal('agent.inference.delta'),
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
});

export const AgentInferenceDeltaMediaEventSchema = z.object({
  type: z.literal('agent.inference.delta.media'),
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
});

export const AgentInferenceDeltaTextEventSchema = z.object({
  type: z.literal('agent.inference.delta.text'),
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
});

export const AgentInferenceDeltaToolEventSchema = z.object({
  type: z.literal('agent.inference.delta.tool'),
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
});

export const AgentToolPermissionBlockedEventSchema = z.object({
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
  }),
});

export const AgentToolPermissionDeniedEventSchema = z.object({
  type: z.literal('agent.tool.permission.denied'),
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
  }),
});

export const AgentToolPermissionRequestedEventSchema = z.object({
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
  }),
});

export const InferenceStreamEventSchema = z.discriminatedUnion('type', [
  AgentInferenceDeltaEventSchema,
  AgentInferenceDeltaTextEventSchema,
  AgentInferenceDeltaToolEventSchema,
  AgentInferenceDeltaMediaEventSchema,
]);

export const AgentStreamEventSchema = z.discriminatedUnion('type', [
  AgentInitEventSchema,
  AgentResumeEventSchema,
  AgentSelfCorrectionEventSchema,
  AgentToolRequestEventSchema,
  AgentOutputFinalizationEventSchema,
  AgentOutputEventSchema,
  AgentToolRequestDelegationEventSchema,
  AgentInferenceDeltaEventSchema,
  AgentInferenceDeltaTextEventSchema,
  AgentInferenceDeltaToolEventSchema,
  AgentToolPermissionBlockedEventSchema,
  AgentToolPermissionDeniedEventSchema,
  AgentToolPermissionRequestedEventSchema,
  AgentInferenceDeltaMediaEventSchema,
]);
