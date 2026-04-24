---
id: plan-02-registry-pipeline
name: Agent Runtime Registry + Engine + Pipeline Wiring
depends_on:
  - plan-01-schema-resolver
branch: per-agent-runtime-configuration-harness-model/registry-pipeline
agents:
  builder:
    effort: high
    rationale: EforgeEngine lifecycle rewiring + 23 pipeline callsite updates +
      agent function option rename across ~25 files require careful coordination
      to keep the tree green.
  reviewer:
    effort: high
    rationale: Lazy Pi import correctness and memoization semantics are easy to get
      wrong; reviewer must verify no stage ever double-instantiates a harness or
      eager-imports Pi.
---

# Agent Runtime Registry + Engine + Pipeline Wiring

## Architecture Context

This is step 3-4 of the PRD's 9-step ordered implementation. With the schema + resolver in place (plan-01), this plan introduces `AgentRuntimeRegistry`, rewires `EforgeEngine` to hold a registry instead of a single backend, updates the `PipelineContext` + all 23 stage call sites from `ctx.backend` to `ctx.agentRuntimes`, and renames agent function option field `backend` → `harness` across ~25 agent files.

Reference files:
- `packages/engine/src/eforge.ts` — `EforgeEngine` class; `private readonly backend: AgentBackend` at ~L121; `EforgeEngineOptions.backend?` at ~L61; `create()` with scalar-backend branch + Pi dynamic-import block at ~L151-214.
- `packages/engine/src/pipeline/types.ts` — `PipelineContext.backend: AgentBackend` at ~L20.
- `packages/engine/src/pipeline/stages/build-stages.ts` and `compile-stages.ts` — 23 total stage call sites use `ctx.backend`.
- `packages/engine/src/agents/*.ts` — ~25 agent function files whose options object takes `backend: AgentBackend`.
- `packages/engine/src/backends/pi.ts` — dynamically imported today; registry must preserve this lazy behavior.
- `test/agent-wiring.test.ts` and `test/stub-backend.ts` — test harness injection of a single `StubBackend`.

## Implementation

### Overview

Introduce a registry abstraction so an engine can hold multiple harness instances, one per named `agentRuntime`. The registry is lazy — Pi is only dynamically imported the first time a `harness: pi` entry is requested. Instances are memoized by config name (two roles pointing at `opus` share one harness instance). Provide `singletonRegistry(harness)` as a test adapter that mirrors today's single-backend injection.

Wire the registry through the engine constructor, the pipeline context, all 23 stage call sites, and rename `backend` → `harness` in the agent function option field. The interface type is still `AgentBackend` at this point (rename happens in plan-03), so the rename is strictly the field name on options objects.

### Key Decisions

1. **Registry memoizes by config name, not harness kind.** Two `pi` entries with different `apiKey` must be distinct instances; config name is the stable identity.
2. **Lazy Pi import stays inside the registry.** Registry internals do the dynamic `import('./backends/pi.js')` on first use. Neither the engine constructor nor stages reach into Pi loading.
3. **`singletonRegistry(harness)` bridge.** Test code that injects a single `StubBackend` wraps it via `singletonRegistry(stub)`; every role resolves to that one instance. Preserves existing test shape during the transition.
4. **`EforgeEngineOptions.agentRuntimes?: AgentRuntimeRegistry | AgentBackend`.** Accepts either for ergonomic test injection; a bare backend is auto-wrapped in `singletonRegistry`.
5. **No behavior change for legacy configs.** In plan-01 the resolver synthesizes a single implicit entry from scalar `config.backend`; the engine builds a registry with just that entry, so legacy configs still work without `agentRuntimes:` declared.

## Scope

### In Scope
- New file `packages/engine/src/agent-runtime-registry.ts` exporting `AgentRuntimeRegistry` interface (`forRole`, `byName`, `nameForRole`, `configured`), `singletonRegistry(harness)` test adapter, and `buildAgentRuntimeRegistry(config)` factory.
- Factory uses dynamic `import('./backends/pi.js')` on first `pi` request; caches the module; memoizes per-entry instances.
- `EforgeEngine` changes: replace `private readonly backend` with `private readonly agentRuntimes: AgentRuntimeRegistry`; replace `EforgeEngineOptions.backend?: AgentBackend` with `agentRuntimes?: AgentRuntimeRegistry | AgentBackend`; `create()` removes the scalar-backend branch and Pi dynamic-import block, delegating to `buildAgentRuntimeRegistry(config)` when the caller doesn't supply one.
- `PipelineContext.backend: AgentBackend` → `PipelineContext.agentRuntimes: AgentRuntimeRegistry`.
- All 23 stage callsites in `packages/engine/src/pipeline/stages/{build-stages,compile-stages}.ts` updated: `backend: ctx.backend` → `harness: ctx.agentRuntimes.forRole(<role>)`.
- ~25 agent function files in `packages/engine/src/agents/*.ts` rename options field `backend` → `harness` (value type still `AgentBackend` in this plan).
- Test updates: `test/agent-wiring.test.ts` uses `singletonRegistry(stub)`; new test case with two stubs for two roles verifying dispatch.
- New test `packages/engine/test/agent-runtime-registry.test.ts`: lazy Pi load (first `forRole` for a `pi` entry triggers import; second does not); shared instance for two roles using same name; throws on unknown name.

### Out of Scope
- Renaming `AgentBackend` interface or `ClaudeSDKBackend`/`PiBackend` classes, or the `backends/` directory (plan-03).
- Removing legacy scalar `backend:` or top-level `pi:` / `claudeSdk:` (plan-04).
- Plan-file `agentRuntime?` override (plan-04).
- `agent:start` event field changes (plan-04).
- Profile directory / MCP / HTTP renames (plan-05).

## Files

### Create
- `packages/engine/src/agent-runtime-registry.ts` — `AgentRuntimeRegistry` interface, `singletonRegistry`, `buildAgentRuntimeRegistry`.
- `packages/engine/test/agent-runtime-registry.test.ts` — lazy-load, memoization, unknown-name test cases.

### Modify
- `packages/engine/src/eforge.ts` — swap `backend` field + option for `agentRuntimes` registry; drop scalar-backend branch + inline Pi dynamic-import in `create()`; thread registry into `PipelineContext` construction.
- `packages/engine/src/pipeline/types.ts` — `backend: AgentBackend` → `agentRuntimes: AgentRuntimeRegistry` on `PipelineContext`.
- `packages/engine/src/pipeline/stages/build-stages.ts` — replace all `ctx.backend` references (14 from grep) with `ctx.agentRuntimes.forRole(role)`; pass as `harness:` option.
- `packages/engine/src/pipeline/stages/compile-stages.ts` — replace all `ctx.backend` references (16 from grep) with `ctx.agentRuntimes.forRole(role)`; pass as `harness:` option.
- `packages/engine/src/agents/*.ts` — every agent function that accepts `{ backend: AgentBackend, ... }` renames the field to `harness: AgentBackend`. Function body usages updated.
- `test/agent-wiring.test.ts` — wrap `StubBackend` injections in `singletonRegistry`; add dual-stub dispatch test.
- `test/stub-backend.ts` — no type change needed here (class stays `StubBackend` until plan-03); the harness-field rename may require touching the exported helper factory if it constructs option objects.
- Any remaining caller of `EforgeEngine.create({ backend })` in tests/fixtures updated to `{ agentRuntimes }`.

## Verification

- [ ] `pnpm type-check` passes.
- [ ] `pnpm test` passes; `agent-runtime-registry.test.ts` covers the three scenarios above.
- [ ] `pnpm build` succeeds.
- [ ] A config with `agentRuntimes: { a: { harness: 'pi', pi: {...} }, b: { harness: 'pi', pi: {...} } }` produces two distinct Pi instances at runtime (verified by identity check in a dedicated test).
- [ ] A config declaring zero `pi` entries never dynamically imports `./backends/pi.js` (verified via a test that counts imports via a module-level spy or a module-load side-effect marker).
- [ ] Two roles pointing at the same `agentRuntime` name call `forRole` and receive the same instance (reference equality).
- [ ] `test/agent-wiring.test.ts` with two stubs (two `singletonRegistry` instances merged via a small test-only registry helper, or a single registry injected with two named entries) verifies the correct stub is dispatched per role.
- [ ] No references to `ctx.backend` remain in `packages/engine/src/pipeline/stages/`.
- [ ] No agent function in `packages/engine/src/agents/` still accepts an options field named `backend`.
