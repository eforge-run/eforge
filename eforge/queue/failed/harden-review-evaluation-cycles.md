---
title: Harden Review/Evaluation Cycles
created: 2026-05-15
depends_on: ["extend-09-usage-aware-profile-router"]
profile: pi-codex-5-5
---

# Harden Review/Evaluation Cycles

## Problem / Motivation

Evaluator verdicts are currently not engine-enforced, evaluator commits can bypass commit conventions, and review-cycle reporting can be misleading.

This is an **architecture / focused** change with high confidence: the main work is changing ownership and data flow in the engine's review/evaluation pipeline, not adding a new user-facing command. It also fixes observable incorrect/misleading behavior.

### Evidence gathered

- Roadmap alignment: `docs/roadmap.md` has an Orchestrator Intelligence goal to make review-cycle decisions adaptive and observable. This work aligns with the observability/safety side of that goal, though it is not the same as adaptive reviewer subset selection.
- Build review/evaluate control flow lives primarily in `packages/engine/src/pipeline/stages/build-stages.ts`:
  - `evaluateStageInner()` only runs when `hasUnstagedChanges()` is true, emits evaluator strictness, invokes `builderEvaluate()`, and swallows evaluator failures as non-fatal.
  - `reviewCycleStage()` runs `review -> review-fix -> evaluate` for each configured round and then emits max-round termination using `ctx.reviewIssues.length`, which is still the last review issue list after the final evaluator pass.
  - `testCycleStage()` also invokes `evaluateStageInner()` using `ctx.review.maxRounds`, so a plan may evaluate during both test and review cycles.
- Evaluation agent behavior is in `packages/engine/src/agents/builder.ts` and prompt `packages/engine/src/prompts/evaluator.md`:
  - `builderEvaluate()` prompts an agent with generic coding tools (`tools: 'coding'`) and then parses XML verdicts with `parseEvaluationBlock()`.
  - The prompt instructs the evaluator agent itself to run `git reset --soft`, `git add`, `git checkout --`, and final `git commit`.
  - `builderEvaluate()` derives accepted/rejected counts from parsed XML only; it does not apply verdicts or validate that git state matches them.
- Compile/planning evaluation has the same pattern in `packages/engine/src/agents/plan-evaluator.ts` and shared `runReviewCycle()` in `packages/engine/src/pipeline/runners.ts`.
- Project convention in `AGENTS.md` says engine commits should use `forgeCommit()` and build-session commits should include `Models-Used:` via `composeCommitMessage()` when agents were invoked. Direct evaluator-agent commits bypass this convention.
- Current running build provided concrete evidence without disruption:
  - Plan 01 committed and merged successfully; accepted evaluator fixes did land in that build.
  - Event history showed evaluator tool calls included direct `edit` calls on source/test files plus raw `git add`, `git checkout --`, and `git commit` commands.
  - Event history also showed `cycle-terminated` reported `issuesRemaining: 7` immediately after the final evaluator pass, confirming stale last-review issue reporting.
- Existing tests cover parser/wiring and continuation behavior (`test/agent-wiring.test.ts`, `test/evaluator-continuation.test.ts`, `test/retry.test.ts`) but searches did not reveal tests that enforce evaluator verdicts against git state or prevent evaluator direct edits.

### Current architecture

- Reviewer/fixer agents leave proposed fixes as unstaged working-tree changes.
- Evaluator agents currently own both judgment and mutation:
  - The evaluator prompt instructs the agent to run `git reset --soft`, inspect diffs, `git add` accepted files, `git checkout --` rejected files, and `git commit`.
  - `builderEvaluate()` / plan-phase `runEvaluate()` parse the final XML verdict block and emit accepted/rejected counts, but do not enforce those verdicts.
- Build-stage `evaluateStageInner()` decides whether to run evaluation based only on `hasUnstagedChanges()` and treats evaluator failure as non-fatal.
- `reviewCycleStage()` persists last review issues in `ctx.reviewIssues` through final evaluation, causing stale `issuesRemaining` reporting when max rounds are exhausted.

### Early assumptions / unknowns

- The preferred architecture is likely to make the evaluator read-only for judgment and let engine code apply/commit verdicts, but exact hunk-level application semantics need design.
- Plan-phase evaluators likely need the same hardening as build-phase evaluator because they share the same agent-commits/apply-by-prompt pattern.
- Some current non-fatal evaluator behavior may be intentional to keep builds moving; changing failures to hard failures may need a migration/strictness decision.

## Goal

Harden review/evaluation cycles so evaluator verdicts are engine-enforced, committed consistently, and reported accurately.

The desired outcome is that evaluator agents produce structured judgments only, while engine code applies accepted/rejected/review decisions, commits through shared helpers, detects invariant violations, and reports review-cycle state without stale or misleading issue counts.

## Approach

### Target architecture

Split evaluation into three explicit responsibilities:

1. **Engine setup**: prepare staged implementation/original artifacts vs unstaged reviewer/fixer patch, and capture a bounded evaluation context.
2. **Evaluator judgment**: evaluator agent inspects context and submits structured verdicts only.
3. **Engine application**: engine applies verdicts to git state and commits via shared commit helpers.

Introduce reusable evaluation-application helpers so build-phase and compile-phase evaluators share one implementation where possible.

- Candidate module: `packages/engine/src/evaluation/apply.ts` or `packages/engine/src/pipeline/evaluation.ts`.
- Responsibilities: reset/setup, diff snapshot, verdict validation, apply accept/reject/review, cleanup, commit, and invariant checks.

Use custom evaluator tools or a structured submission contract similar to `plan-reviewer` submission tools:

- provide read-only diff/file-inspection helpers if needed,
- capture one verdict submission,
- disallow generic mutation tools for evaluator roles where feasible.

Update event schemas if new observability fields/events are needed. Event schema changes must happen in `packages/client/src/events.schemas.ts`, then engine imports types from the client package.

Keep commit discipline centralized through `forgeCommit()` and `composeCommitMessage()` so evaluator-accepted fixes get `Co-Authored-By` and `Models-Used` trailers.

### Affected boundaries

- **Agent/engine boundary**: evaluator changes from mutating actor to structured decision maker.
- **Git-state boundary**: engine becomes the only component that applies and commits evaluator results.
- **Wire/event boundary**: evaluation completion and review-cycle termination may need richer metadata, but event shapes must remain client-owned.
- **Compile/build parity**: build evaluator and plan/cohesion/architecture evaluators should converge on common helpers to avoid two subtly different enforcement models.

### Design decisions

1. **Engine applies verdicts; evaluator only judges.**
   - Decision: remove evaluator responsibility for `git add`, `git checkout --`, and `git commit` from build and plan-phase evaluator prompts.
   - Rationale: the engine can deterministically enforce verdicts and commit conventions; agent self-commit is unverified and bypasses `Models-Used` trailers.
   - Trade-off: engine code must implement patch/hunk application logic rather than outsourcing it to an agent.

2. **Use a structured evaluator submission contract.**
   - Decision: add evaluator submission custom tools, analogous to existing plan-reviewer submission tools, for build evaluator and plan/cohesion/architecture evaluators.
   - Rationale: custom tools give the engine a validated payload and avoid relying solely on XML parsing from final text.
   - Fallback: keep XML parsing temporarily for backward compatibility/tests if needed, but engine enforcement should prefer captured structured submissions.

3. **Constrain evaluator tools to read-only/diff-oriented access.**
   - Decision: run evaluator with non-mutating tools where possible and inject custom read-only helpers such as `list_evaluation_files`, `get_evaluation_diff`, and `submit_evaluation_verdicts` if prompt-only context is too large.
   - Evidence: Pi harness uses read-only tools when `tools: 'none'`, and both Pi/Claude support custom tools; existing agents already use submission tools with write/edit disallowed.
   - Assumption: Claude SDK and Pi can expose custom evaluator tools while keeping generic mutation tools unavailable or disallowed; verify with harness tests.

4. **Snapshot reviewer/fixer diff before evaluator execution.**
   - Decision: after `git reset --soft <resetTarget>`, capture the unstaged diff as the canonical candidate patch. The engine applies only hunks/files from this snapshot.
   - Rationale: prevents evaluator-introduced edits from sneaking into the final commit and makes accepted/rejected verdicts auditable.
   - Invariant: if the working-tree patch changes during evaluator execution, fail or discard and report a mutation violation rather than silently committing.

5. **Support hunk-level verdicts, not just file-level verdicts.**
   - Decision: preserve current schema semantics where a verdict can include `hunk`. File-level verdicts apply all hunks in a file; hunk-level verdicts apply selected hunks only.
   - Proposed mechanism: split the captured unified diff into per-file/per-hunk patches; for accepted hunks, apply selected patch hunks to the index with `git apply --cached`; then discard the full working-tree patch with `git checkout -- <file>` after applying accepted hunks. For full-file accept, `git add <file>` is acceptable. For full-file reject/review, `git checkout -- <file>`.
   - Edge cases: binary files and rename-only patches should require file-level verdicts or be rejected with a clear diagnostic if hunk selection is not representable.

6. **Commit through shared engine helpers.**
   - Decision: final evaluation commit is created by engine code with `forgeCommit(ctx.worktreePath, composeCommitMessage(..., ctx.modelTracker))` for build phase and equivalent model-aware commit context for compile phase.
   - Rationale: satisfies project convention and centralizes commit trailer behavior.

7. **Treat enforcement failures as observable failures, not silent non-fatal skips.**
   - Decision: distinguish reviewer/evaluator agent failures from engine invariant failures. Agent judgment failures may remain non-fatal by policy, but once verdicts are submitted, application/commit invariant failures should emit `plan:build:failed` or at least a strongly typed warning and prevent misleading success.
   - Rationale: silent divergence is the failure mode being fixed.

8. **Fix review-cycle termination semantics.**
   - Decision: after an evaluation pass, clear or separately track `ctx.reviewIssues` so max-round termination does not claim stale unresolved issues as post-evaluation facts.
   - Preferred wording/event data: distinguish `lastReviewIssueCount`, `finalEvaluationAccepted`, `finalEvaluationRejected`, and `reason: max-rounds`; if the schema remains unchanged, set `issuesRemaining` only when no final evaluator ran or rephrase rationale to say "last review produced N issues before final evaluation".

9. **Do not implement adaptive reviewer subset selection in this change.**
   - Decision: leave `perspectives-respawned` selection behavior unchanged except for clearer observability.
   - Rationale: roadmap item is related but separable; adding it would broaden scope and risk.

### Assumptions and validation

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| Build evaluator currently relies on the agent to apply and commit verdicts. | Read `packages/engine/src/agents/builder.ts` and `packages/engine/src/prompts/evaluator.md`; `builderEvaluate()` parses XML counts only while prompt instructs git mutation/commit. Current run event history showed evaluator `git add`, `git checkout --`, and `git commit`. | high | low | Add tests around `builderEvaluate()` and `evaluateStageInner()` with a stub harness and temp git repo. | High: core motivation would be wrong, but evidence is direct. |
| Plan/cohesion/architecture evaluators share the same risk pattern. | Read `packages/engine/src/agents/plan-evaluator.ts`; `runEvaluate()` runs coding tools and parses verdict counts after prompt-driven application/commit. Shared `runReviewCycle()` only delegates. | high | low | Add plan-phase temp repo tests mirroring build evaluator tests. | Medium/high: if omitted, compile review remains brittle and inconsistent. |
| Engine can apply hunk-level decisions using captured unified diffs and `git apply --cached`. | Reasoned from git index/worktree model after `git reset --soft`; not yet implemented in this repo. | medium | medium | Prototype a helper in tests with a temp repo: stage base changes, create unstaged fixes, split `git diff` hunks, apply selected hunks to index, discard worktree, assert final commit. | High: if difficult, scope may need fallback to file-level only or a safer custom apply strategy. |
| Harnesses can expose structured custom tools while keeping evaluator mutation tools unavailable. | Read `harness.ts`, `harnesses/pi.ts`, and existing custom-tool agents (`plan-reviewer.ts`). Pi uses read-only tools when `tools: 'none'` and still collects custom tools. Claude SDK references custom tools and disallowed tools. | medium | low | Add stub harness tests and, if needed, harness-specific tests asserting evaluator receives submission tools without Write/Edit/Bash mutation tools. | Medium: if custom tools require coding mode with mutation tools, invariant checks become more important. |
| Making deterministic application failures visible will not break desired “review is non-fatal” behavior. | Existing code swallows evaluator exceptions in `evaluateStageInner()` and `runReviewCycle()`, suggesting non-fatal agent failure is intentional. This plan distinguishes agent failure from engine invariant failure, but exact failure policy is a design choice. | medium | low | Review existing retry tests and add cases for missing verdicts vs invalid verdicts; decide whether invalid verdict application sets `ctx.buildFailed` or emits warning. | Medium/high: too-strict failure could stop builds that previously succeeded; too-lenient preserves silent divergence. |
| Review-cycle `issuesRemaining` is stale after final evaluation. | Read `reviewCycleStage()` and observed current run event `cycle-terminated` with `issuesRemaining: 7` immediately after final evaluator pass. `ctx.reviewIssues` is not updated by evaluation. | high | low | Add a focused review-cycle unit/integration test asserting corrected event semantics. | Medium: misleading status remains if not fixed. |
| Updating event payloads may require client schema changes. | Read `events.ts` re-export and `packages/client/src/events.schemas.ts`; client is wire-protocol source of truth. | high | low | If new event fields/kinds are added, update schema and run type-check/schema tests. | Medium: inline event shapes would violate project conventions and can break daemon/UI consumers. |

No low-confidence/high-impact assumptions remain unresolved. The most important medium-confidence item is hunk-level patch application; it is testable cheaply with a temp git repo before broad refactoring.

### Profile signal

Recommended profile: **Excursion**.

Rationale: this is cross-cutting across build evaluator, plan-phase evaluator, prompts, git helpers, event schemas, and tests, but it is one cohesive engine refactor with a clear sequence and shared helper design. A single planner can specify the modules and dependencies without needing delegated module planning. It is broader than an Errand because it changes the agent/engine trust boundary and requires regression tests around git state, but it does not require Expedition-scale architecture decomposition.

## Scope

### In scope

- Harden the **build-phase evaluator** path so evaluator verdicts are engine-enforced rather than relying on the evaluator agent to mutate git state correctly.
  - Primary files: `packages/engine/src/agents/builder.ts`, `packages/engine/src/pipeline/stages/build-stages.ts`, evaluator prompt(s), and tests.
  - Current evidence: `builderEvaluate()` only parses XML and emits counts; `evaluateStageInner()` delegates all git mutation to the evaluator agent.
- Harden the **compile/planning evaluator** path where practical because it shares the same pattern.
  - Primary files: `packages/engine/src/agents/plan-evaluator.ts`, `packages/engine/src/pipeline/runners.ts`, `packages/engine/src/prompts/plan-evaluator.md`, and tests.
  - Current evidence: `runEvaluate()` for plan/cohesion/architecture evaluators also runs coding tools and parses XML counts after the agent is responsible for applying git changes.
- Change evaluation flow so the evaluator is an analysis/verdict producer, while engine code performs:
  - setup of staged-vs-unstaged comparison,
  - capture of reviewer/fixer diffs,
  - application of accept/reject/review decisions,
  - cleanup of rejected leftovers,
  - final commit through `forgeCommit(composeCommitMessage(...))`.
- Add invariant checks and tests that prove evaluator output and git state cannot silently diverge.
- Improve review-cycle observability/reporting so a second review round is clearly intentional and max-round termination does not report stale `ctx.reviewIssues` as post-evaluation truth.
- Preserve current high-level pipeline behavior: `review-cycle` may still run multiple rounds according to `maxRounds`; `test-cycle` may still trigger evaluate when tester leaves production fixes.

### Out of scope

- Adaptive reviewer subset selection from the roadmap. This work can improve round observability but should not implement perspective-dropping logic.
- UI redesign beyond event/message/schema changes needed to avoid misleading status.
- Changing reviewer or review-fixer quality criteria except where prompts must clarify evaluator/verdict boundaries.
- Disrupting or repairing the currently running build.
- Broad conversion of every agent commit in the system; target evaluator paths only.

### Classification

Architecture / focused, high confidence. The change modifies the trust boundary and data flow between evaluator agents and engine git state. It is also a bugfix for misleading cycle reporting and missing enforcement.

## Acceptance Criteria

1. **Engine-enforced build evaluation**
   - Given a build-phase reviewer/fixer leaves unstaged changes, evaluator verdicts are submitted as structured data and the engine, not the evaluator agent, applies accepted/rejected/review decisions.
   - Accepted file-level fixes land in the final evaluation commit.
   - Rejected/review file-level fixes are discarded before commit.
   - Mixed hunk-level decisions in one file land only the accepted hunks and discard rejected/review hunks.

2. **No evaluator self-mutation path**
   - Build evaluator prompt no longer instructs `git add`, `git checkout --`, or `git commit`.
   - Build evaluator is run without generic mutation tools where harnesses support it, or mutation tools are explicitly disallowed and guarded by invariant checks.
   - Tests prove evaluator direct edits or working-tree diff drift during evaluation cannot be silently committed.

3. **Compile/planning evaluator parity**
   - Plan, cohesion, and architecture evaluator paths use the same structured verdict / engine application model or share a clearly named helper.
   - Existing continuation/retry behavior remains covered by tests and no longer depends on partially staged evaluator progress.

4. **Commit convention compliance**
   - Evaluation commits are created through `forgeCommit()` and `composeCommitMessage()`.
   - Tests verify `Co-Authored-By` is present and `Models-Used:` appears when `ctx.modelTracker` contains agent model IDs.

5. **Observable invariant failures**
   - If verdict submission is missing while reviewer/fixer changes exist, if a verdict references an unknown file/hunk, or if patch application fails, the engine emits an explicit failure/warning event and does not report a misleading successful evaluation.
   - Existing non-fatal evaluator-agent policy is preserved only for cases where no verdicts can be applied; deterministic engine application errors are not swallowed silently.

6. **Review-cycle reporting corrected**
   - Max-round termination no longer reports stale `ctx.reviewIssues.length` as if issues remain after final evaluation.
   - Tests cover a two-round review cycle where final evaluation accepts/rejects fixes and termination messaging/event data is not misleading.
   - Additional round/start/complete observability is added if needed to make repeated reviews clearly intentional.

7. **Regression tests**
   - Add unit/integration tests for file-level accept/reject/review application.
   - Add hunk-level accept/reject tests.
   - Add evaluator mutation/drift detection tests.
   - Add build-phase and compile-phase evaluator wiring tests.
   - Add event-schema tests if event payloads change.

8. **Validation commands**
   - `pnpm type-check` passes.
   - Targeted evaluator/review-cycle tests pass.
   - Full `pnpm test` passes unless an unrelated existing failure is explicitly documented.
