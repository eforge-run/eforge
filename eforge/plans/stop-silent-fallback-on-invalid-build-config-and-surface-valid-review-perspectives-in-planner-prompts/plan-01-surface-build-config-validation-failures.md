---
id: plan-01-surface-build-config-validation-failures
name: Surface build-config validation failures and inject valid perspectives
  into planner prompts
branch: stop-silent-fallback-on-invalid-build-config-and-surface-valid-review-perspectives-in-planner-prompts/plan-01-surface-build-config-validation-failures
agents:
  builder:
    effort: high
    rationale: "Coordinated multi-file change: parser API change + new wire-protocol
      event variant (with DAEMON_API_VERSION bump and exhaustiveness check
      propagation) + template variable injection across three agents and three
      prompt files. The shape of the work is mechanically uniform but spans
      engine, client, monitor-ui, prompts, and tests; getting the tagged-union
      return type and the new event schema right in one pass benefits from
      thorough reasoning."
  reviewer:
    effort: high
    rationale: Wire-protocol additions (event schema + DAEMON_API_VERSION) and
      parser-contract changes need careful review for completeness — especially
      that all parseBuildConfigBlock callers and tests have been migrated to the
      tagged-union shape, and that the new event variant is added to both the
      discriminated union and the monitor-ui exhaustiveness check.
---


# Surface build-config validation failures and inject valid perspectives into planner prompts

## Architecture Context

This plan closes two upstream gaps left by the prior expedition that tightened `pipelineReviewProfileConfigSchema.perspectives` to `z.enum(REVIEW_PERSPECTIVES)`:

1. **Silent parser fallback** — `parseBuildConfigBlock` (`packages/engine/src/agents/common.ts:370`) returns `null` on any failure (no block / invalid JSON / schema mismatch). The single caller in `packages/engine/src/pipeline/stages/compile-stages.ts:171-177` treats `null` uniformly as "no per-plan config; use composer default," so a model that emits `perspectives: ["correctness"]` silently loses its per-plan review intent with no log line, no event, and no surface in the timeline.
2. **Prompt vocabulary mismatch** — Planner-tier agents pick `correctness/architecture/completeness/cohesion` because (a) those terms are real *issue categories* used by `architecture-reviewer`, `plan-reviewer`, and `cohesion-reviewer`, so the vocabulary is fresh in the model's working context; and (b) the human-readable prompt copy in `planner.md`, `module-planner.md`, and `pipeline-composer.md` either lists an incomplete perspective set or no list at all (the constraint exists only inside the `{{schema}}` YAML).

The constant `REVIEW_PERSPECTIVES = ['code', 'security', 'api', 'docs', 'test', 'verify']` lives in `packages/client/src/events.schemas.ts:59` and is re-exported from `@eforge-build/client`. It is already the source of truth that both `pipelineReviewProfileConfigSchema.perspectives` (`packages/engine/src/config.ts:110`) and `ReviewProfileConfigSchema.perspectives` (`packages/engine/src/schemas.ts:457`) are built from. This plan extends that single-source-of-truth pattern into the prompt layer.

Key existing wiring this plan integrates with:

- `packages/engine/src/prompts.ts` — `loadPrompt(filename, vars)` performs `{{name}}` token substitution and **throws** if any tokens remain unresolved. Adding `{{validPerspectives}}` to a prompt without supplying it from every caller is a hard load-time failure, which is exactly the safety net we want.
- `packages/client/src/events.schemas.ts` — wire-protocol source of truth. `EforgeEventSchema` is a discriminated union; new variants are appended and `EforgeEvent` is derived via `z.infer`.
- `packages/monitor-ui/src/lib/reducer/index.ts` — flat handler registry plus `IGNORED_EVENT_TYPES` array, gated by a compile-time `_Exhaustive` check. New event variants must appear in one of the two lists or `pnpm type-check` fails.
- `packages/client/src/api-version.ts:17` — `DAEMON_API_VERSION` precedent: the previous bump from v19 -> v20 was an additive event variant (`plan:build:review:parallel:perspective:error`). We follow the same precedent for `planning:module:build-config:invalid`.

## Implementation

### Overview

Four coordinated changes land in a single plan because they are tightly coupled by types and tests:

1. Change `parseBuildConfigBlock` from `(text) => Config | null` to a discriminated `ParseBuildConfigResult` tagged union with reasons `'no-block' | 'invalid-json' | 'invalid-schema'`. Update its single production call site in `compile-stages.ts` and its four unit tests in `test/per-plan-build-config.test.ts`.
2. Add a new event variant `planning:module:build-config:invalid` to the wire-protocol schema and bump `DAEMON_API_VERSION` from 20 -> 21. Wire the variant into the monitor-ui exhaustiveness check (in `IGNORED_EVENT_TYPES`, since this is a non-fatal warning event with no UI state effect — same treatment as `planning:warning`).
3. Inject `validPerspectives: REVIEW_PERSPECTIVES.join(', ')` into the three planner-tier `loadPrompt` calls.
4. Edit the three prompt files to consume `{{validPerspectives}}` and add the explicit "Do NOT use ..." anti-list naming the planning-review categories.

### Key Decisions

1. **Tagged-union over null** — The PRD specifies a discriminated `ParseBuildConfigResult`. We follow the PRD exactly. This makes invalid-schema observably distinct from no-block at every call site, eliminating the "silently pretend nothing happened" failure mode at the type level.
2. **Emit only on real failures** — `'no-block'` is the normal case (the module planner did not emit a build-config) and must NOT produce a `planning:module:build-config:invalid` event, only `'invalid-json'` and `'invalid-schema'` do. Otherwise every module that omits the block would produce noise.
3. **Single source of truth: `REVIEW_PERSPECTIVES`** — All three prompts pull the same exported constant via `loadPrompt` template substitution. Adding a new perspective in `events.schemas.ts` propagates automatically on next prompt load. No string duplication across `.md` files.
4. **Bump DAEMON_API_VERSION** — Adding a new SSE event variant follows the established v19 -> v20 precedent (which itself added `plan:build:review:parallel:perspective:error`). Bump to v21 with a one-line comment noting the addition.
5. **Monitor UI: ignored, not handled** — The new event is a non-fatal warning that does not mutate UI run-state. Adding it to `IGNORED_EVENT_TYPES` (alongside `planning:warning`) keeps the exhaustiveness check happy without adding an unused state-mutation handler. The UI's existing planning-warning surfacing path (console + run-state log) is the precedent.
6. **No SSE `"warning"`-style downgrade** — The PRD calls for a *named* event (`planning:module:build-config:invalid`), not a generic `planning:warning`. Keeping it named preserves grep-ability for the failure shape and makes targeted UI surfacing trivial later.

## Scope

### In Scope
- Tagged-union return type for `parseBuildConfigBlock` and migration of its one production call site and four unit tests.
- New event variant `planning:module:build-config:invalid` with `moduleId: string`, `reason: 'invalid-json' | 'invalid-schema'`, and `errors: string[]`.
- `DAEMON_API_VERSION` bump from 20 to 21 with updated inline comment.
- Monitor UI exhaustiveness wiring (add to `IGNORED_EVENT_TYPES`).
- `validPerspectives` template-variable injection in `planner.ts`, `module-planner.ts`, `pipeline-composer.ts`.
- Prompt edits in `planner.md` (line ~458), `module-planner.md` (line ~159), and `pipeline-composer.md` (Guidelines section near line ~60), each with an explicit "Do NOT use" anti-list naming `architecture-reviewer`, `plan-reviewer`, `cohesion-reviewer` as the agents that own the planning-review category vocabulary.
- New unit test verifying invalid-schema input now returns `{ ok: false, reason: 'invalid-schema', errors: [...] }`.

### Out of Scope
- Adding `correctness` / `architecture` as new build-time review perspectives (PRD explicitly out of scope).
- Changing the planning-review agents' issue categories.
- Reworking the `<build-config>` XML/JSON wire format itself.
- Adding a dedicated UI swim-lane bar or dedicated component for the new event variant — `IGNORED_EVENT_TYPES` placement matches `planning:warning` precedent. Future UI surfacing can land separately.
- Pure-event-reducer registry entry — no such registry exists in the current tree; this is the registered handler-registry pattern in `packages/monitor-ui/src/lib/reducer/index.ts`, and adding the variant to `IGNORED_EVENT_TYPES` is the documented way to satisfy the exhaustiveness check.

## Files

### Create
_(none — all changes are in existing files)_

### Modify

- `packages/engine/src/agents/common.ts`
  - Replace the body of `parseBuildConfigBlock` with the tagged-union version specified in the PRD. Export a new `ParseBuildConfigResult` type with the four variants `{ ok: true; config }`, `{ ok: false; reason: 'no-block' }`, `{ ok: false; reason: 'invalid-json'; raw: string }`, `{ ok: false; reason: 'invalid-schema'; raw: string; errors: string[] }`.
  - Map `result.error.issues` to `errors: string[]` via `i => \`${i.path.join('.')}: ${i.message}\`` so each entry is human-readable in the timeline.
  - Update the function's JSDoc to document the new contract (no longer returns null).

- `packages/engine/src/pipeline/stages/compile-stages.ts`
  - Update the call site in `runModulePlannerAttempt` (around lines 171-177) to branch on `result.ok`. On `result.ok === true`, store into `ctx.moduleBuildConfigs.set(mod.id, result.config)`. On `result.reason === 'invalid-schema' || result.reason === 'invalid-json'`, `yield` a `planning:module:build-config:invalid` event with `moduleId`, `reason`, and `errors` (use `[]` when reason is `invalid-json` since errors are JSON-parse-level, not schema-level — the `raw` payload could optionally be appended to errors as a single entry like `\`raw: ${result.raw.slice(0, 200)}\`` for diagnosability, choose whichever the implementer judges clearer; the timestamp must be `new Date().toISOString()` to match sibling events). On `result.reason === 'no-block'`, do nothing — that is the normal case.
  - Do not crash or abort on invalid input; the existing fallback to composer defaults is preserved by intent.

- `packages/client/src/events.schemas.ts`
  - Add a new variant to the `EforgeEventSchema` discriminated union. Place it near the other `planning:*` variants (around the existing `planning:warning` block, lines 380-393, is the natural neighborhood):
    ```ts
    z.object({
      type: z.literal('planning:module:build-config:invalid'),
      moduleId: z.string(),
      reason: z.enum(['invalid-json', 'invalid-schema']),
      errors: z.array(z.string()),
    }),
    ```
  - The `EforgeEvent` type is already `z.infer<typeof EforgeEventSchema>` so the type updates automatically.

- `packages/client/src/api-version.ts`
  - Bump `DAEMON_API_VERSION` from 20 to 21.
  - Update the inline comment to: `// v21: Added planning:module:build-config:invalid event variant; surfaces invalid <build-config> JSON or schema failures from the module planner.`

- `packages/monitor-ui/src/lib/reducer/index.ts`
  - Add `'planning:module:build-config:invalid'` to the `IGNORED_EVENT_TYPES` array. Place it near `'planning:warning'` (around line 89-91 in the registry's neighborhood — but it goes in the IGNORED list, not the handler registry, since this event has no run-state effect). Compile-time `_Exhaustive` check will fail until this entry is present, which is the desired safety net.

- `packages/engine/src/agents/planner.ts`
  - Import `REVIEW_PERSPECTIVES` from `'../events.js'` (already re-exported there) or `'@eforge-build/client'` (current import style varies in this file — match whichever is already used; if the file does not currently import from events, prefer the same path used by other engine files like `packages/engine/src/config.ts:12`).
  - In the `loadPrompt('planner', { ... })` call (line 202), add `validPerspectives: REVIEW_PERSPECTIVES.join(', ')` to the variables object.

- `packages/engine/src/agents/module-planner.ts`
  - Same change: import `REVIEW_PERSPECTIVES` and add `validPerspectives: REVIEW_PERSPECTIVES.join(', ')` to the `loadPrompt('module-planner', { ... })` call (line 36).

- `packages/engine/src/agents/pipeline-composer.ts`
  - Same change: import `REVIEW_PERSPECTIVES` and add `validPerspectives: REVIEW_PERSPECTIVES.join(', ')` to the `loadPrompt('pipeline-composer', { ... })` call (line 89).

- `packages/engine/src/prompts/planner.md`
  - At line 458, replace the current bullet:
    ```
    - `perspectives` — array of review perspectives: `code`, `security`, `api`, `docs`.
    ```
    with:
    ```
    - `perspectives` — array of review perspectives. Valid: `{{validPerspectives}}`.

      **Do NOT use** `correctness`, `architecture`, `completeness`, `cohesion`, `feasibility`, `dependency`, `scope`, or `performance` as perspectives. Those terms are *issue categories* used by the planning-review agents (`architecture-reviewer`, `plan-reviewer`, `cohesion-reviewer`) — not build-time review perspectives. The build-time `reviewer` agent only knows the names listed above.
    ```

- `packages/engine/src/prompts/module-planner.md`
  - At line 159, replace the current bullet:
    ```
      - `perspectives` — array of review perspectives: `code`, `security`, `api`, `docs`
    ```
    with the same pattern as `planner.md` (use `{{validPerspectives}}` and add the "Do NOT use" anti-list calling out the planning-review agents by name).

- `packages/engine/src/prompts/pipeline-composer.md`
  - In the "Guidelines" section near line 60 (after the `Match review strictness to risk` bullet), add a new bullet:
    ```
    - **Review perspectives must come from this set:** `{{validPerspectives}}`. Do NOT use `correctness`, `architecture`, `completeness`, `cohesion`, `feasibility`, `dependency`, `scope`, or `performance` — those are issue categories used by planning-review agents (`architecture-reviewer`, `plan-reviewer`, `cohesion-reviewer`), not build-time perspectives.
    ```

- `test/per-plan-build-config.test.ts`
  - Update all four existing `parseBuildConfigBlock` tests (lines 160-203) to consume the new tagged-union shape:
    - `parses valid JSON with build and review fields` — assert `result.ok === true` and read `result.config.build` / `result.config.review`.
    - `returns null when no block is present` — rename to `returns no-block when no block is present` and assert `{ ok: false, reason: 'no-block' }`.
    - `returns null on invalid JSON content` — rename to `returns invalid-json on malformed JSON` and assert `result.ok === false && result.reason === 'invalid-json'` plus `typeof result.raw === 'string'`.
    - `returns null when JSON does not match schema` — rename to `returns invalid-schema with errors when JSON does not match schema` and assert `result.ok === false && result.reason === 'invalid-schema'` and `result.errors.length > 0`.
    - `returns null when review field is missing` — same treatment: assert `invalid-schema` with non-empty errors.
  - Add one new test: a `<build-config>` with `perspectives: ["correctness"]` returns `{ ok: false, reason: 'invalid-schema' }` and `errors` contains an entry mentioning `perspectives`. This is the regression-witness test that ties this plan to the original silent-failure bug.

## Verification

- [ ] `parseBuildConfigBlock('text with no <build-config> block')` returns `{ ok: false, reason: 'no-block' }`.
- [ ] `parseBuildConfigBlock('<build-config>not valid json</build-config>')` returns `{ ok: false, reason: 'invalid-json', raw: 'not valid json' }`.
- [ ] `parseBuildConfigBlock` called with `<build-config>{"build":["implement"],"review":{"strategy":"single","perspectives":["correctness"],"maxRounds":1,"evaluatorStrictness":"standard"}}</build-config>` returns `{ ok: false, reason: 'invalid-schema', raw: ..., errors: [...] }` and `errors` contains at least one entry whose path includes `review.perspectives`.
- [ ] `parseBuildConfigBlock` called with a fully valid block returns `{ ok: true, config: { build, review } }` with the parsed fields.
- [ ] No production call site of `parseBuildConfigBlock` references `=== null` or `!= null` after the change. (One production call site in `compile-stages.ts`; verify by grep.)
- [ ] `EforgeEvent` discriminated union includes `'planning:module:build-config:invalid'` with the three required fields (`moduleId`, `reason`, `errors`).
- [ ] `DAEMON_API_VERSION` exported value is `21`, and the inline comment names `planning:module:build-config:invalid` as the additive variant.
- [ ] `pnpm type-check` passes with the monitor-ui `_Exhaustive` check satisfied (confirms `planning:module:build-config:invalid` is in `IGNORED_EVENT_TYPES`).
- [ ] Loading `planner.md` via `loadPrompt('planner', { ..., validPerspectives: 'code, security, api, docs, test, verify' })` produces text that contains the literal string `code, security, api, docs, test, verify` AND the literal string `Do NOT use` AND `architecture-reviewer`. (A small unit test with a stub or filesystem read covers this; otherwise confirm via grep on the post-substituted output during a local run.)
- [ ] Loading `module-planner.md` produces output containing `code, security, api, docs, test, verify` and `Do NOT use`.
- [ ] Loading `pipeline-composer.md` produces output containing `code, security, api, docs, test, verify` and `Do NOT use`.
- [ ] Loading any of the three prompts WITHOUT supplying `validPerspectives` raises a `loadPrompt(...): unresolved template variables: validPerspectives` error from `packages/engine/src/prompts.ts` (this is the existing safety behavior; verify it surfaces correctly when a future caller forgets the variable).
- [ ] All four updated unit tests in `test/per-plan-build-config.test.ts` pass against the new tagged-union return type.
- [ ] The new regression-witness test (perspectives: ['correctness'] -> invalid-schema with errors mentioning perspectives) passes.
- [ ] `pnpm type-check` exits 0.
- [ ] `pnpm test` exits 0.
- [ ] `pnpm build` exits 0.
