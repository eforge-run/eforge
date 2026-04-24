---
id: plan-04-legacy-removal-events
name: Rip Legacy Shape + Plan-File Override + Events + Monitor UI
depends_on:
  - plan-03-harness-rename
branch: per-agent-runtime-configuration-harness-model/legacy-removal-events
agents:
  builder:
    effort: high
    rationale: Removing scalar backend + top-level pi/claudeSdk is the breaking
      boundary; plan-file override introduces a new precedence layer; event
      shape change must be kept in lockstep with monitor UI render to avoid a
      visual regression.
  reviewer:
    effort: high
    rationale: Breaking release; reviewer must confirm no coexistence paths remain,
      the migration rejection message actually fires with clear guidance, and
      the plan-file precedence matches the PRD (plan > role > default).
---

# Rip Legacy Shape + Plan-File Override + Events + Monitor UI

## Architecture Context

This is steps 6-7 of the PRD's 9-step ordered implementation, plus the monitor UI stage-hover render that goes hand-in-hand with the event-shape change. With plans 01-03 done, the codebase supports `agentRuntimes` end-to-end but still accepts the legacy scalar `backend:` + top-level `pi:` / top-level `claudeSdk:`. This plan **rips the legacy shape cleanly** (per memory: "No backward compatibility cruft"), adds the plan-file `agentRuntime?` per-role override, swaps the `agent:start` event field, and updates the monitor UI to render the new trio.

Reference:
- `packages/engine/src/config.ts` — scalar `backend:` + top-level `pi:` + top-level `claudeSdk:` schema still alive from plan-01's coexistence period.
- `packages/engine/src/agent-runtime-registry.ts` — legacy-fallback single-entry synthesis from plan-01; removed here.
- `packages/engine/src/pipeline/agent-config.ts` — `resolveAgentRuntimeForRole` currently accepts `planEntry?` but does not consume it; wired here.
- `packages/engine/src/events.ts` — `PlanFile.agents.<role>` shape at ~L43-54; `agent:start` event with `backend: string` at ~L238-240.
- `packages/monitor-ui/` — stage hover rendering (shadcn/ui per memory).
- Memory: "Surface runtime agent decisions in monitor UI" — new per-agent runtime values must appear in the monitor stage hover.

## Implementation

### Overview

Delete scalar `backend:` + top-level `pi:` + top-level `claudeSdk:` from the schema. Replace with a clear migration-rejection error that points users at `agentRuntimes:` + `defaultAgentRuntime:`. Remove the one-entry-registry bridge (legacy fallback) from plan-01's resolver and plan-02's registry factory. Wire the `planEntry?` input into `resolveAgentRuntimeForRole` with precedence plan > role > default. Change the `agent:start` event to carry `agentRuntime: string` + `harness: 'claude-sdk' | 'pi'` instead of `backend: string`. Update the monitor UI stage hover to render the new trio `"<role> → <agentRuntime> (<harness>, <modelId>)"`.

### Key Decisions

1. **Clean rip, one commit.** Per memory: "Rip out old code cleanly when replacing systems, don't add compat layers." Delete scalar `backend`, `backendSchema`, the coexistence branches, and the legacy-fallback registry code. The migration path is a clear error message pointing at the new shape, not an auto-upgrade.
2. **Migration rejection message.** When the loader sees scalar `backend:` or top-level `pi:` / `claudeSdk:`, fail with a structured error: name the offending field, show a minimal `agentRuntimes:` + `defaultAgentRuntime:` example derived from the old shape, and link to the release note.
3. **Plan-file `agentRuntime?` precedence.** `resolveAgentRuntimeForRole(role, config, planEntry?)` uses `planEntry?.agents?.[role]?.agentRuntime ?? config.agents?.roles?.[role]?.agentRuntime ?? config.defaultAgentRuntime`. Plan-file refs are validated at plan-load time — if the plan references a name not in `config.agentRuntimes`, fail with the offending plan file path, role, and referenced name.
4. **`agent:start` event shape.** Replace `backend: string` with two fields: `agentRuntime: string` (config name, e.g. `"opus"`) and `harness: 'claude-sdk' | 'pi'` (kind). Both sourced from `ResolvedAgentConfig.agentRuntimeName` / `.harness` (added in plan-01). Downstream consumers (monitor, telemetry, CLI renderer) updated in this plan.
5. **Monitor UI render.** Stage hover previously showed `backend` as a single string; now shows `"<role> → <agentRuntime> (<harness>, <modelId>)"` — e.g. `"planner → opus (claude-sdk, claude-opus-4-7)"`. Uses existing shadcn/ui primitives (per memory).
6. **ModelTracker unchanged.** Still tracks model IDs for the `Models-Used:` trailer.

## Scope

### In Scope
- Delete scalar `backend:` + top-level `pi:` + top-level `claudeSdk:` from `configSchema` in `packages/engine/src/config.ts`.
- Delete `backendSchema` export; `harnessSchema` becomes the sole name.
- Delete legacy-fallback path from `resolveAgentRuntimeForRole` and `buildAgentRuntimeRegistry` — both now require `config.agentRuntimes` + `config.defaultAgentRuntime` to be present (schema enforces non-empty + required when present).
- Loader-level migration rejection: if a parsed-as-unknown config contains `backend:` (scalar), `pi:` (top level), or `claudeSdk:` (top level), emit a structured error naming all offending fields and showing a minimal migrated example. This check runs before Zod parsing so the error is explicit rather than a generic `unrecognized_keys`.
- `packages/engine/src/events.ts`: extend `PlanFile.agents.<role>` schema with `agentRuntime?: string` alongside existing `effort?`, `thinking?`, `rationale?`. Add plan-load-time validation: referenced name must exist in `config.agentRuntimes`.
- Plumb `planEntry` from plan loader into `resolveAgentRuntimeForRole` at every call site that has access to the active plan entry (build stages, compile stages, gap-closer).
- `packages/engine/src/events.ts`: change `agent:start` event — replace `backend: string` with `agentRuntime: string` and `harness: 'claude-sdk' | 'pi'`. Emit from the resolver's `ResolvedAgentConfig`.
- `packages/monitor-ui/` stage hover: render the new trio using shadcn/ui components. No new components scaffolded if existing primitives cover the layout.
- `packages/monitor/src/server.ts` SSE event forwarding: ensure the renamed fields propagate through event serialization.
- Any CLI event renderer (`packages/eforge/src/cli/*`) that logs `agent:start` — update to read `agentRuntime` + `harness`.
- Unit tests: `packages/engine/test/plan-file.agent-config.test.ts` — plan-level `agentRuntime` override wins over role/default; validation failure when plan references undeclared runtime.
- Unit test: migration rejection fires with the expected error message shape for legacy configs.
- Integration test: one eval-style scenario run through a mixed-runtime config; verify `agent:start` events show the correct `agentRuntime` + `harness` per role (can be asserted via `StubHarness` instances and captured events).

### Out of Scope
- Profile directory rename `eforge/backends/` → `eforge/profiles/` (plan-05) — note: this plan does not change the profile-loader marker filename.
- MCP tool rename `eforge_backend` → `eforge_profile` (plan-05).
- Slash command renames (plan-05).
- HTTP route rename (plan-05).
- Plugin version bump (plan-05).
- README / plugin-README copy edits (plan-05).
- `DAEMON_API_VERSION` bump (plan-05) — this plan's event-shape change rides inside the SSE payload, not the route list, so it does not require the version bump on its own (the route-rename in plan-05 will bump it).

## Files

### Create
- `packages/engine/test/plan-file.agent-config.test.ts` — plan-level override precedence and validation failure cases.
- `packages/engine/test/config.legacy-rejection.test.ts` — migration rejection message shape.
- `packages/engine/test/events.agent-start.test.ts` — `agent:start` emits `agentRuntime` + `harness` per role for a mixed-runtime config.

### Modify
- `packages/engine/src/config.ts` — delete scalar `backend:` field, `backendSchema` export, top-level `pi:` / `claudeSdk:` fields from `configSchema`. Add pre-Zod migration-rejection guard on the raw parsed YAML/JSON. Update `EforgeConfig` TypeScript type to drop these fields.
- `packages/engine/src/pipeline/agent-config.ts` — remove legacy-fallback path from `resolveAgentRuntimeForRole`; add `planEntry?.agents?.[role]?.agentRuntime` as top-precedence source; update error messages to reflect that `agentRuntimes` is mandatory.
- `packages/engine/src/agent-runtime-registry.ts` — remove synthesized-single-entry bridge; factory now requires `config.agentRuntimes` + `config.defaultAgentRuntime`.
- `packages/engine/src/eforge.ts` — remove any code path that constructed a default scalar-backend registry; thread `planEntry` through to resolver calls at the stages layer.
- `packages/engine/src/pipeline/stages/build-stages.ts` + `compile-stages.ts` — ensure `resolveAgentConfig(role, config, planEntry)` is called with the active plan entry.
- `packages/engine/src/plan.ts` (plan loader) — validate `PlanFile.agents.<role>.agentRuntime` against `config.agentRuntimes` at load time; fail with plan-file path + role + name in the error.
- `packages/engine/src/events.ts` — extend `PlanFile.agents.<role>` schema with `agentRuntime?: string`; change `agent:start` event type: replace `backend: string` with `agentRuntime: string` + `harness: 'claude-sdk' | 'pi'`.
- Emission sites of `agent:start` — populate the two new fields from `ResolvedAgentConfig`.
- `packages/monitor-ui/` stage-hover component(s) — render `"<role> → <agentRuntime> (<harness>, <modelId>)"`. Identify via `packages/monitor-ui/src/**/*.tsx` search for the existing `backend` hover render.
- `packages/monitor/src/server.ts` — any field-level event normalization that mentioned `backend`.
- `packages/eforge/src/cli/*` — CLI renderer for `agent:start` events.
- `test/agent-wiring.test.ts` or the `events.agent-start.test.ts` — updated expectations.

## Verification

- [ ] `pnpm type-check` passes.
- [ ] `pnpm test` passes; new tests in `plan-file.agent-config.test.ts`, `config.legacy-rejection.test.ts`, `events.agent-start.test.ts` all green.
- [ ] `pnpm build` succeeds.
- [ ] Loading a config with legacy scalar `backend: claude-sdk` fails with an error whose message contains the string `agentRuntimes` and `defaultAgentRuntime` and names the offending field `backend`.
- [ ] Loading a config with top-level `pi: {...}` (outside `agentRuntimes`) fails with an error naming `pi` as the offending top-level field.
- [ ] A plan file with `agents: { builder: { agentRuntime: 'ghost' } }` where `ghost` is not in `config.agentRuntimes` fails at plan load time with an error containing the plan file path, the role `builder`, and the name `ghost`.
- [ ] Given `defaultAgentRuntime: opus`, `agents.roles.builder.agentRuntime: pi-openrouter`, and plan-file `agents.builder.agentRuntime: pi-anthropic`, the resolved agentRuntime for `builder` is `pi-anthropic` (plan wins).
- [ ] An `agent:start` event captured in a test emits exactly the shape `{ agentRuntime: 'opus', harness: 'claude-sdk', ...other fields }` with no `backend` key present.
- [ ] Monitor UI stage hover renders `"planner → opus (claude-sdk, claude-opus-4-7)"` for a role resolved to the `opus` runtime with `claude-sdk` harness and `claude-opus-4-7` model (verified by a component test or visual snapshot).
- [ ] `grep -R "\\bbackendSchema\\b\\|scalar backend\\|backend: 'claude-sdk' | 'pi'" packages/engine/src/` returns zero matches except for the migration-rejection guard.
- [ ] No code path in `packages/engine/src/` constructs a registry from a scalar backend value.
