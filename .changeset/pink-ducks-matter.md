---
"@arvo-tools/agentic": patch
---

### Tolerant JSON Recovery in Output Builder

The default `OUTPUT_BUILDER` now uses a two-stage JSON recovery strategy when `parsedContent` is null (i.e. the LLM integration's initial parse failed):

1. Runs `jsonrepair` on the raw LLM output to recover from common failure modes: markdown code fences, prose mixed with JSON, and structurally malformed JSON.
2. Rejects non-object results (arrays, primitives) so they route into self-correction rather than causing a schema crash downstream.

If recovery still fails, a clear natural language error is returned to trigger the self-correction loop.

`tryParseJson` is reverted to a simple `JSON.parse` wrapper — tolerant recovery is now the responsibility of the output builder, not the parser.
