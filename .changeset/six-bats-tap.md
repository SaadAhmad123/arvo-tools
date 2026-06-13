---
"@arvo-tools/agentic": patch
---

### Tolerant JSON Parsing and Improved Self-Correction Feedback

`tryParseJson` now uses `jsonrepair` as a fallback when native `JSON.parse` fails, recovering from the three most common LLM output issues: JSON wrapped in markdown code fences, prose mixed with JSON, and structurally malformed JSON. The fast path (`JSON.parse`) is unchanged for well-formed responses.

The self-correction feedback message fed back to the LLM on output validation failure has also been rewritten from a JSON error payload to explicit natural language instructions, directly naming each failure mode so even older models can reliably self-correct.
