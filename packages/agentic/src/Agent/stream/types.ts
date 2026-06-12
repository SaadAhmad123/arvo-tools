import type z from 'zod';
import type { AgentStreamEventSchema } from './schema';

/**
 * Callback invoked for every event emitted by the agent during execution.
 *
 * @param event - The stream event payload, including a unique `id` and ISO `time` timestamp.
 * @param metadata - Orchestration context for the event:
 *   - `subject` — the Arvo subject of the currently executing agent instance.
 *   - `parentSubject` — the Arvo subject of the parent orchestrator that invoked this agent;
 *     `null` when this agent is the root of the orchestration tree.
 *   - `initiatorId` — the contract type that originally initiated this orchestration chain.
 *   - `selfId` — the contract type of the agent emitting this event.
 *   - `selfVersion` — the semantic version of the agent emitting this event.
 */
export type AgentStreamListener = (
  event: z.infer<typeof AgentStreamEventSchema> & {
    id: string;
    time: string;
  },
  metadata: {
    subject: string;
    parentSubject: string | null;
    initiatorId: string;
    selfId: string;
    selfVersion: string;
  },
) => void;

export type AgentEventStreamer = (event: z.infer<typeof AgentStreamEventSchema>) => void;
