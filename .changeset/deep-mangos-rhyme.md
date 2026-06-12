---
"@arvo-tools/agentic": minor
---

### Parent Subject Propagation

The agent now threads `parentSubject` — the Arvo orchestration subject of the calling orchestrator — through the entire execution pipeline, giving every layer of the system awareness of where in the orchestration tree it sits.

#### What changed

**`AgentState`** now persists `parentSubject` (sourced from `parentSubject$$` in the initiating event's data payload). Both `currentSubject` and `parentSubject` are optional in the schema, so existing persisted state from prior versions remains valid.

**`AgentStreamListener`** metadata now includes `parentSubject`, so stream consumers can identify the parent orchestrator for every event the agent emits.

**`AgentInternalTool.fn`** config now receives `subject` and `parentSubject` alongside the existing `otelInfo` and `toolUseId`, giving tool implementations full orchestration context at invocation time.

**`agentLoop`** accepts `currentSubject` and `parentSubject` as explicit parameters and forwards them to every internal tool call.

#### Bug fix

`permissionManagerContext` was accidentally omitted from the `agentLoop` call on the `tool_result` (resume) path. It is now correctly passed in both the initial and resumed execution paths.
