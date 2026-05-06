---
id: plan-01-tighten-review-perspectives
name: Tighten review-perspective schema and surface parallel-reviewer failures
branch: tighten-review-perspective-schema-and-surface-failures-from-parallel-reviewer/plan-01-tighten-review-perspectives
---

# Tighten review-perspective schema and surface parallel-reviewer failures

## Architecture Context

The `review.perspectives` field threads through three layers:

1. **Wire-protocol schemas (`@eforge-build/client`)** — `events.schemas.ts` defines `ReviewPerspectiveSchema = z.enum(['code','security','api','docs','test','verify'])` (line 59) and uses it in three event variants (`plan:build:review:parallel:start`, `:perspective:start`, `:perspective:complete`). The `ReviewProfileConfigSchema` in the same file (line 83-89) currently uses `perspectives: z.array(z.string())` — the loosely typed leak that lets bad names through.
2. **Engine config schemas (`packages/engine/`)** — both `schemas.ts` (pipeline composer output validation, line 454-460) and `config.ts` (orchestration.yaml/plan-frontmatter validation, line 108-114) define a `reviewProfileConfigSchema` bound to `ReviewProfileConfig`. Both currently use `z.array(z.string()).nonempty()` for perspectives.
3. **Runtime fan-out (`packages/engine/src/agents/parallel-reviewer.ts`)** — `PERSPECTIVE_PROMPTS` and `PERSPECTIVE_SCHEMA_YAML` are `Record<ReviewPerspective, …>` keyed by the same six names. When a bad name is passed, lookup returns `undefined`, the call to `PERSPECTIVE_SCHEMA_YAML[perspective]()` throws synchronously, and `runParallel` (`concurrency.ts:144-149`) silently swallows the throw — see comment there: "Individual task failures are non-fatal — swallowed here. Callers wrap their run() generators to emit domain-specific error events." That contract was never honored for the perspective task, so the swim lane never starts and the build proceeds as if review passed.

Key UI/registry constraints:

- **`packages/client/src/event-registry.ts`** has an `_Exhaustive` type check (line 1284-1289) — every `EforgeEvent['type']` MUST have a registry entry. Adding a new event variant without registering it is a compile error.
- **`packages/monitor-ui/src/lib/reducer/index.ts`** has the same exhaustiveness gate (line 282-296) — every event must be in `handlerRegistry` or `IGNORED_EVENT_TYPES`.
- **`packages/eforge/src/cli/display.ts`** uses a `default:` case (line 863-873) that pulls from `getEventSummary(event)` — no explicit case is required.

The other six existing perspective lifecycle events (`:parallel:start`, `:perspective:start`, `:perspective:complete`) are all `scope: 'session', persist: false` in the registry. The new `:perspective:error` event follows the same pattern.

## Implementation

### Overview

Lift the perspective vocabulary to a single `REVIEW_PERSPECTIVES` const in `events.schemas.ts`, derive `ReviewPerspectiveSchema` and `ReviewPerspective` from it, and re-export the const through `events.ts`, `index.ts`, and `browser.ts`. Replace the loose `z.array(z.string())` with `z.array(z.enum(REVIEW_PERSPECTIVES))` in both engine config schemas (`packages/engine/src/schemas.ts` and `packages/engine/src/config.ts`) and fix the misleading `"performance"` example in the config.ts `.describe()`. Wrap the per-perspective task body in `parallel-reviewer.ts` in try/catch so any future runtime throw — not just the now-impossible bad-name throw — surfaces as a `plan:build:review:parallel:perspective:error` event. Register the new event variant in `events.schemas.ts`, `event-registry.ts`, and `IGNORED_EVENT_TYPES` (monitor-ui reducer), and bump `DAEMON_API_VERSION` from 19 to 20.

### Key Decisions

1. **`REVIEW_PERSPECTIVES` lives in `events.schemas.ts` (the wire-protocol source of truth), not in a new file.** This keeps the const, the schema, and the type co-located (same file as `ReviewPerspectiveSchema` on line 59 today), preserves the AGENTS.md rule that event types and schemas are co-located, and adds zero new modules. The const is then re-exported through `events.ts`, `index.ts`, and `browser.ts` so engine code can `import { REVIEW_PERSPECTIVES } from '@eforge-build/client'`.
2. **The new `:perspective:error` event uses `perspective: z.string()`, not `ReviewPerspectiveSchema`.** Per the PRD: "Use `perspective: string` (not `ReviewPerspective`) on the error variant — the whole point is to surface invalid names that wouldn't fit the enum." Even after the enum tightening makes bad names a compile-time failure, runtime errors from a future SDK/harness change inside `harness.run` should still be capturable, and we don't want a Zod parse failure on the error envelope itself when the perspective string falls outside the enum for a different reason.
3. **Try/catch wraps the entire perspective task body, not just the prompt-loading call.** Even though `PERSPECTIVE_SCHEMA_YAML[perspective]()` was the immediate trigger for the silent-swallow bug, the broader contract (per `concurrency.ts:148`) is that every parallel-task `run()` generator should emit its own domain-specific error event rather than relying on `runParallel` to surface failures. Wrapping the whole body — `loadPrompt`, `harness.run`, `parseReviewIssues`, and the issue-aggregation push — covers any future runtime failure inside the perspective task.
4. **Bump `DAEMON_API_VERSION` from 19 to 20.** The `EforgeEvent` union gains a new variant. Per `api-version.ts:6-16`, this is technically additive — old clients won't crash on an unknown event type because they pass through the default case — but the comment in api-version.ts explicitly leaves judgment to the author, and the existing precedent (v19 was bumped for additive event variants like `plan:status:change`) makes a bump the consistent choice.
5. **`packages/engine/src/review-heuristics.ts:6` keeps its local `ReviewPerspective` type alias.** That file currently exports its own `type ReviewPerspective = 'code' | 'security' | …` definition. Replacing it with an import from `@eforge-build/client` is a strictly-better refactor but is out of scope for this PRD — the values are already aligned and the local type reference compiles. Document this as future cleanup; do not touch in this plan.
6. **No new monitor-UI rendering for the error event.** Per the PRD section 5: "Add a no-op reducer entry for the new event type so type-check passes" and "treat the error event like `perspective:complete`". The two existing perspective events (`:start` and `:complete`) are both already in `IGNORED_EVENT_TYPES` — the perspective lane is rendered from `agent:start` → `AgentThread.perspective`, not from these events. Adding the new variant to `IGNORED_EVENT_TYPES` matches the existing pattern. The error becomes "visible in the monitor UI's pipeline view" (AC #2) via the run-state event log (every event flows through `event-registry.ts` and gets a one-line summary via `getEventSummary`), not via a new lane termination indicator. Adding richer rendering is a follow-up if it's needed.

## Scope

### In Scope
- Lift `REVIEW_PERSPECTIVES` to an exported `as const` array in `packages/client/src/events.schemas.ts` and derive `ReviewPerspectiveSchema` and `ReviewPerspective` from it.
- Re-export `REVIEW_PERSPECTIVES` (value) and `ReviewPerspective` (type) through `packages/client/src/events.ts`, `packages/client/src/index.ts`, and `packages/client/src/browser.ts`.
- Add a `plan:build:review:parallel:perspective:error` Zod variant to `EforgeEventVariantsSchema` in `events.schemas.ts` with shape `{ type, planId, perspective: string, error: string }`.
- Register the new event in `packages/client/src/event-registry.ts` with `scope: 'session', persist: false`, and a `summary` callback that produces `Plan ${e.planId}: ${e.perspective} review failed: ${e.error}`.
- Replace `perspectives: z.array(z.string()).nonempty()` with `perspectives: z.array(z.enum(REVIEW_PERSPECTIVES)).nonempty()` in `packages/engine/src/schemas.ts` (line 456) and `packages/engine/src/config.ts` (line 110). Update the `.describe()` text to list the valid perspective names.
- Drop `"performance"` from the doc example in `config.ts:110` and replace it with a real example, e.g. `["code", "security", "api"]`.
- Replace the loose `perspectives: z.array(z.string())` on `ReviewProfileConfigSchema` in `events.schemas.ts:85` with `perspectives: z.array(ReviewPerspectiveSchema)` so the wire-protocol schema for `ReviewProfileConfig` matches.
- Wrap the per-perspective task body in `packages/engine/src/agents/parallel-reviewer.ts:165-196` in `try/catch`. On catch, yield a `plan:build:review:parallel:perspective:error` event with the perspective name and the stringified error.
- Add the new event type to `IGNORED_EVENT_TYPES` in `packages/monitor-ui/src/lib/reducer/index.ts` (alongside the existing `:perspective:start` and `:perspective:complete` entries on lines 184-185).
- Bump `DAEMON_API_VERSION` from 19 to 20 in `packages/client/src/api-version.ts` and update the trailing comment to describe the new variant.
- Update `packages/monitor-ui/src/components/pipeline/__tests__/agent-stage-map.test.ts` to add at least one test that exercises the error-event code path. The most legible coverage is a registry-level assertion: import `eventRegistry` from `@eforge-build/client` and assert that `eventRegistry['plan:build:review:parallel:perspective:error']` exists with `scope: 'session'`, `persist: false`, and a summary that, given a sample event, returns a non-empty string containing the perspective name and the error message. (This satisfies the PRD's instruction to add coverage in this file even though the file's other tests are about build-stage status, not event handling.)
- Add a new test in `test/` that verifies orchestration.yaml validation rejects an invalid perspective. Construct a `ReviewProfileConfig`-shaped object with `perspectives: ['foo']` and assert that `reviewProfileConfigSchema.safeParse(...)` from `packages/engine/src/config.ts` returns `{ success: false }` with an error path mentioning `perspectives`. Add a complementary test that the same schema accepts the six valid perspective names.

### Out of Scope
- Adding `correctness` or `architecture` as new review perspectives (would require new prompt files in `packages/engine/src/prompts/` and new schema YAML getters in `schemas.ts` — defer per PRD).
- Updating planner / pipeline-composer prompts that emitted the bad perspective names (the enum tightening is self-correcting per PRD — bad names now produce a visible compile-time error).
- Auditing the already-merged event-source-spine code that landed without review (separate effort per PRD).
- Unifying `packages/engine/src/review-heuristics.ts:6`'s local `ReviewPerspective` type alias with the shared client export. Values are already aligned; refactor is not required for the bug fix.
- Adding a new lane-termination renderer or failure-tooltip UI for the error event in the pipeline view. The error is surfaced via the event registry's `summary` callback and the run-state event log; richer rendering is a follow-up.

## Files

### Modify

- `packages/client/src/events.schemas.ts` — At line 59, replace `const ReviewPerspectiveSchema = z.enum(['code', 'security', 'api', 'docs', 'test', 'verify']);` with:
  ```ts
  export const REVIEW_PERSPECTIVES = ['code', 'security', 'api', 'docs', 'test', 'verify'] as const;
  const ReviewPerspectiveSchema = z.enum(REVIEW_PERSPECTIVES);
  ```
  At line 85, replace `perspectives: z.array(z.string())` with `perspectives: z.array(ReviewPerspectiveSchema)` so `ReviewProfileConfigSchema` aligns with the engine schemas.
  In the `EforgeEventVariantsSchema` discriminated union (after the `:perspective:complete` variant on line 555), add:
  ```ts
  z.object({
    type: z.literal('plan:build:review:parallel:perspective:error'),
    planId: z.string(),
    perspective: z.string(),
    error: z.string(),
  }),
  ```
  The existing `export type ReviewPerspective = z.infer<typeof ReviewPerspectiveSchema>;` at line 1001 remains and now resolves to the const-derived type automatically. No other change in this file.

- `packages/client/src/events.ts` — In the type re-export block (lines 13-40), the existing `ReviewPerspective` type re-export remains. Add `REVIEW_PERSPECTIVES` to the value re-exports block (lines 42-46) so consumers can `import { REVIEW_PERSPECTIVES } from '@eforge-build/client'`:
  ```ts
  export {
    ORCHESTRATION_MODES,
    SEVERITY_ORDER,
    isAlwaysYieldedAgentEvent,
    REVIEW_PERSPECTIVES,
  } from './events.schemas.js';
  ```

- `packages/client/src/index.ts` — Around line 212 (the existing `export { ORCHESTRATION_MODES, SEVERITY_ORDER, isAlwaysYieldedAgentEvent, EforgeEventSchema } from './events.js';` line), add `REVIEW_PERSPECTIVES` to the same re-export.

- `packages/client/src/browser.ts` — Around line 143 (`export { ORCHESTRATION_MODES, SEVERITY_ORDER, isAlwaysYieldedAgentEvent } from './events.js';`), add `REVIEW_PERSPECTIVES` to the same re-export so browser bundles get the const.

- `packages/client/src/event-registry.ts` — After the `'plan:build:review:parallel:perspective:complete'` entry (around line 434-441), add a new entry:
  ```ts
  'plan:build:review:parallel:perspective:error': {
    scope: 'session',
    persist: false,
    summary: (e) => `Plan ${e.planId}: ${e.perspective} review failed: ${e.error}`,
  },
  ```
  The `_Exhaustive` check at line 1284-1289 will fail compilation if this is omitted — that is the gate enforcing the registration.

- `packages/client/src/api-version.ts` — Bump `DAEMON_API_VERSION` from `19` to `20` on line 17. Update the trailing comment to describe the new variant, e.g. `// v20: Added plan:build:review:parallel:perspective:error event variant; tightened ReviewProfileConfig.perspectives to z.array(z.enum(REVIEW_PERSPECTIVES)).`

- `packages/engine/src/schemas.ts` — At the top of the file (after the existing `import type { ReviewProfileConfig } from '@eforge-build/client';` on line 11), add `REVIEW_PERSPECTIVES` to a value import: `import { REVIEW_PERSPECTIVES } from '@eforge-build/client';`. At line 456, replace `perspectives: z.array(z.string()).nonempty().describe('Review perspective names'),` with:
  ```ts
  perspectives: z.array(z.enum(REVIEW_PERSPECTIVES)).nonempty()
    .describe(`Review perspective names. Valid: ${REVIEW_PERSPECTIVES.join(', ')}`),
  ```

- `packages/engine/src/config.ts` — At the top of the file, add `REVIEW_PERSPECTIVES` to the existing `import { sanitizeProfileName, parseRawConfigLegacy } from '@eforge-build/client';` import on line 12 (or split into a separate value import line if cleaner). At line 110, replace `perspectives: z.array(z.string()).nonempty().describe('Review perspective names, e.g. ["code", "security", "performance"]'),` with:
  ```ts
  perspectives: z.array(z.enum(REVIEW_PERSPECTIVES)).nonempty()
    .describe(`Review perspective names. Valid: ${REVIEW_PERSPECTIVES.join(', ')}. Example: ["code", "security", "api"]`),
  ```
  This drops the misleading `"performance"` example.

- `packages/engine/src/agents/parallel-reviewer.ts` — Wrap the body of the `tasks.map((perspective) => ({ … run: async function* () { … } }))` callback in try/catch, starting around line 167. The transformed shape is:
  ```ts
  const tasks: ParallelTask<EforgeEvent>[] = perspectives.map((perspective) => ({
    id: `review-${perspective}`,
    run: async function* (): AsyncGenerator<EforgeEvent> {
      yield { timestamp: new Date().toISOString(), type: 'plan:build:review:parallel:perspective:start', planId, perspective };
      try {
        const prompt = await loadPrompt(PERSPECTIVE_PROMPTS[perspective], { /* … unchanged … */ }, options.promptAppend);
        let fullText = '';
        for await (const event of harness.run(
          { prompt, cwd, maxTurns: 30, tools: 'coding', abortSignal: abortController?.signal, ...pickSdkOptions(options), perspective },
          'reviewer',
          planId,
        )) {
          if (isAlwaysYieldedAgentEvent(event) || verbose) yield event;
          if (event.type === 'agent:message' && event.content) fullText += event.content;
        }
        const issues = parseReviewIssues(fullText);
        allIssues.push({ perspective, issues });
        yield { timestamp: new Date().toISOString(), type: 'plan:build:review:parallel:perspective:complete', planId, perspective, issues };
      } catch (err) {
        yield {
          timestamp: new Date().toISOString(),
          type: 'plan:build:review:parallel:perspective:error',
          planId,
          perspective,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  }));
  ```
  The `:perspective:start` event MUST stay outside the try/catch — the error handler still emits a `:perspective:error` even if `:perspective:start` was already yielded, which gives consumers a clear lifecycle (`start` → `error`) parallel to (`start` → `complete`).

- `packages/monitor-ui/src/lib/reducer/index.ts` — Add `'plan:build:review:parallel:perspective:error'` to the `IGNORED_EVENT_TYPES` array, immediately after the existing `'plan:build:review:parallel:perspective:complete'` entry on line 185. The `_Exhaustive` check at line 282-296 will fail compilation if this is omitted.

- `packages/monitor-ui/src/components/pipeline/__tests__/agent-stage-map.test.ts` — Add a new top-level `describe('plan:build:review:parallel:perspective:error registry entry', () => { … })` block at the end of the file. Inside, add one test that imports `eventRegistry` from `@eforge-build/client` (or via the monitor-ui's existing client re-export path), narrows to the error variant's metadata, and asserts:
  1. `eventRegistry['plan:build:review:parallel:perspective:error'].scope === 'session'`
  2. `eventRegistry['plan:build:review:parallel:perspective:error'].persist === false`
  3. `getEventSummary({ timestamp: '2024-01-01T00:00:00Z', type: 'plan:build:review:parallel:perspective:error', planId: 'plan-01', perspective: 'foo', error: 'undefined is not a function' })` returns a string containing `'foo'` and `'undefined is not a function'`.
  This is the lightest testable artifact that proves the new event variant is registered, exhaustively typed, and producing a sensible summary line for the run-state event log.

### Create

- `test/parallel-reviewer-perspective-validation.test.ts` — A new vitest file under the repo-root `test/` directory (per AGENTS.md, all tests live there grouped by logical unit). The file should contain two `describe` blocks:
  1. `describe('reviewProfileConfigSchema perspective enum', () => { … })` with three tests that import `reviewProfileConfigSchema` from `packages/engine/src/config.ts`:
     - Accepts a config with `perspectives: ['code', 'security', 'api', 'docs', 'test', 'verify']` (the full valid set).
     - Rejects a config with `perspectives: ['foo']` and asserts the Zod error issue has a path that includes `perspectives` and a message that lists the valid values (Zod's default `invalid_value` / `invalid_enum_value` message is sufficient — assert the issue's `code` is `'invalid_value'` or `'invalid_enum_value'` and that the message string contains at least one valid perspective name like `'code'`).
     - Rejects a config with `perspectives: ['performance']` (the previously-misleading doc example) for the same reason.
  2. `describe('parallel-reviewer surfaces errors as :perspective:error events', () => { … })` — does NOT import `runParallelReview` directly (which would require harness wiring); instead, this block constructs a single `ParallelTask<EforgeEvent>` whose `run()` generator mirrors the wrapped shape from `parallel-reviewer.ts` (i.e. `try { throw new Error('boom'); } catch { yield { type: 'plan:build:review:parallel:perspective:error', … } }`), drives it through `runParallel` from `packages/engine/src/concurrency.ts`, collects all yielded events, and asserts that exactly one `plan:build:review:parallel:perspective:error` event is in the output with `error: 'boom'` and `perspective` set to the test value. This validates the pattern (try/catch in a parallel task surfaces a domain-specific error) without coupling the test to the real reviewer's harness invocation.

## Verification

- [ ] `pnpm type-check` exits 0. The `_Exhaustive` checks in `packages/client/src/event-registry.ts` and `packages/monitor-ui/src/lib/reducer/index.ts` both compile, confirming the new event variant is registered everywhere it must be.
- [ ] `pnpm test` exits 0. The new test in `test/parallel-reviewer-perspective-validation.test.ts` passes — `reviewProfileConfigSchema.safeParse({ strategy: 'parallel', perspectives: ['foo'], maxRounds: 1, evaluatorStrictness: 'standard' })` returns `success: false` with an issue path of `['perspectives', 0]`; `safeParse` with `perspectives: ['code', 'security', 'api', 'docs', 'test', 'verify']` returns `success: true`. The new agent-stage-map test asserting `eventRegistry['plan:build:review:parallel:perspective:error']` exists with `scope: 'session'`, `persist: false` passes.
- [ ] `pnpm build` exits 0. All workspace packages bundle.
- [ ] `grep -rn "REVIEW_PERSPECTIVES" packages/` returns hits in at least: `packages/client/src/events.schemas.ts` (declaration), `packages/client/src/events.ts` (re-export), `packages/client/src/index.ts` (re-export), `packages/client/src/browser.ts` (re-export), `packages/engine/src/schemas.ts` (import + use), `packages/engine/src/config.ts` (import + use).
- [ ] `grep -n "perspectives: z.array(z.string" packages/` returns zero hits — no code path remains where perspectives is loosely typed.
- [ ] `grep -n '"performance"' packages/engine/src/config.ts` returns zero hits — the misleading example is gone.
- [ ] `grep -n "plan:build:review:parallel:perspective:error" packages/` returns hits in: `packages/client/src/events.schemas.ts` (variant definition), `packages/client/src/event-registry.ts` (registry entry), `packages/engine/src/agents/parallel-reviewer.ts` (emit site), `packages/monitor-ui/src/lib/reducer/index.ts` (IGNORED_EVENT_TYPES).
- [ ] `DAEMON_API_VERSION` in `packages/client/src/api-version.ts` is `20` (not `19`).
- [ ] Run a focused vitest invocation to confirm runParallel-style error surfacing works: `pnpm vitest run test/parallel-reviewer-perspective-validation.test.ts` — exits 0 with both describe blocks reporting all tests passing.
- [ ] Manual sanity check: write a temporary `orchestration.yaml` with `perspectives: [foo]` under `eforge/plans/<some-temp>/`, run `eforge` plan-validation entry point (or call `reviewProfileConfigSchema.parse` from a one-off `node -e` invocation that imports the engine config), and confirm the Zod error names `foo` and lists at least one valid perspective. (This is exploratory; not a CI gate.)
