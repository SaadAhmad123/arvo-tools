# @arvo-tools/postgres

## 1.3.2

### Patch Changes

- f48e547: **Fix: failure state write no longer throws a duplicate key violation on resume**

  When a workflow errored during a resume, `arvo-event-handler` called `write(id, failureData, null)` with `prevData = null`. The implementation treated `null` unconditionally as a first-time write and issued a plain `INSERT`. Because the state row already existed, PostgreSQL threw a duplicate key violation that propagated as a `ViolationError` and was silently swallowed by the caller — the failure state was never persisted.

  The `prevData = null` branch now extracts into a private `writeNewState` method that checks for an existing row before touching the transaction:

  - **No existing row** — original `INSERT` + hierarchy setup, unchanged.
  - **Row exists + `executionStatus` is `FAILURE`** — issues an unconditional `UPDATE` (incrementing `version + 1`) to stamp the failure state onto the existing row.
  - **Row exists + any other status** — throws immediately, as a non-failure write with `prevData = null` against an existing row indicates a duplicate init or a bug.

## 1.3.1

### Patch Changes

- 1301df8: Updated the TS compile target to ES2022 for compatibility reasons

## 1.3.0

### Minor Changes

- 988737f: Added schema based grouping for tables

## 1.2.2

### Patch Changes

- c0803c9: Updated dependencies

## 1.2.1

### Patch Changes

- 991ac43: Add README.md and SECURITY.md to the package

## 1.2.0

### Minor Changes

- 0e8d857: Introducing database safety and postgres based event broker

## 1.1.0

### Minor Changes

- b998fd4: Simplified migration management. Secured database access even further.

## 1.0.0

### Major Changes

- 87670d7: Introducing the Postgres based memory backend for Arvo
