---
title: Errand: Deduplicate repeated patterns across engine + tests
created: 2026-03-18
status: pending
---

## Problem / Motivation

The codebase has several copy-pasted patterns that have grown past the "colocate until 3+ files" threshold. Four independent duplication targets exist:

- `SEVERITY_ORDER` map defined identically in 3 places (`pipeline.ts`, `review-fixer.ts`, `parallel-reviewer.ts`)
- A filter-count-colorize pattern repeated 3 times in `src/cli/display.ts` (lines 161-168, 198-205, 259-266)
- `collectEvents()`, `findEvent()`, `filterEvents()` helpers copy-pasted across 13 test files
- `makeTempDir()` + `tempDirs` array + `afterEach` cleanup duplicated across 7 test files

This duplication increases maintenance burden and divergence risk for what are mechanically identical patterns.

## Goal

Extract the four duplicated patterns into shared modules - eliminating redundancy with no behavioral changes.

## Approach

All four extractions are mechanical - pull the repeated code into a canonical location, then replace inline definitions with imports.

### 1. Extract `SEVERITY_ORDER` to `src/engine/events.ts`

Add `export const SEVERITY_ORDER` to `src/engine/events.ts` next to the `ReviewIssue` interface. Remove local definitions from:
- `src/engine/pipeline.ts` (lines 248-252)
- `src/engine/agents/review-fixer.ts` (lines 30-34, inside `formatIssuesForPrompt`)
- `src/engine/agents/parallel-reviewer.ts` (inside `deduplicateIssues`)

All three files import from `../events.js`.

### 2. Extract `formatIssueSummary()` in `src/cli/display.ts`

Add a private `formatIssueSummary(issues: ReviewIssue[]): string` helper in `display.ts`. Replace the three inline filter-count-colorize blocks (lines 161-168, 198-205, 259-266). Import `ReviewIssue` type from events.

### 3. Extract test event helpers to `test/test-events.ts`

Create `test/test-events.ts` exporting `collectEvents()`, `findEvent()`, and `filterEvents()`. Update all 13 test files to import from `./test-events.js` and remove inline definitions.

**Caveats**:
- `formatter-agent.test.ts` has a unique `collectEventsAndResult()` variant - leave that inline.
- `hooks.test.ts` has `collectEvents` inside a describe block but it's pure - safe to hoist to an import.

### 4. Extract temp dir helper to `test/test-tmpdir.ts`

Create `test/test-tmpdir.ts` exporting `useTempDir(prefix?): () => string` - a factory that registers its own `afterEach` cleanup. Update 7 test files to use it, removing the boilerplate and now-unused imports.

### Files touched

| File | Change |
|------|--------|
| `src/engine/events.ts` | Add `SEVERITY_ORDER` export |
| `src/engine/pipeline.ts` | Remove local `SEVERITY_ORDER`, import from events |
| `src/engine/agents/review-fixer.ts` | Remove local `SEVERITY_ORDER`, import from events |
| `src/engine/agents/parallel-reviewer.ts` | Remove local `SEVERITY_ORDER`, import from events |
| `src/cli/display.ts` | Add `formatIssueSummary()` helper, simplify 3 call sites |
| `test/test-events.ts` | **New** - shared `collectEvents`, `findEvent`, `filterEvents` |
| `test/test-tmpdir.ts` | **New** - shared `useTempDir()` factory |
| 13 test files | Replace inline event helpers with imports |
| 7 test files | Replace inline temp dir boilerplate with `useTempDir()` |

## Scope

**In scope**:
- Extracting `SEVERITY_ORDER` to a shared location in engine code
- Extracting `formatIssueSummary()` as a private helper in `display.ts`
- Creating `test/test-events.ts` with shared event helpers
- Creating `test/test-tmpdir.ts` with shared temp dir factory
- Updating all consuming files to use the new shared modules

**Out of scope**:
- Any behavioral changes - all extractions are purely mechanical
- Extracting `collectEventsAndResult()` from `formatter-agent.test.ts` (unique variant, stays inline)

## Acceptance Criteria

- `SEVERITY_ORDER` is defined exactly once in `src/engine/events.ts` and imported by `pipeline.ts`, `review-fixer.ts`, and `parallel-reviewer.ts` - no local definitions remain
- `formatIssueSummary()` exists as a private helper in `display.ts` and the three inline filter-count-colorize blocks are replaced with calls to it
- `test/test-events.ts` exports `collectEvents`, `findEvent`, and `filterEvents` - all 13 test files import from it with no inline definitions remaining
- `test/test-tmpdir.ts` exports `useTempDir()` - all 7 test files use it with no inline temp dir boilerplate remaining
- `formatter-agent.test.ts` retains its unique `collectEventsAndResult()` inline
- `pnpm type-check` passes
- `pnpm test` passes
- No behavioral changes - all tests produce identical results
