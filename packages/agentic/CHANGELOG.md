# @arvo-tools/agentic

## 2.1.0

### Minor Changes

- 98216e2: ### Parent Subject Propagation

  The agent now threads `parentSubject` — the Arvo orchestration subject of the calling orchestrator — through the entire execution pipeline, giving every layer of the system awareness of where in the orchestration tree it sits.

  #### What changed

  **`AgentState`** now persists `parentSubject` (sourced from `parentSubject$$` in the initiating event's data payload). Both `currentSubject` and `parentSubject` are optional in the schema, so existing persisted state from prior versions remains valid.

  **`AgentStreamListener`** metadata now includes `parentSubject`, so stream consumers can identify the parent orchestrator for every event the agent emits.

  **`AgentInternalTool.fn`** config now receives `subject` and `parentSubject` alongside the existing `otelInfo` and `toolUseId`, giving tool implementations full orchestration context at invocation time.

  **`agentLoop`** accepts `currentSubject` and `parentSubject` as explicit parameters and forwards them to every internal tool call.

  #### Bug fix

  `permissionManagerContext` was accidentally omitted from the `agentLoop` call on the `tool_result` (resume) path. It is now correctly passed in both the initial and resumed execution paths.

## 2.0.1

### Patch Changes

- 30ebedd: Passed current subject to the inference hooks for workflow awareness

## 2.0.0

### Major Changes

- 789b572: ### Context-Based Tool Enablement
  The context builder now returns an `enabledTools` map, allowing dynamic tool availability based on initiation input to the agent.

  ### Pre/Post Inference Hooks

  - **preInferenceHook:** Modify messages before each LLM call (e.g., inject instructions, apply token optimization)
  - **postInferenceHook:** Inspect inference results with RETRY (redo inference) or CIRCUIT_BREAK (abort with error) control flow

  ### Arvo Service Output Transformers

  Service contracts now support a `transformer` function that converts service responses into custom message formats, enabling richer tool result representations.

  ### Enhanced Internal Tool Output Format

  Internal tools can now return:

  - `{ messages }` — Full control over tool result messages, supporting multi-modal content (images, files)
  - `{ data }` — Simple key-value results (existing behavior)
  - `void` — No-op acknowledgment

  ***

  These changes provide developers with fine-grained control over the agent's execution lifecycle, from dynamically enabling tools based on context, to injecting instructions mid-process via inference hooks, to shaping how service responses are presented to the LLM. Together, they enable richer multi-modal interactions and more sophisticated orchestration patterns.

## 1.2.17

### Patch Changes

- e1e6895: Version bump cascading from the source dependencies

## 1.2.16

### Patch Changes

- 8a36417: Enhanced permission management

## 1.2.15

### Patch Changes

- 123e4a5: Version bump

## 1.2.14

### Patch Changes

- 182aa6f: Dependency upgrade (Arvo)

## 1.2.13

### Patch Changes

- 258905b: [Bugfix]: The internal tool name was inconsistant with other tool definitions. So fixed that

## 1.2.12

### Patch Changes

- f4711ab: Updated the Respository homepage

## 1.2.11

### Patch Changes

- e49410a: Enhanced permission manager internal logic to be more explicit

## 1.2.10

### Patch Changes

- 500d580: Fixed type in Agent Definition

## 1.2.9

### Patch Changes

- 5fcf504: Made memory optional for simple use cases which dont require agent suspension.

## 1.2.8

### Patch Changes

- 96f47f6: Type bug fix for the context builder

## 1.2.7

### Patch Changes

- cbd1dfe: Exported IPermissionManager interface and added a cleanup hook in the permission manager interface for permission data lifecycle management

## 1.2.6

### Patch Changes

- 9a3679a: Update MCP version to cover the vulnerability

## 1.2.5

### Patch Changes

- 0200915: Added exports for OpenAI and Anthropic sdks used by the package

## 1.2.4

### Patch Changes

- a14ef38: Added deep streaming ability in llm integrations along side agents

## 1.2.3

### Patch Changes

- 4364baa: Updated the arvo deps versions and added defaults of event emission domains

## 1.2.2

### Patch Changes

- 3c8200d: Updated Arvo versions

## 1.2.1

### Patch Changes

- ebc405b: Started a README for agentic package

## 1.2.0

### Minor Changes

- 2f429e2: Added agent permission manager for explicit tool permission management

## 1.1.1

### Patch Changes

- d4de901: Removed azure openai dependency

## 1.1.0

### Minor Changes

- 8e4af08: Added Anthropic and Azure Integration - Also added event streaming in agents

## 1.0.1

### Patch Changes

- 0de51dc: Bugfix: Fixed subject correlation for nested orchestration

## 1.0.0

### Major Changes

- 0bc6465: Releasing production version of the Arvo Agent

## 0.4.1

### Patch Changes

- 75d6821: Fixed UUID version

## 0.4.0

### Minor Changes

- f6418ef: Add openai and mcp integrations

## 0.3.0

### Minor Changes

- 49e0174: Added ArvoAgent

## 0.2.0

### Minor Changes

- 0aa8676: I am testing

## 0.1.0

### Minor Changes

- Started the toolset
