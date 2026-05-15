---
title: EXTEND_09: Usage-aware profile router
created: 2026-05-15
depends_on: ["extend-07-extension-validation-and-replay-test-harness"]
profile: claude-sdk-4-7
---

# EXTEND_09: Usage-aware profile router

## Problem / Motivation

EXTEND_09 needs to turn the already-captured `registerProfileRouter` extension capability into a real pre-build runtime feature. Today profile choice is either an active marker (`.active-profile`/`eforge/.active-profile`/user marker) or an explicit per-build override (`--profile`, daemon enqueue body, PRD frontmatter). Extensions can register profile routers, but the docs and SDK mark runtime execution as deferred.

Why this matters now:
- Teams need quota/cost/provider-aware routing without mutating active profile marker files.
- The TypeScript extension roadmap explicitly calls out pre-build profile routing as the first safe implementation, before any mid-build fallback behavior.
- Existing per-build profile override plumbing is already in place, so the remaining gap is extension decision runtime + observable provenance + usage/cooldown signals.

Affected users: eforge users running multiple agent runtime profiles (e.g. Claude SDK, Pi/Codex, local DeepSeek/Qwen) who want automatic per-build selection based on usage, provider health, priority, or workload.

Evidence sources:
- `docs/prd/typescript-extensibility.md` defines EXTEND_09 as pre-build routing: validate selected profile, stamp/apply per-build override, emit `queue:profile:selected`, and avoid mutating active profile markers.
- Schaake OS epic `fcb0dbf5-fcbf-49f3-b7c2-10bf110d0730` is in progress and requires extension registration, profile existence validation, observable decision events, Claude -> Codex -> local fallback example, and keeping toolbelt metadata advisory only.
- `docs/roadmap.md` lists native TypeScript extensions as current extensibility roadmap work and TypeBox schema unification as still in progress for config/input/MCP schemas.
- Existing extension foundation is present: `packages/extension-sdk/src/api.ts`, `hooks.ts`, `context.ts`; engine loader/recorder in `packages/engine/src/extensions/`; docs in `docs/extensions.md` and `docs/extensions-api.md`; examples in `examples/extensions/`.
- `registerProfileRouter` is currently type-captured but deferred at runtime. The SDK contract currently uses `resolve(ctx: AgentRunContext)` returning `{ profile }`, which conflicts slightly with the PRD's desired pre-build profile routing context.
- Per-build profile override support already exists: enqueue accepts `profile`, `enqueuePrd` writes `profile:` frontmatter, queue worker validates PRD frontmatter profile before spawning, and `queue exec --profile` loads `loadConfig(..., { profileOverride })` rather than changing active markers.
- Queue dispatch is owned by `packages/engine/src/queue/scheduler.ts`; it currently emits `session:start` and `session:profile` before spawning each child. This means dispatch-time routing must happen before those emissions if the monitor metadata should show the routed profile.
- Daemon enqueue route in `packages/monitor/src/server.ts` validates explicit profile overrides before spawning an enqueue worker. The persistent daemon watcher in `packages/monitor/src/server-main.ts` runs `engine.watchQueue()` and records events to SQLite.
- Existing wire event schemas live in `packages/client/src/events.schemas.ts`; any new `queue:profile:selected` / failed / timeout event must be defined there and registered in `packages/client/src/event-registry.ts`.
- Current local/user profiles include `claude-sdk-4-7`, `pi-codex-5-5`, and `pi-deepseek-qwen`; the PRD example names `codex-5-5` and `deepseek-qwen-local`, so docs/examples should make names configurable rather than hard-coded.
- `docs/prd/typescript-extensibility.md` EXTEND_09 section and Schaake OS epic acceptance criteria.
- `packages/extension-sdk/src/api.ts` / `hooks.ts` expose `registerProfileRouter` but docs mark runtime deferred.
- `test/per-build-profile-override.test.ts` confirms profile overrides already load config via `profileOverride` and serialize PRD frontmatter.

Early assumptions / unknowns:
- Assumption (medium confidence): dispatch-time routing is safer than enqueue-time routing for initial delivery because it covers external/manual queue files and daemon auto-build, while reusing existing PRD frontmatter/`queue exec --profile` behavior. It requires making scheduler launch asynchronous.
- Unknown: whether exact provider quota data is available. Existing events expose token/cost usage and model usage, but no provider subscription quota API was found. Initial usage heuristics should therefore be local/event-derived plus explicit cooldown state, not claimed as exact quota truth.
- Assumption (medium confidence): the profile-router SDK contract should be widened to a build/queue routing context, with `AgentRunContext` compatibility either deprecated or replaced for this capability. Keeping an agent-run-shaped context would under-specify queue priority/source/workload inputs.

## Goal

Deliver pre-build runtime execution of profile router extensions so that queued PRDs (without an explicit `profile` override) are automatically routed to an appropriate profile at dispatch time, applied as a per-build override with observable provenance events, validated profile existence, fail-open semantics, and best-effort usage/cooldown signals - without ever mutating active profile marker files.

## Approach

### Design Decisions

1. **Route at dispatch time for initial delivery.**
   - Decision: evaluate routers in `QueueScheduler` immediately before a ready PRD is launched.
   - Rationale: dispatch-time routing covers daemon auto-build, manually added queue files, playbook/recovery enqueues, and externally written PRDs. It also lets routing use latest usage/cooldown data.
   - Trade-off: scheduler launch becomes async and needs a `routing`/`launching` guard to prevent duplicate launches.

2. **Explicit per-build overrides win.**
   - Decision: if PRD frontmatter already contains `profile`, do not invoke routers for that PRD.
   - Rationale: explicit user/API/frontmatter intent should remain deterministic and already has validation/preflight behavior.
   - Observable behavior: optional debug/default event is not required, but selected-router events should not claim ownership of explicit choices.

3. **Canonical router API should be build-oriented.**
   - Decision: introduce `selectBuildProfile(ctx)` as the canonical router method. Preserve existing `resolve(ctx)` as deprecated compatibility if cheap, but do not keep `AgentRunContext` as the main context.
   - Rationale: profile routing needs PRD id/title/body/priority, current profile, available profiles, usage/cooldown state, and workload hints. `AgentRunContext` is role/tier/agent-run oriented and would encourage the wrong lifecycle semantics.

4. **First valid router result wins; failures fail open.**
   - Decision: invoke routers sequentially in registration order. A `null`/`undefined` result defers. A thrown error, timeout, or invalid/missing profile emits a diagnostic and continues to the next router or default active profile.
   - Rationale: profile routers influence cost/performance but should not break builds by default. This matches event/agent-context extension fail-open precedent.
   - Constraint: a selected missing profile must never reach `queue exec --profile`; validation happens before application.

5. **Selection event is the source of truth for provenance.**
   - Decision: emit `queue:profile:selected` when a valid router selection is applied, carrying PRD id/title, profile, router name, extension name/path, reason, and current/base profile.
   - Rationale: monitor/CLI/users need to understand why a build used a different profile, and docs require observable decision events.
   - Additional diagnostics: add router failed/timeout/invalid events either as `extension:profile-router:*` or `queue:profile:*` diagnostics, registered in the wire schema.

6. **Persist profile selection into PRD frontmatter when possible.**
   - Decision: add a helper to update queued PRD frontmatter with `profile: <selected>` and commit via `forgeCommit`; then existing child spawn can rely on `prd.frontmatter.profile`. If persistence fails, emit a diagnostic and either fail open to spawn with explicit in-memory profile override or default; choose one behavior explicitly in implementation tests.
   - Rationale: persisting frontmatter matches the PRD's preferred implementation, survives parent/child boundaries, makes recovery/audit easier, and reuses existing validation.
   - Risk: extra queue mutation commit before each routed build; must scope staging to the PRD file only.

7. **Usage API is best-effort and local.**
   - Decision: expose `ctx.usage.profile(name)` as a normalized summary with fields such as recent tokens/cost/run count, last used time, recent quota/rate-limit-like failure, cooldown status, and `nearLimit` derived from configurable thresholds.
   - Rationale: exact provider quota is not available in existing code. The PRD explicitly allows local rolling counters, provider errors, thresholds, and cooldown windows.
   - Implementation boundary: engine receives an optional usage provider from the daemon; CLI/direct runs use a no-data provider rather than importing monitor DB into the engine.

8. **Profile metadata/toolbelts are advisory only.**
   - Decision: include profile summaries/metadata/toolbelt assignments in router context so extensions can inspect them, but do not add any automatic toolbelt-based routing behavior.
   - Rationale: matches epic guardrail that routing belongs to extensions and toolbelt metadata may inform but not trigger routing.

9. **No active marker mutation.**
   - Decision: never call `setActiveProfile` or write `.active-profile` marker files as part of routing.
   - Rationale: acceptance criteria require per-build override only; existing `loadConfig(..., { profileOverride })` already supports this.

10. **Docs/examples track actual supported capability.**
    - Decision: update runtime support tables to mark `registerProfileRouter` as supported only after scheduler runtime/tests land; example uses configurable profile names with environment variables/default constants.
    - Rationale: avoid docs promising exact quota or hard-coded profile names that may not exist.

### Code Impact

Likely files/modules to change, with evidence:

#### SDK and extension types
- `packages/extension-sdk/src/hooks.ts`
  - Current `ProfileRouterSpec` uses `resolve(ctx: AgentRunContext)` and `ProfileRouterResult { profile }`; update for build/queue routing context and `reason`.
- `packages/extension-sdk/src/context.ts`
  - Current context contains `AgentRunContext`; add `ProfileRouterContext`, profile summary, usage summary, and usage provider interfaces.
- `packages/extension-sdk/src/api.ts`
  - Docs/comments currently say runtime deferred; update `registerProfileRouter` comments and examples.
- `packages/extension-sdk/src/index.ts`, `packages/extension-sdk/README.md`
  - Re-export/document new types and runtime support.

#### Engine extension runtime
- `packages/engine/src/extensions/types.ts`
  - Mirror updated router spec shape without importing SDK types.
- `packages/engine/src/extensions/recorder.ts`
  - Accept canonical `selectBuildProfile` and deprecated `resolve`; keep duplicate-name diagnostics.
- New likely file: `packages/engine/src/extensions/profile-router-runtime.ts`
  - Execute routers with timeout/fail-open semantics.
  - Build `ProfileRouterContext` with queue item, current profile, profile listing/validation helpers, usage API, logger/exec.
  - Return selected profile + diagnostics/events.
- `packages/engine/src/extensions/index.ts`
  - Export profile-router runtime helpers/types.

#### Queue dispatch/profile application
- `packages/engine/src/queue/scheduler.ts`
  - Current launch path is synchronous and emits `session:start`/`session:profile` before spawning. Routing must happen before these emissions.
  - Add async routing step for ready PRDs; guard against duplicate concurrent launch attempts while routing is pending.
  - Emit selected profile in parent `session:profile` metadata for accurate monitor session metadata.
- `packages/engine/src/eforge.ts`
  - Pass `nativeExtensionRegistry` and config profile/profile-usage provider into `QueueScheduler`.
  - Ensure `spawnPrdChild` receives routed profile (frontmatter persisted or an explicit spawn override) and existing explicit `prd.frontmatter.profile` behavior still wins.
- `packages/engine/src/prd-queue.ts`
  - Add helper to set/replace `profile:` frontmatter on a queued PRD and commit with `forgeCommit`, if persisted frontmatter is selected.
  - Existing `enqueuePrd`, frontmatter parsing, and queue exec validation can be reused.

#### Daemon/usage provider
- `packages/monitor/src/server-main.ts`
  - Persistent daemon watcher has `MonitorDB`; pass a profile usage provider into `engine.watchQueue(...)` if the engine API accepts one.
- `packages/monitor/src/db.ts`
  - Add a named DB helper to compute recent profile usage/cost/failure/cooldown summaries from persisted events, rather than inlining SQL shape in server-main.
  - Existing events include `session:profile`, `agent:usage`, `agent:result`, and agent failures, but no exact quota signal.

#### Wire events and rendering
- `packages/client/src/events.schemas.ts`
  - Add `queue:profile:selected` and any router diagnostic event schemas.
- `packages/client/src/event-registry.ts`
  - Add registry entries/summaries.
- `packages/eforge/src/cli/display.ts`
  - Add concise CLI output for routing selection/diagnostics if not intentionally silent.
- Monitor UI may not require custom rendering if registry summaries cover it, but check `packages/monitor-ui/src/components/timeline/event-card.tsx` if event details need first-class display.

#### Examples/docs/tests
- `examples/extensions/profile-router.ts` and `examples/extensions/README.md`.
- `docs/extensions.md`, `docs/extensions-api.md`, possibly `docs/config.md` if usage/cooldown config fields are added.
- Tests likely in `test/extension-loader.test.ts`, new `test/extension-profile-router-runtime.test.ts`, `test/per-build-profile-override.test.ts` or new scheduler integration test, `packages/client/src/__tests__/events-schemas.test.ts`, `packages/client/src/__tests__/events-wire-parity.test.ts`, and `test/extension-tooling-wiring.test.ts`.

Validated patterns:
- Per-build profile override already exists and does not mutate active markers (`loadConfig(..., { profileOverride })`, `queue exec --profile`).
- Extension event and agent-context runtimes already establish timeout/fail-open diagnostics patterns to follow.
- Queue ordering already exposes `priority` in PRD frontmatter, which should be included in router context.

### Profile Signal

Recommended eforge profile: **Excursion**.

Rationale: this is cross-cutting feature work across the SDK, engine scheduler, daemon DB/provider boundary, client wire events, docs, and examples, but it is still cohesive enough for one planner to enumerate the implementation sequence. It does not require delegated module planning or independently planned subprojects. The key complexity is integration ordering (routing before parent `session:profile`, validating before spawn, and keeping engine/monitor boundaries clean), not expedition-scale architectural decomposition.

## Scope

### In scope

1. SDK/API contract for build profile routers
   - Add/confirm a pre-build routing context type distinct from `AgentRunContext`.
   - Prefer canonical `selectBuildProfile(ctx)` naming to match the PRD; keep existing `resolve(ctx)` as a deprecated compatibility alias if cheap.
   - Router result should include `profile` and `reason` at minimum; optional metadata/confidence is acceptable if useful for events.
2. Runtime execution before queue dispatch
   - Evaluate routers for queued PRDs that do not already have an explicit `profile` frontmatter override.
   - Run routers sequentially in registration order; first valid non-null result wins.
   - Fail open on router errors/timeouts/invalid profile selections: emit diagnostics and continue to the next router or default active profile.
3. Profile validation/application
   - Validate selected profiles with existing scoped `loadProfile` lookup before running.
   - Apply the selected profile as a per-build override only, never by writing active-profile marker files.
   - Prefer persisting the selection into the queued PRD frontmatter before spawn using a helper that stages/commits with `forgeCommit`; at minimum the spawned `queue exec` must receive `--profile <selected>`.
4. Observable events/provenance
   - Add wire-schema events for successful selection and router diagnostics (failed/timeout/invalid selection as needed).
   - Include router name, extension name/path, PRD id/title, selected profile, and reason.
5. Usage/profile context
   - Expose available profile summaries/metadata/toolbelt hints to router context.
   - Expose a best-effort usage API based on local event/cost/cooldown signals; make exact quota caveats explicit.
6. Example and docs
   - Ship an example profile router implementing configurable Claude -> Codex -> local fallback.
   - Update `docs/extensions.md`, `docs/extensions-api.md`, `packages/extension-sdk/README.md`, and example index/readme to mark profile routing runtime as supported.
7. Tests
   - Unit and integration coverage for SDK contract, recorder validation, router runtime, scheduler dispatch, event schemas/registry, docs/examples, and no active marker mutation.

### Out of scope

- Mid-build profile switching or retry-with-new-profile after a quota failure.
- Exact provider subscription quota integration unless already exposed by a harness/provider.
- Toolbelt-driven automatic routing. Toolbelt metadata may be inspected by routers, but toolbelts themselves must not trigger routing.
- Broad workflow automation, scheduling policy, notifications, or approvals outside the eforge build lifecycle.
- Extension replay/test harness work beyond adding the profile-router example/tests needed for this feature.

## Acceptance Criteria

### Functional

- An extension can register a profile router using the supported SDK contract, and `eforge extension list/show/validate` reports the registration.
- During queue dispatch, a PRD without explicit `profile` frontmatter is offered to registered routers before the build subprocess starts.
- The first router returning a valid profile selection applies that profile as a per-build override; active profile marker files are not created or modified.
- If a PRD already has explicit `profile` frontmatter, routing is skipped and existing explicit override behavior remains unchanged.
- eforge validates the selected profile exists in project-local, project-team, or user profile scopes before spawning `queue exec`.
- Missing/invalid router selections, router throws, and router timeouts are visible as typed events/diagnostics and do not crash otherwise valid builds.
- A successful router decision emits an observable typed event containing at least PRD id/title, selected profile, router name, extension name/path, base/current profile, and reason.
- The spawned queue worker runs under the selected profile (`--profile <selected>` / `profileOverride`) and monitor session metadata reflects the routed profile.
- Routing never calls active-profile marker mutation helpers and tests prove marker files are unchanged.

### Usage/profile context

- Router context exposes queue/workload inputs including PRD id, title, body/content summary, priority, dependencies, current/base profile, and available profile summaries.
- Router context exposes best-effort usage/cooldown helpers with documented caveats; exact provider quota is not implied.
- Daemon auto-build can provide event-history-derived usage summaries; CLI/direct fallback returns unknown/zero usage rather than failing.
- Profile metadata/toolbelt assignments may be inspected by router code, but toolbelt configuration alone does not trigger routing.

### Example/docs

- `examples/extensions/profile-router.ts` implements configurable Claude -> Codex -> local fallback using profile names and thresholds/cooldown heuristics configurable by constants/env/config.
- Extension docs/API reference/SDK README mark profile routing runtime support accurately and explain fail-open behavior, exact quota caveat, and explicit override precedence.

### Tests/quality gates

- Add/update TypeScript/unit tests for SDK type exports and recorder validation of canonical/deprecated router shapes.
- Add runtime tests for first-valid-router-wins, defer/null, invalid profile, timeout/error diagnostics, and explicit override precedence.
- Add scheduler integration coverage proving selected profile is applied before parent `session:profile` and before child spawn.
- Add wire schema and registry tests for new events.
- Run `pnpm test` and `pnpm type-check` (or narrower affected tests during development plus full checks before completion).

### Assumptions and Validation

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| Dispatch-time routing is the right first implementation point. | PRD says enqueue or dispatch, with preferred pre-build profile routing. Code inspection shows `QueueScheduler` owns launch and can emit correct parent `session:profile` only if routing happens before spawn. | high | low | Implementation spike in scheduler tests. | If wrong, build may need enqueue-route integration too; dispatch still covers more queue sources. |
| Existing per-build profile override plumbing can be reused. | Verified `EnqueueOptions.profile`, `enqueuePrd` writes `profile:`, daemon route validates explicit profiles, `spawnPrdChild` passes `--profile`, and `loadConfig(profileOverride)` exists with tests. | high | low | Extend existing per-build profile tests with router-selected profile. | If wrong, routing would require broader profile-runtime plumbing. |
| Exact provider quota data is not currently available. | Searches found token/cost events (`agent:usage`, `agent:result`) but no provider quota API. PRD itself notes exact quota caveat and suggests rolling counters/errors/cooldowns. | high | medium | Inspect Pi provider SDK capabilities if exact quota becomes a hard requirement. | If wrong, usage API could be richer; current best-effort design remains compatible. |
| Engine should not import monitor DB directly. | Project conventions keep shared daemon/client contracts separate; monitor owns SQLite DB, engine emits events. `server-main.ts` already wraps watcher events with recording. | high | low | Confirm package dependency graph in `package.json` if needed. | Direct import would create architectural coupling and likely build issues. |
| Persisting router selection to PRD frontmatter is acceptable despite an extra commit. | PRD preferred implementation says stamp queue item/frontmatter; queue helpers already commit queue mutations with `forgeCommit`. | medium | low | Test working-tree cleanliness and queue-file commit behavior. | If extra commit is undesirable, use in-memory spawn override plus event provenance instead. |
| `selectBuildProfile(ctx)` can be added while keeping `resolve(ctx)` compatibility. | Current recorder requires `{ name, resolve }`; changing validation is straightforward. No existing runtime depends on `resolve`. | medium | low | Run extension loader tests and compile SDK examples. | If compatibility adds complexity, breaking old deferred-only API may be acceptable but should be documented. |
| Router context can include enough PRD body/content for workload decisions without excessive memory/perf cost. | `QueuedPrd` already includes full `content`; dependency detector passes content summaries elsewhere. | medium | low | Cap body length or provide `contentSummary` in context during implementation. | If large PRDs cause overhead, expose summary/path instead of full body. |
| Router fail-open is preferable to failing builds. | Existing event and agent-context extension runtimes fail open; profile routing is advisory/cost-related, not a blocking policy gate. | high | low | User/maintainer review during implementation. | If teams expect fail-closed, future config can add failure policy; initial behavior must be documented. |

No unresolved low-confidence/high-impact assumptions remain. The main implementation choice to watch is whether frontmatter persistence should be mandatory or whether in-memory per-spawn override is sufficient if queue-file mutation is too invasive.
