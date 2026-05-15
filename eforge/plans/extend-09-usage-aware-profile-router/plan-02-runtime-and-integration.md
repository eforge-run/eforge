---
id: plan-02-runtime-and-integration
name: Profile router runtime, scheduler integration, usage provider, example, docs
branch: extend-09-usage-aware-profile-router/plan-02-runtime-and-integration
agents:
  builder:
    effort: xhigh
    rationale: Touches QueueScheduler async lifecycle, daemon usage-provider
      plumbing, frontmatter mutation/commit, and new diagnostic event ordering;
      multiple integration boundaries with strict ordering constraints (route
      before session:profile/session:start, validate before --profile spawn arg,
      no active-marker mutation).
  reviewer:
    effort: high
    rationale: Scheduler async refactor and daemon DB plumbing need careful
      integration review for duplicate-launch guards, abort/shutdown semantics,
      and fail-open correctness.
---

---
id: plan-02-runtime-and-integration
name: Profile router runtime, scheduler integration, usage provider, example, docs
depends_on: [plan-01-sdk-and-wire-contracts]
---

# Profile router runtime, scheduler integration, usage provider, example, docs

## Architecture Context

Builds on plan-01's `selectBuildProfile`/`ProfileRouterContext`/`queue:profile:*` contracts to deliver the actual pre-build runtime:

- A new `packages/engine/src/extensions/profile-router-runtime.ts` invokes registered routers sequentially in registration order with timeout and fail-open semantics, mirroring the patterns already established in `packages/engine/src/extensions/event-runtime.ts` and `packages/engine/src/extensions/agent-context-runtime.ts`.
- `QueueScheduler.startReadyPrds` becomes async: for each ready PRD without an explicit `frontmatter.profile`, routing runs to completion before the parent `session:start`/`session:profile` emissions and before `_spawnPrdChild` is called. A per-PRD `launching` guard prevents duplicate concurrent launches across overlapping ticks (mutation + completion).
- When a router selects a valid profile, the engine persists `profile: <selected>` into the queued PRD's frontmatter via a new `prd-queue` helper and commits with `forgeCommit` (paths-scoped to the PRD file). The downstream `spawnPrdChild` then takes the existing `prd.frontmatter.profile` path and passes `--profile <selected>` to `queue exec`, reusing the existing pre-flight validation in `eforge.ts` (lines 1142-1184).
- A new `ProfileUsageProvider` interface is consumed by the engine; the daemon implements it on top of `MonitorDB` (a new `getProfileUsageSummary(profileName, windowMs)` method joining `session:profile`, `agent:usage`, and `agent:result` rows). CLI/direct runs pass a no-data provider so `dataSource: 'none'` is returned and routers see zero usage rather than failures.
- An example `examples/extensions/profile-router.ts` ships a Claude → Codex → local fallback whose profile names default to `claude-sdk-4-7`, `pi-codex-5-5`, `pi-deepseek-qwen` (matching repo defaults) and accept overrides via env vars `EFORGE_PROFILE_PRIMARY`, `EFORGE_PROFILE_SECONDARY`, `EFORGE_PROFILE_LOCAL`.
- Docs/runtime-support tables flip `registerProfileRouter` from `Deferred` to `Yes (pre-build dispatch)` across `docs/extensions.md`, `docs/extensions-api.md`, and `examples/extensions/README.md`.

## Implementation

### Overview

Wire the four moving parts: runtime executor, scheduler integration (incl. frontmatter persistence), daemon usage provider, and example/docs/tests. Order inside a single PRD launch becomes: discover -> isReady -> capacity check -> (if no explicit profile frontmatter) router runtime -> validate -> persist frontmatter + commit -> `session:start` + `session:profile` (with routed profile) -> `_spawnPrdChild` -> `queue:prd:complete`.

### Key Decisions

1. **Route at dispatch time.** `startReadyPrds` becomes async-capable: the inner per-PRD branch awaits a new `routeProfileForPrd(prd)` helper before constructing `session:start`/`session:profile` payloads. Routing covers daemon auto-build, manual queue file drops, playbook enqueues, and recovery.
2. **Per-PRD `launching` guard.** A `Map<prdId, Promise<void>>` (or boolean flag set inside `prdState`) prevents the same PRD from entering routing twice when `onMutation` and `onComplete` both fire while routing is in flight. Capacity check moves inside the async path so a PRD that started routing still counts toward `runningCount` for the tick.
3. **Explicit `frontmatter.profile` wins.** When `prd.frontmatter.profile` is already set, routing is skipped entirely (no `queue:profile:*` event emitted, no router invoked). The existing `spawnPrdChild` pre-flight validation continues to handle invalid explicit overrides.
4. **First valid router result wins; fail-open.** Routers are invoked in registration order; a `null`/`undefined` result defers to the next router. A throw emits `queue:profile:router-failed` and continues; a timeout emits `queue:profile:router-timeout` and continues; a result whose `profile` fails `loadProfile` (scope: local/project/user) emits `queue:profile:invalid-selection` and continues. If no router yields a valid selection, no `queue:profile:selected` is emitted and the build proceeds under the active profile (existing behavior).
5. **Frontmatter persistence is preferred; in-memory override is the documented fallback.** The new helper `setQueuedPrdProfile(prd, profile, cwd)` rewrites the YAML frontmatter block in place (preserving non-profile fields), stages only that single file, and commits via `forgeCommit` with message `chore(queue): route ${prd.id} to profile ${profile}` and the standard trailers. On write/commit failure it logs via `eventQueue` (a `queue:profile:router-failed` diagnostic with `reason: 'persist-failed'` packaged in `message`) and falls back to in-memory: the routed profile is held in a per-launch override that is passed into `spawnPrdChild` via a new optional 4th argument. The selected profile still reaches `--profile` either way.
6. **`spawnPrdChild` accepts an optional `routedProfileOverride`.** When provided, it short-circuits the in-memory override path: `args.push('--profile', routedProfileOverride)` and the existing pre-flight validation re-runs on the override too. Frontmatter-persisted selections take the existing `prd.frontmatter.profile` code path unchanged.
7. **Usage provider is engine-injected, daemon-implemented.** Engine adds an optional `profileUsageProvider?: ProfileUsageProvider` to `EforgeEngineOptions`. `ProfileUsageProvider` is a single-method contract: `getUsageSummary(profileName: string, options?: { windowMs?: number }): ProfileUsageSummary | null`. The daemon implements it on top of a new `MonitorDB.getProfileUsageSummary(profileName, windowMs)` that joins `session:profile` rows to the run, then aggregates `agent:usage` token totals and `agent:result` cost/errors over the window. CLI/direct `eforge run` provides a no-data provider returning `dataSource: 'none'`.
8. **No active marker mutation.** Routing never calls `setActiveProfile` or writes any `.active-profile` marker. A test grep gate asserts zero references to `setActiveProfile` in `packages/engine/src/extensions/profile-router-runtime.ts` and `packages/engine/src/queue/scheduler.ts`.
9. **Sequential routing of routers, parallel PRDs unchanged.** Within one PRD, routers run sequentially. Across PRDs, the scheduler's existing semaphore-bounded parallelism is preserved; routing happens before semaphore acquire and does not block other PRDs from progressing.
10. **Body/content cap.** `ProfileRouterContext.prdBody` is capped at `EFORGE_ROUTER_PRD_BODY_CHARS` (default 4096) to bound memory/perf; `prdContentSummary` exposes the first ~600 chars regardless. The cap is applied by the runtime, not by routers.
11. **Cooldown is local and config-driven.** `ProfileUsageSummary.cooldownActive`/`cooldownUntil` are derived inside the daemon usage helper using a configurable window for recent quota-like failures (default 10 minutes after `recentQuotaErrors > 0`). No new top-level config is required for this slice; thresholds are hard-coded constants in the daemon usage helper with named exports for tests. The example reads its own thresholds from env so users can experiment without changing engine code.

## Scope

### In Scope

- New `packages/engine/src/extensions/profile-router-runtime.ts` exporting `executeProfileRouters(...)` and `buildProfileRouterContext(...)`.
- Wiring the runtime into `QueueScheduler` with an async launch path, per-PRD `launching` guard, and routed profile flowing into `session:profile` and `spawnPrdChild`.
- New `setQueuedPrdProfile` helper in `packages/engine/src/prd-queue.ts` that rewrites only the `profile:` frontmatter line (adds it if absent, replaces it if present) and commits the single PRD file via `forgeCommit`.
- Optional `profileUsageProvider` plumbing through `EforgeEngineOptions` and into `QueueScheduler`.
- New `MonitorDB.getProfileUsageSummary(profileName, windowMs)` method and a `createProfileUsageProvider(db)` adapter in `packages/monitor/src/`.
- Daemon wiring in `packages/monitor/src/server-main.ts` so `engine.watchQueue(...)` receives the daemon's usage provider (passed via `EforgeEngineOptions` at create time).
- New `examples/extensions/profile-router.ts` plus an entry in `examples/extensions/README.md` describing it and noting the env vars.
- Doc updates: flip `registerProfileRouter` row from `Deferred` to `Yes (pre-build dispatch)` in `docs/extensions.md`, `docs/extensions-api.md`, and `packages/extension-sdk/README.md` table footer; rewrite the `docs/extensions-api.md#registerProfileRouter` runtime-status sentence to describe the four `queue:profile:*` events, fail-open semantics, the explicit-override precedence, and the exact-quota caveat.
- Tests: new `test/extension-profile-router-runtime.test.ts` for unit coverage of `executeProfileRouters` (first-valid-wins, defer/null, throw/timeout/invalid diagnostics, explicit-override precedence handled by caller); new `test/profile-router-scheduler.test.ts` covering scheduler integration end-to-end with a stub spawn function (asserts routing precedes `session:profile`, routed profile flows into `session:profile.profileName` and into `spawnPrdChild` args, frontmatter is rewritten and committed, active-marker file is untouched); extending `test/per-build-profile-override.test.ts` with a routed-selection scenario; extending `packages/monitor/src/__tests__/db.test.ts` (or adding a new sibling) for `getProfileUsageSummary` aggregation correctness.

### Out of Scope

- Mid-build profile switching or any retry/escalation after a quota failure.
- Real provider quota API integration (Pi/Claude SDK provider-side quota fetch).
- Toolbelt-driven automatic routing — toolbelt fields stay advisory only.
- New top-level config fields under `eforge/config.yaml` (cooldown thresholds are daemon-internal constants in this slice).
- Monitor UI custom rendering — the new events surface through `event-registry.ts` summaries only.
- Active-profile marker behavior anywhere in the engine.

## Files

### Create

- `packages/engine/src/extensions/profile-router-runtime.ts` — exports `executeProfileRouters(registry, prd, opts)` returning `{ selection: { profile, routerName, extensionName, extensionPath, reason?, confidence? } | null, diagnostics: EforgeEvent[] }`. Encapsulates: sequential invocation in `registry.profileRouters` order, per-router timeout (defaults to `config.extensions.eventHookTimeoutMs`, override via `config.extensions.profileRouterTimeoutMs` if present, else `eventHookTimeoutMs`), try/catch + timer race that emits `queue:profile:router-failed`/`router-timeout`, invocation of `selectBuildProfile` when present (else falls back to deprecated `resolve` if that is the only callable), validation of returned profile via `loadProfile(configDir, name, cwd)` emitting `queue:profile:invalid-selection` on miss. Also exports `buildProfileRouterContext(prd, deps)` which composes `availableProfiles` from `listProfiles(configDir, cwd)`, `usage.profile(name)` from the provider or no-data, current/base profile from the engine's `configProfile`, and capped `prdBody`/`prdContentSummary`.
- `examples/extensions/profile-router.ts` — Claude → Codex → local fallback using `defineEforgeExtension`. Reads thresholds and profile names from env vars with safe defaults; consults `ctx.usage.profile(name)` for `cooldownActive`/`nearLimit`/`recentQuotaErrors` to skip the primary; returns `{ profile, reason }` with human-readable rationale; defers when no candidate is suitable so other routers (or the default profile) can take over.
- `test/extension-profile-router-runtime.test.ts` — covers: (a) two routers, first returns `null`, second returns valid profile -> second wins; (b) router throws -> failed event emitted, next router consulted; (c) router never resolves -> timeout event emitted at configured timeout; (d) router returns missing profile name -> invalid-selection event emitted, next router consulted; (e) `selectBuildProfile` preferred over `resolve` when both present; (f) deprecated `resolve` path still works when `selectBuildProfile` is absent; (g) router context includes `availableProfiles`, `currentProfile`, `usage.profile` returning `dataSource: 'none'` with a no-data provider.
- `test/profile-router-scheduler.test.ts` — uses an in-memory bus + stub `spawnPrdChild` against a real `QueueScheduler` with a stub registry containing one router. Asserts: routing runs before `session:profile` emission; routed profile appears in `session:profile.profileName`; `spawnPrdChild` is invoked with a PRD whose `frontmatter.profile` is the routed profile (or whose override is routed when persistence is disabled in the test); `queue:profile:selected` is emitted with `prdId`/`profile`/`routerName`/`extensionName`/`extensionPath`/`reason`; explicit `frontmatter.profile` on the input PRD bypasses routing (no `queue:profile:*` events emitted); no `.active-profile` file is created/modified in the test cwd; abort during routing exits cleanly without enqueuing `session:start`.
- `packages/monitor/src/__tests__/profile-usage-db.test.ts` (or extend an existing DB test) — covers: aggregation across a window emits correct `recentTokens`/`recentCostUsd`/`recentRunCount`; quota-style failures surface as `recentQuotaErrors > 0` and trigger `cooldownActive`/`cooldownUntil`; no rows -> returns `null` (caller maps to `dataSource: 'none'`).

### Modify

- `packages/engine/src/extensions/index.ts` — export `executeProfileRouters` and `buildProfileRouterContext` from `./profile-router-runtime.js`.
- `packages/engine/src/queue/scheduler.ts` — convert `startReadyPrds` to support an async routing step inside its per-PRD branch via an inner `void (async () => { ... })()` that awaits routing before pushing `session:start`/`session:profile` and calling `_spawnPrdChild`. Add `launching: Set<string>` (or extend `PrdRunState` with `launching: boolean`) to prevent double entry. Accept new optional constructor options: `extensionRegistry?: Pick<NativeExtensionRegistry, 'profileRouters'>`, `profileUsageProvider?: ProfileUsageProvider`, `configDir: string`. When routing emits a `queue:profile:selected`, push that event onto `eventQueue` BEFORE `session:start` for the PRD so the monitor's session-metadata projection sees the routed profile in the right order. After routing, set the routed profile on `session:profile.profileName` (overriding `this.configProfile.name`) and pass either the persisted PRD object or a `routedProfileOverride` arg to `_spawnPrdChild`. Preserve existing capacity-blocked/dependency-blocked diagnostics by computing them on the synchronous tick before routing kicks off. Suspend (`this.suspended`) gate still applies; routing does not start while suspended.
- `packages/engine/src/eforge.ts` — thread `profileUsageProvider?: ProfileUsageProvider` through `EforgeEngineOptions`; store on the engine instance; pass it (along with `extensionRegistry: this.extensionRegistry` and `configDir`) into the `QueueScheduler` constructor. Extend `spawnPrdChild` with an optional fourth parameter `routedProfileOverride?: string`; when present, validate via the existing `loadProfile` pre-flight and pass `--profile ${routedProfileOverride}` to the child. Add a `ProfileUsageProvider` type re-export from this file (or a shared `engine/src/profile-usage.ts` if cleaner).
- `packages/engine/src/prd-queue.ts` — add `setQueuedPrdProfile(prd: QueuedPrd, profile: string, cwd: string): Promise<QueuedPrd>` that rewrites the YAML frontmatter block (using the existing simple parser) to set/replace the `profile:` line, writes the file, stages only `prd.filePath` via `forgeCommit({ cwd, message: \`chore(queue): route ${prd.id} to profile ${profile}\`, paths: [prd.filePath] })`, and returns the updated `QueuedPrd` with `frontmatter.profile` set. Throws on write/commit error; callers convert to a `queue:profile:router-failed` diagnostic.
- `packages/monitor/src/db.ts` — add `getProfileUsageSummary(profileName: string, windowMs: number): { lastUsedAt?: string; recentRunCount: number; recentTokens?: { input?: number; output?: number; total?: number }; recentCostUsd?: number; recentQuotaErrors: number } | null`. Join `events` rows of type `session:profile` (filtered to the given `profileName`) to their run id, then aggregate `agent:usage` token totals and `agent:result` cost/error counts whose timestamps fall within `windowMs` of `now()`. Return `null` when no `session:profile` rows match in window.
- `packages/monitor/src/server-main.ts` — instantiate the `ProfileUsageProvider` adapter on top of the `MonitorDB` instance and pass it into `EforgeEngine.create({ ..., profileUsageProvider })` (or however the daemon currently constructs the engine for `watchQueue`). Add cooldown derivation alongside the adapter: when `recentQuotaErrors > 0`, set `cooldownActive: true` and `cooldownUntil: now + COOLDOWN_WINDOW_MS` (named export for tests, default 10 minutes); derive `nearLimit` from a configurable token threshold constant (also named-exported, default 1_000_000 input tokens in window).
- `packages/engine/src/config.ts` — add `profileRouterTimeoutMs?: number` to `extensionConfigSchema` with the same defaulting pattern as `agentContextHookTimeoutMs` (falls back to `eventHookTimeoutMs`). Update `DEFAULT_CONFIG.extensions` and the file-load merge logic to include it.
- `docs/extensions.md` — flip the `registerProfileRouter` row in the runtime-support table from `Deferred` to `Yes (pre-build dispatch)` and add a sentence in the surrounding prose describing: dispatch-time routing, explicit override precedence, fail-open semantics, exact-quota caveat, and a link to `examples/extensions/profile-router.ts`.
- `docs/extensions-api.md` — flip the `registerProfileRouter` row in the runtime-support summary table from `Deferred` to `Yes (pre-build dispatch)`. Replace the runtime-status sentence below the `ProfileRouterResult` block with a paragraph describing the `queue:profile:*` event family (selected/router-failed/router-timeout/invalid-selection), pre-build dispatch, explicit-override precedence, and fail-open behavior. Add an example using `selectBuildProfile` that returns `{ profile, reason }` and consults `ctx.usage.profile(...)`.
- `packages/extension-sdk/README.md` — confirm the `registerProfileRouter(spec)` row's Runtime column reads `Yes (pre-build dispatch)` (set in plan-01) and ensure surrounding prose mentions `selectBuildProfile`, fail-open, and the example file path.
- `examples/extensions/README.md` — add a `### profile-router.ts` section describing the Claude → Codex → local fallback example, the env-var-driven configuration, the exact-quota caveat, the fail-open behavior, and that the runtime is wired (no `Runtime note: deferred` caveat).
- `test/per-build-profile-override.test.ts` — extend with a scenario where (a) no explicit `frontmatter.profile` is set on the queued PRD, (b) a stub router selects a valid profile, (c) the spawned `queue exec` receives the routed `--profile` and reads the persisted frontmatter. Assert no `.active-profile` mutation occurred.

## Verification

- [ ] `pnpm test test/extension-profile-router-runtime.test.ts` passes all seven cases (a-g) listed in the file's create entry.
- [ ] `pnpm test test/profile-router-scheduler.test.ts` passes: routing precedes `session:profile`; `session:profile.profileName` equals the routed profile; `_spawnPrdChild` receives a PRD/override whose profile equals the routed value; `queue:profile:selected` is emitted with all required fields; explicit `frontmatter.profile` PRDs emit zero `queue:profile:*` events; the test cwd has no `.active-profile` file.
- [ ] `pnpm test test/per-build-profile-override.test.ts` still passes including the new routed-selection scenario, and the existing explicit-override test continues to bypass routing.
- [ ] `pnpm test packages/monitor/src/__tests__/profile-usage-db.test.ts` (or sibling) passes aggregation, cooldown, and empty-window cases.
- [ ] `pnpm type-check` passes; `EforgeEngineOptions` exposes `profileUsageProvider?: ProfileUsageProvider`; `QueueScheduler` constructor accepts the new options without breaking existing callers in `eforge.ts`.
- [ ] `pnpm build` produces dist artifacts for `@eforge-build/engine`, `@eforge-build/monitor`, and `@eforge-build/extension-sdk` with no TypeScript errors.
- [ ] `pnpm docs:check` passes after running `pnpm docs:generate` — generated reference docs reflect the new `selectBuildProfile` signature and `queue:profile:*` events.
- [ ] `grep -n setActiveProfile packages/engine/src/extensions/profile-router-runtime.ts packages/engine/src/queue/scheduler.ts` returns zero hits (no active-marker mutation in routing paths).
- [ ] `examples/extensions/profile-router.ts` type-checks via `pnpm test test/extension-sdk-example.test.ts` (extend the existing test file's import list to include the new example file).
- [ ] Running `EFORGE_PROFILE_PRIMARY=claude-sdk-4-7 EFORGE_PROFILE_SECONDARY=pi-codex-5-5 EFORGE_PROFILE_LOCAL=pi-deepseek-qwen pnpm --filter ... compile-example` (or equivalent type-check) succeeds; no hard-coded profile names beyond env-var defaults appear in the example.
- [ ] Manual smoke: with an explicit `frontmatter.profile` set on a fixture PRD, `queue:profile:selected` is NOT emitted (verified via the scheduler integration test).
- [ ] Manual smoke: when the persisted-frontmatter commit fails (simulated via read-only filesystem in test), the runtime falls back to in-memory `routedProfileOverride`, emits a single `queue:profile:router-failed` diagnostic with a `persist-failed` message, and the spawned child still runs under the routed profile.
