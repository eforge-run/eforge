---
id: plan-01-state-safety
name: Atomic State Writes & Corruption Recovery
depends_on: []
branch: phase4-polish-prd/state-safety
---

# Atomic State Writes & Corruption Recovery

## Architecture Context

`.forge/state.json` is the single source of truth for orchestration state — plan statuses, worktree paths, completion tracking. The current implementation uses bare `writeFileSync` which risks corruption under concurrent writes or SIGINT during write, and `loadState` crashes on corrupt JSON via unguarded `JSON.parse`. This plan makes writes atomic and recovery graceful, which is a prerequisite for signal-based cancellation (plan-03) where state must be saved reliably during shutdown.

## Implementation

### Overview

Replace direct `writeFileSync` with write-to-temp-then-rename (atomic on POSIX same-filesystem) and wrap `loadState`'s `JSON.parse` in try-catch to return `null` on corrupt/truncated/empty JSON. Add comprehensive tests covering roundtrip, corruption, and edge cases.

### Key Decisions

1. **Temp file in same directory** — `renameSync` is only atomic when source and destination are on the same filesystem. Writing to `filePath + '.tmp'` guarantees this since the `.forge/` directory is always on the same filesystem.
2. **Return `null` on corruption, don't delete** — When `loadState` encounters corrupt JSON, it returns `null` (same as "no state file") rather than deleting the file. The orchestrator's `initializeState` already handles `null` by creating fresh state. The corrupt file remains for debugging if needed.

## Scope

### In Scope
- Atomic write-to-temp-then-rename in `saveState()`
- Try-catch around `JSON.parse` in `loadState()` returning `null` on parse failure
- 5 new tests: atomic roundtrip, corrupt JSON recovery, empty file recovery, truncated JSON recovery, missing directory creation

### Out of Scope
- State file locking (beyond scope — atomic rename is sufficient for single-process writes)
- State migration/versioning
- Signal handling (plan-03)

## Files

### Modify
- `src/engine/state.ts` — Replace `writeFileSync` with `writeFileSync` to `.tmp` + `renameSync`; wrap `JSON.parse` in `loadState` with try-catch returning `null`
- `test/state.test.ts` — Add 5 new tests for atomic write behavior and corruption recovery. Import `writeFileSync`, `mkdirSync`, `readFileSync`, `rmSync` from `node:fs` and `tmpdir` from `node:os` to create real temp directories for filesystem-level tests.

## Verification

- [ ] `saveState()` writes to `.tmp` then renames — verified by checking no `.tmp` file exists after save
- [ ] `loadState()` returns `null` for corrupt JSON (e.g., `"{ broken"`)
- [ ] `loadState()` returns `null` for empty file
- [ ] `loadState()` returns `null` for truncated JSON (e.g., `{"setName":"te`)
- [ ] `loadState()` still returns `null` when no state file exists (existing behavior preserved)
- [ ] `saveState()` creates parent directories if needed (existing behavior preserved)
- [ ] `pnpm test` passes with all new tests
- [ ] `pnpm type-check` passes
