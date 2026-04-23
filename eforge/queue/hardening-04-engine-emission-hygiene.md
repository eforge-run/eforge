---
title: Hardening 04: Engine Emission Hygiene
created: 2026-04-22
---

# Hardening 04: Engine Emission Hygiene

## Problem / Motivation

The engine's contract is "engine emits events, consumers render." Three drift sites violate this or related invariants:

1. **`console.error` in the engine** (five calls):
   - `packages/engine/src/plan.ts:162,212` — malformed agent blocks go to stderr instead of an event
   - `packages/engine/src/config.ts:385,517,859` — config validation warnings go to stderr

   These bypass the event system, so subscribers (CLI renderer, monitor UI, CI integrations) miss structured diagnostics.

2. **Raw `git commit` calls bypassing `forgeCommit()`**. `AGENTS.md` requires every engine commit to go through `forgeCommit()` (which adds the `Co-Authored-By: forged-by-eforge` trailer). Confirmed offenders:
   - `packages/engine/src/worktree-ops.ts:156,173,292` — raw `exec('git', ['commit', ...])`
   - `packages/engine/src/pipeline.ts` near 2111-2114 — staging + commit outside the helper

   Commits from these paths won't carry the trailer, breaking attribution queries.

3. **Prompt template substitution doesn't enforce completeness**. `packages/engine/src/prompts.ts:70` leaves unmatched `{{varName}}` tokens in place rather than throwing. The planner prompt alone has 145 substitution sites; a missed variable silently ships a broken prompt to the model. User feedback ("Keep prompts closed") implies this should fail loudly.

## Goal

Eliminate engine emission violations by ensuring zero `console.*` calls in `packages/engine/src`, routing every engine commit through `forgeCommit()`, and making `loadPrompt()` throw on unresolved `{{vars}}`.

## Approach

### 1. Replace engine `console.error` with events

Add two event variants to the `EforgeEvent` union in `packages/engine/src/events.ts`:

```ts
| { type: 'config:warning'; message: string; source: string; details?: string }
| { type: 'plan:warning'; planId?: string; message: string; source: string; details?: string }
```

Update call sites:

- `packages/engine/src/plan.ts:162,212`: these run inside agent/orchestration contexts. Yield a `plan:warning` event via whichever event channel is in scope (most likely the async generator consumes a `yield` helper). If the surrounding function is pure and can't yield, return the warning alongside the parsed result and have the caller yield.
- `packages/engine/src/config.ts:385,517,859`: `loadConfig()` is typically called before any event stream exists. Change its signature to return `{ config, warnings: string[] }`. Callers that have an event stream yield `config:warning` events for each; the CLI early-startup path (where no stream exists yet) prints warnings to stderr *from the consumer*, not from the engine. The engine itself must not write.

Add matching handling in the CLI renderer (`packages/eforge/src/cli/index.ts`) and monitor reducer (`packages/monitor-ui/src/lib/reducer.ts`) to display the new event types.

### 2. forgeCommit() sweep

Review each of the raw commit sites:

- `packages/engine/src/worktree-ops.ts:156`: squash-merge commit. Change to `forgeCommit({ cwd, message: commitMessage })`.
- `packages/engine/src/worktree-ops.ts:173`: same.
- `packages/engine/src/worktree-ops.ts:292`: `git commit --no-edit` after a merge resolution. `forgeCommit()` needs to support a "re-use HEAD message" mode — either add an option `{ amend: false, reuseMessage: true }` or accept a pre-staged commit and let it use the existing message. Pick the minimum change that keeps the trailer attached.
- `packages/engine/src/pipeline.ts` (around 2111-2114 and any nearby spots): same treatment.

Widen `forgeCommit()` in `packages/engine/src/git.ts` only as necessary. Add a unit test that asserts every commit produced by `forgeCommit()` contains the trailer.

After the sweep, grep to confirm:

```
rg "exec\('git', \['commit'" packages/engine/src
```

should return zero hits outside `packages/engine/src/git.ts` itself.

### 3. Prompt variable enforcement

In `packages/engine/src/prompts.ts:70` (the `{{...}}` replace), after substitution, run a final regex:

```ts
const unresolved = [...output.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map(m => m[1]);
if (unresolved.length > 0) {
  throw new Error(
    `loadPrompt(${promptName}): unresolved template variables: ${[...new Set(unresolved)].join(', ')}`
  );
}
```

Run `pnpm test` and any end-to-end pipeline test to discover which current callers are relying on unresolved vars being silently preserved. Fix each caller to pass the required variables. If any caller intentionally emits `{{something}}` as literal text (unlikely but possible), escape it (e.g., `{{{ var }}}` style) rather than weakening the check.

Add a test: `loadPrompt('planner', { /* partial vars */ })` throws with the missing variable names listed.

## Scope

**Frontmatter:**
- title: "Hardening 04: engine emission hygiene (no stdout writes, forgeCommit sweep, prompt var enforcement)"
- scope: excursion
- depends_on: []

**Files touched (in scope):**
- `packages/engine/src/{events,plan,config,prompts,git,worktree-ops,pipeline}.ts`
- All callers of `loadConfig()`, `parseRawConfig()`, `findConfigFile()`, and `resolveActiveProfileName()` across `packages/engine/src`, `packages/eforge/src`, `packages/monitor/src`, and `packages/pi-eforge/extensions` — every call site must destructure the new `{ ..., warnings }` shape.
- `packages/eforge/src/cli/index.ts` (render new warning events; print early-startup warnings to stderr from the consumer side).
- `packages/monitor-ui/src/lib/reducer.ts` (handle new warning events; display is optional — can be console.log in UI is fine as long as events flow).
- **Tests (all that reference the changed signatures — do not miss any):**
  - `test/prompts.test.ts` or `test/prompt-resolution.test.ts` — loadPrompt strictness.
  - `test/git.test.ts` or a new `test/git-forge-commit.test.ts` — commit trailer assertion.
  - `test/plan.test.ts` or a new `test/plan-warnings.test.ts` — plan warning events.
  - `test/config.test.ts` — loadConfig return shape.
  - **`test/config-backend-profile.test.ts`** — MUST be updated. This file was missed in the previous attempt and caused 9 test failures. It contains:
    - 4 `const cfg = await loadConfig(projectDir)` call sites (around lines 361, 381, 402, 949) that must be rewritten to destructure `const { config: cfg } = await loadConfig(projectDir);`.
    - 8 `expect(result).toEqual({ name, source })` assertions on `resolveActiveProfileName` (around lines 515, 529, 539, 552, 788, 807, 823, 829, 839) that must include the new `warnings: [...]` key — empty array for the happy paths and the stale-marker warning string for the two stale-marker edge cases.

**Process guidance (learned from previous attempt):**
Before considering the builder done, run `rg -l "loadConfig\\(|resolveActiveProfileName\\(|parseRawConfig\\(|findConfigFile\\(" test/ packages/` and confirm every hit compiles against the new `{ ..., warnings }` shape.

**Out of scope:**
- Adding schema validation beyond what exists in `packages/engine/src/schemas.ts`.
- Structured logging infra (pino/winston) — this PRD is narrow: remove the violations, don't introduce a new logger.
- Retry policy (PRD 06).

## Acceptance Criteria

- Zero `console.*` calls in `packages/engine/src`.
- Every engine commit routes through `forgeCommit()`.
- `loadPrompt()` throws on unresolved `{{vars}}`.
- `pnpm test && pnpm build` pass.
- `rg "console\.(log|warn|error)" packages/engine/src` returns zero hits.
- `rg "exec\('git', \['commit'" packages/engine/src` returns zero hits outside `git.ts`.
- End-to-end: run a build with an intentionally malformed `eforge/config.yaml` field. Confirm the warning surfaces as an event in the monitor UI (or CLI renderer) rather than stderr spam.
- End-to-end: run a build and inspect `git log --oneline` on the merge commits — every engine-produced commit has the `forged-by-eforge` trailer.
- Unit test asserts every commit produced by `forgeCommit()` contains the trailer.
- Test: `loadPrompt('planner', { /* partial vars */ })` throws with the missing variable names listed.
- CLI renderer (`packages/eforge/src/cli/index.ts`) and monitor reducer (`packages/monitor-ui/src/lib/reducer.ts`) handle the new `config:warning` and `plan:warning` event types.
