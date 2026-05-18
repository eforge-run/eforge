---
title: EXTEND_11: Runtime Input Transformers and PRD Enrichers
created: 2026-05-18
profile: gpt-claude-combo
---

# EXTEND_11: Runtime Input Transformers and PRD Enrichers

## Problem / Motivation

Schaake OS epic `831736f7-27ec-4224-9b56-1cca5958b544` is in progress and targets native extension input adapters / PRD enrichers. Acceptance criteria require extension APIs for adapters/enrichers, normalized build source before the engine, visible provenance, an issue-tracker example, and keeping the engine input-agnostic.

Roadmap alignment: `docs/roadmap.md` explicitly lists native TypeScript extensions including input transformers as planned extensibility work, and separately notes low-fidelity input handling as future integration work. This epic should implement deterministic/input-layer extension transformations, not launch exploration agents.

Current native extensions can register `registerInputSource`, but that registration is provenance-only: no runtime path fetches external build input or enriches PRDs before enqueue. Users still have to paste issue content manually or write wrapper scripts for Linear/Jira/GitHub expansion, label-derived acceptance criteria, repo Definition of Done injection, and similar source normalization.

Why it matters now:

- EXTEND_11 is the extension roadmap phase intended to move input sources from deferred registration to runtime capability.
- The architecture requires transformations to happen before content reaches `EforgeEngine.enqueue()` / formatter agents while keeping the engine independent of `@eforge-build/input`.
- Existing input-boundary behavior is already split: `@eforge-build/input.normalizeBuildSource()` handles session plans, daemon `/api/enqueue` calls it, but direct CLI `eforge enqueue` currently calls the engine directly. EXTEND_11 should use this as the normalization seam rather than adding input semantics inside the engine.
- Users need observable provenance so an enriched PRD can be traced back to the extension/source adapter that produced or modified it.

Relevant current implementation evidence (as of post-trust-model-hardening state):

- `packages/extension-sdk/src/api.ts` exposes `registerInputSource(adapter)`, marked "Runtime not yet wired". No `registerPrdEnricher` exists yet.
- `packages/extension-sdk/src/hooks.ts` defines `InputSourceAdapter` as `{ name, description, fetch(id): Promise<string | null> }` with no context parameter, no `canHandle`, and no enricher contract.
- `packages/engine/src/extensions/types.ts` includes `InputSourceRegistration` and new trust model types (from the completed harden-extension-trust-model work). No `PrdEnricherSpec` or `PrdEnricherRegistration` types exist.
- `packages/engine/src/extensions/recorder.ts` validates and captures input-source registrations with duplicate-name diagnostics. The trust model hardening added trust verification to the discovery/loader path.
- `packages/engine/src/extensions/loader.ts`, `projector.ts`, `replay.ts` were updated as part of trust model hardening. The new registration family will layer on top of these changes.
- `docs/extensions.md`, `docs/extensions-api.md`, and `packages/extension-sdk/README.md` all document `registerInputSource` as deferred runtime execution.
- `packages/input/src/index.ts` exports only synchronous `normalizeBuildSource()` plus session-plan helpers. No async extension-aware helper exists.
- `packages/monitor/src/server.ts` received ~345 lines of additions as part of trust model hardening (extension tooling routes, trust verification, etc.). It still normalizes session-plan file sources in the `/api/enqueue` route before spawning the enqueue worker.
- `packages/eforge/src/cli/index.ts` received ~83 lines of additions for trust model work. The direct `eforge enqueue` command still passes source directly to `engine.enqueue(source)` with no preprocessing — no call to `normalizeBuildSource()` or extension-aware transformation.
- `packages/client/src/events.schemas.ts` has event families for `extension:event-handler`, `extension:agent-context`, `extension:agent-tools`, and `extension:policy`, but no `extension:input-source:*` or `extension:prd-enricher:*` events.
- `examples/extensions/` contains: `agent-context.ts`, `agent-tools.ts`, `minimal-event-logger.ts`, `profile-router.ts`, `protected-paths.ts`, `slack-webhook-notifier.ts`. No input-source or issue-tracker example exists.

Classification: this is a **feature / focused** change with medium-high confidence. It adds a new runtime capability to an existing extension API and spans SDK, input boundary, daemon/CLI wiring, client event schemas, docs, and tests. It should stay cohesive enough for Excursion rather than Expedition: one plan can cover the contracts, runtime helper, integration points, and docs/tests without delegated module planning.

## Goal

Implement runtime-supported extension input adapters and PRD/build-source enrichers that run before `EforgeEngine.enqueue()` while keeping the engine input-agnostic.

The outcome should include normalized build source, visible provenance/diagnostics, deterministic enrichment sequencing, issue-tracker examples, updated docs, and tests across SDK, input, CLI/daemon, client events, and extension tooling.

## Approach

### High-level implementation

- Keep `registerInputSource` and wire it at runtime for enqueue preprocessing.
- Add a PRD/build-source enricher registration method, tentatively `registerPrdEnricher(enricher)`, because input adapters fetch a source while enrichers modify already-normalized content.
- Preserve existing loader/list/show/validate behavior and add the new registration family to counts, duplicate detection, projection, and docs. Note: the trust model hardening already updated these surfaces; the new enricher family layers on top.
- Preserve existing synchronous `normalizeBuildSource()` for session-plan conversion and tests.
- Add an async extension-aware helper in `@eforge-build/input` that accepts structurally typed source-adapter/enricher registrations and returns normalized content plus provenance/diagnostics.
- Support explicit extension input references such as `eforge://input/<adapter>/<id...>` so issue-tracker input can be requested without ambiguous filesystem/path parsing.
- Consider a convenience `adapter:id` shorthand only if it does not conflict with paths/URLs and is covered by tests.
- Run built-in session-plan normalization before enrichers, so enrichers see ordinary build source.
- Preprocess sources in the CLI/worker enqueue path before calling `EforgeEngine.enqueue(normalizedContent, ...)`.
- Keep `packages/engine` input-agnostic: no dependency from engine to `@eforge-build/input` and no issue-tracker/source parsing inside `EforgeEngine.enqueue()`.
- Update daemon `/api/enqueue` so it does not consume extension input in the daemon route and then hide provenance from the worker. It may retain cheap session-plan validation for 400 responses, but the spawned enqueue worker should receive enough original source context to run the shared preprocessing and emit provenance.

### Design decisions

1. **Keep the engine input-agnostic.**

   Runtime input transformation should execute in the enqueue boundary layer, CLI/daemon worker path, before `EforgeEngine.enqueue()` receives content.

   The engine may continue to own extension discovery/registration capture, but it must not import `@eforge-build/input` or learn source adapter semantics.

   Rationale: this directly satisfies the epic acceptance criterion and aligns with `AGENTS.md`: input artifact protocols live in `@eforge-build/input`; the engine consumes normalized PRD/build source.

2. **Preserve current sync session-plan API and add an async extension-aware helper.**

   Do not change `normalizeBuildSource(input)` from synchronous to asynchronous.

   Add a new helper such as `normalizeBuildSourceWithExtensions(...)` / `preprocessBuildSource(...)` for adapters/enrichers.

   Rationale: existing tests and callers rely on a simple sync helper for session plans. Extension handlers are async by nature, such as network fetches, so a separate helper avoids a breaking API change.

3. **Split source adapters from PRD enrichers.**

   Keep `registerInputSource(adapter)` for producing raw/normalized build source from an external reference.

   Add `registerPrdEnricher(enricher)` for transforming already-available build source.

   Rationale: fetching `linear issue ENG-123` and injecting a repo Definition of Done are different lifecycle points. A split avoids overloading `fetch(id)` with mutation semantics and creates clearer provenance.

   Tentative contracts:

   ```ts
   interface InputSourceAdapter {
     name: string;
     description: string;
     canHandle?: (source: string, ctx: InputTransformContext) => boolean | Promise<boolean>;
     fetch: (id: string, ctx: InputTransformContext) => Promise<string | InputSourceResult | null>;
   }

   interface PrdEnricher {
     name: string;
     description: string;
     appliesTo?: (input: PrdEnrichmentInput, ctx: InputTransformContext) => boolean | Promise<boolean>;
     enrich: (input: PrdEnrichmentInput, ctx: InputTransformContext) => Promise<string | PrdEnrichmentResult | null | undefined>;
   }
   ```

   Existing one-argument `fetch(id)` examples should remain type-compatible by making `ctx` an additional parameter and accepting string return values.

4. **Use an explicit source reference syntax.**

   Support an unambiguous URI-like source reference, e.g. `eforge://input/<adapter>/<id...>`, for extension-provided sources.

   The adapter name and id should be URL-decoded path components, with tests for unsafe/invalid forms.

   A shorthand may be added only if collision risk is low.

   Rationale: current enqueue accepts inline text or paths. Guessing that `ABC-123` is Linear or `owner/repo#123` is GitHub would create surprising behavior. Explicit syntax lets agents and users invoke adapters deterministically.

5. **Use a sequential deterministic pipeline.**

   Preprocessing should run in this order:

   1. Resolve content from explicit input source, file path, or inline text.
   2. Apply built-in session-plan normalization when the source path is `.eforge/session-plans/*.md`.
   3. Run PRD enrichers sequentially in extension registration order.
   4. Return normalized content plus provenance.
   5. Pass only normalized content to `EforgeEngine.enqueue()`.

   Rationale: this matches existing extension precedence/registration ordering and ensures enrichers operate on ordinary build source, not session-plan frontmatter.

6. **Failure policy.**

   Explicit selected input-source failures should fail the enqueue, because there is no valid source to build.

   Optional enrichers should default fail-open with a typed diagnostic event unless their result contract later gains an explicit blocking variant.

   Timeouts should apply to both adapters and enrichers, likely reusing or deriving from `extensions.eventHookTimeoutMs` until a dedicated config key is justified.

   Rationale: source fetch failure is fatal; enrichment failure should not silently crash all builds unless an extension is being used as a policy gate, which belongs in policy-gate APIs.

7. **Provenance as first-class wire events plus helper return data.**

   Add events such as:

   - `extension:input-source:fetched`
   - `extension:input-source:failed`
   - `extension:prd-enricher:applied`
   - `extension:prd-enricher:failed`

   Exact names may be refined for consistency with existing `extension:*` event naming conventions.

   The input helper should also return structured provenance so callers can test without an event recorder.

   Rationale: user-visible event streams satisfy acceptance; return data keeps `@eforge-build/input` testable and decoupled from monitor recording.

8. **Daemon route should not hide extension provenance.**

   Avoid executing extension adapters/enrichers entirely inside `/api/enqueue` before spawning a worker, because those events would not naturally appear in the worker's recorded session stream.

   Prefer moving runtime preprocessing into the worker/CLI enqueue path.

   The daemon route can still prevalidate session-plan files to preserve existing 400 behavior, then spawn the worker with the original source argument.

   Note: the trust model hardening added significant new surface to `server.ts` (~345 lines). Take care to layer daemon route changes cleanly on top of the existing trust verification logic rather than modifying it.

   Rationale: the recorded enqueue session should show what transformed the input.

9. **Example strategy.**

   Add one issue-tracker example that demonstrates all three common providers via separate adapters or provider branches:

   - GitHub issue
   - Linear issue
   - Jira issue

   It should be safe-by-default: use environment tokens, redact secrets, and return helpful markdown when a provider is not configured.

   Rationale: acceptance asks for Linear/Jira/GitHub issue enrichment, but a full production-grade integration for all three would be too large. A documented example gives agents a concrete pattern to customize.

### Expected code impact

SDK and extension contracts:

- `packages/extension-sdk/src/api.ts` — add `registerPrdEnricher(...)` to `EforgeExtensionAPI`; update `registerInputSource` docs from deferred to runtime-supported.
- `packages/extension-sdk/src/hooks.ts` — extend input-source types (add optional `canHandle`, context param, result type) and add `PrdEnricher`/result/context types.
- `packages/extension-sdk/src/context.ts` — add `InputTransformContext` if source/enricher handlers receive logger/exec/cwd/source metadata.
- `packages/extension-sdk/src/index.ts` and `packages/extension-sdk/README.md` — export and document new types.
- `test/extension-sdk-example.test.ts` — update barrel/type export assertions and add compile-time examples.

Engine extension loader/registry/projection:

- `packages/engine/src/extensions/types.ts` — add `PrdEnricherSpec`, `PrdEnricherRegistration`, registry state/counts. Note: trust model hardening already added new types here; add enricher types alongside existing additions.
- `packages/engine/src/extensions/recorder.ts` — validate `registerPrdEnricher`, merge duplicate names, and preserve existing input-source validation.
- `packages/engine/src/extensions/loader.ts`, `projector.ts`, `replay.ts`, `index.ts` — include new registration family in totals/projection/deferred replay summaries. These files were updated by trust model hardening; additions should layer cleanly.
- `packages/engine/src/extensions/scaffold.ts` — optional: add an input/enricher scaffold template only if small; otherwise leave templates unchanged and rely on the example.
- Tests: `test/extension-loader.test.ts`, `test/extension-tooling-routes.test.ts`, `test/extension-cli-commands.test.ts`, `test/extension-tooling-wiring.test.ts`, and replay tests likely need count/projection updates. These tests were expanded by trust model hardening; add enricher coverage alongside existing additions.

Input layer:

- `packages/input/src/session-plan.ts` or a new `packages/input/src/normalize.ts` / `extensions.ts` — keep `normalizeBuildSource()` sync; add async extension-aware normalization and provenance result types.
- `packages/input/src/index.ts` — export the new helper/types.
- `packages/input/package.json` — likely add `@eforge-build/extension-sdk` for public handler types or keep structural local types to avoid tighter coupling; choose intentionally.
- Tests: extend `test/normalize-build-source.test.ts` or add `test/input-extension-normalization.test.ts` for adapter/enricher behavior.

CLI/daemon/client surfaces:

- `packages/eforge/package.json` — add `@eforge-build/input` if CLI enqueue imports the new preprocessing helper directly.
- `packages/eforge/src/cli/index.ts` — run preprocessing before `engine.enqueue(...)`, yield provenance/diagnostic events before enqueue events, and pass normalized content to the engine. This file was modified by trust model hardening; add preprocessing to the enqueue command path without disturbing trust verification additions.
- `packages/monitor/src/server.ts` — adjust `/api/enqueue` route. Keep profile validation and optional session-plan prevalidation, but avoid route-side extension execution that would bypass worker event/provenance. This file received ~345 lines of trust model additions; changes to the enqueue route must be made carefully alongside the existing trust verification logic.
- `packages/client/src/events.schemas.ts`, `event-registry.ts`, `events-wire-parity` tests, and `events-schemas` tests — add typed provenance/diagnostic event variants for input-source and prd-enricher families.
- `packages/client/src/api-version.ts` — bump daemon API version if wire events/API response shapes change.

Docs/examples/integration UX:

- `docs/extensions.md`, `docs/extensions-api.md`, `packages/extension-sdk/README.md` — mark input source/enricher runtime support, source URI syntax, failure policy, and provenance events.
- `examples/extensions/` and `examples/extensions/README.md` — add issue tracker source/enricher example covering GitHub/Linear/Jira patterns.
- `packages/pi-eforge/skills/eforge-extend/SKILL.md` and `eforge-plugin/skills/extend/extend.md` — move `registerInputSource` from deferred to supported, and mention PRD enrichers.
- If CLI/MCP/Pi extension tool schemas expose template lists, update them only if a new scaffold template is added.

### Assumptions and validation

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| Enqueue preprocessing can run in the CLI/worker path before `EforgeEngine.enqueue()` and still be recorded through existing event wrapping. | Inspected `packages/eforge/src/cli/index.ts`: enqueue creates `EforgeEngine`, calls `engine.enqueue(source)`, then wraps events with monitor/native hooks. Trust model hardening added ~83 lines but did not change the enqueue flow. | High | Low | Implement a small generator/helper that yields preprocessing provenance events before yielding `engine.enqueue(...)` events; add CLI test. | If wrong, provenance may be invisible or the route may need a daemon-side event-recording path. |
| Daemon `/api/enqueue` can stop replacing session-plan source with normalized content and instead let the spawned worker preprocess it, while retaining cheap prevalidation for 400 behavior. | `packages/monitor/src/server.ts` received ~345 lines of trust model additions. The basic enqueue route structure (validate, spawn worker) is still present but verify route details carefully before modifying. | Medium | Medium | Read current server.ts enqueue route carefully before making changes; update route tests around enqueue/session plans. | If wrong, implementation may need to pass provenance metadata into the worker or accept different daemon route behavior. |
| Adding `@eforge-build/input` to the CLI package is acceptable. | `packages/eforge/package.json` currently lacks it; monitor already depends on input. CLI is the boundary package that owns `eforge enqueue` UX. | High | Low | Add dependency and run `pnpm type-check`; verify workspace graph has no cycle. | If wrong, preprocessing helper must live in monitor/engine-adjacent code or be invoked through another package. |
| `@eforge-build/input` can depend on `@eforge-build/extension-sdk` or use structural types without creating a problematic cycle. | Current dependencies: engine -> extension-sdk; monitor -> engine + input; input -> scopes only. No current input -> engine dependency. | Medium | Low | Prefer structural input-layer types if dependency risk is unclear; otherwise add extension-sdk dependency and run type-check. | If wrong, contracts may duplicate or cause package cycles. |
| Existing `InputSourceAdapter.fetch(id)` examples remain TypeScript-compatible if runtime adds a second context parameter and allows object results. | Current `packages/extension-sdk/src/hooks.ts` defines `fetch: (id: string) => Promise<string \| null>`. TS generally allows fewer parameters for function assignment, but return type widening needs care. | Medium | Low | Add SDK compile tests with old one-arg string-return adapter and new ctx/object-return adapter. | If wrong, this becomes a breaking SDK change; implementation may need overloads or a separate v2 method. |
| The trust model hardening changes to extension loader/projector/replay/server.ts do not conflict with EXTEND_11 additions. | The trust model work added trust verification, hash/fingerprint tracking, and discovery hardening - orthogonal to input transformation concerns. | High | Low | Read the updated files before adding enricher registration; additions should layer on top cleanly. | If wrong, there may be structural conflicts requiring coordinated changes. |
| Optional PRD enrichers should fail open by default. | Existing event hooks/profile routers are fail-open; policy gates are the explicit blocking extension API. No current config exists for input enrichment failure policy. | Medium | Low | Record in docs/tests; revisit if user wants mandatory DoD injection to block. | If wrong, teams may expect failed enrichers to block enqueue; follow-up may add per-enricher `failurePolicy`. |
| The issue-tracker example can satisfy Linear/Jira/GitHub acceptance without implementing a full robust client for each service. | PRD asks for an example covering those sources, not production-ready official integrations. | Medium | Low | Build a token-gated example with clear comments and static validation; avoid network-dependent tests. | If wrong, scope expands significantly into provider-specific API/test fixtures. |

No low-confidence/high-impact assumption is unresolved. The biggest implementation risk is the daemon route changes layering cleanly on top of the trust model hardening additions; read `server.ts` carefully before modifying the enqueue route.

### Profile signal

Recommended profile: **Excursion**.

Rationale: this is a cross-package feature touching SDK contracts, input-layer helpers, extension registry projection, enqueue boundary wiring, event schemas, docs, examples, and tests. However, the work is cohesive around a single runtime seam, pre-engine input normalization. A single planner can enumerate the implementation path and dependencies without needing delegated subsystem planning, so Expedition would be unnecessarily heavy.

## Scope

### In scope

1. **Extension API/runtime registration**
   - Keep `registerInputSource` and wire it at runtime for enqueue preprocessing.
   - Add a PRD/build-source enricher registration method, tentatively `registerPrdEnricher(enricher)`, because input adapters fetch a source while enrichers modify already-normalized content.
   - Preserve existing loader/list/show/validate behavior and add the new registration family to counts, duplicate detection, projection, and docs.

2. **Input-layer normalization**
   - Preserve existing synchronous `normalizeBuildSource()` for session-plan conversion and tests.
   - Add an async extension-aware helper in `@eforge-build/input` that accepts structurally typed source-adapter/enricher registrations and returns normalized content plus provenance/diagnostics.
   - Support explicit extension input references such as `eforge://input/<adapter>/<id...>` so issue-tracker input can be requested without ambiguous filesystem/path parsing.
   - A convenience `adapter:id` shorthand can be considered only if it does not conflict with paths/URLs and is covered by tests.
   - Run built-in session-plan normalization before enrichers, so enrichers see ordinary build source.

3. **Enqueue integration before the engine**
   - Preprocess sources in the CLI/worker enqueue path before calling `EforgeEngine.enqueue(normalizedContent, ...)`.
   - Keep `packages/engine` input-agnostic: no dependency from engine to `@eforge-build/input` and no issue-tracker/source parsing inside `EforgeEngine.enqueue()`.
   - Update daemon `/api/enqueue` so it does not consume extension input in the daemon route and then hide provenance from the worker. It may retain cheap session-plan validation for 400 responses, but the spawned enqueue worker should receive enough original source context to run the shared preprocessing and emit provenance.

4. **Provenance and diagnostics**
   - Add typed client events or diagnostics for input source selection/fetch, enrichment application, and failures/timeouts.
   - Include extension name/path, registration name, source identifier redacted/truncated if needed, and whether content changed.
   - Ensure provenance appears in CLI/daemon-recorded event streams for runtime preprocessing.

5. **Example/docs/tests**
   - Add an example extension covering Linear/Jira/GitHub issue enrichment patterns without committing secrets.
   - The example should use environment variables for tokens and have safe no-token behavior documented.
   - Update `docs/extensions.md`, `docs/extensions-api.md`, `packages/extension-sdk/README.md`, and the `/eforge:extend` skill docs to move input sources/enrichers from deferred to supported once runtime lands.
   - Add unit/integration tests for adapter matching, enrichment sequencing, failure behavior, event schema validation, recorder/projection counts, CLI enqueue preprocessing, and daemon route behavior.

### Out of scope

- Low-fidelity exploratory agents for vague prompts.
- `beforeEnqueue` policy gates, approval workflows, or mutation-style policy decisions.
- Reviewer perspectives, validation providers, custom stage registration, and package/install support.
- A full external service abstraction layer for every issue tracker. The example can show patterns; production teams can customize endpoints/tokens.
- Any engine dependency on `@eforge-build/input`.

## Acceptance Criteria

### Functional acceptance

1. Extension authors can register runtime-supported input sources and PRD enrichers with typed SDK contracts.
   - `registerInputSource` is no longer documented as deferred.
   - New PRD enricher registration is documented and validated.
   - Loader/list/show/validate surfaces include counts/provenance for both families.

2. A user can enqueue an explicit extension input reference, for example `eforge://input/github/<encoded-id>`, and have the selected adapter produce build source before the engine formatter runs.
   - Unknown adapter / not-found source produces a clear enqueue failure.
   - Adapter failure emits/returns a diagnostic with extension name/path and adapter name.

3. PRD enrichers run after source resolution/session-plan normalization and before `EforgeEngine.enqueue()`.
   - Multiple enrichers run in deterministic registration order.
   - No-op enrichers do not change content.
   - Applied enrichers produce provenance showing whether content changed.

4. The engine remains input-agnostic.
   - `packages/engine/package.json` does not gain `@eforge-build/input`.
   - No engine source file imports `@eforge-build/input`.
   - Input-source parsing/fetching/enrichment happens in `@eforge-build/input` plus CLI/daemon boundary code.

5. Provenance is visible.
   - At least one typed event or diagnostic is emitted/recorded for source fetch and enrichment application/failure.
   - Client schemas, event registry summaries, and wire parity tests cover the new event variants.

6. Existing session-plan normalization still works.
   - Existing `normalizeBuildSource()` tests continue passing.
   - Direct CLI enqueue and daemon enqueue both handle session-plan file sources consistently.
   - Daemon route does not hide extension transformation provenance by doing all extension work before worker/session events can be recorded.

7. An example extension ships for issue tracker enrichment.
   - The example covers GitHub, Linear, and Jira patterns using environment variables for credentials/base URLs.
   - The example is safe to load without secrets and documents required env vars.
   - Tests or static validation ensure the example compiles/loads.

8. Documentation and integration skills are updated.
   - `docs/extensions.md`, `docs/extensions-api.md`, `packages/extension-sdk/README.md`, and `examples/extensions/README.md` reflect runtime support and syntax.
   - Pi and Claude Code `/eforge:extend` skill docs no longer label input sources as runtime-deferred once implemented.

### Validation acceptance

- `pnpm type-check` passes.
- Relevant extension, input, client event schema, CLI/daemon route, and docs tests pass.
- A grep or test confirms the engine does not import `@eforge-build/input`.
- If daemon API/versioned event wire shape changes, `DAEMON_API_VERSION` is bumped with a clear comment.

Validation commands:

```bash
pnpm type-check
pnpm test -- test/normalize-build-source.test.ts test/extension-loader.test.ts test/extension-tooling-routes.test.ts test/extension-cli-commands.test.ts test/extension-sdk-example.test.ts packages/client/src/__tests__/events-schemas.test.ts packages/client/src/__tests__/events-wire-parity.test.ts
pnpm docs:check
```

Run `pnpm docs:check` if generated docs/reference output is affected.