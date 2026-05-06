---
id: plan-01-engine-owned-structural-fields
name: Engine-owned structural fields in orchestration.yaml
branch: engine-owns-structural-fields-in-orchestration-yaml-planner-can-no-longer-emit-placeholders-for-name-basebranch-mode-per-plan-branch/engine-owned-structural-fields
agents:
  builder:
    effort: high
    rationale: Coordinated changes across schema/writer/prompt/orchestrator/tests
      must land together to keep type-check and tests green in a single commit.
  reviewer:
    effort: high
    rationale: Reviewer must verify both halves of the fix (schema trim +
      initializeState throw) plus the prompt edit and test updates land
      coherently — partial application would be a silent regression risk.
---

# Engine-owned structural fields in orchestration.yaml

## Architecture Context

The planner LLM is currently asked to emit four values in `orchestration.yaml` that the engine has already determined before invoking the planner: the plan-set `name`, `baseBranch`, `mode`, and per-plan `branch`. When the LLM hallucinates placeholders (`name: test`, plan `id: a`, `branch: a`), `parseOrchestrationConfig` accepts them (only checks non-empty string), and the build phase then derives `featureBranch: eforge/test`, finds the branch missing, and aborts with a generic 'Feature branch not found' error 20 ms in. Ten minutes of compile work is wasted; the recovery analyzer can't see the YAML.

A second compounding bug masks the symptom: `Orchestrator.initializeState` (`packages/engine/src/orchestrator.ts:104-113`) silently falls through to fresh-state creation when `existing.setName !== config.name`, so config/state drift never surfaces with context.

This plan ships both fixes as one engine-internal change. The engine becomes the sole source of truth for the four structural fields (the planner stops being asked to copy values it never originated), and `initializeState` throws a descriptive error on setName mismatch matching the throw style at `orchestrator.ts:161-162`. `parseOrchestrationConfig` is intentionally left unchanged — once both halves (state file and YAML `name`) are engine-written, drift is only possible via manual edit, which the new throw catches.

No backward-compat shims (per AGENTS.md): the schema fields are removed cleanly. Existing on-disk `orchestration.yaml` files still parse because we still write/read the same root fields — only the planner's submission payload shape changes, and that payload is regenerated each compile.

## Implementation

### Overview

1. Trim `planSetSubmissionSchema`, `planSetSubmissionPlanSchema.frontmatter`, and `orchestrationPlanSchema` in `packages/engine/src/schemas.ts` to drop `name`/`mode`/`baseBranch`/`branch` where they duplicate engine-known values. The `superRefine` block (duplicate ids, dependency cycles, orchestration-vs-plan-id consistency) operates on `id` and `dependsOn` and is unaffected.
2. Extend `WritePlanSetOptions` with `baseBranch: string` and `mode: 'errand' | 'excursion' | 'expedition'`. In `writePlanSet`, derive `name`, `base_branch`, `mode`, plan-file frontmatter `branch`, and per-plan `branch` from engine-supplied parameters (`planSetName`, `baseBranch`, `mode`) instead of reading them from the agent payload. Plan `name` is still agent-authored (looked up from `payload.plans[].frontmatter.name` by id).
3. Update the `writePlanSet` call site in `packages/engine/src/agents/planner.ts` (~line 312) to pass `baseBranch` and `mode` from existing scope (`options.baseBranch` and the pipeline scope). No new fetches needed.
4. Replace the silent fall-through in `Orchestrator.initializeState` with a descriptive throw on `existing.setName !== config.name`. Match the throw style at `orchestrator.ts:161-162` (single sentence, names both setName values, points at `.eforge/state.json`, suggests a fix path).
5. Update `packages/engine/src/prompts/planner.md` to remove `name`/`base_branch`/`mode`/per-plan `branch` from the example YAML blocks, drop `branch` from the plan-file frontmatter example, and add one sentence: "The engine fills in `name`, `base_branch`, `mode`, and per-plan `branch`. Do not emit them." Keep id/name/dependsOn examples intact.
6. Update tests: rewrite the `'creates fresh state when setName differs'` test to assert the new throw, add submission-handler tests for engine-derived YAML values + schema rejection of removed fields, and update StubHarness planner submission fixtures to match the trimmed schema.

### Key Decisions

1. **One plan, not two.** The schema change without the writer/prompt/test updates would break compile. Splitting would create a known-broken intermediate state. Tests live alongside the code they verify (per AGENTS.md / planning rules — never split tests into a standalone plan).
2. **Leave `parseOrchestrationConfig` unchanged.** Once the engine writes both halves (state and YAML `name`), drift is only possible via manual edit. The new `initializeState` throw catches that case with full context. Adding redundant validation in the parser would be guard-railing against a path that can no longer happen via the supported flow.
3. **No backward-compat shims.** Per the project convention (`feedback_no_backward_compat`), the four fields are removed from the schema cleanly rather than marked deprecated/optional. The planner submission payload is regenerated each compile, so nothing on disk constrains the schema shape.
4. **Per-plan `branch` derivation matches existing convention.** The format `${planSetName}/${plan.id}` matches the documented convention in the current `prompts/planner.md` and what `Orchestrator`/`WorktreeManager` already treat as opaque branch strings. Changing the source from agent-authored to engine-derived is safe.
5. **Throw style mirrors line 161-162 of orchestrator.ts.** Single descriptive sentence naming both values and pointing at the remediation path. Keeps error voice consistent within the file.
6. **`writePlanSet` signature carries `baseBranch` and `mode` explicitly** rather than re-deriving them inside the function. The caller already has them in scope (the engine computed `baseBranch` at `eforge.ts:276-277`, and `mode` lives on the pipeline scope). Explicit parameters keep `writePlanSet` testable in isolation.

## Scope

### In Scope

- Trim `planSetSubmissionSchema` to drop root `name`, `mode`, and `baseBranch`.
- Trim `planSetSubmissionPlanSchema.frontmatter` to drop `branch`.
- Trim `orchestrationPlanSchema` to drop `name` and `branch`.
- Update the exported `PlanSetSubmission` type via `z.output` (it derives from the schema, so this is automatic).
- Add `baseBranch: string` and `mode: 'errand' | 'excursion' | 'expedition'` to `WritePlanSetOptions` in `packages/engine/src/plan.ts`.
- Make `writePlanSet` derive `name`, `base_branch`, `mode`, plan-file frontmatter `branch`, and per-plan orchestration `branch` from engine-supplied parameters; look up plan `name` from `payload.plans[].frontmatter.name` by id (still agent-authored).
- Update the `writePlanSet` call in `packages/engine/src/agents/planner.ts` to pass the new options.
- Replace silent fall-through in `Orchestrator.initializeState` (`packages/engine/src/orchestrator.ts:104-113`) with a descriptive throw on setName mismatch.
- Edit `packages/engine/src/prompts/planner.md` example YAML blocks (orchestration.yaml example ~lines 391-431 and plan-file frontmatter example ~lines 268-279) to remove the four fields and add one explanatory sentence.
- Update `test/orchestration-logic.test.ts` `'creates fresh state when setName differs'` test to assert the new throw.
- Add tests covering: (a) submit handler accepts payload without `name`/`baseBranch`/`mode`/`branch` and produces YAML with engine values; (b) schema rejects payloads that include the removed fields. Place in the most-relevant existing file from `test/planner-submission.test.ts`, `test/plan-writers.test.ts`, or `test/submission-schemas.test.ts`.
- Update `test/agent-wiring.test.ts` StubHarness planner submission fixtures to match the trimmed schema.
- Audit other test files that construct `PlanSetSubmission` payloads inline (`test/plan-parsing.test.ts`, `test/planner-submission.test.ts`, `test/plan-writers.test.ts`, `test/submission-schemas.test.ts`) and update them so they stop including the removed fields.

### Out of Scope

- Changes to `parseOrchestrationConfig` validation. Once the engine writes both halves, drift is only possible via manual edit, which the new `initializeState` throw catches.
- Recovery analyzer changes. The new throw message gives the existing analyzer enough signal.
- Cleanup of the original schaake-os incident artifacts (the bad `orchestration.yaml`). Separate cleanup task.
- Changes to `validatePlanSetName` (already runs at compile time; not affected).
- Hand-edits to `dist/prompts/planner.md` — regenerated by `pnpm build`.
- CHANGELOG.md edits (managed by the release flow per `feedback_changelog_managed_by_release`).
- Roadmap updates — `docs/roadmap.md` does not flag this work; the fix is reactive to a production incident.
- `packages/pi-eforge/` updates — verified during exploration that pi-eforge does not import `planSetSubmissionSchema`, `PlanSetSubmission`, or `writePlanSet`, so no parity update is needed.
- Plugin version bump in `eforge-plugin/.claude-plugin/plugin.json` — this change is engine-internal with no user-facing plugin behavior change.

## Files

### Create

- None. All changes extend or rewrite existing files.

### Modify

- `packages/engine/src/schemas.ts` (~lines 466-498) — drop `branch` from `planSetSubmissionPlanSchema.frontmatter`; drop `name` and `branch` from `orchestrationPlanSchema`; drop root `name`, `mode`, `baseBranch` from `planSetSubmissionSchema`. The `superRefine` block stays as-is (it operates on `id` and `dependsOn`). Verify `PlanSetSubmission` type via `z.output` reflects the trimmed shape.
- `packages/engine/src/plan.ts` (~lines 709-758) — extend `WritePlanSetOptions` with `baseBranch: string` and `mode: 'errand' | 'excursion' | 'expedition'`. In `writePlanSet`: set plan-file frontmatter `branch` to `${planSetName}/${plan.frontmatter.id}`; set orchestration root `name` to `planSetName`, `base_branch` to `options.baseBranch`, `mode` to `options.mode`; set each per-plan orchestration entry's `branch` to `${planSetName}/${p.id}`; look up plan `name` from `payload.plans[].frontmatter.name` by id.
- `packages/engine/src/agents/planner.ts` (~line 312, the `writePlanSet({ cwd, outputDir, planSetName, payload: planSetPayload })` call) — pass `baseBranch` and `mode` from existing scope. Builder must trace these to confirm exact accessor: `baseBranch` flows from the planner's `options` / `PlannerOptions` (added there if not already present — the engine has it at `eforge.ts:276-277` and passes it through ctx); `mode` comes from `options.scope` (which is `'errand' | 'excursion' | 'expedition' | undefined`). If `options.scope` is undefined (the catch-all branch where both submission tools are injected), pick a sensible default or thread the resolved scope through — confirm during implementation.
- `packages/engine/src/orchestrator.ts` (~lines 104-113) — replace the silent fall-through `if (existing && existing.setName === config.name) { ... }` block with an explicit `throw new Error(...)` when `existing && existing.setName !== config.name`. Message must name both setName values, point at `.eforge/state.json`, and suggest a remediation path. Match the single-sentence throw style at lines 161-162. The resume-on-match path (`isResumable(existing)`) and fresh-state creation path (no existing state) must remain unchanged.
- `packages/engine/src/prompts/planner.md` (~lines 268-279 plan frontmatter example, ~lines 391-431 orchestration.yaml example) — remove `branch:` from the plan frontmatter example block; remove `name:`, `base_branch:`, `mode:`, and per-plan `branch:` lines from the orchestration.yaml example block; add one sentence (placement: just before or after the orchestration.yaml example) reading: "The engine fills in `name`, `base_branch`, `mode`, and per-plan `branch`. Do not emit them." Keep all id/name/depends_on/build/review examples intact. Also update the `Important:` bullet at line 330 that says "`branch` is the git branch name for this plan's work" — remove it (the field is gone from the example).
- `test/orchestration-logic.test.ts` (~line 637) — rewrite `'creates fresh state when setName differs'` to assert `expect(() => initializeState(stateDir, config, '/tmp/repo')).toThrow(/setName .* does not match/)`. Verify the message names both `setName` values (`old-set` and `new-set`) and references `.eforge/state.json`. Rename the test (e.g., `'throws when persisted setName does not match config'`) to reflect the new behavior.
- `test/planner-submission.test.ts` and/or `test/plan-writers.test.ts` and/or `test/submission-schemas.test.ts` — add: (a) a test that submits a payload without `name`/`baseBranch`/`mode`/per-plan `branch` and asserts the resulting `orchestration.yaml` and plan files have the engine-derived values; (b) a test that schema-validates a payload that includes the removed fields and asserts validation fails. Place tests in the file most consistent with the existing layout — builder must inspect the existing groupings before deciding.
- `test/agent-wiring.test.ts` — update any `StubHarness` planner submission payloads to drop the removed fields. Verify all submission constructions still validate against the trimmed schema.
- `test/plan-parsing.test.ts` — audit for inline `PlanSetSubmission` constructions that include the removed fields and update them.
- Verify `test/fixtures/orchestration/valid.yaml` and similar YAML fixtures still parse via `parseOrchestrationConfig` (which is unchanged — still reads `name`, `base_branch`, `mode`, per-plan `branch` from disk). No fixture edits expected, but confirm on first test run.

## Verification

- [ ] `packages/engine/src/schemas.ts`: `planSetSubmissionSchema` shape (per `z.output`) has no root `name`, `mode`, or `baseBranch` properties; `planSetSubmissionPlanSchema.frontmatter` has no `branch` property; `orchestrationPlanSchema` has no `name` or `branch` properties.
- [ ] Constructing a payload that includes any of `name`/`mode`/`baseBranch` at root, or `branch` in plan frontmatter, or `name`/`branch` in an orchestration plan entry, fails Zod parse with a strict-object error (or is silently dropped only if the schema is intentionally non-strict — test asserts behavior either way).
- [ ] `writePlanSet` accepts `baseBranch: string` and `mode: 'errand' | 'excursion' | 'expedition'` in `WritePlanSetOptions`; calling it with a payload missing those fields and supplying the options produces an `orchestration.yaml` whose root `name` equals the supplied `planSetName`, `base_branch` equals `options.baseBranch`, and `mode` equals `options.mode`.
- [ ] Each plan markdown file written by `writePlanSet` has frontmatter `branch: <planSetName>/<plan.id>`; each entry under `plans:` in the generated `orchestration.yaml` has `branch: <planSetName>/<plan.id>`.
- [ ] The call to `writePlanSet` in `packages/engine/src/agents/planner.ts` passes `baseBranch` and `mode` sourced from existing scope; `pnpm type-check` reports zero errors.
- [ ] `Orchestrator.initializeState` throws when given an existing state whose `setName` does not equal `config.name`. The thrown `Error` message contains both setName values and the substring `.eforge/state.json`.
- [ ] When `existing.setName === config.name` and the state is resumable, `initializeState` returns `{ resumed: true }` (behavior unchanged).
- [ ] When no existing state is present, `initializeState` returns a fresh state with `setName === config.name` (behavior unchanged).
- [ ] `packages/engine/src/prompts/planner.md` orchestration.yaml example block contains no `name:` line at root, no `base_branch:` line, no `mode:` line, and no `branch:` line under any plan entry.
- [ ] `packages/engine/src/prompts/planner.md` plan-file frontmatter example block contains no `branch:` line.
- [ ] `packages/engine/src/prompts/planner.md` contains exactly one sentence near the orchestration.yaml example stating that the engine fills in `name`, `base_branch`, `mode`, and per-plan `branch` and that the agent must not emit them.
- [ ] `test/orchestration-logic.test.ts` no longer contains a test asserting that `initializeState` returns fresh state on setName mismatch; the replacement test asserts the throw and inspects the message.
- [ ] New test exists asserting that `writePlanSet` produces YAML with engine-derived `name`/`base_branch`/`mode`/per-plan `branch`; the test constructs a valid trimmed payload and inspects the written files.
- [ ] New test exists asserting Zod schema rejection of payloads that include any of the removed fields.
- [ ] `test/agent-wiring.test.ts` StubHarness planner submission constructions match the trimmed `PlanSetSubmission` shape; the file compiles and its tests pass.
- [ ] `pnpm type-check` exits 0.
- [ ] `pnpm test` exits 0.
- [ ] `pnpm build` exits 0.