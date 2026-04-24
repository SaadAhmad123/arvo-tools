---
"@arvo-tools/postgres": patch
---

**Fix: failure state write no longer throws a duplicate key violation on resume**

When a workflow errored during a resume, `arvo-event-handler` called `write(id, failureData, null)` with `prevData = null`. The implementation treated `null` unconditionally as a first-time write and issued a plain `INSERT`. Because the state row already existed, PostgreSQL threw a duplicate key violation that propagated as a `ViolationError` and was silently swallowed by the caller — the failure state was never persisted.

The `prevData = null` branch now extracts into a private `writeNewState` method that checks for an existing row before touching the transaction:

- **No existing row** — original `INSERT` + hierarchy setup, unchanged.
- **Row exists + `executionStatus` is `FAILURE`** — issues an unconditional `UPDATE` (incrementing `version + 1`) to stamp the failure state onto the existing row.
- **Row exists + any other status** — throws immediately, as a non-failure write with `prevData = null` against an existing row indicates a duplicate init or a bug.
