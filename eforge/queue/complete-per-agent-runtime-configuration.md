---
title: Complete Per-Agent Runtime Configuration (Harness + Model)
created: 2026-04-24
---

# Complete Per-Agent Runtime Configuration (Harness + Model)

## Context

This is the successor PRD to
`eforge/queue/failed/per-agent-runtime-configuration-harness-model.md`, which
failed on plan-04 after 4 continuation attempts. The original PRD introduced
per-agent runtime configuration via a named `agentRuntimes` map and renamed the
"backend" concept to "harness"/"profile". It was compiled into 5 plans; plans
01-03 landed cleanly and plan-04 reached ~75% completion before exhausting the
continuation budget on mechanical test-fixture migrations. Plan-05 never
started.

This successor PRD is scoped to **finish the remaining work** (plan-04
remainder + full plan-05) and carries the **original PRD's full Acceptance
Criteria as the review gate**, so the expedition's final reviewer/evaluator
pass validates the whole PRD, not just the new slice.

The feature branch `eforge/per-agent-runtime-configuration-harness-model`
carries the landed work as:

- `a271e03` / `1d224a5` — plan-01 schema + resolver
- `337df8c` / `d9463a4` — plan-02 registry + pipeline
- `a05cf15` / `97b2bd5` / `c689cb8` — plan-03 harness rename
- `212af9e` — plan-04 WIP squashed (source changes done; test fixtures + new tests + plan-load validation + monitor-ui session rename + one `AgentTerminalError.message` bug still outstanding)

Enqueue this PRD with the feature branch checked out so the expedition runs
on top of the landed work. `packages/engine/src/eforge.ts:264-265` infers the
base branch from the current `HEAD`, not from a CLI flag.

## Goal

Land plan-04's outstanding work and all of plan-05 on top of the existing
feature branch, with a final review gate that re-validates the original
PRD's 15 Acceptance Criteria against the whole tree.

## Approach

### Section A — Finish plan-04

**A1. Source fix: `AgentTerminalError.message` regression.**

`test/harness-rename.test.ts:135` asserts `err.message === 'Max turns exceeded'`
but the current `AgentTerminalError` constructor prepends `<subtype>: ` to
`.message`. Fix in `packages/engine/src/harness.ts` — subtype already lives
on `.subtype`, so the prefix is redundant and breaks idiomatic Error usage.

**A2. Test fixture migration — 25 files, one pattern.**

Replace every occurrence of:

```ts
{ backend: 'claude-sdk', ...rest }
```

inside `EforgeEngine.create({ config: … })` call sites with:

```ts
{
  agentRuntimes: { default: { harness: 'claude-sdk' } },
  defaultAgentRuntime: 'default',
  ...rest,
}
```

Files (verified via `grep -rln "backend: 'claude-sdk'\\|backend: 'pi'" test/`):

- `test/watch-queue.test.ts`
- `test/greedy-queue-scheduler.test.ts`
- `test/engine-wiring.test.ts`
- `test/backend-common.test.ts`
- `test/gap-closer.test.ts`
- `test/monitor-reducer.test.ts`
- `test/continuation.test.ts`
- `test/cohesion-review.test.ts`
- `test/dependency-detector.test.ts`
- `test/doc-updater-wiring.test.ts`
- `test/evaluator-continuation.test.ts`
- `test/formatter-agent.test.ts`
- `test/merge-conflict-resolver.test.ts`
- `test/parallel-reviewer.test.ts`
- `test/pipeline-composer.test.ts`
- `test/pipeline.test.ts`
- `test/planner-continuation.test.ts`
- `test/planner-submission.test.ts`
- `test/prd-validator-fail-closed.test.ts`
- `test/retry.test.ts`
- `test/staleness-assessor.test.ts`
- `test/tester-wiring.test.ts`
- `test/validation-fixer.test.ts`

Two files need partial migration (not a blind pattern replace):

- `test/config.test.ts` — rewrite the `backendSchema` and `backend and pi validation` describes to assert **rejection** by `configYamlSchema` (since scalar `backend:` / top-level `pi:` / top-level `claudeSdk:` are now rejected at parse time). Keep `resolveConfig` / `mergePartialConfigs` coverage intact but point it at the nested `agentRuntimes` shape.
- `test/config-backend-profile.test.ts` — profile files still carry a nested `backend: pi` shape inside `agentRuntimes.<name>`, so profile tests stay valid; update only the top-level fixtures that used scalar `backend:`.
- `test/config.agent-runtimes.schema.test.ts` — legacy-coexistence assertions, rewrite to assert rejection of the old shape.

Reuse `test/stub-harness.ts` + `singletonRegistry(stub)` for stub-based tests
(see `test/agent-wiring.test.ts`). No new test helpers required.

**A3. Add the 3 new tests scoped in plan-04.**

- `packages/engine/test/plan-file.agent-config.test.ts` — plan-level `agentRuntime` override wins over role/default; validation failure when plan references undeclared runtime.
- `packages/engine/test/config.legacy-rejection.test.ts` — migration rejection message shape for each of `backend:`, top-level `pi:`, top-level `claudeSdk:`.
- `packages/engine/test/events.agent-start.test.ts` — `agent:start` emits `{ agentRuntime, harness }` for a mixed-runtime config, never carries `backend`.

**A4. Plan-load-time validation.**

`packages/engine/src/plan.ts` (plan-file loader) — validate every
`PlanFile.agents.<role>.agentRuntime` exists in `config.agentRuntimes`; error
carries plan file path, role, and referenced name.

**A5. Monitor-UI session rename (complete the rip).**

Rename the session-level `backend` display field to `harness` across:

- `packages/monitor-ui/src/lib/types.ts:78` — field in `RunState`
- `packages/monitor-ui/src/lib/reducer.ts:81,108,142,297-300,413,435` — reducer + initial state + reset logic
- `packages/monitor-ui/src/app.tsx:318` — prop passed to `SummaryCards`
- `packages/monitor-ui/src/components/common/summary-cards.tsx:23,50,75` — prop name
- `packages/monitor-ui/src/components/layout/sidebar.tsx:116-117` — `metadata.backend` display

### Section B — Plan-05: profile rename + MCP/slash/HTTP surface + docs

**B1. Profile system directory and loader rename.**

- Directory rename `eforge/backends/` → `eforge/profiles/`.
- Marker file rename `.active-backend` → `.active-profile`.
- Loader function renames in `packages/engine/src/config.ts` (L748-1073):
  - `loadBackendProfile` → `loadProfile`
  - `setActiveBackend` → `setActiveProfile`
  - `listBackendProfiles` → `listProfiles`
- Auto-migration on first load: if `eforge/backends/` exists and `eforge/profiles/` does not, `git mv` the directory and rename the marker; log the action. If both exist, warn and leave `eforge/backends/` untouched (human resolves).

**B2. MCP tool rename.**

`eforge_backend` → `eforge_profile` in BOTH:

- `packages/pi-eforge/extensions/eforge/index.ts` L598
- `packages/eforge/src/cli/mcp-proxy.ts` L415

**B3. Slash command skill rename.**

- `eforge-plugin/skills/backend/` → `profile/` (command `/eforge:backend` → `/eforge:profile`)
- `eforge-plugin/skills/backend-new/` → `profile-new/` (command `/eforge:backend-new` → `/eforge:profile-new`)
- Mirror in `packages/pi-eforge/skills/` to satisfy `scripts/check-skill-parity.mjs`.
- Update skill registration in `eforge-plugin/.claude-plugin/plugin.json`.
- Sweep all remaining skill files for stale `/eforge:backend` references and update (`config/config.md` has ~18 occurrences per the original plan-05 doc).

**B4. HTTP route + client rename + `DAEMON_API_VERSION` bump.**

- `packages/monitor/src/server.ts` — `/backends` → `/profiles`, `/backends/active` → `/profiles/active`. Dispatch via `API_ROUTES` per AGENTS.md.
- `packages/client/src/api-version.ts` — rename `API_ROUTES.backends` / `.backendsActive` to `.profiles` / `.profilesActive`; bump `DAEMON_API_VERSION` 5 → 6 (breaking).
- `packages/client/src/api/backend.ts` → `packages/client/src/api/profile.ts` (git mv); rename exported helpers (`apiBackends` → `apiProfiles`, etc.). Update `packages/client/src/index.ts` exports.
- Update callers: `packages/monitor-ui/src/lib/api.ts`, any CLI / Pi extension code using the client.

**B5. Plugin version bump + init-skill update.**

- `eforge-plugin/.claude-plugin/plugin.json` — bump `0.7.1` → `0.8.0`.
- `eforge-plugin/skills/init/init.md` + `packages/pi-eforge/skills/eforge-init/SKILL.md` — scaffold configs using `agentRuntimes:` + `defaultAgentRuntime:` (not scalar `backend:`); write profile files to `eforge/profiles/`; manage `eforge/.active-profile` marker; success message references `/eforge:profile` and `/eforge:profile-new`.

**B6. Docs.**

- `README.md` — update terminology and config examples to `agentRuntimes:` shape.
- `AGENTS.md` — update the `eforge/backends/` reference in conventions (already notes `harnesses/` per plan-03).
- `packages/pi-eforge/README.md`, `eforge-plugin/README.md` (if present) — same terminology sweep.
- **CHANGELOG.md is untouched** — release-flow-owned.

## Scope

### In scope

All items in sections A and B above.

### Out of scope

- `CHANGELOG.md` — release-flow-owned.
- `packages/pi-eforge/package.json` version — versioned at npm publish time, not here.
- Eval harness updates (`eval/eforge/backends/` → `eval/eforge/profiles/`, etc.) — tracked separately in `tmp/eval-harness-per-agent-config.md`.
- `eforge init --migrate` helper — rejection-message path (already landed in plan-04 WIP) handles config migration; profile directory auto-migration handles the profile side.

## Critical files

### Section A (plan-04 finish)

- `packages/engine/src/harness.ts` — `AgentTerminalError.message` fix
- `packages/engine/src/plan.ts` — plan-load-time `agentRuntime` validation
- `packages/engine/test/plan-file.agent-config.test.ts` — NEW
- `packages/engine/test/config.legacy-rejection.test.ts` — NEW
- `packages/engine/test/events.agent-start.test.ts` — NEW
- `test/{25 files listed in A2}` — fixture migration
- `test/{config.test.ts,config-backend-profile.test.ts,config.agent-runtimes.schema.test.ts}` — partial rewrite for rejection semantics
- `packages/monitor-ui/src/lib/{types.ts,reducer.ts}`, `app.tsx`, `components/common/summary-cards.tsx`, `components/layout/sidebar.tsx` — session `backend` → `harness`

### Section B (plan-05)

- `packages/engine/src/config.ts` L748-1073 — profile loader renames + auto-migration
- `packages/pi-eforge/extensions/eforge/index.ts` + `packages/eforge/src/cli/mcp-proxy.ts` — MCP tool rename
- `eforge-plugin/skills/{backend,backend-new}/` → `{profile,profile-new}/`; mirror in `packages/pi-eforge/skills/`; `eforge-plugin/.claude-plugin/plugin.json`
- `packages/monitor/src/server.ts` + `packages/client/src/api-version.ts` + `packages/client/src/api/backend.ts` → `profile.ts`
- `packages/monitor-ui/src/lib/api.ts` — caller update
- `eforge-plugin/skills/init/init.md` + `packages/pi-eforge/skills/eforge-init/SKILL.md` — init-skill terminology + output shape
- `README.md`, `AGENTS.md`, plugin READMEs — docs

## Acceptance Criteria

**These are carried verbatim from the original PRD. Every item must be
verified against the tree state at the end of this build, not only the new
work. Each item is annotated with its expected source (landed earlier, or
pending in this build).**

### Build & type checks

- [ ] `pnpm build && pnpm test && pnpm type-check` green at each commit boundary.

### Unit + integration tests

- [ ] `packages/engine/test/agent-runtime-registry.test.ts` — lazy Pi load; shared instance for two roles using same name; throws on unknown name. *(landed in plan-02; re-verify green)*
- [ ] `packages/engine/test/agent-config.resolution.test.ts` — `resolveAgentRuntimeForRole` precedence (plan > role > default); missing/dangling reference errors; per-role ModelRef provider-ness validation at resolve time. *(landed in plan-01; re-verify green)*
- [ ] `packages/engine/test/agent-config.mixed-harness.test.ts` — planner on claude-sdk and builder on pi; correct class-defaults table per role. *(landed in plan-01; re-verify green)*
- [ ] `test/agent-wiring.test.ts` — stub injection via `singletonRegistry(stub)`; two-stubs two-roles dispatch case. *(landed in plan-02; re-verify green)*
- [ ] `packages/engine/test/plan-file.agent-config.test.ts` — plan-level `agentRuntime` override wins; validation failure on undeclared ref. **(new in this build, Section A3)**
- [ ] Integration: one eval-style scenario run through a mixed-runtime config; verify `agent:start` events show the correct `agentRuntime` + `harness` per role. **(new in this build, Section A3)**

### Manual verification

- [ ] `eforge init` scaffolds a config using `agentRuntimes:`. **(Section B5 — init skill update)**
- [ ] `/eforge:profile` lists profiles. **(Section B3)**
- [ ] `/eforge:profile new <name>` scaffolds one. **(Section B3)**
- [ ] `eforge enqueue` kicks off a build with a mixed-runtime config. **(verify at merge)**
- [ ] Monitor UI shows per-agent `agentRuntime` + `harness` + `model` in stage hover — e.g. `"planner → opus (claude-sdk, claude-opus-4-7)"`. *(landed in plan-04 WIP; re-verify at merge)*

### Migration behavior

- [ ] Loader rejects scalar top-level `backend:` + top-level `pi:` / `claudeSdk:` with a clear migration message pointing at `agentRuntimes:` + `defaultAgentRuntime:`. *(landed in plan-04 WIP; re-verified by new `config.legacy-rejection.test.ts` in Section A3)*
- [ ] Existing `eforge/backends/*.yaml` profiles auto-moved to `eforge/profiles/` on first load. **(Section B1)**

### Version + release

- [ ] `eforge-plugin/.claude-plugin/plugin.json` bumped to `0.8.0`. **(Section B5)**
- [ ] `DAEMON_API_VERSION` in `packages/client/src/api-version.ts` bumped (5 → 6) for HTTP route rename. **(Section B4)**
- [ ] `packages/pi-eforge/package.json` version untouched.
- [ ] `CHANGELOG.md` not edited in this PR.

### Anti-regression (absence checks)

- [ ] `grep -R "\\bbackendSchema\\b" packages/engine/src/` — zero matches.
- [ ] `grep -R "backend: 'claude-sdk'\\|backend: 'pi'" test/` — zero matches.
- [ ] No code path in `packages/engine/src/` constructs a registry from a scalar `backend` value.
- [ ] No remaining `eforge_backend` MCP tool registration or `/eforge:backend` slash reference in `eforge-plugin/skills/` or `packages/pi-eforge/skills/` (except release notes / CHANGELOG).

## Implementation order (each commit keeps the tree green)

1. **A1 + A2 + A3**: source fix + test fixture migration + 3 new tests together, because the fixture migration fails fast without the source fix and the new tests cover behavior that only becomes visible once fixtures are green. Land as a single plan.
2. **A4**: plan-load-time validation. Small, isolated. Can piggyback on A1-A3's plan if sized fits.
3. **A5**: monitor-UI session rename. Isolated; land as its own plan.
4. **B1 + B2**: profile directory rename + loader renames + MCP tool rename. Tightly coupled (loader consumers are the MCP tools).
5. **B3 + B5**: slash command rename + plugin version bump + init-skill update. Coupled via plugin.json registration.
6. **B4**: HTTP route + client + `DAEMON_API_VERSION` bump. Breaking HTTP contract; last before docs.
7. **B6**: docs sweep (README, AGENTS.md, plugin READMEs).

The planner should produce plans roughly aligned with this order; each plan
touches a bounded file set so no single plan hits the continuation wall that
killed the first build's plan-04.
