---
title: Monitor UI tooltip: surface real tier and per-reviewer perspective
created: 2026-05-02
---

# Monitor UI tooltip: surface real tier and per-reviewer perspective

## Problem / Motivation

Two defects in the agent-strip tooltip in the monitor UI's session timeline:

**Defect 1 — `tier: unknown (tier)`.** Every agent's tooltip displays the literal string `unknown` for tier. The user expects to see the resolved tier (`planning`, `implementation`, `review`, or `evaluation`) so they can verify which tier recipe an agent is running under.

**Defect 2 — parallel reviewers are indistinguishable.** When `runParallelReview` fans out per-perspective specialist reviewers (`code`, `security`, `api`, `docs`, `test`, `verify`), all strips read `reviewer` with identical-looking tooltips. The user cannot tell which strip is handling security vs. docs vs. correctness, even though the perspective is known at fan-out time and is emitted on parallel-review lifecycle events.

**Who's affected.** Anyone debugging eforge sessions via the monitor UI - primarily the user when reviewing why a particular reviewer flagged (or missed) an issue. Today the only signal is duration/token count, which is not enough to attribute behavior to a specialist.

**Why now.** A user-facing memory rule already exists: "Surface runtime agent decisions in monitor UI" - new per-agent runtime values must appear in the stage hover. Tier resolution exists in the engine but is being dropped at the harness boundary; perspective is even further from being surfaced. Both are concrete instances of the same gap.

### Context

The user reported two issues with the agent-strip tooltip in the monitor UI's session timeline (screenshot showed three parallel `reviewer` strips):

1. The `tier` line always reads `tier: unknown (tier)` instead of a real tier (`planning`, `implementation`, `review`, `evaluation`).
2. When `runParallelReview` fans out per-perspective reviewers (`code`, `security`, `api`, `docs`, `test`, `verify`), every strip looks identical - there is no way to tell which reviewer is handling which perspective.

Both issues share the same root-cause shape: information that *is* resolved upstream gets dropped on the way to the harness, so the `agent:start` event the monitor consumes never carries it.

### Reproduction Steps

**Defect 1 - tier shows `unknown`** (reproduces on every agent, every build):

1. Open the monitor UI for any session that has run at least one agent.
2. Hover any agent strip (planner, builder, reviewer, evaluator - any of them).
3. **Observed:** tooltip line reads `tier: unknown (tier)`.
4. **Expected:** tooltip reads `tier: <resolved tier> (<source>)` where `<resolved tier>` is one of `planning | implementation | review | evaluation` and `<source>` is one of `tier | role | plan`. Example: `tier: review (tier)` for a reviewer running under the default review tier recipe.

**Defect 2 - parallel reviewers are indistinguishable** (reproduces only when the parallel review path is taken):

1. In a project, make a changeset large enough to trip `shouldParallelizeReview` - 10+ files changed or 500+ insertions+deletions (heuristic in `packages/engine/src/review-heuristics.ts`). Alternatively, force the path by setting `strategy: 'parallel'` on the plan's review config so the heuristic is bypassed.
2. Enqueue an eforge build against that changeset.
3. Open the monitor UI and watch the build. When the review phase runs, you'll see N parallel `reviewer` strips (one per applicable perspective from `code`, `security`, `api`, `docs`, `test`, `verify`).
4. Hover each strip in turn.
5. **Observed:** every strip shows the same name (`reviewer`), the same tier (`unknown`), the same model. The strips are visually identical except for duration/token count.
6. **Expected:** each strip's tooltip includes a line like `perspective: security` (or `code`, `api`, `docs`, `test`, `verify`) so the user can attribute each parallel reviewer to its specialty.

**Workaround.** None today. The `plan:build:review:parallel:perspective:start` and `:complete` events emit `perspective`, but the monitor UI does not associate them with the corresponding `agent:start` (different agentIds, no shared key beyond `planId` + timing).

### Root Cause

**Defect 1 - tier shows `unknown`.** Confirmed by reading the call chain end-to-end.

1. `resolveTierForRole` in `packages/engine/src/pipeline/agent-config.ts:88-101` always returns `{ tier, tierSource }` populated from a real `AgentTier`. `resolveAgentConfig` (`packages/engine/src/pipeline/agent-config.ts:147`) wraps this and returns the resolved config to pipeline stages. There is no code path where `tier` is left undefined upstream.
2. Pipeline stages spread the resolved config into agent-runner options. Example: `packages/engine/src/pipeline/stages/build-stages.ts:146` does `...reviewerAgentConfig` into `runParallelReview`'s options, so `tier` and `tierSource` are present at the agent-runner level.
3. At the agent-runner -> harness boundary, every runner calls `harness.run({ ..., ...pickSdkOptions(options) }, ...)`. `pickSdkOptions` (`packages/engine/src/harness.ts:50`) drops any key in `NON_SDK_KEYS`, which today includes `tier`, `tierSource`, `effortSource`, `thinkingSource`, `effortClamped`, `effortOriginal`, `thinkingCoerced`, `thinkingOriginal`, `harness`, `harnessSource`. These are *all* valid `AgentRunOptions` fields (declared at `packages/engine/src/harness.ts:100-135`) - the harness needs them for `agent:start` stamping and for the `thinking-coerced` warning. They are *not* SDK fields, but they are also not non-harness fields. The exclusion was overly broad.
4. With `tier` stripped, the harness sees `options.tier === undefined` and falls back to the literal string `'unknown'`:
   - `packages/engine/src/harnesses/claude-sdk.ts:119` - `tier: options.tier ?? 'unknown'`
   - `packages/engine/src/harnesses/pi.ts:286, 309, 333` - same pattern in three branches (Pi has separate code paths for "no model configured", "subagents disabled", and the normal run).
5. Everything after this point preserves what the harness emits - `agent:start` carries `tier: 'unknown'`, the reducer extracts it (`packages/monitor-ui/src/lib/reducer.ts:329`), the tooltip renders it (`packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx:873-880`).

The harness already explicitly picks which fields to forward to the underlying SDK (`packages/engine/src/harnesses/claude-sdk.ts:207-235` enumerates `model`, `cwd`, `maxTurns`, `tools`, `effort`, `thinking`, `maxBudgetUsd`, `fallbackModel`, `allowedTools`, `disallowedTools`, plus `abortController`). Letting metadata fields flow into the harness will not leak them into the SDK call.

**Defect 2 - no perspective on `agent:start`.** Confirmed by code reading.

- `packages/engine/src/agents/parallel-reviewer.ts:165-196` creates one `ParallelTask` per perspective. Each task calls `harness.run({ ..., ...pickSdkOptions(options) }, 'reviewer', planId)`. The `agent` argument is the literal string `'reviewer'` - perspective is never passed in.
- The harness assigns a fresh `crypto.randomUUID()` agentId (`packages/engine/src/harnesses/claude-sdk.ts:111`, equivalent in pi.ts) and emits `agent:start` via `buildAgentStartEvent` (`packages/engine/src/harnesses/common.ts:46`). `BuildAgentStartEventOptions` does not have a `perspective` field; the `agent:start` event union (`packages/engine/src/events.ts:243`) does not have one either.
- `AgentThread` (`packages/monitor-ui/src/lib/reducer.ts:35-61`) has no `perspective` field; the reducer's `agent:start` handler (`packages/monitor-ui/src/lib/reducer.ts:306-332`) does not extract one. The tooltip in `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx:847-896` therefore has nothing to display, even though `parallel-reviewer.ts:168, 194` emit `perspective` on the lifecycle events.

The path is intentionally generic: making `perspective` an optional field on `AgentRunOptions` and `agent:start` (typed as `string`, not narrowed to `ReviewPerspective`) lets future fan-outs (planner per module, builder per shard) reuse the same plumbing without another schema change.

## Goal

Surface the resolved tier (and its source) and the per-reviewer perspective on every `agent:start` event so the monitor UI's agent-strip tooltip displays real tier values (never the literal `unknown`) and distinguishes parallel reviewers by perspective (`code`, `security`, `api`, `docs`, `test`, `verify`).

## Approach

The approach is already approved in the plan file:

1. Trim `NON_SDK_KEYS` to just `'promptAppend'` so the resolved metadata flows through to the harness.
2. Drop the `?? 'unknown'` / `?? 'tier'` fallbacks in both harnesses - `resolveTierForRole` always populates real values.
3. Add optional `perspective?: string` to `AgentRunOptions`, the `agent:start` event variant, and `BuildAgentStartEventOptions` / `buildAgentStartEvent`.
4. Forward `perspective` from `parallel-reviewer.ts:178` into `harness.run`.
5. Extend `AgentThread` and the `agent:start` reducer to capture perspective.
6. Render a `perspective: <name>` line in the tooltip when set.

### Tier flow (currently broken)

- `packages/engine/src/pipeline/agent-config.ts:88` (`resolveTierForRole`) always returns a real `AgentTier` plus a `tierSource` provenance.
- Pipeline stages spread that resolved config into agent runner options (e.g. `packages/engine/src/pipeline/stages/build-stages.ts:146` spreads `...reviewerAgentConfig` into `runParallelReview`).
- At the agent-runner -> harness boundary, every runner does `harness.run({ ..., ...pickSdkOptions(options) }, ...)`. `pickSdkOptions` (`packages/engine/src/harness.ts:50`) strips `tier`, `tierSource`, `effortSource`, `thinkingSource`, `effortClamped`, `effortOriginal`, `thinkingCoerced`, `thinkingOriginal`, `harness`, `harnessSource` even though they are valid `AgentRunOptions` fields the harness needs for `agent:start` stamping.
- The harness then sees `options.tier === undefined` and falls back to the literal `'unknown'`:
  - `packages/engine/src/harnesses/claude-sdk.ts:119`
  - `packages/engine/src/harnesses/pi.ts:286, 309, 333`
- The harness already explicitly picks which fields to forward to the underlying SDK (`claude-sdk.ts:207-235`), so trimming `NON_SDK_KEYS` will not leak metadata into the SDK call.

### Perspective flow (missing entirely)

- `packages/engine/src/agents/parallel-reviewer.ts:165-196` fans out one `harness.run()` call per perspective with `agent: 'reviewer'` for each.
- Perspective is emitted on `plan:build:review:parallel:perspective:start/complete` events (`packages/engine/src/events.ts:203-204`) but never on `agent:start`.
- `AgentThread` (`packages/monitor-ui/src/lib/reducer.ts:35-61`) has no `perspective` field, and the tooltip (`packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx:847-896`) has nothing to render.

### Profile Signal

**Recommendation: Excursion.**

The change touches 8 files across 2 packages (`packages/engine` and `packages/monitor-ui`) but is tightly scoped: data-flow plumbing for two related metadata fields, with no cross-cutting redesign. Both edits follow established patterns (`buildAgentStartEvent` / reducer / tooltip already handle a half-dozen similar fields). No dependency upgrades, no new modules, no new tests beyond a regression check.

Not Errand: more than a single mechanical edit - the change spans event schema, two harnesses, an agent runner, the reducer, and the tooltip.

Not Expedition: no parallel subsystems or independent module fan-out - every file edit unblocks the next, and the whole change can land as a single PR.

## Scope

**In scope:**

- `packages/engine/src/harness.ts` - trim `NON_SDK_KEYS` to just `'promptAppend'` (and undefined values).
- `packages/engine/src/harnesses/claude-sdk.ts` - drop the `?? 'unknown'` / `?? 'tier'` fallbacks.
- `packages/engine/src/harnesses/pi.ts` - drop the `?? 'unknown'` / `?? 'tier'` fallbacks in all three branches (no model configured, subagents disabled, normal run).
- `packages/engine/src/events.ts` - add optional `perspective?: string` to the `agent:start` event variant.
- `packages/engine/src/harnesses/common.ts` (`buildAgentStartEvent`) and `BuildAgentStartEventOptions` - accept and copy through optional `perspective?: string`.
- `AgentRunOptions` (in `packages/engine/src/harness.ts`) - add optional `perspective?: string`.
- `packages/engine/src/agents/parallel-reviewer.ts` - forward `perspective` into `harness.run` for each fanned-out reviewer.
- `packages/monitor-ui/src/lib/reducer.ts` - add `perspective?: string` to `AgentThread` and capture it in the `agent:start` handler.
- `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` - render a `perspective: <name>` line in the tooltip when set.

**Out of scope:**

- Narrowing `perspective` to a `ReviewPerspective` union; it is intentionally typed as `string` so future fan-outs (planner per module, builder per shard) reuse the same plumbing without another schema change.
- Any cross-cutting redesign beyond data-flow plumbing for tier and perspective.
- Dependency upgrades, new modules, or new tests beyond a regression check.

## Acceptance Criteria

**Tier resolution end-to-end:**

1. After build (`pnpm build`), the engine compiles cleanly with `tier: options.tier ?? 'unknown'` and `tierSource: options.tierSource ?? 'tier'` removed in `packages/engine/src/harnesses/claude-sdk.ts` and `packages/engine/src/harnesses/pi.ts`. Same for `harnessSource ?? 'tier'`.
2. `pickSdkOptions` in `packages/engine/src/harness.ts` only filters `'promptAppend'` (and undefined values). All other previously-listed metadata fields flow through to the harness.
3. Hover any agent strip in the monitor UI for a fresh build:
   - tooltip shows `tier: <real-tier> (<source>)` where `<real-tier>` ∈ {`planning`, `implementation`, `review`, `evaluation`} and `<source>` ∈ {`tier`, `role`, `plan`}.
   - The literal string `unknown` never appears in the tier line.
4. Agents whose effort or thinking was clamped/coerced now show the previously-stripped provenance/clamping fields too (e.g., `effort: high (clamped from xhigh)` for clamped agents, `(role)` source on tooltips when a user-level role override is set).

**Perspective surfacing:**

5. `agent:start` event variant in `packages/engine/src/events.ts` carries an optional `perspective?: string`.
6. `AgentRunOptions` and `BuildAgentStartEventOptions` accept an optional `perspective?: string`; `buildAgentStartEvent` copies it onto the event when defined (mirroring the existing `effortSource` handling).
7. `parallel-reviewer.ts:178` passes `perspective` into `harness.run` for each fanned-out reviewer.
8. `AgentThread` in `packages/monitor-ui/src/lib/reducer.ts` has a `perspective?: string` field, populated by the `agent:start` handler.
9. With a parallel review (10+ files or `strategy: 'parallel'`), the monitor UI tooltip on each parallel reviewer strip displays a `perspective: <name>` line, where `<name>` is one of `code`, `security`, `api`, `docs`, `test`, `verify`. Each parallel strip shows a distinct perspective.
10. With a single (non-parallel) review, no `perspective` line appears in the tooltip - the field is undefined.

**No regressions:**

11. `pnpm type-check` and `pnpm test` pass.
12. Hovering non-reviewer strips (planner, builder, evaluator, doc-author, doc-syncer, tester, etc.) shows the real tier with no perspective line - `perspective` is reviewer-only today.
13. Agents whose clamping/coercion or source provenance was already correctly displayed (e.g., effort/thinking when explicitly set) continue to render as before.
