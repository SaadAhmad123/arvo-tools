import type z from 'zod';
import type { AgentStreamEventSchema } from './schema';

export type AgentStreamListener = (
  event: z.infer<typeof AgentStreamEventSchema> & {
    id: string;
    time: string;
  },
  metadata: {
    subject: string;
    initiatorId: string;
    selfId: string;
    selfVersion: string;
  },
) => void;

export type AgentEventStreamer = (event: z.infer<typeof AgentStreamEventSchema>) => void;
