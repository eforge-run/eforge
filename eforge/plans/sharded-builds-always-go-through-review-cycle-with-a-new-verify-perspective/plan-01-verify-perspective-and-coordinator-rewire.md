---
id: plan-01-verify-perspective-and-coordinator-rewire
name: Verify perspective + coordinator rewire to review-cycle
branch: sharded-builds-always-go-through-review-cycle-with-a-new-verify-perspective/main
---

# Verify perspective + coordinator rewire to review-cycle

## Architecture Context

Today the sharded build path has a structural asymmetry with the single-builder path. The single-builder agent self-verifies and the retry loop wraps the agent (`packages/engine/src/pipeline/stages/build-stages.ts` ~lines 486-503: `withRetry(builderPolicy, runBuilderAttempt)` with `maxAttempts = maxContinuations + 1`). When verification fails, another builder attempt runs with continuation context. The builder fixes its own mistakes.

In the sharded flow, individual shards are deliberately told NOT to verify (each shard only sees a slice). Verification is hoisted to a one-shot coordinator step at `build-stages.ts` ~lines 577-597 (`runVerificationCommands`). That step has **no agent loop wrapped around it**: first non-zero exit sets `ctx.buildFailed = true; return;` and the build dies with no fix path.

This plan moves verification out of the coordinator and into a new `verify` reviewer perspective so the existing iterative review-cycle handles verification failures the same way it handles every other class of issue. No special sharded path for downstream stages, no new agent role, no new "coordinator-builder". One new reviewer perspective + one runtime guard.

Key codebase facts confirmed during exploration:
- `review-cycle` is a registered build stage at `build-stages.ts` ~lines 648-672 that loops `reviewStageInner -> reviewFixStageInner -> evaluateStageInner` for `ctx.review.maxRounds` iterations, breaking when no actionable issues remain. It reads perspectives from `ctx.review.perspectives`.
- `parallel-reviewer.ts` exposes `PERSPECTIVE_PROMPTS` and `PERSPECTIVE_SCHEMA_YAML` maps (lines ~49-64) keyed by `ReviewPerspective`. Both maps must gain a `verify` entry.
- `ReviewPerspective` lives in `packages/engine/src/review-heuristics.ts` line 6 as `'code' | 'security' | 'api' | 'docs' | 'test'`. We add `'verify'`.
- `runVerificationCommands` is currently called from exactly one site (the sharded coordinator). Removing the call leaves the helper unreferenced; we delete the helper too unless something else picks it up before merge.
- `planRunner` in `packages/engine/src/eforge.ts` (lines ~540-589) constructs the `BuildStageContext` from `planEntry.build` and `planEntry.review`. This is the right place for the runtime guard.
- The plan body's `## Verification` section is parsed by a regex in `runVerificationCommands` (`/^##\s+Verification\s*\n([\s\S]*?)(?=\n##\s|$(?![\s\S]))/m`) and shell command tokens are extracted with `/`((?:pnpm|npm|npx|yarn)\s+[^`]+)`/g`. The new `reviewer-verify` perspective re-uses this extraction logic by lifting it from the helper into a shared utility, then drives the commands as a subprocess.
- `postMergeCommands` come from `ctx.config.build.postMergeCommands` and must run before verification commands so the worktree has installed state.

## Implementation

### Overview

Four coordinated changes:

1. Add a `verify` reviewer perspective (new prompt, new schema, wiring in `parallel-reviewer.ts`, union expansion in `review-heuristics.ts`).
2. Delete the coordinator verification step in `build-stages.ts` (lines ~577-597) and remove the `runVerificationCommands` helper at lines ~313-377 once unreferenced. Lift the verification-command extraction into a shared util the new perspective consumes.
3. Update prompts: `review-fixer.md` gets a cross-diff clause for verify-category issues; `planner.md` gets a hard rule that sharded plans must include `review-cycle`.
4. Runtime guard in `eforge.ts` planRunner: when the plan's resolved builder agent config has `shards`, inject `review-cycle` into `ctx.build` if missing and inject `verify` into `ctx.review.perspectives` if missing.

### Key Decisions

1. **Reuse the code-review issue schema for `verify`.** Verify-category issues use the same `<issue severity=... category=... file=... line=...>` shape as code review, with `<fix>` carrying the failing command, exit code, and full stdout/stderr. New schema getter `getVerifyReviewIssueSchemaYaml()` defined in `schemas.ts` that wraps the same Zod schema as code review (or shares it). Categories: `verification-failure` (single category covering all subprocess failures). Severity: always `critical` for failed commands.
2. **Lift the verification-command extraction into `packages/engine/src/verification.ts`** (or a similarly named module) so both the new reviewer-verify prompt machinery and any future caller share one parser. Old helper deleted.
3. **Do NOT add `verify` to `determineApplicableReviews()` heuristics.** `verify` is opt-in via the sharded-plan runtime guard (and via explicit planner inclusion). Diff-based reviewers run on every diff; `verify` runs subprocess commands and is too costly for non-sharded paths where the builder self-verifies.
4. **Runtime guard belongs in `eforge.ts` planRunner**, after `planEntry.build` and `planEntry.review` are read but before `buildCtx` is constructed. The guard inspects `planEntry.frontmatter.agents?.builder?.shards` (or equivalent resolved agent config). The mutation is local to the per-plan `BuildStageContext` initialization, not the shared orchestration config.
5. **Coordinator commit semantics unchanged.** The coordinator still does the safety-sweep `git add -A`, scope enforcement, and a single coordinator commit. Only the verification block is removed.
6. **No backward-compat shim for non-sharded plans.** Diff-based perspectives (code, security, api, docs, test) keep working unchanged. The single-builder path still self-verifies inside `runBuilderAttempt`.

## Scope

### In Scope

- New prompt `packages/engine/src/prompts/reviewer-verify.md` describing a perspective that runs the plan's verification commands plus `postMergeCommands` and emits one critical issue per failing command, with full stdout/stderr in `<fix>`.
- New verify-issue schema in `packages/engine/src/schemas.ts` (export a `getVerifyReviewIssueSchemaYaml()` and accompanying Zod schema; can share the code review issue shape with `category` constrained to a single `verification-failure` value).
- Wire `verify` into `PERSPECTIVE_PROMPTS` and `PERSPECTIVE_SCHEMA_YAML` in `parallel-reviewer.ts`.
- Expand `ReviewPerspective` union in `review-heuristics.ts` to include `'verify'`. Do NOT add it to `determineApplicableReviews()`.
- Delete the coordinator verification block at `build-stages.ts` ~lines 577-597 (the `runVerificationCommands` for-await loop and the `verificationFailed` terminal handler).
- Delete the `runVerificationCommands` helper at `build-stages.ts` ~lines 313-377 once unreferenced. Move its `## Verification` extraction logic to a new `packages/engine/src/verification.ts` (or extend an existing util module) so it can be invoked from prompt context generation for the new perspective.
- Add a cross-diff clause to `packages/engine/src/prompts/review-fixer.md` instructing the fixer that `verify`-category issues may require editing files outside the original diff and that the fixer should follow the path named in the issue's `<fix>` element.
- Update `packages/engine/src/prompts/planner.md` with a hard rule under the sharding section: when a plan's `agents.builder.shards` is set, the build pipeline MUST include `review-cycle`, and the runtime will inject the `verify` perspective. Include one sentence of rationale.
- Runtime guard in `packages/engine/src/eforge.ts` planRunner (~lines 540-589): when the resolved builder agent config has shards, ensure `planBuild` contains `review-cycle` (inject if missing) and `planReview.perspectives` contains `verify` (inject if missing). Belt-and-suspenders against missed planner-prompt updates.
- Tests:
  - `test/reviewer-verify.test.ts` — unit-test the perspective wiring: prompt rendering with verification commands, schema YAML included, StubHarness-driven path that returns a failure issue and confirms the issue carries the failing command/exit code/stderr.
  - Extend `test/agent-wiring.test.ts` with a case asserting `parallel-reviewer.ts` registers `verify` in both maps and accepts it as a valid override perspective.
  - New `test/sharded-build-via-review-cycle.test.ts` — end-to-end stub-harness scenario covering the acceptance criteria: 2-shard plan in temp git repo, shards stage benign changes that break a tripwire test post-merge, StubHarness configured so the verify reviewer emits a critical issue on a file outside the original diff, the review-fixer edits that file, the evaluator accepts, and round 2 finds no issues. Assert: coordinator commits without running verification, review-cycle round 1 surfaces the verify failure, fixer repairs, round 2 verify passes, plan ends in `merged` status.
  - Asserts on the runtime guard: a sharded plan whose `build` array omits `review-cycle` gets it injected; whose `review.perspectives` omits `verify` gets it injected.

### Out of Scope

- Per-shard builder behavior: shards still don't self-verify.
- Scope enforcement in the coordinator: still runs unchanged.
- The global post-merge `phases.validate` phase: stays as the build-level gate.
- Recovery behavior on `maxRounds` exhaustion: existing failure path unchanged.
- Adding `verify` to the auto-applicable perspective set for non-sharded plans.
- Changing the single-builder path or its retry/continuation plumbing.

## Files

### Create

- `packages/engine/src/prompts/reviewer-verify.md` — new prompt for the verify perspective. Follow the structure of `reviewer-code.md`: Role, Context (`{{plan_content}}`, `{{base_branch}}`), Scope (run verification commands rather than diffing), Issue Triage (only command failures count; do not analyze code), Severity Mapping (failures are always `critical`), Fix Instructions (do NOT stage or commit; describe the fix in the `<fix>` element with the failing command, exit code, and full stdout/stderr), Review Issue Schema (`{{review_issue_schema}}`), Output Format (`<review-issues>` with `<issue category="verification-failure">` entries), Constraints. The prompt explicitly tells the agent to run only the verification commands extracted from the plan body's `## Verification` section plus the project's `postMergeCommands`, and to emit one issue per failing command with the full output in `<fix>`. State that this perspective intentionally runs subprocess commands while other perspectives only read diffs.
- `packages/engine/src/verification.ts` — extracted helper module exporting `extractVerificationCommands(planBody: string, postMergeCommands: string[], scope: 'build-only' | 'full'): string[]`. Replaces the inline logic previously in the deleted `runVerificationCommands` helper. Used by the build pipeline if any caller still needs it and by the verify-perspective prompt context generation.
- `test/reviewer-verify.test.ts` — unit tests for the verify perspective wiring (prompt loads, schema YAML inserted, StubHarness path returns parsed issues with the expected category and `<fix>` content).
- `test/sharded-build-via-review-cycle.test.ts` — end-to-end sharded scenario per acceptance criteria.

### Modify

- `packages/engine/src/pipeline/stages/build-stages.ts` — delete the coordinator verification block (~lines 577-597: the `runVerificationCommands` for-await loop and the `verificationFailed` terminal handler). Delete the `runVerificationCommands` helper at ~lines 313-377 once it has no remaining callers (verify by grep before deletion). Imports of any helpers that move to `verification.ts` updated accordingly.
- `packages/engine/src/agents/parallel-reviewer.ts` — add `verify: 'reviewer-verify'` to `PERSPECTIVE_PROMPTS` (~lines 49-55) and `verify: getVerifyReviewIssueSchemaYaml` to `PERSPECTIVE_SCHEMA_YAML` (~lines 58-64). Update the imports at the top to include `getVerifyReviewIssueSchemaYaml`.
- `packages/engine/src/review-heuristics.ts` — extend the `ReviewPerspective` union (line 6) to include `'verify'`. Do NOT modify `determineApplicableReviews()` to emit `'verify'` automatically.
- `packages/engine/src/schemas.ts` — add `verifyReviewIssueSchema` (Zod) and `getVerifyReviewIssueSchemaYaml()` exported helper. Schema mirrors the code-review issue shape (`severity`, `category`, `file`, `line`, `description`, `fix`) but constrains `category` to `'verification-failure'` and `severity` to `'critical'`. Confirm location by searching for existing `getCodeReviewIssueSchemaYaml` neighbors.
- `packages/engine/src/prompts/review-fixer.md` — append a short clause stating that for `verify`-category issues, the fix may require editing files outside the original diff (verification failures often reveal coupling between changed code and unchanged tests/config/docs); the fixer should edit whatever the issue's `<fix>` element identifies. Keep existing rules (no `git add`, no `git commit`, minimal fix) intact.
- `packages/engine/src/prompts/planner.md` — under the sharding section (~lines 85-108, near the example frontmatter), add a hard rule: "When you set an `agents.builder.shards` block, the plan's build pipeline MUST include `review-cycle`. Shards do not self-verify, so the review-cycle's `verify` perspective is the integration gate; the engine will refuse to run a sharded plan without it." Include one sentence of rationale.
- `packages/engine/src/eforge.ts` — add the runtime guard in the `planRunner` closure (~lines 554-589) immediately after `planEntry.build` and `planEntry.review` are read and before `buildCtx` is constructed. Pseudocode:
  ```ts
  const builderShards = planFile.frontmatter?.agents?.builder?.shards;
  if (builderShards && builderShards.length > 0) {
    if (!planBuild.flat().includes('review-cycle')) {
      planBuild = [...planBuild, 'review-cycle'];
    }
    if (!planReview.perspectives.includes('verify')) {
      planReview = { ...planReview, perspectives: [...planReview.perspectives, 'verify'] };
    }
  }
  ```
  Adjust to use the actual frontmatter accessor pattern observed in nearby code (or fall back to `resolveAgentConfig('builder', config, planFile).shards`). Add a debug log or trace event when the guard injects either field so it's visible in the monitor UI.
- `test/agent-wiring.test.ts` — add a case verifying that `parallel-reviewer` accepts `verify` as an override perspective and dispatches to the `reviewer-verify` prompt with the verify schema.

## Verification

- [ ] `pnpm type-check` passes with zero errors.
- [ ] `pnpm test` passes; the new `test/reviewer-verify.test.ts`, `test/sharded-build-via-review-cycle.test.ts`, and the extended `test/agent-wiring.test.ts` cases all run green.
- [ ] `pnpm build` produces bundles for all workspace packages with no errors.
- [ ] Grep confirms `runVerificationCommands` has zero references in `packages/engine/` after deletion.
- [ ] Grep confirms exactly six entries in `PERSPECTIVE_PROMPTS` and `PERSPECTIVE_SCHEMA_YAML` (`code`, `security`, `api`, `docs`, `test`, `verify`).
- [ ] `ReviewPerspective` union in `review-heuristics.ts` line 6 contains `'verify'` as the sixth member.
- [ ] `prompts/reviewer-verify.md` exists and includes the `{{plan_content}}`, `{{base_branch}}`, and `{{review_issue_schema}}` template variables.
- [ ] `prompts/review-fixer.md` contains the new clause referencing `verify`-category issues and cross-diff edits.
- [ ] `prompts/planner.md` contains the sharding rule that requires `review-cycle` and mentions the `verify` perspective.
- [ ] In `eforge.ts` planRunner, the runtime guard runs before `buildCtx` construction; a unit test sets up a sharded plan whose orchestration entry omits `review-cycle` and asserts the resulting `buildCtx.build` contains `'review-cycle'`.
- [ ] In the same unit test, a sharded plan whose `review.perspectives` omits `'verify'` results in `buildCtx.review.perspectives` containing `'verify'`.
- [ ] End-to-end sharded scenario test: coordinator commits without invoking `runVerificationCommands` (the helper no longer exists; assert the coordinator phase emits `plan:build:implement:complete` directly after the commit). Review-cycle round 1 surfaces a critical verify-category issue with the failing test path in `<fix>`. Review-fixer applies an edit to that file (which is outside the original shard diffs). Evaluator accepts. Round 2 verify passes (no issues). Plan ends in `merged` status.
- [ ] Existing `test/sharded-builder.test.ts` and `test/sharded-implement-stage.test.ts` continue to pass without modification.
- [ ] Non-sharded single-builder tests in `test/agent-wiring.test.ts` continue to pass without modification, confirming no regression in the diff-based review path.
