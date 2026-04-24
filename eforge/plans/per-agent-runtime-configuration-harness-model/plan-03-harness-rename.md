---
id: plan-03-harness-rename
name: "Mechanical Rename: Backend -> Harness"
depends_on:
  - plan-02-registry-pipeline
branch: per-agent-runtime-configuration-harness-model/harness-rename
agents:
  builder:
    effort: medium
    rationale: Mechanical rename across ~30 files; the risk is missed references,
      not design complexity.
  reviewer:
    effort: medium
    rationale: Rename verification; look for stale `Backend` / `backend` tokens in
      comments, debug callback types, SDK-restriction doc blocks, and test
      fixtures.
---

# Mechanical Rename: Backend -> Harness

## Architecture Context

This is step 5 of the PRD's 9-step ordered implementation. All structural changes (schema, registry, pipeline) were completed in plans 01-02. Now rename the interface, classes, directory, and debug callback types from `Backend` → `Harness`. This is a cohesive rename-and-update-all-callers refactor — it MUST happen in a single plan so the type change and every consumer update land together (per the planner instructions: "never split a type change from the updates to its consumers").

Reference:
- `packages/engine/src/backend.ts` — `AgentBackend` interface at ~L129-148; `BackendDebugCallback` / `BackendDebugPayload` at ~L201.
- `packages/engine/src/backends/claude-sdk.ts` — `ClaudeSDKBackend` class at ~L82.
- `packages/engine/src/backends/pi.ts` — `PiBackend` class at ~L249; AGENTS.md SDK-import restriction doc block references this path.
- `test/stub-backend.ts` — `StubBackend` class.
- PRD notes 6 supporting files in `backends/` directory (claude-sdk.ts, pi.ts, common.ts, eforge-resource-filter.ts, pi-extensions.ts, pi-mcp-bridge.ts, usage.ts) to move.

## Implementation

### Overview

Purely mechanical: rename types, classes, files, directory. Update every import, every call site, every comment referencing the old names, every AGENTS.md / doc block referencing the directory path. The `ctx.agentRuntimes` plumbing from plan-02 already passes instances that are typed `AgentBackend`; flipping the type name to `AgentHarness` ripples through but produces no behavior change.

### Key Decisions

1. **Do the directory rename.** PRD calls out: "The file name `backends/pi.ts` → `harnesses/pi.ts` is worth the paperwork since the AGENTS.md SDK-import restriction doc-block references it." Use `git mv` to preserve history.
2. **Test file `stub-backend.ts` → `stub-harness.ts`.** Test fixture file and the exported `StubBackend` → `StubHarness` class rename together.
3. **Rename the file `backend.ts` → `harness.ts`.** The interface lives there; keeping `backend.ts` would be confusing.
4. **Agent function field `harness: AgentBackend` (from plan-02) becomes `harness: AgentHarness`.** Field name was already renamed; only the type annotation changes.
5. **SDK-import restriction note in `AGENTS.md`.** The doc block pointing at `packages/engine/src/backends/` updates to `packages/engine/src/harnesses/`.

## Scope

### In Scope
- `packages/engine/src/backend.ts` → `packages/engine/src/harness.ts` (via `git mv`).
- `AgentBackend` → `AgentHarness` (interface + all import sites).
- `BackendDebugCallback` → `HarnessDebugCallback`, `BackendDebugPayload` → `HarnessDebugPayload` (exported types + all call sites).
- Directory `packages/engine/src/backends/` → `packages/engine/src/harnesses/` (via `git mv`, preserves history for all 7 files inside).
- `ClaudeSDKBackend` → `ClaudeSDKHarness` (class + exports + imports).
- `PiBackend` → `PiHarness` (class + exports + imports).
- `test/stub-backend.ts` → `test/stub-harness.ts`; `StubBackend` → `StubHarness`.
- Update every import path that referenced `./backends/*` or `./backend`; typical patterns: `from '../backends/pi.js'`, `from '../backend.js'`.
- Update the `AGENTS.md` SDK-import restriction doc block to reference `packages/engine/src/harnesses/`.
- Update any comments, JSDoc, or test-description strings that mention "backend" in the renamed-type sense (not to be confused with runtime/profile concepts — those are handled in plans 04-05).

### Out of Scope
- Removing legacy scalar `backend:` config / top-level `pi:` / top-level `claudeSdk:` (plan-04). The word "backend" still appears in the config schema and in legacy-fallback code paths; that's intentional for this plan.
- Event field `backend: string` (plan-04).
- Profile directory rename, MCP tool rename, HTTP route rename (plan-05).
- `eforge_backend` tool, `/eforge:backend` slash commands, README copy (plan-05).

## Files

### Create
- (none — this is a rename plan; files move via `git mv`.)

### Modify / Move
- `packages/engine/src/backend.ts` → `packages/engine/src/harness.ts` (rename via `git mv`; rename interface and debug types inside).
- `packages/engine/src/backends/` → `packages/engine/src/harnesses/` (move all 7 files: `claude-sdk.ts`, `pi.ts`, `common.ts`, `eforge-resource-filter.ts`, `pi-extensions.ts`, `pi-mcp-bridge.ts`, `usage.ts`).
- `packages/engine/src/harnesses/claude-sdk.ts` — rename `ClaudeSDKBackend` class to `ClaudeSDKHarness`.
- `packages/engine/src/harnesses/pi.ts` — rename `PiBackend` class to `PiHarness`.
- `packages/engine/src/agent-runtime-registry.ts` — update dynamic import target from `./backends/pi.js` to `./harnesses/pi.js`; update type imports.
- `packages/engine/src/eforge.ts` — update imports and type references.
- `packages/engine/src/pipeline/types.ts` — type references on registry/harness.
- `packages/engine/src/pipeline/stages/build-stages.ts` + `compile-stages.ts` — type references.
- `packages/engine/src/agents/*.ts` (~25 files) — options field type `harness: AgentBackend` → `harness: AgentHarness` in every agent function.
- `test/stub-backend.ts` → `test/stub-harness.ts` (rename file; rename `StubBackend` class to `StubHarness`).
- `test/agent-wiring.test.ts` — update import of `StubBackend` → `StubHarness`; class usage updates.
- `packages/engine/test/agent-runtime-registry.test.ts` (from plan-02) — update to `StubHarness` import if applicable.
- Any other test files referencing `StubBackend`, `AgentBackend`, `ClaudeSDKBackend`, `PiBackend`, `BackendDebugCallback`, `BackendDebugPayload` — update all references.
- `AGENTS.md` — update the provider-SDK-import restriction doc block to point at `packages/engine/src/harnesses/`.

## Verification

- [ ] `pnpm type-check` passes with zero references to `AgentBackend`, `ClaudeSDKBackend`, `PiBackend`, `StubBackend`, `BackendDebugCallback`, `BackendDebugPayload` remaining anywhere except in config-schema legacy-fallback code (which still uses scalar `backend: 'claude-sdk' | 'pi'` until plan-04).
- [ ] `pnpm test` passes; all tests importing `StubHarness` compile and run.
- [ ] `pnpm build` succeeds.
- [ ] `packages/engine/src/backends/` directory no longer exists; `packages/engine/src/harnesses/` contains all 7 files.
- [ ] `packages/engine/src/backend.ts` no longer exists; `packages/engine/src/harness.ts` exports `AgentHarness`, `HarnessDebugCallback`, `HarnessDebugPayload`.
- [ ] `AGENTS.md` SDK-import restriction doc block references `packages/engine/src/harnesses/` (exact path match).
- [ ] `grep -R "AgentBackend\|ClaudeSDKBackend\|PiBackend\|BackendDebugCallback\|BackendDebugPayload\|StubBackend" packages/engine/src/ test/` returns zero matches.
- [ ] `git log --follow packages/engine/src/harnesses/pi.ts` shows history from the original `backends/pi.ts`.
