---
id: plan-01-runtime-and-observability
name: Runtime MCP filtering and observability schema
branch: resolve-tier-toolbelts-into-harness-mcp-config-and-expose-toolbelt-observability/plan-01-runtime-and-observability
agents:
  builder:
    effort: xhigh
    rationale: Touches harness boundary in two harnesses, registry memoization
      keying that must not regress existing claudeSdk.disableSubagents
      under-keying, the shared wire schema in @eforge-build/client, and
      AgentRunOptions/ResolvedAgentConfig type additions threaded through
      resolveAgentConfig. Subtle leakage bugs (tiers sharing pi.provider but
      different toolbelts) require careful keying; high effort warranted.
  reviewer:
    effort: high
    rationale: Wire-protocol additions and harness boundary changes need thorough
      review for cross-tier leakage and debug-payload category correctness.
---

---
id: plan-01-runtime-and-observability
name: Runtime MCP filtering and observability schema
depends_on: []
---

# Runtime MCP filtering and observability schema

## Architecture Context

TOOLBELTS_03 has already landed: `tools.toolbelts` and per-tier `toolbelt` are schema-valid and statically validated against `.mcp.json` (`packages/engine/src/config.ts::validateToolbeltReferences`). Project MCP servers are still loaded once in `EforgeEngine.create()` via `loadMcpServers(cwd)` and passed globally as `RegistryGlobalOptions.mcpServers` to `buildAgentRuntimeRegistry()`. The registry currently memoizes harness instances by `claude-sdk` or `pi:<provider>`, so two tiers sharing the same provider also share one MCP server set - that is exactly what this plan must fix.

This plan implements the runtime filter and exposes observability so users can verify which project MCP servers were actually selected for each agent run. The smallest safe design is to derive a per-tier effective project MCP server map at the registry layer and include the sorted effective server names in the memoization key. This avoids a larger `AgentRunOptions`/harness interface migration while addressing cross-tier leakage.

Key constraints from `docs/prd/profile-toolbelts.md`:
- omitted `toolbelt` → pass all discovered project MCP servers (back-compat default)
- `toolbelt: none` → pass no project MCP servers
- named toolbelt → pass only servers listed by `tools.toolbelts.<name>.mcpServers`
- Filtering applies ONLY to project MCP servers from `.mcp.json` - engine-internal `eforge_engine` custom tools, Claude built-ins, Pi built-ins, and future extension-contributed tools are never filtered
- User-facing names must be MCP server names (`playwright`), not backend tool names (`mcp__playwright__browser_navigate`)

## Implementation

### Overview

1. Extend the registry to resolve `tier.toolbelt` against `tools.toolbelts` and the global project MCP server map, producing a per-tier filtered map plus a `toolbelt` summary descriptor (state: `all` | `none` | `named`, optional toolbelt name, sorted server names).
2. Change registry memoization key from `(harness, provider)` to `(harness, provider, sortedProjectMcpServerNames, disableSubagents)` so equivalent effective tool surfaces share an instance and different ones do not.
3. Pass the filtered project MCP server map to harness constructors (`ClaudeSDKHarness`, `PiHarness`). Preserve engine-internal `eforge_engine` custom-tool MCP server in Claude SDK regardless of filtering. Preserve Pi built-in and `eforgeCustomTools` regardless of filtering.
4. Add optional toolbelt fields to `ResolvedAgentConfig`, thread them through `AgentRunOptions`, and stamp them on `agent:start` events via `BuildAgentStartEventOptions` / `buildAgentStartEvent`. Mirror the additions in `agentStartFields` (TypeBox) in `packages/client/src/events.schemas.ts`.
5. Restructure `HarnessDebugPayload.extra` to separate project MCP server names from engine-internal MCP server names so Claude SDK's current merged `mcpServerNames` no longer conflates the two categories.
6. Update `docs/config.md` to remove the "Runtime per-tier MCP filtering is not yet implemented" paragraph and replace it with the now-accurate runtime semantics.
7. Update the monitor-ui agent-state reducer (`handle-agent.ts`) to capture the new optional `agent:start` fields so they are available to downstream UI rendering in plan-02 without breaking existing snapshots.

### Key Decisions

1. **Filter at the registry, not per-run.** Current harness APIs take `mcpServers` at construction time. Keying instances by effective project MCP server set is the smallest safe correctness fix; per-run `AgentRunOptions.mcpServers` would be cleaner long-term but requires a larger interface change out of scope here.
2. **Memoization key audit.** The current key under-keys `claudeSdk.disableSubagents` (two tiers sharing harness but differing on `disableSubagents` would currently share one Claude instance). While adding the MCP-name dimension, also include `disableSubagents` in the key so the new MCP-filtering tests do not accidentally pass due to that latent under-keying. Do NOT expand into a broader registry refactor.
3. **Toolbelt selection summary.** Compute once in the registry (`resolveTierToolbelt(tier, globalMcp, toolbelts)` → `{ selection: 'all' | 'none' | 'toolbelt'; toolbelt?: string; projectMcpServerNames: string[] }`) and stamp the result onto the harness instance AND surface it via `ResolvedAgentConfig`/`AgentRunOptions`/`agent:start`. The registry layer holds the project MCP map; `resolveAgentConfig` does not, so the registry must produce the summary.
4. **Threading the summary to events.** Two paths considered: (a) put the summary on the harness instance and have the harness emit it in `agent:start`; (b) compute in registry and stamp onto `AgentRunOptions` via a small registry helper. Choose (a) for Claude SDK and Pi: harness already owns the filtered `this.mcpServers`, and the agent:start emission in `run()` already pulls tier/harness fields from `options`. Add `toolbelt`, `toolbeltSource`, `projectMcpSelection`, and `projectMcpServerNames` to `AgentRunOptions` so `resolveAgentConfig` callers can stamp them; the registry exposes a small helper `forRoleResolved(role, planEntry)` returning `{ harness, toolbeltSummary }` so existing call sites can spread the summary onto run options without duplicating logic.
5. **Defensive runtime errors only.** Static validation in TOOLBELTS_03 should normally catch impossible references. Runtime should fail loudly (throw with the same path-specific message format) rather than silently broaden a tier from a bad named toolbelt to all project MCP servers. Do not duplicate `validateToolbeltReferences` here - call it via `assertToolbeltReferencesResolvable` defensive helper if a named toolbelt cannot be resolved at registry construction.
6. **Debug payload separation.** Replace ambiguous `extra.mcpServerNames` with `projectMcpServerNames` (filtered) and `internalMcpServerNames` (just `['eforge_engine']` when custom tools are present, else `[]`). Keep `customToolCount`. Pi already separates `bridgedMcpToolCount` from `customToolCount` - just add `projectMcpServerNames` and remove the misleading `mcpServerNames` field.
7. **Closed naming convention.** Field naming: `toolbelt` (string|null - null when explicit `none`), `toolbeltSource: 'tier' | 'role' | 'plan' | 'default'` (`default` for omitted), `projectMcpSelection: 'all' | 'none' | 'toolbelt'`, `projectMcpServerNames: string[]` (sorted). All optional on the wire schema for back-compat.
8. **Monitor reducer parity.** Updating the reducer at this stage avoids a stale agent-state shape blocking plan-02 from rendering. Optional fields on the reducer state means UI plan-02 can render them without changing reducer logic again.

## Scope

### In Scope
- Runtime resolution of per-tier project MCP server set in `agent-runtime-registry.ts`.
- Memoization key extended to include effective project MCP server names and `disableSubagents`.
- `ClaudeSDKHarness` receives filtered project MCP map; `eforge_engine` custom-tool MCP server preserved.
- `PiHarness` receives filtered project MCP map; `PiMcpBridge` constructed from filtered map; Pi built-ins and `eforgeCustomTools` preserved.
- `ResolvedAgentConfig` and `AgentRunOptions` extended with `toolbelt`, `toolbeltSource`, `projectMcpSelection`, `projectMcpServerNames`.
- `agent:start` wire schema (`agentStartFields` in `packages/client/src/events.schemas.ts`) and `BuildAgentStartEventOptions` / `buildAgentStartEvent` extended with the same fields.
- `HarnessDebugPayload.extra` restructured to separate project MCP from internal MCP.
- Defensive runtime check that throws a path-specific error if a named toolbelt cannot be resolved against the loaded `tools.toolbelts` at registry construction.
- Monitor-ui agent-state reducer captures the new optional fields (rendering happens in plan-02).
- New tests at `test/toolbelt-runtime.test.ts` and `test/harness-debug-payload.toolbelt.test.ts`; extend `test/agent-runtime-registry.test.ts` for toolbelt cases.
- Update `docs/config.md` to remove the "not yet implemented" caveat and document runtime semantics + observability fields.

### Out of Scope
- New schema/static validation beyond what TOOLBELTS_03 provides.
- Multiple toolbelts per tier, toolbelt composition, per-role toolbelt assignment.
- Per-run `AgentRunOptions.mcpServers` injection (kept as a future option).
- UI rendering of toolbelt summaries in monitor or profile UX surfaces (covered in plan-02).
- Profile-list/show wire shape additions in `@eforge-build/client` (deferred to plan-02 once UX needs them; agent:start already carries the resolved selection).
- Pi extension or Claude plugin-backed toolbelts.
- Exposing backend tool names like `mcp__playwright__browser_navigate` in user-facing output.

## Files

### Create
- `test/toolbelt-runtime.test.ts` - registry resolves project MCP set per tier (omitted/none/named); two tiers sharing harness+provider but different toolbelts get distinct harness instances and non-overlapping `projectMcpServerNames`; named toolbelt that cannot be resolved throws a path-specific error; `eforge_engine` custom tool path remains available when `toolbelt: none`.
- `test/harness-debug-payload.toolbelt.test.ts` - `ClaudeSDKHarness.run` debug payload separates `projectMcpServerNames` from `internalMcpServerNames`; `PiHarness.run` debug payload includes `projectMcpServerNames` and preserves bridged/custom tool counts; `agent:start` events carry `toolbelt`, `toolbeltSource`, `projectMcpSelection`, `projectMcpServerNames` when stamped.

### Modify
- `packages/engine/src/agent-runtime-registry.ts` - add `resolveTierToolbelt(tier, globalMcp, toolbelts)` helper returning `{ projectMcpServerMap, summary }`; rebuild `makeKey()` to include sorted server names and `disableSubagents`; pass filtered map into harness constructors; expose `forRoleResolved(role, planEntry)` returning `{ harness, toolbeltSummary }`; throw path-specific error when a named toolbelt references a missing entry at registry build time.
- `packages/engine/src/eforge.ts` - rename internal `loadMcpServers` to `loadProjectMcpServers` for clarity (no behavior change); pass the loaded map plus `config.tools.toolbelts` through `RegistryGlobalOptions` so the registry has both the unfiltered project MCP source and the toolbelt registry.
- `packages/engine/src/config.ts` - extend `ResolvedAgentConfig` with optional `toolbelt?: string | null`, `toolbeltSource?: 'tier' | 'role' | 'plan' | 'default'`, `projectMcpSelection?: 'all' | 'none' | 'toolbelt'`, `projectMcpServerNames?: string[]`. Type-only addition.
- `packages/engine/src/harness.ts` - extend `AgentRunOptions` with the same four optional toolbelt-summary fields so build-stage call sites can stamp the summary via `...agentConfig` spreads.
- `packages/engine/src/harnesses/common.ts` - extend `BuildAgentStartEventOptions` with the same four fields and propagate them in `buildAgentStartEvent` using the existing "only include when defined" pattern.
- `packages/engine/src/harnesses/claude-sdk.ts` - thread `options.toolbelt*` and `options.projectMcpSelection`/`options.projectMcpServerNames` into `buildAgentStartEvent` and the debug payload `extra`; replace `mcpServerNames: mergedMcpServers ? Object.keys(mergedMcpServers) : []` with explicit `projectMcpServerNames: Object.keys(this.mcpServers ?? {}).sort()` plus `internalMcpServerNames: customMcpServers.eforge_engine ? ['eforge_engine'] : []`; update the `note` field to explain the split.
- `packages/engine/src/harnesses/pi.ts` - replace `mcpServerNames: this.mcpServers ? Object.keys(this.mcpServers) : []` with `projectMcpServerNames: Object.keys(this.mcpServers ?? {}).sort()`; thread agent:start additions; update the `note` field accordingly. Confirm `PiMcpBridge` is constructed from the filtered map (no change beyond what the registry hands the constructor).
- `packages/engine/src/pipeline/agent-config.ts` - extend `resolveAgentConfig` so callers can pass the registry-derived toolbelt summary in (or invoke a helper) and stamp `toolbelt`, `toolbeltSource`, `projectMcpSelection`, `projectMcpServerNames` onto `ResolvedAgentConfig`. Preserve the existing six-step algorithm.
- `packages/engine/src/pipeline/stages/build-stages.ts` and `packages/engine/src/pipeline/stages/compile-stages.ts` - where they construct agent run inputs via `...agentConfig`, ensure the new optional fields flow through (no-op if already spreading the full resolved config). Call `agentRuntimes.forRoleResolved(...)` once and stamp the summary fields onto agent options.
- `packages/client/src/events.schemas.ts` - extend `agentStartFields` (lines 434-460) with four `Type.Optional` fields: `toolbelt`, `toolbeltSource`, `projectMcpSelection`, `projectMcpServerNames` (`Type.Array(Type.String())`). Bump `DAEMON_API_VERSION` if any other consumers gate on it; otherwise leave alone since these are additive optional fields.
- `packages/monitor-ui/src/lib/reducer/handle-agent.ts` - capture the new optional fields onto agent state so plan-02 can render them. No new dependencies, no UI rendering yet.
- `test/agent-runtime-registry.test.ts` - add cases: omitted toolbelt → all servers; `toolbelt: none` → empty; named toolbelt → subset; two pi tiers same provider different toolbelts → different instances and different `projectMcpServerNames`; two claude tiers same harness different `disableSubagents` → different instances.
- `docs/config.md` - replace the "Important: Runtime per-tier MCP filtering is not yet implemented" paragraph with documentation of the now-implemented runtime semantics and the new `agent:start` observability fields (using MCP server names, not backend tool names).

## Verification

- [ ] `pnpm type-check` succeeds across all workspace packages.
- [ ] `pnpm test` passes; specifically the new `test/toolbelt-runtime.test.ts` and `test/harness-debug-payload.toolbelt.test.ts` files are green.
- [ ] When tier `implementation` declares `toolbelt: browser-ui` and tier `evaluation` declares `toolbelt: none`, the registry returns harness instances whose effective project MCP map matches the toolbelt selection: `browser-ui` lists `['playwright']` (or equivalent) and `evaluation` lists `[]`.
- [ ] When two tiers share `harness: pi` and the same `pi.provider` but declare different `toolbelt` values, `registry.forRole(roleA)` and `registry.forRole(roleB)` return distinct harness instances, and a request from each yields `agent:start` events with non-overlapping `projectMcpServerNames`.
- [ ] When `tier.toolbelt` is omitted, `agent:start.projectMcpSelection === 'all'` and `projectMcpServerNames` equals the sorted keys of the discovered `.mcp.json` `mcpServers`.
- [ ] When `tier.toolbelt === 'none'`, `agent:start.projectMcpSelection === 'none'` and `projectMcpServerNames === []`; `eforge_engine` custom-tool MCP server remains registered (verifiable via debug payload `internalMcpServerNames` for Claude SDK and `customToolCount > 0` for Pi).
- [ ] `HarnessDebugPayload.extra` for `claude-sdk` contains `projectMcpServerNames` and `internalMcpServerNames` as distinct fields; the old single `mcpServerNames` field is gone.
- [ ] `HarnessDebugPayload.extra` for `pi` contains `projectMcpServerNames` distinct from `bridgedMcpToolCount` and `customToolCount`.
- [ ] When `tier.toolbelt` references a name not present in `tools.toolbelts` and TOOLBELTS_03's static validation has been bypassed (constructed config), registry construction throws an error whose message includes `agents.tiers.<tierName>.toolbelt references "<name>"` and does NOT silently fall back to all project MCP servers.
- [ ] `agentStartFields` in `packages/client/src/events.schemas.ts` includes the four new optional fields and `safeParseEforgeEvent` accepts `agent:start` events both with and without them.
- [ ] `docs/config.md` no longer contains the substring "Runtime per-tier MCP filtering is not yet implemented" and the replacement section names runtime semantics for omitted, `none`, and named toolbelt cases.
- [ ] The monitor-ui agent-state reducer attaches the new optional fields onto agent records when an `agent:start` event carries them; absent fields leave agent state unchanged.
