---
title: Fix: Build phase ignores profile selected during compile
created: 2026-03-18
status: pending
---

## Problem / Motivation

When the planner selects a custom profile (e.g., `docs` from `eforge.yaml`) during the compile phase, the selection is correctly applied via the `plan:profile` event in `pipeline.ts:300-310`, updating `ctx.profile`. However, the `build()` method in `eforge.ts:338` creates a fresh context and hardcodes `config.profiles['excursion']` — completely ignoring the profile chosen during compile.

This means a `docs` profile declaring `build: [implement]` still runs the full excursion build stages `[['implement', 'doc-update'], 'review', 'review-fix', 'evaluate']`, spawning the doc-updater agent alongside the builder. The `compile()` and `build()` methods share no state — the selected profile is local to the compile `PipelineContext` and never persisted.

**Root cause**: `src/engine/eforge.ts:338`:
```typescript
const buildProfile = config.profiles['excursion']; // always excursion, ignores compile selection
```

## Goal

Persist the fully resolved profile in `orchestration.yaml` so that the build phase uses the profile selected during compile, allowing dynamically generated and custom profiles to survive the compile→build boundary.

## Approach

1. **Add `profile` to `OrchestrationConfig`** — `src/engine/events.ts` (line 46-54): add a required `profile: import('./config.js').ResolvedProfileConfig` field.

2. **Write resolved profile to orchestration.yaml during compile** —
   - `src/engine/plan.ts` — `writePlanArtifacts()` (line 432): add `profile: ResolvedProfileConfig` to `WritePlanArtifactsOptions` and serialize the full profile object into orchestration.yaml.
   - `src/engine/compiler.ts` — `compileExpedition()` (line 117): accept `profile` parameter, write it to orchestration.yaml.

3. **Parse resolved profile from orchestration.yaml** — `src/engine/plan.ts` — `parseOrchestrationConfig()` (line 163): read the `profile` object from parsed YAML and validate through `resolvedProfileConfigSchema.safeParse()` for integrity.

4. **Pass resolved profile through the compile pipeline** —
   - `src/engine/pipeline.ts` — planner stage (around line 275-340): the stage already updates `ctx.profile` on `plan:profile` events (line 300-310). Pass `ctx.profile` through to `writePlanArtifacts()` wherever plan artifacts are written.
   - `src/engine/pipeline.ts` — compile-expedition stage: pass `ctx.profile` to the compiler.

5. **Build method uses persisted profile** — `src/engine/eforge.ts` — `build()` method (line 338): after parsing orchestration config, use `orchConfig.profile` directly:
   ```typescript
   const buildProfile = orchConfig.profile;
   ```

## Scope

**In scope:**
- `src/engine/events.ts` — add `profile: ResolvedProfileConfig` to `OrchestrationConfig`
- `src/engine/plan.ts` — write resolved profile in `writePlanArtifacts()`, parse it in `parseOrchestrationConfig()`
- `src/engine/pipeline.ts` — pass `ctx.profile` through to artifact-writing functions
- `src/engine/eforge.ts` — use `orchConfig.profile` instead of hardcoding excursion
- `src/engine/compiler.ts` — write resolved profile to orchestration.yaml for expeditions
- Tests for orchestration.yaml round-tripping and config profile resolution

**Out of scope:**
- N/A

## Acceptance Criteria

- `writePlanArtifacts` with a resolved profile round-trips through `parseOrchestrationConfig` — write with a resolved profile, parse back, assert the profile object matches.
- `parseOrchestrationConfig` reads a full profile object from hand-crafted YAML with an inline profile block and returns all fields present.
- `parseOrchestrationConfig` rejects missing or malformed profile — YAML without `profile` or with invalid shape throws.
- A docs-like profile `{ extends: 'errand', build: ['implement'] }` resolves to exactly `build: ['implement']`.
- `pnpm test` — all existing and new tests pass.
- `pnpm type-check` — no type errors.
- Manual verification: `eforge run` with a source that triggers the `docs` profile confirms the monitor shows only `builder` (no `doc-updater`) during build.
