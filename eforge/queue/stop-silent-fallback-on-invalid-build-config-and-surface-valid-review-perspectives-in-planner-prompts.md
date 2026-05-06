---
title: Stop silent fallback on invalid build-config and surface valid review perspectives in planner prompts
created: 2026-05-06
---

# Stop silent fallback on invalid build-config and surface valid review perspectives in planner prompts

## Problem / Motivation

Plan 1 (`feat(tighten-review-perspective-schema-and-surface-failures-from-parallel-reviewer)`) tightened `pipelineReviewProfileConfigSchema.perspectives` to `z.enum(REVIEW_PERSPECTIVES)`, so the six valid perspective names (`code, security, api, docs, test, verify`) are now schema-enforced. That fix closes the build-time runtime hole, but two upstream gaps remain that will reproduce the same silent-failure shape on the next expedition:

1. **Silent fallback in `parseBuildConfigBlock`** (`packages/engine/src/agents/common.ts:381`). The module-planner emits per-plan build/review config inside a `<build-config>` JSON block. If `safeParse` fails - e.g. because the model picked `"correctness"` again - the parser returns `null` and `compile-stages.ts:173-177` silently falls back to the composer's `defaultReview`. No event, no warning, no log entry. The user-intended per-plan review config is dropped without anyone noticing - exactly the silent-failure shape Plan 1 just fixed at a different layer.

2. **Prompt vocabulary mismatch.** The model picks `correctness/architecture/completeness/cohesion` for build-time perspectives because (a) those are real *issue categories* used by `architecture-reviewer`, `plan-reviewer`, and `cohesion-reviewer`, so the vocabulary is fresh in the model's working context during expedition planning; and (b) the human-readable prompt copy is incomplete or absent:
   - `packages/engine/src/prompts/planner.md:458` enumerates only `code, security, api, docs` (missing `test, verify`)
   - `packages/engine/src/prompts/module-planner.md:159` enumerates only `code, security, api, docs`
   - `packages/engine/src/prompts/pipeline-composer.md` enumerates none in human-readable form (only the schema YAML constraint via `{{schema}}`)

   The schema YAML now contains the enum, but the prompt copy is the more salient signal at generation time. The model needs an explicit nudge plus a complete list to resist the planning-vocabulary bias.

## Goal

Make the same silent-fallback bug shape impossible at the upstream parser, and steer the planner/composer agents away from the planning-review vocabulary by surfacing the valid build-time perspective list in their prompts.

## Approach

### 1. Surface validation failures from `parseBuildConfigBlock`

Change the parser's contract from "returns null on any failure" to "returns either parsed config or a structured error", and wire a domain event at the call site so the failure is visible in the timeline.

In `packages/engine/src/agents/common.ts`:

```ts
export type ParseBuildConfigResult =
  | { ok: true; config: { build: BuildStageSpec[]; review: ReviewProfileConfig } }
  | { ok: false; reason: 'no-block' }
  | { ok: false; reason: 'invalid-json'; raw: string }
  | { ok: false; reason: 'invalid-schema'; raw: string; errors: string[] };

export function parseBuildConfigBlock(text: string): ParseBuildConfigResult {
  const match = text.match(/<build-config>([\s\S]*?)<\/build-config>/);
  if (!match) return { ok: false, reason: 'no-block' };

  const raw = match[1].trim();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return { ok: false, reason: 'invalid-json', raw }; }

  const result = buildConfigSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: 'invalid-schema', raw, errors: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
  }
  return { ok: true, config: result.data };
}
```

In `packages/engine/src/pipeline/stages/compile-stages.ts:173-177`, branch on the result. On `'invalid-schema'` or `'invalid-json'`, emit a domain event before falling back so the failure is recorded:

```ts
const result = parseBuildConfigBlock(event.content);
if (result.ok) {
  ctx.moduleBuildConfigs.set(mod.id, result.config);
} else if (result.reason === 'invalid-schema' || result.reason === 'invalid-json') {
  yield {
    timestamp: new Date().toISOString(),
    type: 'planning:module:build-config:invalid',
    moduleId: mod.id,
    reason: result.reason,
    errors: result.reason === 'invalid-schema' ? result.errors : [],
  };
  // Fall through to default — but the failure is now visible
}
// 'no-block' is fine — module planner just didn't emit one
```

Add the new event variant to `EforgeEvent` in `packages/client/src/events.ts`:

```ts
| { type: 'planning:module:build-config:invalid'; moduleId: string; reason: 'invalid-json' | 'invalid-schema'; errors: string[] }
```

If the pure-event-reducer registry has landed, also add a registry entry. UI: render in the timeline like a non-fatal warning event (no swim-lane bar, surfaced in the run-state log).

### 2. Inject `REVIEW_PERSPECTIVES` as a template variable

Update `loadPrompt` callers for the three planner-tier agents to inject the valid perspective set as `{{validPerspectives}}`. The list comes from `REVIEW_PERSPECTIVES` in `@eforge-build/client` (single source of truth - same constant the schema enum is built from).

Touch points:
- `packages/engine/src/agents/planner.ts` - wherever `loadPrompt('planner', { ... })` is called, add `validPerspectives: REVIEW_PERSPECTIVES.join(', ')`.
- `packages/engine/src/agents/module-planner.ts` - same.
- `packages/engine/src/agents/pipeline-composer.ts` - same.

### 3. Edit the prompt copy

In `packages/engine/src/prompts/planner.md` (around line 458), replace the hardcoded list with the template variable, and add the anti-list:

```markdown
- `perspectives` — array of review perspectives. Valid: `{{validPerspectives}}`.

  **Do NOT use** `correctness`, `architecture`, `completeness`, `cohesion`, `feasibility`, `dependency`, `scope`, or `performance` as perspectives. Those terms are *issue categories* used by the planning-review agents (`architecture-reviewer`, `plan-reviewer`, `cohesion-reviewer`) — not build-time review perspectives. The build-time `reviewer` agent only knows the names listed above.
```

Apply the same pattern in `packages/engine/src/prompts/module-planner.md:159`.

In `packages/engine/src/prompts/pipeline-composer.md`, add a new bullet under the "Guidelines" section (near line 60) - pipeline-composer currently has zero perspective enumeration in human-readable form:

```markdown
- **Review perspectives must come from this set:** `{{validPerspectives}}`. Do NOT use `correctness`, `architecture`, `completeness`, `cohesion`, `feasibility`, `dependency`, `scope`, or `performance` — those are issue categories used by planning-review agents, not build-time perspectives.
```

## Scope

**In scope:**
- The `parseBuildConfigBlock` signature change and the corresponding call site in `compile-stages.ts`.
- The new `planning:module:build-config:invalid` event type (events.ts + reducer + registry entry if the pure-event-reducer expedition has merged).
- Template-variable injection in the three planner-tier agents.
- Prompt edits in three files.
- `DAEMON_API_VERSION` bump (additive event variant).

**Out of scope:**
- Adding `correctness` / `architecture` as new build-time review perspectives (they're already covered by the planning-review pipeline; out of scope per separate decision).
- Changing the planning-review agents' issue categories.
- Reworking the `<build-config>` XML/JSON wire format itself.

## Acceptance Criteria

1. A module-planner that produces `<build-config>` with `perspectives: ["correctness"]` causes a `planning:module:build-config:invalid` event to be recorded in the run-state log, naming the module ID and the validation error. The compiler then falls back to defaults - the existing safety net is preserved, but the failure is no longer silent.
2. `parseBuildConfigBlock` no longer returns `null` on validation failure; existing call sites have been updated to consume the new tagged-union result type.
3. Loading any of `planner.md`, `module-planner.md`, `pipeline-composer.md` resolves `{{validPerspectives}}` to the same list the schema enum enforces. Adding a new perspective to `REVIEW_PERSPECTIVES` in `@eforge-build/client` automatically updates all three prompts on the next load.
4. The three prompts contain an explicit "Do NOT use" line listing the planning-review categories, naming the planning-review agents that own those terms.
5. `pnpm type-check`, `pnpm test`, `pnpm build` pass.
