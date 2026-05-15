---
id: plan-02-build-evaluator-enforcement
name: Build Evaluator Enforcement and Reporting
branch: harden-review-evaluation-cycles/plan-02-build-evaluator-enforcement
agents:
  builder:
    effort: high
    rationale: This changes the build evaluator trust boundary, retry behavior,
      event metadata, and review-cycle reporting in coordinated engine files.
  reviewer:
    effort: high
    rationale: Review must verify no evaluator self-mutation path remains and
      max-round reporting no longer uses stale review issue lists.
  tester:
    effort: high
    rationale: Pipeline-level tests need stub harnesses plus temp git repos to prove
      enforcement and reporting behavior.
---

# Build Evaluator Enforcement and Reporting

## Architecture Context

The build evaluator currently receives generic coding tools and is instructed to run `git reset --soft`, `git add`, `git checkout --`, and `git commit`. The engine only parses XML verdict counts after the agent finishes. This plan wires the build evaluator to the shared application layer from plan 01 so the evaluator becomes a judgment producer and the engine becomes the only component that applies and commits review-fixer changes.

## Implementation

### Overview

Update the build evaluation stage to prepare an evaluation snapshot before invoking the evaluator, run the evaluator with structured submission tools and mutating tools blocked, apply verdicts through the shared helper, and emit completion only after the engine commit succeeds. Also update review-cycle termination data so max-round termination no longer reports the last review issue list as post-evaluation unresolved state.

### Key Decisions

1. `evaluateStageInner()` prepares the snapshot after confirming candidate changes exist, passes it through evaluator retry input, and preserves that snapshot across evaluator continuations.
2. `builderEvaluate()` runs the agent as a read-only judgment step. It captures one `submit_evaluation_verdicts` payload and falls back to XML parsing only when no structured submission was captured.
3. The evaluator run uses custom evaluation tools and blocks mutation tools (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash`) while retaining enough read-only/diff access for both Claude SDK and Pi harnesses. Drift detection remains the enforcement gate if a harness exposes an unexpected mutating path.
4. The stage yields `plan:build:evaluate:complete` only after `applyEvaluationVerdicts()` creates the engine commit. Application errors yield `plan:build:failed` and set `ctx.buildFailed = true`; agent judgment failures without verdicts remain non-fatal after restoring the original builder commit state.
5. `review` verdicts are applied as rejects for build evaluation, matching the acceptance requirement that rejected/review fixes are discarded.
6. `ctx.reviewIssues` is consumed after a successful evaluation pass. Max-round termination reports the last review count separately from post-evaluation state instead of reusing a stale issue list.

## Scope

### In Scope

- Build evaluator prompt changes that remove agent-owned git setup, staging, checkout, and commit instructions.
- Build evaluator custom tool wiring and structured submission capture.
- Build-stage git setup/application/restore flow using the shared evaluation helper.
- Completion event verdict summaries that preserve optional `hunk` metadata.
- Build decision schema and monitor UI formatting changes needed to distinguish last-review issue counts from final post-evaluation state.
- Tests for build evaluator file-level application, hunk-level application, drift detection, missing verdict submission, commit trailers, and max-round reporting.

### Out of Scope

- Plan/cohesion/architecture evaluator parity; plan 03 handles compile-phase evaluators.
- Adaptive reviewer subset selection.
- Reviewer or review-fixer quality criteria changes beyond evaluator-boundary wording.
- Broad commit convention changes for non-evaluator agents.

## Files

### Create

- `test/build-evaluator-enforcement.test.ts` — build evaluator integration tests using temp git repos and `StubHarness` submissions.

### Modify

- `packages/engine/src/agents/builder.ts` — change `builderEvaluate()` to use evaluation tools, structured verdict capture, mutation-tool denylist, XML fallback, hunk-preserving verdict summaries, and no agent-owned git mutation.
- `packages/engine/src/prompts/evaluator.md` — remove setup/actions/final-commit sections and instruct the evaluator to inspect captured diffs and call the submission tool once.
- `packages/engine/src/pipeline/stages/build-stages.ts` — prepare snapshots, pass snapshot state through evaluator retry, apply/commit verdicts through the shared helper, restore on non-fatal agent failure, fail on deterministic application errors, clear consumed review issues, and emit non-stale cycle termination metadata.
- `packages/engine/src/retry.ts` — preserve evaluation snapshot/options across evaluator continuations and update continuation wording assumptions that referenced partially staged evaluator progress.
- `packages/client/src/events.schemas.ts` — add optional `hunk` to evaluate-complete verdict summaries and add optional `lastReviewIssueCount`, `finalEvaluationAccepted`, `finalEvaluationRejected`, and `finalEvaluationRan` fields to the `cycle-terminated` build decision variant.
- `packages/monitor-ui/src/lib/decision-format.ts` — render cycle termination with final-evaluation fields when present, avoiding the phrase “issues remaining” for stale pre-evaluation review counts.
- `packages/monitor-ui/src/lib/reducer/__tests__/handle-decisions.test.ts` — cover the updated cycle-termination rendering data.
- `packages/client/src/__tests__/events-schemas.test.ts` — cover hunk verdict summaries and enriched `cycle-terminated` decisions.
- `test/agent-wiring.test.ts` — update build evaluator wiring assertions for custom tools, disallowed mutation tools, structured submissions, and hunk-preserving summaries.
- `test/evaluator-continuation.test.ts` — update continuation prompt expectations so they no longer reference evaluator-owned `git add` or `git checkout` progress.
- `test/retry.test.ts` — update evaluator retry tests to preserve snapshot options across attempts.
- `test/pipeline.test.ts` — add a focused review-cycle max-round test that verifies final evaluation metadata and no stale `ctx.reviewIssues.length` reporting.
- `test/decisions.test.ts` — add schema round-trip coverage for enriched `cycle-terminated` decisions.
- `web/public/schemas/events.schema.json` and generated event reference artifacts — regenerate with `pnpm docs:generate` if the event schema generator changes these files.

## Verification

- [ ] The build evaluator prompt contains no `git reset`, `git add`, `git checkout`, or `git commit` instruction.
- [ ] A `StubHarness` build evaluator call receives `submit_evaluation_verdicts`, `list_evaluation_files`, and `get_evaluation_diff` custom tools, plus a denylist containing `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, and `Bash`.
- [ ] Given two reviewer-fixer files, one accept verdict and one reject verdict, the final engine commit contains the accepted fix and excludes the rejected fix.
- [ ] Given two hunks in one file, an accept verdict for hunk 1 and reject verdict for hunk 2, the final engine commit contains only hunk 1.
- [ ] If the evaluator run mutates the working-tree diff after snapshot capture, the stage emits `plan:build:failed`, sets `ctx.buildFailed`, and creates no evaluation commit.
- [ ] If candidate changes exist and no structured submission or XML verdicts are produced, the stage emits an explicit evaluation failure/warning event and creates no evaluation commit.
- [ ] Evaluation commits created from build-stage verdicts contain `Co-Authored-By: forged-by-eforge` and include `Models-Used:` when the build `ModelTracker` recorded evaluator or builder model IDs.
- [ ] A two-round review-cycle test emits max-round termination with `finalEvaluationRan: true`, `lastReviewIssueCount` equal to the final review pass count, and no summary text that labels that count as post-evaluation remaining issues.