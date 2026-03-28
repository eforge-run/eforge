---
title: Fix Planner Profile Selection Errand Bias
created: 2026-03-28
status: pending
---

# Fix Planner Profile Selection Errand Bias

## Problem / Motivation

The planner agent selects the "errand" profile too often, even for large refactors. This matters because errand's compile stages (`['prd-passthrough']`) cause the plan-review-cycle to be **skipped entirely** - plans go straight to build without quality review.

The root cause is in the planner prompt, not the pipeline mechanics. The pipeline correctly skips plan review when errand is selected (index-based iteration advances past the shortened compile list). The problem is the prompt biases the LLM toward errand through several mechanisms:

1. **"This is the common case" language** (`planner.md` line 95) - explicitly tells the LLM errand is the default
2. **No "when to use errand" criteria** - the prompt has "when NOT to use expedition" but no equivalent errand guardrails
3. **No consequence explanation** - the LLM doesn't know errand skips plan review
4. **Plan count conflated with profile** (line 339) - `"mode must match the plan count: errand for 1 plan"` equates single-plan with errand
5. **Profile table lacks impact info** - `formatProfileDescriptions` shows only a short description, no pipeline consequences

## Goal

Eliminate the errand bias in the planner prompt so that excursion becomes the default for most feature work and refactors, reserving errand for truly trivial changes - ensuring non-trivial work goes through plan review before build.

## Approach

### 1. Rewrite Profile Selection section in planner prompt

**File**: `src/engine/prompts/planner.md` (lines 53-69)

Replace the sparse selection criteria with structured decision guidance:

- Add concrete "Use errand" criteria: typo fixes, single-line config changes, single-file bug fixes - truly trivial work
- State that **errand skips plan review** - plans go directly to build
- Position excursion as the default for "most feature work and refactors"
- Add tiebreaker: "When in doubt between errand and excursion, choose excursion"
- Keep the existing expedition anti-patterns (already good)

### 2. Remove "common case" bias

**File**: `src/engine/prompts/planner.md` (line 95)

Remove `"This is the common case."` and the `(errand)` / `(excursion)` parentheticals from the plan count guidance. Plan count should be a sizing decision independent of profile choice.

### 3. Decouple `mode` field from plan count

**File**: `src/engine/prompts/planner.md` (line 339)

Change from:
```
mode must match the plan count: errand for 1 plan, excursion for 2-3 plans
```
To:
```
mode must match the selected profile name
```

### 4. Neutralize orchestration.yaml example

**File**: `src/engine/prompts/planner.md` (line 303)

Replace the hardcoded `mode: errand` in the example with a template placeholder `mode: {selected profile name}` so the example doesn't privilege any particular profile. This aligns with item 3 (mode matches selected profile).

### 5. Add consequence column to profile table

**File**: `src/engine/agents/planner.ts` - `formatProfileDescriptions()`

Add a "Pipeline Effect" column showing what each profile means:
- errand: "Skips plan review - plan goes directly to build"
- excursion: "Includes plan review before build"
- expedition: "Full architecture review, module planning, and cohesion review"
- Custom profiles: shows compile stages as fallback

## Scope

**In scope:**
- `src/engine/prompts/planner.md` - prompt changes (items 1-4)
- `src/engine/agents/planner.ts` - `formatProfileDescriptions()` enhancement (item 5)

**Out of scope:**
- Pipeline mechanics (already working correctly)
- Changes to profile definitions or compile stage behavior
- Changes to any agents other than the planner

## Acceptance Criteria

- `pnpm type-check` passes with no type errors from the `planner.ts` change
- `pnpm test` passes (profile formatting, config resolution, and all existing tests)
- The "This is the common case" language and `(errand)` / `(excursion)` parentheticals are removed from plan count guidance
- The `mode` field guidance no longer equates plan count with profile selection
- The orchestration.yaml example uses a neutral placeholder instead of hardcoded `mode: errand`
- The profile selection section includes concrete errand criteria (typo fixes, single-line config changes, single-file bug fixes), states that errand skips plan review, positions excursion as the default, and includes a tiebreaker favoring excursion
- `formatProfileDescriptions()` includes a "Pipeline Effect" column describing the consequence of each profile
- Manual: running the planner on a multi-file refactor PRD results in excursion selection
- Manual: running the planner on a trivial change PRD still results in errand selection
