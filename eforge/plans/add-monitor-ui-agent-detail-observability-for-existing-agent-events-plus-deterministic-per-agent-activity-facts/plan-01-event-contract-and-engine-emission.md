---
id: plan-01-event-contract-and-engine-emission
name: Event contract changes and engine emission for per-agent detail observability
branch: add-monitor-ui-agent-detail-observability-for-existing-agent-events-plus-deterministic-per-agent-activity-facts/plan-01-event-contract-and-engine-emission
---

# Event contract changes and engine emission for per-agent detail observability

## Architecture Context

`packages/client/src/events.schemas.ts` is the wire-protocol source of truth. The current `agent:result` schema carries `planId`, `agent`, and a `result` object (`AgentResultDataSchema`) but does not carry `agentId`, even though every other `agent:*` lifecycle event already does. This makes downstream consumers (the monitor UI reducer in particular) match results against threads by reverse-walking `(agent, planId, durationMs === null)`, which is fragile when multiple threads of the same role/plan exist or are retried.

Both harnesses already have `agentId` in scope when they emit `agent:result`:
- `packages/engine/src/harnesses/claude-sdk.ts` declares `const agentId = crypto.randomUUID();` early in `runSession` and passes it to `mapSDKMessages(q, agent, agentId, planId)`; emission sites at lines 492 and 497 omit it.
- `packages/engine/src/harnesses/pi.ts` emits the final `agent:usage` with `agentId` immediately before `agent:result` at line 845, so the variable is in scope at the result emission site too.

Deterministic per-agent file/diffstat facts already have a robust foundation:
- `packages/engine/src/prd-validator-diff.ts` contains thoroughly battle-tested NUL-delimited parsers `parseNameStatusZ` and `parseNumstatZ` that handle renames, copies, and binary files. These should be extracted to a shared helper.
- `packages/engine/src/pipeline/git-helpers.ts` already wraps mutating agent runs with `withPeriodicFileCheck`, which captures `git diff --name-only` against the base branch.

The `implement` stage in `packages/engine/src/pipeline/stages/build-stages.ts` (lines 423-481 single-builder flow; lines 482+ sharded flow) snapshots `preImplementCommit` before running the builder. That gives a precise pre/post commit range for builder attribution — `exact` attribution is reliable here for the non-sharded path. Sharded builders are scope-enforced so each shard owns disjoint files; per-shard attribution is also `exact`. Review-fixer (`reviewFixStageInner`, line 230) runs after `review` and writes unstaged changes; the unstaged file set captured immediately after the agent stops is a precise attribution scope when no other mutating agent overlaps. Per the source assumptions table, agents that may overlap or whose attribution cannot be isolated must be marked `best_effort` or omitted in this plan.

## Implementation

### Overview

This plan changes the wire contract and engine emission only — no monitor UI consumption changes are made here (those land in plan-02).

1. Extend `agent:result` schema with an optional `agentId` field (optional for backward compatibility with logs replayed from before this change).
2. Add a new typed event `agent:activity` carrying deterministic per-agent file/diffstat facts plus an `attribution` quality marker.
3. Register both schema changes in `event-registry.ts`.
4. Update both harnesses (`claude-sdk.ts`, `pi.ts`) to include `agentId` on emitted `agent:result` events.
5. Extract a shared diffstat helper from `prd-validator-diff.ts` so its `--name-status -z` + `--numstat -z` parsers can be reused for per-agent attribution.
6. Wrap the builder implementation stage (single-builder path) and the review-fixer stage to compute and emit `agent:activity` with `exact` attribution when a clean pre/post snapshot is available; mark `best_effort` or skip emission when overlap or absence of pre-state makes attribution ambiguous.
7. Regenerate `web/content/reference/events.md` and the schema JSON via `pnpm docs:generate` so the `docs:check` drift gate passes.

### Key Decisions

1. **`agentId` is added as an optional field on `agent:result`, not required.** Old persisted logs and replay paths must continue to parse — `safeParseEforgeEvent` must accept events without `agentId`. Both harnesses always emit it going forward.
2. **`agent:activity` is a new top-level event variant, not nested inside `agent:stop` or `agent:result`.** Rationale (from source design decision 4): activity facts are observational data and may be absent without implying a stop failure; nesting would conflate lifecycle and observation.
3. **Attribution quality is explicit on every emitted `agent:activity`.** The `attribution` field is `'exact' | 'best_effort' | 'unavailable'`, with optional `notes: string[]` explaining the verdict. Emission is conservative: only emit `exact` when a pre-state snapshot bounds the change to one agent in one worktree.
4. **Diffstat helper is extracted from `prd-validator-diff.ts`, not duplicated.** The new helper exposes `collectDiffStats(cwd, fromRef, toRef)` returning `{ files: Array<{path; status; additions; deletions; binary}>, totals: {filesChanged; additions; deletions} }`. `prd-validator-diff.ts` continues to own the rendering/budgeting concern but imports the parsers from the shared helper.
5. **Emission is staged at known-clean boundaries.** Per source assumption-validation guidance, only emit deterministic activity from boundaries where pre/post is unambiguous: (a) `implement` single-builder flow using `preImplementCommit` as the base; (b) `reviewFixStageInner` using the HEAD-at-stage-entry as the base; sharded builders use per-shard claim sets as a secondary filter. Doc-author/doc-syncer/test-writer paths are out of scope for this plan — they can be added later once their concurrency invariants are verified.

## Scope

### In Scope
- Add optional `agentId` to the `agent:result` schema variant.
- Add new `agent:activity` event schema variant with deterministic file/diffstat facts and explicit `attribution` quality.
- Register both changes in `event-registry.ts` (entries for `agent:activity`; `agent:result` entry already exists and needs no shape change).
- Update `extractResultData` callsites in `claude-sdk.ts` to include `agentId` in the emitted `agent:result` event (both success and error paths).
- Update Pi harness `agent:result` emission to include `agentId`.
- Extract `parseNameStatusZ` and `parseNumstatZ` to a shared helper module under `packages/engine/src/` (suggested filename `git-diff-stats.ts`) and export a `collectDiffStats({cwd, fromRef, toRef})` function.
- Wire the `implement` single-builder stage to compute and emit `agent:activity` (`attribution: 'exact'`) once the builder completes, using `ctx.preImplementCommit` -> `HEAD` as the range.
- Wire the sharded builder path to emit one `agent:activity` per shard, with the shard claim set used as a sanity filter and `attribution: 'exact'` when all listed files fall inside the shard, else `best_effort` with a note.
- Wire `reviewFixStageInner` to snapshot `HEAD` at entry and emit `agent:activity` once the fixer stops, with `attribution: 'exact'` when no unrelated background mutation occurred.
- Update `events-wire-parity.test.ts` to cover: `agent:result` with `agentId`, `agent:result` without `agentId` (backward compatibility), and at least one valid `agent:activity` payload.
- Update `events-schemas.test.ts` if necessary so the new event variant is asserted as part of the discriminated union.
- Regenerate `web/content/reference/events.md`, `web/public/llms-full.txt`, `web/public/schemas/events.schema.json`, and `web/public/reference/events.md` via `pnpm docs:generate` and commit the regenerated files.

### Out of Scope
- Any monitor UI changes — `AgentThread` fields, reducer handlers, and the agent-detail drawer all land in plan-02.
- Emitting `agent:activity` from doc-author, doc-syncer, test-writer, or evaluator paths. Future plans can add those once their concurrency invariants are verified.
- Any LLM-generated summary or new model call.
- Changing the existing plan-level `plan:build:files_changed` event behavior.

## Files

### Create
- `packages/engine/src/git-diff-stats.ts` — Shared NUL-delimited git diff parsers extracted from `prd-validator-diff.ts`. Exports `parseNameStatusZ`, `parseNumstatZ`, and a high-level `collectDiffStats({cwd, fromRef, toRef})` helper that returns `{ files: Array<{path; status; additions; deletions; binary}>, totals: {filesChanged; additions; deletions} }`. Returns empty totals (no throw) on git failure or no-changes.
- `test/git-diff-stats.test.ts` — Unit tests for `collectDiffStats`: empty range, simple add/modify/delete, rename, binary file (`-\t-`), file path with embedded tab. Uses fixture worktrees set up with `git init` + commits in the test (no mocks).

### Modify
- `packages/client/src/events.schemas.ts` — (1) Add `agentId: Type.Optional(Type.String())` to the `agent:result` `Type.Object` variant (around line 1093). (2) Add a new `agent:activity` variant under the `// Agent lifecycle` section with shape: `{ type: 'agent:activity', planId?: string, agentId: string, agent: AgentRoleSchema, files?: Array<{path: string; status?: string; additions?: number; deletions?: number; binary?: boolean}>, totals?: {filesChanged: number; additions: number; deletions: number}, attribution: 'exact'|'best_effort'|'unavailable', notes?: string[] }`. (3) Add `agent:activity` to the `isAlwaysYieldedAgentEvent` predicate.
- `packages/client/src/event-registry.ts` — Add an entry for `'agent:activity'` with `scope: 'session'`, `persist: false`, and a `summary` lambda (e.g. `(e) => Agent ${e.agent} activity (${e.totals?.filesChanged ?? 0} files, ${e.attribution})`). The `_Exhaustive` check at the bottom of the file will force this entry to exist.
- `packages/engine/src/harnesses/claude-sdk.ts` — At line 492 add `agentId` to the success-path `agent:result` emission. At line 497 add `agentId` to the error-path emission. Both sites have `agentId` already in scope from line 212.
- `packages/engine/src/harnesses/pi.ts` — At line 845, add `agentId` to the emitted `agent:result` event. `agentId` is already in scope.
- `packages/engine/src/prd-validator-diff.ts` — Replace the locally-defined `parseNameStatusZ` and `parseNumstatZ` with imports from `./git-diff-stats.ts`. No behavior change.
- `packages/engine/src/pipeline/git-helpers.ts` — Add a new exported helper `emitAgentActivity({cwd, baseRef, planId, agentId, agent, attribution, notes?})` that returns an `EforgeEvent` (the `agent:activity` shape) by calling `collectDiffStats` from `../git-diff-stats.ts`. Returns `undefined` (and the caller skips) when no changes are detected. This helper is a single source of truth so the build-stage wrappers stay simple.
- `packages/engine/src/pipeline/stages/build-stages.ts` — (1) In `implementStage` single-builder branch (around line 447-481), after the `withRetry` loop exits without failure, call `emitAgentActivity` with `baseRef = ctx.preImplementCommit ?? 'HEAD~1'`, `attribution: 'exact'`. The `agentId` and `agent` come from the most-recent agent thread known to the stage; the stage has access to the builder agent id via the runtime resolution (use the same id the harness emitted via `agent:start`). If the agent id is not retrievable in the stage, capture it from the `agent:start` event yielded by the inner runner and remember it for the activity emission. (2) In the sharded branch (line 482+), call `emitAgentActivity` once per completed shard with `baseRef = ctx.preImplementCommit`. Mark `attribution: 'exact'` when every changed file falls inside the shard's claim set (use `shardClaimsFile`); otherwise emit `attribution: 'best_effort'` with a note listing unclaimed files. (3) In `reviewFixStageInner` (line 230), snapshot `git rev-parse HEAD` at stage entry as `fixerBaseRef`, then emit `agent:activity` after the agent stops using `attribution: 'exact'`. Wrap all three emissions in `try { yield* emitAgentActivity(...) } catch { /* non-critical */ }` so a git failure cannot abort the stage.
- `packages/client/src/__tests__/events-wire-parity.test.ts` — (1) Update the existing `agent:result` valid payload to include `agentId` (around line 737). (2) Add a second `agent:result` valid payload variant WITHOUT `agentId` (backward compatibility). (3) Add a new valid payload for `agent:activity` exercising the full schema (files array, totals, attribution='exact', notes). (4) Add an invalid payload that omits the required `attribution` field on `agent:activity`.
- `packages/client/src/__tests__/events-schemas.test.ts` — Add an assertion that `agent:activity` is a recognized discriminant of `EforgeEventSchema` (mirror the existing pattern for `agent:result`).
- `web/content/reference/events.md` — Regenerated by `pnpm docs:generate`. Builder must run `pnpm docs:generate` after schema edits and commit the regenerated reference docs and JSON schema files so `pnpm docs:check` passes.
- `web/public/llms-full.txt`, `web/public/schemas/events.schema.json`, `web/public/reference/events.md` — Regenerated by `pnpm docs:generate`. Same as above.

## Verification

- [ ] `pnpm type-check` exits 0 across all workspaces.
- [ ] `vitest run packages/client/src/__tests__/events-wire-parity.test.ts` exits 0 and includes the two new `agent:result` cases (with and without `agentId`) plus the new `agent:activity` valid case.
- [ ] `vitest run packages/client/src/__tests__/events-schemas.test.ts` exits 0 and recognizes `agent:activity`.
- [ ] `vitest run test/git-diff-stats.test.ts` exits 0 with the new cases for empty range, modify, rename, binary, and tabbed-path files.
- [ ] `pnpm test` (full suite) exits 0 — `prd-validator-diff` tests still pass after the parser extraction.
- [ ] `pnpm docs:check` exits 0: the regenerated `web/content/reference/events.md` and `web/public/schemas/events.schema.json` include `agentId` on `agent:result` and a new `agent:activity` entry.
- [ ] grep `agentId` inside the `agent:result` emission lines in both harnesses returns a match: `grep -n "type: 'agent:result'" packages/engine/src/harnesses/claude-sdk.ts packages/engine/src/harnesses/pi.ts` followed by inspection shows each emission includes `agentId`.
- [ ] `safeParseEforgeEvent` accepts an `agent:result` event WITHOUT an `agentId` field (covered by the new wire-parity test).
- [ ] When a build runs end-to-end (manual smoke after merge is acceptable for verification, but unit-test coverage is the primary gate), `agent:activity` events appear for the `implement` stage with `attribution: 'exact'` and a non-empty `totals.filesChanged` when files were modified.