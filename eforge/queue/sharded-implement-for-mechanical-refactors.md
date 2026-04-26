---
title: Sharded `implement` for mechanical refactors (β)
created: 2026-04-26
---

# Sharded `implement` for mechanical refactors (β)

## Problem / Motivation

Large mechanical refactors (e.g. rename a type across many files) currently route to a single excursion plan, where one builder thread grinds through the work — frequently exhausting maxTurns, checkpoint-committing, and re-entering. Wall-clock cost is dominated by this single-thread iteration.

## Goal

Allow the `implement` stage to fan out into N parallel builder invocations within the same worktree, partitioned by scope, when the planner classifies a PRD as a mechanical refactor large enough to warrant sharding. Each shard is a regular `builder` invocation — no new agent role, no harness-specific prompt language, no engine-side worktree orchestration. Parallelism lives in eforge's pipeline layer; harness equality is preserved (Pi and Claude SDK both gain the same wall-clock improvement).

## Approach

### Decisions already locked in

- **Commit shape:** Coordinator commit. Shards stage-only; the `implement` stage runs verification and creates one commit at the end. Preserves "one commit per plan."
- **Scope shape:** Hybrid — each shard can declare `roots` (directory globs), `files` (explicit list), or both. Lets the planner partition large directories file-by-file when needed.
- **Trigger:** Heuristic, planner judgment. No fixed file-count threshold — planner weighs file count, file size, change uniformity, and expected total work against single-builder budget.

### Plan frontmatter shape

The planner emits a new optional `shards` block under `agents.builder`:

```yaml
agents:
  builder:
    maxTurns: 80          # per-shard budget; same default as today
    shards:
      - id: shard-1
        roots: [packages/engine/src/]
      - id: shard-2
        roots: [packages/monitor/src/, packages/monitor-ui/src/]
      - id: shard-3
        files:
          - packages/engine/src/giant-mapping-file.ts
          - packages/engine/src/another-big-file.ts
```

Absence of `shards` preserves today's behavior (single builder, no fan-out). Presence triggers β. Each shard's `id` becomes its lane label in logs and per-shard notices.

### Engine changes

#### 1. Config schema — `packages/engine/src/config.ts`

Extend the resolved builder config schema to include an optional `shards` array. Each shard:

```ts
type ShardScope = {
  id: string;
  roots?: string[];   // directory globs
  files?: string[];   // explicit paths
};
```

Validation: at least one of `roots` or `files` must be present per shard; shard `id`s must be unique within a plan.

#### 2. `implement` stage — `packages/engine/src/pipeline/stages/build-stages.ts:245+`

Today the `implement` stage runs a single `builderImplement` call. With β, it:

1. Reads `plan.agents.builder.shards`. If absent, runs today's single-builder flow unchanged.
2. If present, runs N `builderImplement` calls concurrently via `runParallel` from `concurrency.ts:127-163` (already used elsewhere — not new infrastructure). Each call gets a `shardScope` injected into `BuilderOptions`.
3. After all shards finish staging (no commits yet), runs a coordinator phase:
   - Run verification on the staged state (same commands the builder runs today, just hoisted out).
   - Run a scope-enforcement check (see §6).
   - `git add -A` (sweep up anything missed) and create the single commit using the existing builder commit message template.

The stage's existing tracing span wraps the whole thing; per-shard spans nest under it for visibility.

#### 3. `builderImplement` — `packages/engine/src/agents/builder.ts:99+`

Two changes:

- Accept a new optional `shardScope` in `BuilderOptions`. When set, the builder runs in shard mode.
- In shard mode: skip verification and skip commit. The agent's job is to apply changes within scope and stop. The existing `verification_scope` and commit sections of the prompt are replaced (or suppressed) when shard mode is active.

#### 4. Per-shard lane notice — `packages/engine/src/agents/builder.ts:50+`

Extend `formatBuilderParallelNotice` (or add a sibling `formatShardScope`) to inject the per-shard scope into the prompt. The notice tells the agent:

- Your scope is files under `<roots>` and these explicit `<files>`.
- Do not modify files outside this scope. Other agents are handling those.
- Use targeted `git add <file>` for the files you change. Do not run `git add -A`.
- Do not commit. Do not run verification — those happen after all shards finish.

This is harness-agnostic prose about the shape of the work — no `Task`, no `Bash`, no tool names. Same pattern as the existing builder+doc-updater notice.

#### 5. Verification placement — `packages/engine/src/agents/builder.ts:80-93`

The `VERIFICATION_FULL` / `VERIFICATION_BUILD_ONLY` blocks today are interpolated into the builder prompt. In shard mode, replace them with a one-liner: "Verification will run once after all shards finish; do not run it yourself." The actual verification commands move to the `implement` stage's coordinator phase, executed via the existing helper functions.

#### 6. Scope enforcement — new helper in `packages/engine/src/pipeline/stages/build-stages.ts`

After all shards stage their changes, before the coordinator commit, run a sanity check:

- Get the list of staged-but-uncommitted files (`git diff --cached --name-only`).
- For each file, determine which shard(s) claim it (via `roots` glob match or explicit `files` membership).
- Fail the stage if any file is claimed by zero shards (out-of-scope edit) or by more than one shard (overlap).

This is cheap — a few hundred lines of staged-file path matching — and gives a clean failure mode if the planner emits overlapping shards.

#### 7. Per-shard retry — `packages/engine/src/retry.ts`

Each shard gets the existing builder retry policy (`DEFAULT_RETRY_POLICIES.builder`, `retry.ts:462-479`) but with a shard-aware checkpoint mechanism:

- Within a shard, on maxTurns exhaustion, the shard checkpoints by **stashing its scope's staged changes** (instead of committing them). The continuation context references the stash diff, just as today's continuation references the WIP commit diff.
- After all shards reach a successful terminal state, the coordinator pops each stash in turn into the index and proceeds to the single coordinator commit.
- If a shard exhausts its retry attempts, the whole `implement` stage fails — the same failure semantics as today's single-builder retry exhaustion.

Net: the existing 4-attempt × 80-turn-per-attempt budget applies per shard. Total budget for an N-shard plan is roughly N × the single-builder budget, but in parallel wall-clock.

### Planner changes — `packages/engine/src/prompts/planner.md:85+`

At the existing "Rename-and-update-all-callers refactors → excursion" guidance, extend the planner's responsibility:

- For mechanical-refactor PRDs, the planner inspects the candidate file set (count, sizes, directory layout, change uniformity).
- The planner decides whether to shard based on its judgment — **no fixed file-count threshold**. Heuristics in the prompt: shard when expected total work would substantially exceed a single builder's 80-turn budget; consider that 5 large files may warrant sharding while 30 small files may not.
- When sharding, the planner emits the `shards` block with a mix of `roots` and `files` as appropriate. If a directory contains too many files for one shard, partition it by sub-directory or by explicit file lists.

The planner prompt does not need to know about commit shape, retry, or verification placement — those are handled by the engine. It just declares scope.

## Scope

### Files touched

- `packages/engine/src/config.ts` — schema for `shards`.
- `packages/engine/src/agents/builder.ts` — shard-mode in `builderImplement` and `formatBuilderParallelNotice`.
- `packages/engine/src/pipeline/stages/build-stages.ts` — `implement` stage fan-out, coordinator phase, scope enforcement.
- `packages/engine/src/prompts/builder.md` — small additions for the shard-mode prompt branches (no harness-specific tool references).
- `packages/engine/src/prompts/planner.md` — sharding judgment guidance.
- `packages/engine/src/retry.ts` — stash-based per-shard checkpoint mechanism (alongside existing commit-based mechanism for non-shard mode).

### Reused without modification

- `packages/engine/src/concurrency.ts` — `runParallel` for fan-out.
- The existing parallel-stages mechanism (no schema changes; β extends `implement`'s internals, not the stage system).
- The existing `tester` stage placement (still runs after `implement`, unchanged).
- Region marker infrastructure (still applies for shared files; orthogonal to shard scope).

### Out of scope (deliberately *not* doing)

- No new entry in `AGENT_ROLE_TIERS`. No new `refactor` agent role.
- No new pipeline stage. β extends `implement`'s internals, not the stage graph.
- No harness-specific language in any prompt.
- No engine-side worktree orchestration. All shards share the worktree, as builder+doc-updater already do.
- No changes to the "one commit per plan" invariant.

## Acceptance Criteria

End-to-end test plan:

1. **Identity test (no regression):** Pick a non-refactor PRD from a recent build. Run it through the modified engine. Confirm: no `shards` declared by planner → single-builder flow runs unchanged → identical commit, identical trace shape.
2. **Sharded refactor — Claude SDK:** Pick a real candidate (rename touching ≥20 files). Run through the modified engine with Claude SDK harness. Confirm: planner emits shards; N parallel builder spans appear; coordinator commit is the only commit; wall-clock improves over single-builder baseline.
3. **Sharded refactor — Pi:** Same PRD, same engine, Pi harness. Confirm: harness equality — Pi gets the same parallelism benefit since shards are eforge-orchestrated, not subagent-based.
4. **Scope-violation failure mode:** Hand-craft a plan where two shards have overlapping `roots`. Confirm: scope enforcement fails the stage with a clear error; no commit is produced.
5. **Per-shard retry:** Hand-craft a plan with an artificially low `maxTurns` per shard (e.g. 5) so shards exhaust budget. Confirm: each shard checkpoints to stash, retries up to policy, and either succeeds or fails the stage cleanly with stash state recoverable.
6. **Small-refactor heuristic:** Run a small refactor (~5 files of varied size) through the planner. Confirm: planner judgment selects single-builder mode, not sharded — i.e. the heuristic doesn't over-fire.
