import type z from 'zod';
import type {
  AgentInferenceDeltaEventSchema,
  AgentInferenceDeltaMediaEventSchema,
  AgentInferenceDeltaTextEventSchema,
  AgentInferenceDeltaToolEventSchema,
  AgentInitEventSchema,
  AgentOutputEventSchema,
  AgentOutputFinalizationEventSchema,
  AgentResumeEventSchema,
  AgentSelfCorrectionEventSchema,
  AgentStreamEventSchema,
  AgentToolPermissionBlockedEventSchema,
  AgentToolPermissionDeniedEventSchema,
  AgentToolPermissionRequestedEventSchema,
  AgentToolRequestDelegationEventSchema,
  AgentToolRequestEventSchema,
  InferenceStreamEventSchema,
} from './schema';

export type AgentStreamEvent = z.infer<typeof AgentStreamEventSchema>;
export type AgentInitEvent = z.infer<typeof AgentInitEventSchema>;
export type AgentResumeEvent = z.infer<typeof AgentResumeEventSchema>;
export type AgentSelfCorrectionEvent = z.infer<typeof AgentSelfCorrectionEventSchema>;
export type AgentToolRequestEvent = z.infer<typeof AgentToolRequestEventSchema>;
export type AgentOutputFinalizationEvent = z.infer<typeof AgentOutputFinalizationEventSchema>;
export type AgentOutputEvent = z.infer<typeof AgentOutputEventSchema>;
export type AgentToolRequestDelegationEvent = z.infer<typeof AgentToolRequestDelegationEventSchema>;
export type AgentInferenceDeltaEvent = z.infer<typeof AgentInferenceDeltaEventSchema>;
export type AgentInferenceDeltaTextEvent = z.infer<typeof AgentInferenceDeltaTextEventSchema>;
export type AgentInferenceDeltaToolEvent = z.infer<typeof AgentInferenceDeltaToolEventSchema>;
export type AgentInferenceDeltaMediaEvent = z.infer<typeof AgentInferenceDeltaMediaEventSchema>;
export type AgentToolPermissionBlockedEvent = z.infer<typeof AgentToolPermissionBlockedEventSchema>;
export type AgentToolPermissionDeniedEvent = z.infer<typeof AgentToolPermissionDeniedEventSchema>;
export type AgentToolPermissionRequestedEvent = z.infer<
  typeof AgentToolPermissionRequestedEventSchema
>;
export type InferenceStreamEvent = z.infer<typeof InferenceStreamEventSchema>;
