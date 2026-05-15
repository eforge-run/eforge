---
id: plan-01-evaluation-application-core
name: Evaluation Application Core
branch: harden-review-evaluation-cycles/plan-01-evaluation-application-core
agents:
  builder:
    effort: xhigh
    rationale: Unified-diff parsing, hunk-level git index application, and state
      restoration require careful git semantics and edge-case handling.
  reviewer:
    effort: high
    rationale: The helper becomes the trust boundary for evaluator decisions and
      must be reviewed for path safety and git-state invariants.
  tester:
    effort: high
    rationale: Temp git repository tests need to cover file-level, hunk-level,
      commit trailer, and invariant-failure paths.
---

# Evaluation Application Core

## Architecture Context

Evaluator hardening needs one shared engine-owned layer that can prepare the staged/original versus unstaged-fix comparison, validate verdicts, apply accepted fixes, discard rejected fixes, and commit through existing engine commit helpers. This plan creates that layer and tests it directly before any agent or pipeline integration depends on it.

The evaluator agent remains outside this plan. Build and compile evaluator call sites are updated in later plans so this foundation can land with direct unit/integration coverage and without changing live pipeline behavior in the same step.

## Implementation

### Overview

Create a shared evaluation module under `packages/engine/src/evaluation/` that owns git-state setup, diff snapshotting, structured verdict validation, hunk/file application, cleanup, and model-aware forge commits.

### Key Decisions

1. The canonical candidate patch is the unstaged diff captured immediately after `git reset --soft <resetTarget>`. Later application rejects any working-tree diff drift relative to that snapshot.
2. Verdict validation happens before any git mutation. Unknown files, duplicate verdicts, missing verdict coverage, hunk references outside the captured hunk range, absolute paths, and `..` path escapes raise engine errors.
3. File-level accept stages the working-tree version for that file. File-level reject/review discards the working-tree fix for that file. Hunk-level accept applies selected captured hunks to the index with `git apply --cached`, then resets the working tree to the accepted index state for that file.
4. Binary, rename-only, and untracked-file candidates require file-level verdicts. Hunk-level verdicts for candidates without text hunks raise a validation error with the file path and requested hunk.
5. All evaluation commits use `forgeCommit()` with `composeCommitMessage()` so `Co-Authored-By` is always present and `Models-Used:` appears when a model tracker contains model IDs.

## Scope

### In Scope

- Shared TypeScript types for evaluation snapshots, candidate files, candidate hunks, verdict summaries, and application results.
- A TypeBox `evaluationSubmissionSchema` with a `verdicts` array using the existing `evaluationVerdictSchema`.
- Custom evaluator tool factories for listing captured files, reading captured diffs, and submitting verdicts exactly once.
- Git helpers for soft-reset setup, snapshot capture, drift checks, file-level verdict application, hunk-level verdict application, cleanup, restoration after non-fatal agent failure, and model-aware commits.
- Temp git repository tests for direct helper behavior.

### Out of Scope

- Wiring `builderEvaluate()` or plan-phase evaluators to the new helper.
- Changing evaluator prompts.
- Changing review-cycle event wording or monitor UI rendering.
- Adaptive reviewer subset selection.

## Files

### Create

- `packages/engine/src/evaluation/apply.ts` — evaluation snapshot setup, diff parsing, verdict validation, git application, cleanup, restoration, and forge commit helpers.
- `packages/engine/src/evaluation/tools.ts` — read-only custom tool factories for `list_evaluation_files`, `get_evaluation_diff`, and `submit_evaluation_verdicts` backed by a captured snapshot and a one-shot submission callback.
- `packages/engine/src/evaluation/index.ts` — public exports for build and compile evaluator integrations.
- `test/evaluation-application.test.ts` — temp git repo tests for file-level verdicts, hunk-level verdicts, path validation, drift detection, and commit trailers.

### Modify

- `packages/engine/src/schemas.ts` — add `evaluationSubmissionSchema`, `EvaluationSubmission` type, and a schema-YAML getter for prompt/tool documentation.
- `test/schemas.test.ts` — assert the evaluation submission YAML includes `verdicts`, `file`, `action`, `reason`, and optional `hunk` fields.

## Verification

- [ ] `applyEvaluationVerdicts()` accepts one file-level fix and rejects another in a temp git repo; the committed file contents match the accepted/rejected matrix.
- [ ] `applyEvaluationVerdicts()` accepts hunk 1 and rejects hunk 2 in one file; the commit contains only hunk 1.
- [ ] A verdict for `../outside.ts` or `/tmp/outside.ts` raises an evaluation validation error before any commit is created.
- [ ] A verdict for hunk `3` when the captured file has two hunks raises an evaluation validation error before any commit is created.
- [ ] Mutating the working tree after snapshot capture causes drift detection to raise an evaluation invariant error before any commit is created.
- [ ] A commit created by the helper contains `Co-Authored-By: forged-by-eforge` and contains `Models-Used:` when the supplied `ModelTracker` records at least one model ID.