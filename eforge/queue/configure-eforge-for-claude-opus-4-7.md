---
title: Configure eforge for Claude Opus 4.7
created: 2026-04-18
---

# Configure eforge for Claude Opus 4.7

## Problem / Motivation

Anthropic's "Best practices for Opus 4.7 with Claude Code" introduces three changes relevant to how eforge drives the model:

1. **New default effort = `xhigh`.** Opus 4.7 supports a new `xhigh` level (between `high` and `max`) and Anthropic recommends it as the default for most agentic coding (API design, migrations, code review). `max` is reserved for genuinely hard problems and is "prone to overthinking."
2. **No fixed-budget Extended Thinking.** Opus 4.7 does not support a fixed thinking budget. It uses *adaptive* thinking and decides per-turn whether to deliberate. Passing `thinking: { type: 'enabled', budgetTokens: N }` is no longer a meaningful knob on 4.7.
3. **Behavioral shifts.** 4.7 reasons more and calls tools / spawns subagents less by default. The recommended counter is to (a) front-load specs in the first turn, (b) prompt explicitly when you want aggressive parallel exploration.

Currently, eforge has a single shared capability entry for Opus 4.6 and 4.7 (`/^claude-opus-4-[67]/`) with `defaultEffort: 'high'`. There is no per-role effort default - `AGENT_ROLE_DEFAULTS` carries only `maxTurns`. A user could also pass `thinking: { type: 'enabled', budgetTokens: 10000 }` and it would be forwarded verbatim to the SDK, which is incorrect for 4.7.

eforge sits *downstream* of the high-effort planning step. The intended user flow is:

1. **Outer-loop planning** - User works in Claude Code with Opus 4.7 at `xhigh`, develops and bakes a PRD. This is the open-ended, ambiguous, expensive step. The blog's `xhigh` guidance is for *this* surface.
2. **Hand-off to eforge** - The baked PRD enters eforge's queue.
3. **Inner-loop refinement and execution** - eforge's planner decomposes the PRD into modules (still benefits from `high` - there's real judgment in module decomposition), and downstream roles (builder, doc-updater, fixers) execute well-scoped, front-loaded tasks. These don't need `xhigh`; the blog's "front-load specs" recommendation is *already satisfied* by the time the work reaches them.

### What eforge already has

- `packages/engine/src/model-capabilities.ts:52` - regex-keyed capability table. Opus 4.6 and 4.7 currently **share one entry** (`/^claude-opus-4-[67]/`) with `defaultEffort: 'high'` and `supportedEffort` through `'max'`.
- `packages/engine/src/backend.ts:12` - `ThinkingConfig` already includes `{ type: 'adaptive' }`; the Claude SDK adapter passes `thinking` straight through (`backends/claude-sdk.ts:100`); Pi maps `adaptive → 'medium'` (`backends/pi.ts:59`).
- `packages/engine/src/pipeline.ts:495` - `resolveAgentConfig` precedence: planEntry → role-config → global-config → built-in role defaults → built-in global. Effort is clamped to model capability at `:642`.
- `SdkPassthroughConfig.promptAppend` already exists (`backend.ts:35`) - text appended to the agent prompt after variable substitution. This is the natural carrier for any model-specific nudges.

## Goal

Configure eforge with model-agnostic per-role effort defaults, split the Opus 4.6/4.7 capability entries, and coerce fixed-budget thinking to adaptive on 4.7 - so eforge drives Opus 4.7 correctly and efficiently without requiring user config changes.

## Approach

### 1. Set per-role effort defaults in `AGENT_ROLE_DEFAULTS`

`packages/engine/src/pipeline.ts:412`

Extend each entry with `effort` per the table below. Today many roles have no entry at all - add them with `effort` only (no need to set `maxTurns` if no override is needed). The right place to express the effort strategy is **per-role effort defaults**, not a model-wide default. This is model-agnostic - `high`/`medium` work on every Claude 4.x model and get clamp-protected on weaker ones.

Recommended starting effort by role tier (proposal - adjust based on eval signal):

| Tier                    | Roles                                                                                                   | Effort   |
| ----------------------- | ------------------------------------------------------------------------------------------------------- | -------- |
| Inner planning          | `planner`, `module-planner`, `architecture-reviewer`, `architecture-evaluator`, `cohesion-reviewer`, `cohesion-evaluator`, `plan-reviewer`, `plan-evaluator` | `high`   |
| Heavyweight execution   | `builder`, `reviewer`, `evaluator`                                                                      | `high`   |
| Scoped fixes            | `review-fixer`, `validation-fixer`, `merge-conflict-resolver`                                           | `medium` |
| Mechanical / supportive | `doc-updater`, `test-writer`, `tester`, `gap-closer`                                                    | `medium` |

The planner can still escalate any role to `xhigh` per-module via `planEntry.agents[role].effort` (`pipeline.ts:511`) when it judges a module genuinely hard - see step 4.

```ts
export const AGENT_ROLE_DEFAULTS: Partial<Record<AgentRole, Partial<ResolvedAgentConfig>>> = {
  planner: { effort: 'high' },
  'module-planner': { maxTurns: 20, effort: 'high' },
  'architecture-reviewer': { effort: 'high' },
  // ... etc per the table
  builder: { maxTurns: 50, effort: 'high' },
  'review-fixer': { effort: 'medium' },
  'doc-updater': { maxTurns: 20, effort: 'medium' },
  // ...
};
```

### 2. Split Opus 4.6 / 4.7 capability entries

`packages/engine/src/model-capabilities.ts:54`

```ts
{ match: /^claude-opus-4-7/, capabilities: { label: 'Opus 4.7', supportedEffort: ['low','medium','high','xhigh','max'], defaultEffort: 'high', thinkingMode: 'adaptive-only' } },
{ match: /^claude-opus-4-6/, capabilities: { label: 'Opus 4.6', supportedEffort: ['low','medium','high','xhigh','max'], defaultEffort: 'high' } },
```

Splitting now (rather than divergent labels later) keeps room for 4.7-specific fields without a regex change. The `defaultEffort` field stays documentation-only for now - per-role defaults from step 1 are the load-bearing layer.

### 3. Add `thinkingMode` to capabilities; coerce in the SDK adapter

This is the one *correctness* fix from the blog. Opus 4.7 does not support fixed-budget Extended Thinking.

Extend `ModelCapabilities` with `thinkingMode?: 'budgeted' | 'adaptive-only'` (default `'budgeted'`). When `'adaptive-only'`:

- In `backends/claude-sdk.ts:100`, if the resolved `thinking.type === 'enabled'`, downgrade to `{ type: 'adaptive' }`.
- Emit a one-time warning event (engine emits, consumers render - never stdout).
- Track this in `effortSource`-style provenance so the monitor tooltip can show "thinking: adaptive (coerced from enabled)".

Coerce, don't error: existing user configs should keep working. The warning telegraphs the change.

### 4. Make the planner aware it can escalate per-module

Today the planner *can* emit `planEntry.agents[role].effort` overrides (`pipeline.ts:511`), but may not use that lever well. Two small changes:

a. **Document the lever in the planner's structured output schema (Zod).** The per-agent effort field should carry a description like: "Set `xhigh` only for modules with significant ambiguity, novel API design, or large refactors. Default: omit (uses role default)."

b. **Observe it.** `effortSource: 'planner'` provenance is already plumbed (`pipeline.ts:533`); the monitor will make it visible. Use that signal - and an eval comparing planner-driven vs. fixed `high` - to judge whether the planner is using the lever sensibly.

Where to find the planner's schema and prompt: needs a quick grep on `agents/planner` - defer to implementation.

### 5. (Optional, defer) Per-role prompt nudges keyed by model

The blog says 4.7 spawns fewer subagents and calls fewer tools by default. For the **reviewer** role specifically (where parallel exploration is desired), this could matter. Rather than editing prompt files (violates "closed prompts"), add to `ModelCapabilities`:

```ts
rolePromptHints?: Partial<Record<AgentRole, string>>;
```

In the resolver, append `caps.rolePromptHints?.[role]` to `result.promptAppend`. Defer until an actual reviewer-thoroughness regression is observed on 4.7 - premature otherwise.

### 6. (Separate decision) Default model class mappings

If `MODEL_CLASS_DEFAULTS['claude-sdk'].max` currently points at 4.6, the question of when to flip to 4.7 is its own decision (eval signal, release timing). Flag and defer.

### Coordination with the peppy-sunbeam plan

`~/.claude/plans/we-recently-added-to-peppy-sunbeam.md` adds `thinkingSource` provenance and always-render tooltip rows. This Opus 4.7 work introduces a **new** `effortSource` value (`'model-default'`) and (under step 3) potentially a coercion event for thinking. Both should be reflected in the tooltip's source label mapping. Land peppy-sunbeam first (smaller, monitor-scoped); then this PR extends the source enum and the label mapping is a one-line addition.

### Files to modify

- `packages/engine/src/pipeline.ts` (`AGENT_ROLE_DEFAULTS`, `:412`) - add per-role `effort` defaults per the table
- `packages/engine/src/model-capabilities.ts:54` - split 4.6/4.7 entries; add `thinkingMode: 'adaptive-only'` for 4.7
- `packages/engine/src/backend.ts` - extend `ModelCapabilities` with `thinkingMode?: 'budgeted' | 'adaptive-only'` (and optionally `rolePromptHints` for step 5, deferred)
- `packages/engine/src/backends/claude-sdk.ts:100` - coerce `thinking.type === 'enabled'` → `'adaptive'` when capability is `adaptive-only`; emit a warning event
- (Step 4) Planner's Zod output schema - locate via grep; document the per-agent effort field
- Tests (`test/`): resolver - for each role, assert the new default effort applies when no other layer sets it. Capability table - assert 4.6 / 4.7 entries match the right model IDs and 4.7 carries `thinkingMode: 'adaptive-only'`. SDK adapter - assert `enabled` thinking is coerced on 4.7.

## Scope

### In scope

- Per-role effort defaults in `AGENT_ROLE_DEFAULTS` (steps 1)
- Split Opus 4.6/4.7 capability table entries (step 2)
- `thinkingMode` capability field and SDK adapter coercion from `enabled` to `adaptive` on 4.7 (step 3)
- Planner Zod schema documentation for per-agent effort escalation lever (step 4)
- Tests for resolver defaults, capability table entries, and SDK adapter coercion
- Coordination with the peppy-sunbeam plan (land peppy-sunbeam first, then extend source enum)

### Out of scope

- Per-role prompt nudges keyed by model (step 5) - deferred until reviewer-thoroughness regression is observed on 4.7
- Flipping `MODEL_CLASS_DEFAULTS['claude-sdk'].max` to `claude-opus-4-7` (step 6) - separate decision gated on eval signal
- Changes to the peppy-sunbeam plan itself (separate PR, lands first)

### Open questions for the user

- The per-role effort table is a starting proposal - particularly for `builder` (`high` vs `medium`?) and `reviewer` (`high` vs `xhigh`?) - confirm or adjust before implementation.
- Sequencing with the peppy-sunbeam plan: land peppy-sunbeam first (cleaner; gives provenance visibility before changing defaults), then this PR? Or bundle?
- Should `MODEL_CLASS_DEFAULTS['claude-sdk'].max` flip to `claude-opus-4-7` in this PR, or wait for eval signal?

## Acceptance Criteria

1. `pnpm test` passes - new resolver tests verify that for each role in the table, the expected default effort applies when no other layer sets it; existing effort-clamp tests remain untouched.
2. `pnpm type-check` is clean.
3. Capability table has separate entries for Opus 4.6 and 4.7. 4.7 entry carries `thinkingMode: 'adaptive-only'`. Test asserts 4.6 and 4.7 entries match the right model IDs.
4. When `thinking: { type: 'enabled', budgetTokens: N }` is configured and the model is Opus 4.7, the SDK adapter coerces to `{ type: 'adaptive' }`, does not error, and emits a one-time warning event. Test covers this path.
5. Coercion provenance is tracked (`effortSource`-style) so the monitor tooltip can show "thinking: adaptive (coerced from enabled)".
6. Planner's Zod output schema documents the per-agent effort override field with guidance on when to use `xhigh`.
7. A small build run with `claude-opus-4-7` shows each role with the expected default effort and `effortSource: default` in the monitor (per peppy-sunbeam labels).
8. A build run with an explicit `thinking: { type: 'enabled', budgetTokens: 10000 }` config on Opus 4.7 completes without error, the SDK request shows adaptive thinking, and a warning event appears.
9. Eval gate: standard eval suite run with the new per-role defaults; compare pass rate and token usage to baseline.
