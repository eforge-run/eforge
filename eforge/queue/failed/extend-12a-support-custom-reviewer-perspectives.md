---
title: EXTEND_12A: Support Custom Reviewer Perspectives
created: 2026-05-18
depends_on: ["extend-11-runtime-input-transformers-and-prd-enrichers"]
profile: gpt-claude-combo
---

# EXTEND_12A: Support Custom Reviewer Perspectives

## Problem / Motivation

Native extensions can currently call `registerReviewerPerspective(...)`, and the loader records those registrations, but runtime execution is explicitly deferred. The build-time review pipeline only knows the six built-in perspective keys:

- `code`
- `security`
- `api`
- `docs`
- `test`
- `verify`

These keys are encoded through closed schemas, planner prompt text, hard-coded prompt/schema maps, and UI/event types.

Teams therefore cannot add domain-specific reviewer lenses such as:

- Accessibility
- i18n
- Privacy
- Design-system compliance
- Package-boundary safety

This is a planned limited stage-like extension API. If an extension registers a reviewer perspective today, it is visible only as a registration count and cannot influence review.

### Context / Evidence

- PRD: `docs/prd/typescript-extensibility.md` defines EXTEND_12A as the limited stage-like API for custom reviewer perspectives, separate from validation providers and arbitrary build stage registration.
- Roadmap: `docs/roadmap.md` lists Native TypeScript extensions, including limited stage-like APIs such as custom reviewer perspectives, as planned extensibility work.
- Schaake OS dependencies: EXTEND_08A agent prompt/context hooks and EXTEND_10 blocking policy gates are done; EXTEND_12A is in progress and unblocked.
- Current SDK/loader files already capture `registerReviewerPerspective({ key, label, promptFragment })` registrations for provenance, validation, list/show, and duplicate detection:
  - `packages/extension-sdk/src/api.ts`
  - `packages/extension-sdk/src/hooks.ts`
  - `packages/engine/src/extensions/types.ts`
  - `packages/engine/src/extensions/recorder.ts`
- Docs currently mark runtime execution deferred.
- Review runtime currently hard-codes built-in perspectives to prompt files and issue schema helpers in:
  - `packages/engine/src/agents/parallel-reviewer.ts`
- Built-in perspective names are also encoded as closed unions/enums in:
  - `packages/engine/src/review-heuristics.ts`
  - `packages/client/src/events.schemas.ts`
  - `packages/client/src/types.ts`
  - `packages/engine/src/config.ts`
  - `packages/engine/src/schemas.ts`
- Monitor/UI support exists for built-in parallel review events:
  - `plan:build:review:parallel:*` events carry `perspective`, `reviewIssuesByPerspective`, and `perspectiveErrors`
  - `packages/monitor-ui/src/components/pipeline/plan-row.tsx` renders per-perspective activity/issues
- Planning/diagnostics currently expose review profile perspectives through:
  - `planning:complete.planConfigs`
  - `packages/engine/src/prompts/planner.md`
  - `packages/engine/src/prompts/module-planner.md`
  - `packages/engine/src/prompts/pipeline-composer.md`
  - extension registration totals via `packages/engine/src/extensions/projector.ts`
- Existing tests:
  - `test/extension-loader.test.ts` verifies reviewer perspective registration capture
  - `test/extension-replay.test.ts` summarizes it as deferred
  - `test/parallel-reviewer-perspective-validation.test.ts` verifies the current config schema rejects non-built-in names

### Classification

This is a **feature / deep** change with medium-high confidence. It adds a public extension capability and touches SDK, engine runtime, wire schemas, planner guidance, monitor/CLI representations, docs, and tests.

Deep planning is warranted because the current implementation deliberately uses closed perspective unions and hard-coded prompt/schema maps.

### Why Now

EXTEND_08A and EXTEND_10 are complete, so the extension loader, agent context path, policy-gate discipline, provenance, diagnostics, and trust foundations exist.

EXTEND_12A is the next constrained stage-like capability before validation providers or arbitrary stage registration.

## Goal

Promote `registerReviewerPerspective` from a loader-only/deferred registration to a runtime-supported extension point for build-time code review.

Custom reviewer perspectives should run as bounded reviewer-agent prompt lenses, flow through review configuration/events/UI/diagnostics, and preserve existing built-in review behavior.

## Approach

### High-Level Design

Introduce a review perspective catalog that combines built-in perspectives with loaded extension registrations.

The review runtime should no longer depend on a closed static map for every possible perspective. Built-in heuristic code should remain closed over known categories, while wire/config/review event surfaces accept safe custom perspective keys.

Reviewer perspectives remain high-level reviewer-agent prompt lenses, not arbitrary stages. They must not become validation providers, approval workflows, blocking policy gates, or arbitrary compile/build stages.

### Core Design Decisions

#### 1. Perspective Key Model

- Introduce a safe `ReviewPerspectiveKey` string type/schema for wire/config fields that can carry extension keys.
- Keep `BUILT_IN_REVIEW_PERSPECTIVES` / `BuiltInReviewPerspective` for built-in heuristic logic and prompt/schema maps.
- Use a conservative key pattern already common in config: `^[A-Za-z0-9._-]+$`.
- Reject empty/path-like keys.
- Do not let extensions override built-in perspective keys in this slice.
- Collisions with built-in keys should produce diagnostics and skipped registrations.

#### 2. Public SDK Shape

Evolve `ReviewerPerspectiveSpec` to something like:

```ts
interface ReviewerPerspectiveSpec {
  key: string;
  label: string;
  description: string;
  promptFragment: string;
  appliesTo?: (ctx: ReviewerPerspectiveApplicabilityContext) =>
    boolean |
    { applies: boolean; reason?: string } |
    Promise<boolean | { applies: boolean; reason?: string }>;
}
```

Constraints:

- Keep `promptFragment` rather than arbitrary prompt templates for MVP consistency and lower risk.
- Treat missing `appliesTo` as explicit/config-only or always applicable only when directly requested; document the choice.
- Recommended behavior: missing `appliesTo` means the perspective is selectable by config/planner but not auto-added during heuristic inference.

#### 3. Applicability Evaluation

Evaluate applicability using a read-only, frozen context containing bounded data such as:

- Plan id/name/body or summary
- Changed files
- File categories
- Diff stats
- Review strategy
- Configured perspectives
- `cwd` as metadata only
- Extension provenance

Constraints:

- No `ctx.exec`.
- No mutable engine objects.
- No direct state handles.
- Applicability can influence only whether that perspective participates.
- Applicability must not mutate engine state.
- Add `extensions.reviewerPerspectiveTimeoutMs` defaulting to `extensions.eventHookTimeoutMs`, or reuse event timeout if adding config is too large.
- Fail open by skipping that extension perspective and emitting a diagnostic event/decision.
- Do not fail the build for auto-applicability errors.
- If an explicitly requested perspective cannot be evaluated, fail with a clear diagnostic because user intent/config cannot be honored.

#### 4. Runtime Catalog

Build a catalog per review run from:

- Built-in perspective definitions
- Loaded extension registrations

Behavior:

- Built-ins have prompt file + perspective-specific schema YAML.
- Custom perspectives use a generic reviewer prompt/schema.
- Custom prompts append a provenance-wrapped section with:
  - Label
  - Description
  - Prompt fragment
- Deterministic order:
  - Built-in inferred/configured order first
  - Extension perspectives in loader registration order
  - De-duplicated by key

#### 5. Selection Behavior

- Explicit `review.perspectives` keys must resolve in the catalog.
- Unknown explicit keys should fail fast with a clear diagnostic/build error rather than silently skipping a requested reviewer.
- In `auto`, built-in threshold/category logic remains intact.
- Applicable extension perspectives are merged into inferred perspectives.
- If one or more extension perspectives apply, `auto` should run parallel review even when size thresholds alone would choose single, with a review-strategy decision rationale that names extension applicability.
- In `single`, keep existing single reviewer behavior and do not run extension perspectives.
- Document that custom perspectives require `auto` applicability or `parallel`/explicit config.

#### 6. Events and UI

- Reuse existing `plan:build:review:parallel:*` events.
- Change perspective fields to support `perspective: string` / `perspectives: string[]` for custom keys.
- Extend `plan:build:decision` metadata only as needed.
- Prefer enriching existing `perspectives-inferred` and `review-strategy` rationales/rules before adding a new event family.
- Preserve agent `perspective` metadata so monitor pipeline rows and detail sheets can show custom perspective activity without bespoke UI.

#### 7. Safety and Failure Policy

- Reviewer perspective handlers can influence only whether their own perspective participates and what prompt fragment is used.
- A failing reviewer agent should behave like current built-in perspective failures:
  - emit `plan:build:review:parallel:perspective:error`
  - continue other perspectives
  - preserve issue aggregation
- Applicability errors/timeouts should be visible and skip that extension perspective unless explicitly requested.
- Explicitly requested perspectives that cannot be evaluated should fail with a clear diagnostic.

### Architecture Impact

This change turns a previously loader-only registration into an engine runtime extension point.

Architecture changes:

- Introduce a review perspective catalog boundary between extension loading and review execution.
- Split built-in perspective identity from extension-capable perspective keys.
- Keep built-in heuristic code closed over known categories.
- Let wire/config/review event surfaces accept safe custom keys.
- Pass extension registry data into build-stage review execution, not just queue/profile/policy runtime.
- Current context paths show the full engine has `nativeExtensionRegistry`, while orchestrator/pipeline types currently expose only selected registry families in some places.
- Preserve the engine/consumer boundary:
  - engine emits typed events and decisions
  - monitor/CLI render strings and provenance
  - monitor should not learn extension runtime internals
- Keep reviewer perspectives as high-level reviewer-agent prompt lenses, avoiding coupling extensions to:
  - worktrees
  - commits
  - recovery
  - validation orchestration

No deployment/operational changes are expected beyond daemon restart after code changes.

Trust model remains the existing native-extension trust model. This epic should not add packaging/install semantics.

### Code Impact

#### SDK / Extension Loader

Update:

- `packages/extension-sdk/src/hooks.ts`
- `packages/extension-sdk/src/api.ts`

Changes:

- Update `ReviewerPerspectiveSpec` with:
  - `description`
  - applicability callback/result type
- Document runtime support.

Update:

- `packages/engine/src/extensions/types.ts`
- `packages/engine/src/extensions/recorder.ts`

Changes:

- Mirror SDK shape.
- Validate required fields.
- Reject invalid applicability functions.
- Diagnose duplicate/colliding names, including built-in perspective keys.

Update as needed:

- `packages/engine/src/extensions/projector.ts`
- `packages/client/src/types.ts`
- daemon extension response construction
- CLI/Pi/Claude surfaces

Purpose:

- Expose enough reviewer-perspective detail or diagnostics to make registrations visible beyond counts.

#### Review Runtime

Update:

- `packages/engine/src/agents/parallel-reviewer.ts`

Changes:

- Replace hard-coded built-in prompt/schema maps with a catalog-aware resolver.
- Run custom perspectives with generic reviewer prompt/schema plus extension prompt fragment.
- Carry extension provenance into diagnostics/rationale.

Update:

- `packages/engine/src/review-heuristics.ts`
- `packages/engine/src/review-cycle-perspectives.ts`

Changes:

- Separate built-in heuristic perspectives from arbitrary perspective keys.
- Keep built-in category inference while merging applicable extension perspectives.

Update:

- `packages/engine/src/pipeline/stages/build-stages.ts`

Changes:

- Pass the extension registry/catalog into review execution and adaptive review-cycle selection.
- Avoid closed `isReviewPerspective` checks dropping custom perspective metadata.

Update:

- `packages/engine/src/pipeline/types.ts`
- `packages/engine/src/eforge.ts`
- orchestrator/pipeline wiring

Changes:

- Make `reviewerPerspectives` available to build stages.
- Current orchestrator extension registry pick is policy-gate-only in some paths.

#### Wire Schemas / Config / Planning

Update:

- `packages/client/src/events.schemas.ts`
- `packages/client/src/types.ts`

Changes:

- Change review perspective fields from closed built-in union to safe perspective-key string schema where events/config need extension keys.
- Preserve exported built-in constants for heuristics and docs.

Update:

- `packages/engine/src/config.ts`
- `packages/engine/src/schemas.ts`

Changes:

- Relax review profile perspective validation to safe non-empty keys.
- Add runtime validation against the perspective catalog where extension registrations are available.

Update:

- `packages/engine/src/agents/planner.ts`
- `packages/engine/src/agents/module-planner.ts`
- `packages/engine/src/agents/pipeline-composer.ts`
- planner prompts

Changes:

- Include registered custom perspective keys/descriptions in `validPerspectives`/guidance so planning can choose them when appropriate.

#### Monitor/UI and Event Summaries

Update as needed:

- `packages/client/src/event-registry.ts`
- `packages/client/src/event-to-progress.ts`

Purpose:

- Ensure custom keys render in summaries.

Likely mostly string-compatible, but remove imported closed types and add tests for custom keys in:

- `packages/monitor-ui/src/lib/reducer/handle-plan-build.ts`
- `packages/monitor-ui/src/lib/reducer/handle-agent.ts`
- `packages/monitor-ui/src/lib/reducer/handle-decisions.ts`
- `packages/monitor-ui/src/components/pipeline/*`
- `packages/monitor-ui/src/components/plans/build-config.tsx`

#### Tests / Docs / Examples

Add or update tests around:

- Loader validation
- Runtime applicability
- Parallel review events with custom keys
- Config validation/runtime unknown-key diagnostics
- Planner prompt available perspectives
- Monitor reducer rendering
- Schema parity

Update docs/examples:

- `docs/extensions.md`
- `docs/extensions-api.md`
- `packages/extension-sdk/README.md`
- `examples/extensions/README.md`

Add a supported example such as:

- `examples/extensions/accessibility-reviewer.ts`

### Documentation Impact

Docs/examples needing updates:

- `docs/extensions-api.md`
  - Change `registerReviewerPerspective` from deferred to runtime-supported.
  - Document spec fields.
  - Document applicability context.
  - Document timeout/failure behavior.
  - Document explicit-vs-auto selection.
  - Document limitations.
- `docs/extensions.md`
  - Update runtime support table.
  - Update capability summary.
  - Clarify that reviewer perspectives are supported while validation providers remain deferred.
- `packages/extension-sdk/README.md`
  - Update support table.
  - Update API summary.
- `examples/extensions/README.md`
  - Add the reviewer perspective example to the supported examples list.
- New example:
  - `examples/extensions/accessibility-reviewer.ts`, or
  - `examples/extensions/design-system-reviewer.ts`
  - Should show description, prompt fragment, and an applicability rule.
- Planner prompt docs/guidance:
  - Update `planner.md`
  - Update `module-planner.md`
  - Update `pipeline-composer.md`
  - Ensure prompts do not state only the six built-ins are possible when extension perspectives are registered.
- PRD docs:
  - If this epic ships, `docs/prd/typescript-extensibility.md` and/or `docs/roadmap.md` may need pruning/updating only if project policy expects shipped PRDs to be removed or roadmap items narrowed after implementation.

### Risks

- Closed schema drift:
  - Review perspective keys are currently duplicated across client TypeBox schemas, engine Zod config, engine TypeBox schemas, planner prompts, runtime maps, and UI/test types.
  - Missing one will cause type errors or runtime validation failures for custom keys.
- Silent review gaps:
  - If an explicitly configured custom perspective is missing or skipped, silently falling back would hide user intent.
  - The plan should require clear failure/diagnostics for explicit unknown/unavailable keys.
- Over-parallelization:
  - Auto-running custom perspectives on small changes can increase cost.
  - Applicability should be specific, rationale should be emitted, and `single` should remain a way to opt out.
- Prompt quality:
  - Generic custom-perspective prompts may produce poor or malformed review XML if prompt fragments are too vague.
  - Docs/examples should include strong guidance.
  - Tests should use stub harness outputs.
- Extension side effects:
  - TypeScript extensions are not sandboxed.
  - Even a read-only applicability context cannot prevent arbitrary filesystem side effects.
  - The documented contract can prevent engine-state mutation, but trust docs must remain explicit.
- Adaptive review-cycle typing:
  - Existing second-round selection uses `ReviewPerspective` closed types and may drop custom perspective errors/issues unless updated to string keys.
- Planner availability:
  - Compile/planning stages need extension perspective metadata to mention custom keys.
  - If this path is skipped, runtime can still run applicable perspectives, but acceptance around planning visibility may be weaker.
- Backward compatibility:
  - Existing configs/tests expecting invalid `performance` to be rejected must be updated carefully.
  - It should remain invalid unless registered by an extension or possibly fail at runtime with a clear unavailable-perspective diagnostic.

### Assumptions and Validation

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|---|---|---:|---:|---|---|
| Custom reviewer perspectives should be reviewer-agent prompt lenses, not arbitrary code/validation stages. | PRD places reviewer perspectives under limited stage-like APIs and separates validation providers into EXTEND_12B; current built-ins are prompt-driven reviewer runs in `parallel-reviewer.ts`. | high | low | Confirm with user/epic owner if custom perspective should ever run commands; otherwise keep verify/validation separate. | If wrong, the implementation may under-deliver by not allowing richer executable reviewers. |
| Custom perspective keys must flow as safe strings through wire/config/UI, while built-in keys remain constants for heuristics. | `events.schemas.ts`, `types.ts`, `config.ts`, `schemas.ts`, `review-heuristics.ts`, and `parallel-reviewer.ts` all currently use closed built-in unions/maps; custom keys cannot validate today. | high | low | Type-check after relaxing schemas; add schema parity tests with a custom key. | If wrong, either custom keys will fail validation or too much type safety will be lost. |
| Applicability rules can be function callbacks with bounded read-only context and timeout, despite extensions being unsandboxed. | PRD example uses `appliesTo: ({ changedFiles }) => ...`; epic requires bounded rules and no engine-state mutation. Native extensions are already arbitrary trusted TS. | medium | low | Validate against existing extension API style and docs; consider declarative `fileGlobs` as a fallback if callbacks are too risky. | If wrong, callback API may be considered too permissive and require redesign. |
| Auto-applicable extension perspectives should be able to trigger parallel review even below size thresholds. | This best satisfies “applicability rules” and makes custom perspectives useful without requiring planners to explicitly configure every plan. Not directly specified in acceptance criteria. | medium | medium | Discuss/decide before implementation; alternatively limit execution to explicit `parallel` configs. | If wrong, review cost may increase unexpectedly or behavior may surprise users. |
| Existing monitor UI is mostly string-compatible once client types/schemas change. | Search found pipeline and plan UI render perspective values directly; reducers store maps keyed by perspective. | medium | low | Run monitor-ui tests/type-check after changing `ReviewPerspective` to a string key; add a custom-key fixture. | If wrong, additional UI refactors are needed. |
| Extension registration details beyond counts may be needed for “visible in planning/diagnostics”. | Current projection/list surfaces counts; runtime events will show active custom keys, but inactive registrations may not be named in CLI/diagnostics. | medium | low | Inspect CLI/show output and decide whether to add registration detail arrays to `ExtensionEntry` or a catalog diagnostic event. | If wrong, acceptance around visibility may be partially unmet. |
| Config validation can be relaxed to safe keys with runtime catalog validation without weakening safety too much. | Current static schema rejects `performance`; custom extension keys require dynamic validation after extensions load. | medium | medium | Add tests: unregistered `performance` fails at runtime with a clear diagnostic; registered `performance` succeeds only when extension is loaded/trusted. | If wrong, invalid perspective names may slip through too late or produce confusing failures. |

No low-confidence/high-impact assumptions remain unresolved. The medium-confidence assumptions all have low/medium validation paths and can be validated during implementation with focused tests and type-checking.

### Profile Signal

Recommended profile: **Excursion**.

Rationale:

- This is a cross-cutting feature touching SDK, engine runtime, schemas, monitor/UI, docs, and tests.
- It is still a cohesive extension-point implementation with one central design:
  - build a review perspective catalog
  - let the existing parallel reviewer execute extension-provided prompt lenses
- A single planner should be able to enumerate the required plan sequence and dependencies.
- It does not require delegated module planning or independent subsystem plans, so Expedition would likely add overhead without improving cohesion.

## Scope

### In Scope

- Promote `registerReviewerPerspective` from loader-only/deferred to runtime-supported for build-time code review.
- Extend the public SDK contract so a reviewer perspective has:
  - stable key
  - label
  - description
  - prompt fragment
  - bounded applicability rule
- Build a review perspective catalog from built-ins plus loaded extension registrations, with:
  - deterministic ordering
  - duplicate/collision diagnostics
- Allow custom perspective keys to flow through:
  - review config
  - planning guidance
  - build decisions
  - agent metadata
  - review events
  - monitor reducers/UI
  - CLI/event summaries
  - tests
- Execute applicable extension perspectives in the parallel review path as reviewer-agent runs using:
  - existing harness abstraction
  - generic review-issue parsing
- Emit coherent diagnostics/events when:
  - applicability evaluation fails
  - applicability evaluation times out
  - applicability returns invalid data
  - a perspective collides with a built-in key
  - review config references an unavailable perspective
- Update docs/examples to show a supported custom reviewer perspective and call out limitations.

### Out of Scope

- Validation providers, EXTEND_12B.
- Arbitrary compile/build stage registration.
- Extension mutation of plans, review config, issue lists, or engine state outside explicit return contracts.
- Approval workflows or blocking policy decisions from reviewer perspectives.
- Custom review issue schemas in the first slice.
- Custom perspectives should use the existing review issue XML contract with string categories.
- Full event replay execution for reviewer perspectives.
- `eforge extension test` can continue to summarize non-event registrations unless this falls out cheaply.

## Acceptance Criteria

- `@eforge-build/extension-sdk` exposes a runtime-supported `registerReviewerPerspective` contract with:
  - key
  - label
  - description
  - prompt fragment
  - bounded applicability rule types
- Loader/recorder validation:
  - accepts valid reviewer perspective registrations
  - rejects invalid specs
  - rejects duplicate extension keys
  - diagnoses collisions with built-in perspective keys
- The build-time review runtime builds a catalog from built-in and extension perspectives and can execute an applicable custom perspective as a reviewer-agent run.
- Custom perspective keys flow through the following without schema validation failures:
  - `plan:build:review:parallel:start`
  - `plan:build:review:parallel:perspective:start`
  - `plan:build:review:parallel:perspective:complete`
  - `plan:build:review:parallel:perspective:error`
  - agent metadata
  - review issue grouping
  - monitor/CLI/event summaries
- Planner/module-planner/pipeline-composer guidance can surface registered custom perspective keys/descriptions, or an explicit diagnostic documents why planner visibility is not available in this slice.
- Applicability evaluation receives only bounded read-only context.
- Applicability evaluation can influence only whether that perspective participates.
- Applicability errors/timeouts are visible and do not mutate engine state.
- Explicit review config references to unavailable perspective keys fail clearly or emit a clear blocking diagnostic rather than silently skipping the requested perspective.
- Built-in perspective behavior and existing review-cycle behavior remain backward compatible for configs using:
  - `code`
  - `security`
  - `api`
  - `docs`
  - `test`
  - `verify`
- Validation providers and arbitrary compile/build stage registration are not introduced.
- Docs and examples are updated to:
  - show a supported reviewer perspective extension
  - keep validation-provider/runtime-deferred caveats accurate
- Tests cover:
  - SDK/loader validation
  - runtime custom perspective execution with a stub harness
  - applicability skip/error/timeout behavior
  - wire schema acceptance of custom keys
  - planner/diagnostic visibility
  - monitor reducer/rendering behavior for a custom perspective key.
