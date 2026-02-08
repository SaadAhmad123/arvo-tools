---
"@arvo-tools/agentic": major
---

### Context-Based Tool Enablement
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

---

These changes provide developers with fine-grained control over the agent's execution lifecycle, from dynamically enabling tools based on context, to injecting instructions mid-process via inference hooks, to shaping how service responses are presented to the LLM. Together, they enable richer multi-modal interactions and more sophisticated orchestration patterns.
