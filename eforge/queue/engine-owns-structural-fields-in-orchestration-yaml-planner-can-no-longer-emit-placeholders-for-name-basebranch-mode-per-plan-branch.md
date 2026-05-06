---
title: Engine owns structural fields in orchestration.yaml; planner can no longer emit placeholders for name/baseBranch/mode/per-plan-branch
created: 2026-05-06
---

# Engine owns structural fields in orchestration.yaml; planner can no longer emit placeholders for name/baseBranch/mode/per-plan-branch

## Problem / Motivation

A schaake-os build failed in 20 ms because the planner LLM wrote literal placeholders (`name: test`, plan `id: a`, `branch: a`) into `orchestration.yaml` despite being given the correct values via the `{{planSetName}}` template variable. Compile had already created the right feature branch (`eforge/add-admin-sessions-page-...`) and persisted state with the right `setName`, but the build phase re-parsed the bad YAML, derived `featureBranch: eforge/test`, found the branch missing, and aborted. The recovery analyzer saw the symptom but couldn't see the YAML and recommended a blind retry that would have likely regenerated another broken file.

**Symptom**: cryptic "Feature branch not found" failures that mask the underlying placeholder hallucination. Ten minutes of compile work is wasted; the recovery analyzer can't see the YAML, so it recommends a blind retry that may regenerate another broken file.

**Who is affected**: anyone running an eforge build through the planner pipeline. The bug surfaces non-deterministically based on LLM output quality.

**Why it matters now**: this is the second class of "planner emits something that passes loose schema validation but breaks downstream" failures we've hit recently, and it consumes wall-clock time on every occurrence. The structural framing (the engine asks the agent to copy values it already knows) makes this preventable rather than just guardable.

### Codebase findings (from prior `/plan` exploration)

- `packages/engine/src/eforge.ts:251` — engine computes `planSetName` and validates it before invoking the planner.
- `packages/engine/src/eforge.ts:275-279` — engine creates `eforge/${planSetName}` feature branch.
- `packages/engine/src/agents/planner.ts:202` — engine passes `{{planSetName}}` to the planner prompt.
- `packages/engine/src/schemas.ts:466-498` — `planSetSubmissionSchema` requires the planner to emit `name`, `baseBranch`, `mode`, and per-plan `branch`. All four are values the engine already determined; the planner is being asked to copy them.
- `packages/engine/src/plan.ts:716-758` — `writePlanSet` already receives `planSetName` separately but writes `name: payload.name` instead of using it.
- `packages/engine/src/plan.ts:258-331` — `parseOrchestrationConfig` only validates `name` is a non-empty string; placeholders pass.
- `packages/engine/src/orchestrator.ts:104-113` — `initializeState` silently falls through when `existing.setName !== config.name` instead of throwing; line 133 then derives `featureBranch: eforge/${config.name}` from the bad YAML, masking the planner's output behind a generic "branch not found" failure.
- `packages/engine/src/prompts/planner.md:391-431` — the planner prompt instructs the agent to emit these four fields literally.

CLAUDE.md / AGENTS.md conventions to honor: no backward-compat shims, prompts stay closed (no model-specific content), tests use vitest with no mocks and inline-constructed inputs, agent prompts must not reference harness-specific tools. Roadmap (`docs/roadmap.md`) does not flag orchestration-schema work; this fix is reactive to a production incident.

### Root Cause

Two compounding causes. Both are confirmed by reading the code paths.

**Cause 1: the planner is asked to emit structural fields the engine already knows.**

`planSetSubmissionSchema` (`packages/engine/src/schemas.ts:466-498`) requires the planner LLM to submit:
- root `name` — duplicates `planSetName`, which the engine derived at `eforge.ts:251` and validated before invoking the planner.
- root `baseBranch` — already resolved at `eforge.ts:276-277`.
- root `mode` — already chosen by the pipeline composer (`ctx.pipeline.scope`).
- per-plan `branch` — purely formulaic (`${planSetName}/${plan.id}`), documented as the convention in `prompts/planner.md:409,422`.

`writePlanSet` (`plan.ts:716-758`) already takes `planSetName` as a parameter but writes `name: payload.name` (line 740) instead of using it. Asking an LLM to copy values it never originated is the root mechanism that produced `name: test`, plan `id: a`, `branch: a` in the failing build. `parseOrchestrationConfig` (`plan.ts:264`) only checks `name` is a non-empty string, so placeholders pass.

**Cause 2: `Orchestrator.initializeState` silently discards persisted state on setName mismatch.**

At `orchestrator.ts:104-113`:
```ts
if (existing && existing.setName === config.name) {
  if (isResumable(existing)) { ...resume... }
  // Non-resumable — fall through to fresh state creation
}
// Fresh state path runs unconditionally on mismatch
```
When `existing.setName !== config.name`, the if-block is skipped entirely. The fresh-state branch then derives `featureBranch: eforge/${config.name}` (line 133) from the bad YAML, masking the original error behind a generic "branch not found" failure at lines 161-162. The recovery analyzer sees only the symptom.

**Why this is one bug, not two**: cause 1 produces the bad YAML; cause 2 hides what happened. Fixing only cause 2 would surface clearer errors but not prevent the placeholder writes. Fixing only cause 1 would prevent placeholders via this path but leave drift between state and YAML (e.g., manual edits) silently masked. Both are in scope.

### Reproduction Steps

The original failure was a non-deterministic LLM hallucination, but the failure-mode the engine fix targets is reliably reproducible:

**Reproducing the masked-failure path** (initializeState silent fall-through):
1. Run a build that completes the compile phase and writes `eforge/plans/<setName>/orchestration.yaml`.
2. Hand-edit `orchestration.yaml` to change `name:` to any other string (e.g., `name: oops`).
3. Re-run the build phase against the same `.eforge/state.json`.
4. **Expected (after fix)**: `Orchestrator.initializeState` throws an error naming both setName values and pointing at `.eforge/state.json` with a remediation hint.
5. **Actual today**: silent fall-through; orchestrator derives `featureBranch: eforge/oops`; downstream throws generic `Feature branch 'eforge/oops' not found` with no context about why config and state diverged.

**Reproducing the placeholder-acceptance path** (schema is too lax):
1. Construct a `PlanSetSubmission` payload manually (or via StubHarness) with `name: 'test'`, plans `[{ frontmatter: { id: 'a', name: 'a', branch: 'a' }, body: '...' }]`, etc.
2. Submit through `submitPlanSet` / `writePlanSet`.
3. **Expected (after fix)**: schema rejects the payload because `name`/`baseBranch`/`mode`/per-plan `branch` are no longer accepted fields, OR the engine writes correct values regardless of what the agent attempts.
4. **Actual today**: payload validates; `orchestration.yaml` is written with the placeholder values; the next build phase fails 20 ms in.

The original schaake-os incident artifacts (the bad `orchestration.yaml`) are out of scope — separate cleanup, not part of this fix.

## Goal

Make the engine the sole source of truth for the structural fields in `orchestration.yaml` (`name`, `baseBranch`, `mode`, per-plan `branch`) so the planner LLM cannot inject placeholders, and surface a descriptive error when persisted state and config disagree on `setName` instead of silently falling through to a misleading "branch not found" failure.

## Approach

Two compounding fixes shipped together as one engine-internal change:

1. **Trim the planner submission schema** to remove the four structural fields the engine already knows, and have `writePlanSet` derive them from engine-supplied parameters. The planner remains responsible for the plan graph (id, dependsOn, body, build, review).
2. **Replace silent fall-through in `Orchestrator.initializeState`** with a descriptive throw on `existing.setName !== config.name`, matching the throw style at `orchestrator.ts:161-162`.

Update the planner prompt to stop instructing the agent to emit these fields and add one sentence explaining the engine fills them in. No backward-compat shims; rip out the old fields cleanly. Keep `parseOrchestrationConfig` unchanged — once both halves (state and YAML name) are engine-written, drift is only possible via manual edit, which the new throw catches.

### Code Impact

**Files to modify** (all under `packages/engine/`):

- `src/schemas.ts:466-498` — drop `name`, `mode`, `baseBranch` from `planSetSubmissionSchema` root; drop `branch` from `planSetSubmissionPlanSchema.frontmatter`; drop `name` and `branch` from `orchestrationPlanSchema`. The `superRefine` block (duplicate-id, dependency-cycle, orchestration-vs-plan-id consistency) is unaffected — it operates on `id` and `dependsOn`. Update `PlanSetSubmission` via `z.output`.

- `src/plan.ts:709-758` — extend `WritePlanSetOptions` with `baseBranch: string` and `mode: 'errand' | 'excursion' | 'expedition'`. In `writePlanSet`:
  - Plan-file frontmatter: `branch: \`${planSetName}/${plan.frontmatter.id}\``.
  - Orchestration root: `name: planSetName`, `base_branch: baseBranch`, `mode`.
  - Per-plan: `branch: \`${planSetName}/${p.id}\``; look up plan `name` from `payload.plans[].frontmatter.name` by id (still agent-authored).

- `src/agents/planner.ts` (call site of `writePlanSet`, ~line 312) — pass `baseBranch` and `mode` from existing scope (`options.baseBranch` / pipeline `ctx.scope`). No new fetches needed.

- `src/orchestrator.ts:104-113` — replace silent fall-through with a descriptive throw on `existing.setName !== config.name`. Match throw style of lines 161-162 (single sentence, names both values, suggests fix path).

- `src/prompts/planner.md` (~lines 268-279, 391-431) — remove `name`/`base_branch`/`mode`/per-plan `branch` from the example YAML blocks; add one sentence: "The engine fills in `name`, `base_branch`, `mode`, and per-plan `branch`. Do not emit them." Keep id/name/dependsOn examples intact.

**Test files**:
- `test/orchestration-logic.test.ts` (~line 637) — rewrite `'creates fresh state when setName differs'` to assert the new throw via `expect(() => initializeState(...)).toThrow(/setName .* does not match/)`. Verify message names both setName values.
- `test/plan-parsing.test.ts` (or wherever submit handler is tested) — add: payload without `name`/`baseBranch`/`mode`/`branch` produces YAML with engine-derived values; schema rejects payloads that include the removed fields.
- `test/agent-wiring.test.ts` — `StubHarness` submission payloads need updating to match the trimmed schema.

**Patterns to reuse** (do not reinvent):
- Throw style at `orchestrator.ts:161-162` (descriptive single sentence with remediation hint) — model the new throw on this.
- `forgeCommit` from `packages/engine/src/git.ts` for any engine-side commits during this work (per AGENTS.md convention).
- Existing `validatePlanSetName` (`plan.ts`) — already runs at compile time; we are not changing it.

### Risks

**Test fixture drift**: `test/fixtures/orchestration/valid.yaml` and similar files contain `name`, `base_branch`, `mode`, per-plan `branch`. They are read via `parseOrchestrationConfig` (which is unchanged — still reads these fields from the YAML, since the engine still writes them). No fixture changes expected, but verify on first test run.

**StubHarness payload drift**: `test/agent-wiring.test.ts` constructs a `PlanSetSubmission` for the planner stub. With the schema trimmed, those payloads will fail validation if they still include the removed fields. Update inline.

**Agent prompt clarity**: removing slots from the prompt is fine, but the prompt must still make clear that the planner is responsible for the **plan graph** (id, dependsOn, body, build, review) and only the trivially-derivable structural fields are removed. Add the one-sentence note explicitly so the agent doesn't "decide" to re-emit them anyway.

**Prompt drift between repos**: `dist/prompts/planner.md` (a built copy) was found alongside `packages/engine/src/prompts/planner.md` in earlier exploration. Confirm the build output regenerates the dist copy from src; do not hand-edit dist.

**Pi extension parity**: per AGENTS.md, `eforge-plugin/` and `packages/pi-eforge/` must stay in sync. This change is engine-internal — schema, write logic, prompt — so neither consumer-facing package should need updates. Confirm no pi-eforge code reads the planner submission schema directly. If it does, update both.

**No backward-compat concern**: nothing on disk is constrained by this change. Existing `orchestration.yaml` files still parse (we still write/read all the same root fields). The schema only governs the planner's submission payload, which is regenerated each compile.

**Subtle invariant**: the per-plan `branch` derivation `${planSetName}/${plan.id}` must match whatever `Orchestrator` and `WorktreeManager` expect for branch naming. Verified during exploration: orchestrator.ts and the worktree manager treat `config.plans[].branch` as opaque, so changing the source from agent-authored to engine-derived is safe as long as the format is consistent.

**Partial-application risk**: this change ships as one PR. If the schema change lands without the writePlanSet update, the agent's submission would fail validation but no YAML would be produced — a clean failure, not a silent regression. Acceptable. Order of edits within a single commit doesn't matter because tests gate the merge.

### Profile Signal

**Recommended profile: excursion.**

Multi-file but well-bounded change touching one schema, one write function, one call site, one orchestrator branch, one prompt, and 2-3 test files. No new subsystems, no architectural shifts, no cross-package coordination (engine-internal only). Too substantial for `errand` (which is for trivial single-file tweaks) and far below `expedition` thresholds (4+ independent subsystems, cross-cutting changes). The work has clear file targets and explicit acceptance criteria, both of which favor a single-plan execution path.

## Scope

### In scope

- Trim `planSetSubmissionSchema`, `planSetSubmissionPlanSchema.frontmatter`, and `orchestrationPlanSchema` in `packages/engine/src/schemas.ts` to remove `name`/`mode`/`baseBranch`/`branch` where they duplicate engine-known values.
- Update `WritePlanSetOptions` and `writePlanSet` in `packages/engine/src/plan.ts` to take and apply `baseBranch` and `mode`, and to derive per-plan and root `branch`/`name` from `planSetName`.
- Update the `writePlanSet` call site in `packages/engine/src/agents/planner.ts` to pass `baseBranch` and `mode` from existing scope.
- Replace the silent fall-through in `Orchestrator.initializeState` (`packages/engine/src/orchestrator.ts:104-113`) with a descriptive throw on `setName` mismatch.
- Update `packages/engine/src/prompts/planner.md` to remove the four fields from example YAML blocks and add a single explanatory sentence.
- Update tests: `test/orchestration-logic.test.ts`, `test/plan-parsing.test.ts` (or equivalent submit-handler test), `test/agent-wiring.test.ts` (StubHarness payloads).
- Confirm `pi-eforge` does not consume the planner submission schema directly; if it does, update it for parity per AGENTS.md.

### Out of scope

- Changes to `parseOrchestrationConfig` validation. Once the engine writes both halves, drift is only possible via manual edit, which the new `initializeState` throw catches.
- Recovery analyzer changes. The new throw message gives the existing analyzer enough signal.
- Cleanup of the original schaake-os incident artifacts (the bad `orchestration.yaml`). Separate cleanup task.
- Changes to `validatePlanSetName` (already runs at compile time; not affected).
- Hand-edits to `dist/prompts/planner.md` — this is regenerated by the build.
- CHANGELOG.md edits (managed by the release flow).
- Roadmap updates — `docs/roadmap.md` does not flag this work; the fix is reactive to a production incident.

## Acceptance Criteria

**Schema (`packages/engine/src/schemas.ts`)**:
- `planSetSubmissionSchema` no longer accepts `name`, `mode`, or `baseBranch` at the root.
- `planSetSubmissionPlanSchema.frontmatter` no longer accepts `branch`.
- `orchestrationPlanSchema` no longer accepts `name` or `branch`.
- `superRefine` checks (duplicate ids, dependency cycles, orchestration-vs-plan-id consistency) still pass on valid payloads.
- `PlanSetSubmission` type reflects the trimmed shape.

**Write logic (`packages/engine/src/plan.ts`)**:
- `WritePlanSetOptions` accepts `baseBranch: string` and `mode: 'errand' | 'excursion' | 'expedition'`.
- A generated `orchestration.yaml` has `name === planSetName`, `base_branch === options.baseBranch`, `mode === options.mode`, regardless of any value in the agent payload.
- Each plan file's frontmatter and the orchestration entry both have `branch === \`${planSetName}/${plan.id}\``.

**Caller update (`packages/engine/src/agents/planner.ts`)**:
- The call to `writePlanSet` passes `baseBranch` and `mode` from existing scope; no new derivations.

**Orchestrator (`packages/engine/src/orchestrator.ts`)**:
- `initializeState` throws when `existing.setName !== config.name`. Message names both setName values, points at `.eforge/state.json`, and suggests a fix path. Style matches lines 161-162.
- The resume-on-match path is unchanged for the equal case.

**Prompt (`packages/engine/src/prompts/planner.md`)**:
- The orchestration.yaml example no longer shows `name`, `base_branch`, `mode`, or per-plan `branch`.
- The plan-file frontmatter example no longer shows `branch`.
- One sentence explains that the engine fills these in.

**Tests**:
- New: submit handler accepts a payload without `name`/`baseBranch`/`mode`/`branch` and the resulting YAML uses engine values.
- New: schema rejects payloads that include the removed fields.
- New: `initializeState` throws with the expected message shape on setName mismatch.
- Updated: existing `'creates fresh state when setName differs'` test asserts the throw, not silent fall-through.
- Updated: `StubHarness` planner submission fixtures match the trimmed schema.
- All existing tests continue to pass.

**End-to-end**:
- A fresh build through the planner produces `orchestration.yaml` with engine-derived structural fields, regardless of what the LLM attempts.
- Hand-editing the generated `orchestration.yaml`'s `name` and re-running the build surfaces the new descriptive throw, not a generic "branch not found" error.

**Build gates**:
- `pnpm type-check` passes.
- `pnpm test` passes.
- `pnpm build` succeeds.
