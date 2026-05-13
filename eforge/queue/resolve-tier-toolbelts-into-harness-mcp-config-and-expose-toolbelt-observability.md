---
title: Resolve tier toolbelts into harness MCP config and expose toolbelt observability
created: 2026-05-13
depends_on: ["toolbelts-03-add-mcp-toolbelt-schema-and-static-validation"]
profile: claude-sdk-4-7
---

# Resolve tier toolbelts into harness MCP config and expose toolbelt observability

## Problem / Motivation

Eforge currently treats project MCP servers as a global build/runtime capability: `.mcp.json` is loaded once and the same MCP server map is passed to every harness instance. That prevents profiles from limiting MCP capabilities by agent tier. Users cannot say that only implementation/review agents get a Playwright/browser MCP server while planning/evaluation agents get no project MCP servers.

This matters because profile toolbelts are intended to make profiles both safer and easier to reason about: each tier should see only the project MCP servers relevant to its job, while omitted `toolbelt` preserves today's all-project-MCP behavior for existing projects.

The observability problem is directly coupled: once MCP selection varies by tier/agent, users need to understand which profile/tier/toolbelt/server set was actually selected during a build, and profile UX should summarize tier assignments without requiring Claude SDK or Pi backend-visible tool names.

Evidence:
- `docs/prd/profile-toolbelts.md` defines the runtime flow and build/debug UX expectation.
- `packages/engine/src/eforge.ts` currently passes one discovered `mcpServers` map globally.
- `packages/engine/src/agent-runtime-registry.ts` currently memoizes harnesses by harness/provider, not by effective MCP server set.
- Current debug payloads expose only backend-oriented details and do not distinguish project MCP servers from engine-internal custom tools.

### Context

This plan combines Schaake OS epics:

- `TOOLBELTS_04 Resolve tier toolbelt into harness MCP config`
- `TOOLBELTS_05 Add toolbelt observability to build and profile UX`

Classification: **feature / focused** with high confidence. This is a behavior-changing profile toolbelt slice plus directly coupled diagnostics/UX. A single cohesive plan should be able to cover runtime filtering, event/debug payloads, profile UX, docs, and tests without delegated module planning.

Evidence reviewed:

- `docs/roadmap.md` lists **Profile toolbelts** under Extensibility: MCP-backed capability bundles selected per agent tier; MVP is one toolbelt per tier, MCP-only, no composition.
- `docs/prd/profile-toolbelts.md` defines the target runtime behavior: role → tier → tier `toolbelt`; omitted `toolbelt` means all discovered project MCP servers; `toolbelt: none` means no project MCP servers; named toolbelt means only the servers in `tools.toolbelts.<name>.mcpServers`.
- `docs/prd/profile-toolbelts.md` explicitly distinguishes engine-internal tools, profile/toolbelt-selected project MCP tools, and future extension-contributed custom tools. Filtering must apply only to project MCP servers from `.mcp.json`.
- Current code loads project MCP servers once in `packages/engine/src/eforge.ts::loadMcpServers()` and passes them globally into `buildAgentRuntimeRegistry()`.
- Current `packages/engine/src/agent-runtime-registry.ts` resolves role → tier but memoizes harnesses only by `claude-sdk` or `pi:<provider>`, so tiers sharing provider currently also share one MCP server set.
- `packages/engine/src/harnesses/claude-sdk.ts` stores `mcpServers` on the harness and merges them with the internal `eforge_engine` custom-tool MCP server per run.
- `packages/engine/src/harnesses/pi.ts` stores `mcpServers` on the harness, lazily builds a `PiMcpBridge`, and filters bridged MCP tools separately from eforge custom tools.
- `packages/engine/src/harness.ts` and `packages/engine/src/harnesses/common.ts` define `AgentRunOptions`, `HarnessDebugPayload`, and `agent:start` construction. Current agent events include `harness` and `tier`, but no resolved toolbelt/MCP selection.
- Wire event schemas are owned by `packages/client/src/events.schemas.ts`; monitor reducers/UI consume `agent:start` and `session:profile` through that shared schema.
- Current debug payloads already include `extra.mcpServerNames`, but Claude SDK currently reports the merged project + internal MCP server names there, which does not satisfy the observability requirement to distinguish project MCP from engine-internal tools.
- Profile list/show API shapes live in `packages/client/src/types.ts`; daemon routes live in `packages/monitor/src/server.ts`; Claude Code and Pi profile UX live under `packages/eforge/src/cli/mcp-proxy.ts`, `eforge-plugin/skills/profile*`, and `packages/pi-eforge/extensions/eforge/profile-commands.ts` / skill docs.
- `TOOLBELTS_03` is the planned prerequisite for `tools.toolbelts` schema/static validation and tier-level `toolbelt`; this combined plan should assume that schema exists once its dependency lands and should not duplicate the static validation work except where runtime errors/warnings are needed for defensive safety.

Dependency note: this work should be enqueued after `TOOLBELTS_03`, which itself depends on `TOOLBELTS_02`.

Early validated assumptions / unknowns:

- Assumption, high confidence: implementing runtime filtering by varying the harness instance per effective project MCP server set is the smallest safe change because current harness APIs take MCP servers at construction time. The alternative, adding per-run MCP servers to `AgentRunOptions`, is cleaner long-term but a larger harness interface change.
- Assumption, medium confidence: adding optional toolbelt fields to `agent:start` is the right monitor/debug payload mechanism. It reuses existing per-agent lifecycle events and avoids creating a separate event stream, but implementation must update shared TypeBox schemas and monitor reducers carefully.

## Goal

Deliver runtime MCP server selection per agent tier based on resolved profile toolbelts, together with the observability and profile UX surfaces needed to verify which profile/tier/toolbelt/server set was actually selected during a build - advancing the Profile toolbelts roadmap item.

## Approach

### Profile Signal

Recommended eforge profile: **Excursion**.

Rationale:

- Not an Errand: this changes runtime behavior, shared wire event schemas, harness/debug payloads, monitor/profile UX, docs, and tests.
- Not an Expedition: the work is cross-cutting but cohesive around one concept - effective project MCP selection by tier and its observability. A single planner should be able to enumerate the affected modules and ordering without delegated subsystem plans.
- The main implementation risk is the harness memoization/per-run selection boundary; this is a focused design/test problem rather than a multi-module architecture exploration.

### Design Decisions

1. Combine TOOLBELTS_04 and TOOLBELTS_05 as one eforge build unit.
   - Decision: runtime filtering and observability should land together.
   - Rationale: filtering without diagnostics is hard to verify/debug; observability is most accurate when implemented alongside the code that computes effective MCP selection.

2. Treat `.mcp.json` servers as the only filterable project MCP source.
   - Decision: the effective tool surface is `engine-internal tools + selected project MCP servers + future extension-contributed tools - explicit allow/disallow filters`.
   - Rationale: this is stated in `docs/prd/profile-toolbelts.md` and prevents toolbelts from accidentally removing planner submission tools or future extension tools.

3. Preserve compatibility by making omitted `toolbelt` mean "all project MCP servers".
   - Decision: missing tier `toolbelt` should not change behavior for existing profiles/projects.
   - Rationale: existing `.mcp.json` users expect all agents to receive the same project MCP servers unless they explicitly opt into tier selection.

4. Use `toolbelt: none` as explicit no-project-MCP for that tier.
   - Decision: explicit none should be visible in profile and build/debug output.
   - Rationale: users need to distinguish "default/all" from "intentionally no project MCP".

5. Prefer harness-instance keying by effective project MCP server names for this slice.
   - Decision: because current harnesses receive `mcpServers` at construction time, the smallest safe runtime implementation is to compute the filtered server map before constructing/reusing the harness and include the sorted effective server names in the registry memoization key.
   - Rationale: this avoids a larger `AgentRunOptions`/harness interface migration while addressing the known leak risk where two tiers share `pi.provider` or Claude SDK but need different MCP availability.
   - Assumption: this is sufficient because `forRole(role, planEntry)` already resolves the effective tier before returning a harness.

6. Audit and avoid worsening existing memoization under-keying.
   - Decision: while adding MCP names to the key, implementation should check whether existing keying ignores other tier-affecting harness constructor options such as `claudeSdk.disableSubagents` and Pi extension settings.
   - Rationale: the toolbelt work exposes the same class of cross-tier leakage risk; fixing only MCP keying while leaving obvious adjacent leakage may produce confusing tests/behavior.
   - Scope caution: do not expand into a broad registry refactor unless needed for correctness.

7. Put observability on agent lifecycle/debug payloads, not backend tool names.
   - Decision: add optional resolved toolbelt/MCP-selection metadata to `agent:start` and debug payloads, using project MCP server names (`playwright`) rather than backend-visible tool names.
   - Rationale: `agent:start` already carries tier/harness/model and is consumed by monitor/debug views. Project MCP server names are the user-facing abstraction from config.

8. Distinguish project MCP servers from engine-internal/custom tools in debug payloads.
   - Decision: replace or supplement ambiguous `extra.mcpServerNames` with explicit fields such as `projectMcpServerNames`, `internalMcpServerNames`, and/or `customToolCount`.
   - Rationale: Claude SDK currently merges project MCP servers with `eforge_engine`; the acceptance criteria require observability that does not confuse these categories.

9. Keep profile UX summaries at tier/toolbelt/server-name level.
   - Decision: profile list/show should summarize tier toolbelt assignments and, where available, referenced MCP server names from config; it should not list backend-visible tool names or live tools.
   - Rationale: no live MCP startup is required and backend-visible tool names are intentionally not part of user config.

10. Runtime missing/unavailable states should be actionable but not duplicate static validation.
    - Decision: if a named toolbelt or server reference is unexpectedly missing at runtime, fail or warn with the same path-specific language from `TOOLBELTS_03` rather than silently falling back to all servers.
    - Rationale: silent fallback would violate least surprise and could expose broader tool access than requested.
    - Assumption: after `TOOLBELTS_03`, normal invalid config is caught before runtime; runtime checks are defensive.

11. Tests should assert boundaries rather than SDK implementation internals.
    - Decision: use registry/harness construction/debug payloads and existing `StubHarness` patterns where possible. Do not test external Claude/Pi SDK behavior.
    - Rationale: project testing guidance says no mocks for real code and not to test harness implementations/infra beyond local behavior.

### Code Impact

Primary code impact:

1. `packages/engine/src/config.ts`
   - Depends on `TOOLBELTS_03` adding `tools.toolbelts` and tier `toolbelt` types.
   - May need exported helper/types for `ToolbeltConfig`, effective `tools.toolbelts`, and tier `toolbelt` values.
   - Runtime code should rely on resolved/validated config rather than revalidating static references.

2. `packages/engine/src/eforge.ts`
   - Current evidence: `EforgeEngine.create()` loads `.mcp.json` once via `loadMcpServers(cwd)` and passes the discovered map as `RegistryGlobalOptions.mcpServers`.
   - Likely change: keep this project MCP server map as the unfiltered source-of-truth but pass it to registry resolution code that can derive tier-specific maps.
   - Avoid changing `.mcp.json` loading semantics except possibly extracting/renaming helpers for clearer "project MCP server" terminology.

3. `packages/engine/src/agent-runtime-registry.ts`
   - Current evidence: registry already resolves role → tier using plan override, role override, then `AGENT_ROLE_TIERS`, but memoizes harnesses only by `claude-sdk` or `pi:<provider>`.
   - Add effective toolbelt resolution near `instanceForTier()` / `forRole()`:
     - omitted `toolbelt` → `globalOptions.mcpServers` as-is;
     - `none` → `undefined` or `{}` so no project MCP servers are exposed;
     - named toolbelt → subset of `globalOptions.mcpServers` matching configured names.
   - Update memoization key to include the effective project MCP server set and any other harness-affecting fields that already vary by tier (note: current key may already under-key `claudeSdk.disableSubagents`; implementation should audit rather than worsen this).
   - Prefer stable/sorted server-name keys so equivalent configs reuse instances and tests are deterministic.
   - Consider returning or stamping resolved toolbelt metadata alongside the harness. If the `AgentRuntimeRegistry.forRole()` interface remains `AgentHarness`, metadata may need to be computed separately in `resolveAgentConfig()`/agent options.

4. `packages/engine/src/pipeline/agent-config.ts`
   - Current evidence: `resolveAgentConfig()` stamps tier/harness/model/effort into `AgentRunOptions` inputs.
   - Add resolved toolbelt fields to `ResolvedAgentConfig`, e.g. `toolbelt?: string | null`, `toolbeltSource?: 'tier' | 'default'`, `projectMcpServerNames?: string[]`, and maybe `projectMcpSelection?: 'all' | 'none' | 'toolbelt'`.
   - This is the natural place to make agent events/debug payloads know what was selected, but it may not currently have access to the discovered `.mcp.json` map. If so, compute metadata in the registry/harness layer and thread it through `AgentRunOptions`.

5. `packages/engine/src/harness.ts`, `packages/engine/src/harnesses/common.ts`, `packages/client/src/events.schemas.ts`
   - Add optional toolbelt/MCP-selection fields to `AgentRunOptions`, `BuildAgentStartEventOptions`, and `agent:start` wire schema.
   - Suggested fields, final naming to be implementation-owned:
     - `toolbelt?: string | null` (`null`/`'none'` for explicit none needs a clear convention);
     - `toolbeltSource?: 'tier' | 'omitted'` or `projectMcpSelection?: 'all' | 'none' | 'toolbelt'`;
     - `projectMcpServerNames?: string[]` sorted by server name.
   - Because event schemas are client-owned wire protocol, update tests and consider whether `DAEMON_API_VERSION` should be bumped for the new optional event fields.

6. `packages/engine/src/harnesses/claude-sdk.ts`
   - Use filtered project MCP server maps in the harness constructor or, if a larger design is selected, per run.
   - Preserve the internal `eforge_engine` MCP server for `customTools` regardless of toolbelt filtering.
   - Improve `HarnessDebugPayload.extra` so project MCP servers and internal custom MCP servers are distinct. Current `extra.mcpServerNames` uses `mergedMcpServers` and can include `eforge_engine`; this must not be the only observability field.

7. `packages/engine/src/harnesses/pi.ts`
   - Use filtered project MCP server maps when constructing/reusing `PiMcpBridge`.
   - Ensure `customTools` remain registered even when `toolbelt: none` removes all project MCP servers.
   - Improve `HarnessDebugPayload.extra` to report selected project MCP server names separately from built-in, bridged, and eforge custom tool counts.

8. Profile UX / client / daemon / integrations
   - `packages/client/src/types.ts` profile list/show types may need typed tier toolbelt summaries if not already available through opaque `profile` after `TOOLBELTS_02/03`.
   - `packages/monitor/src/server.ts` profile routes likely need to include summarized tier toolbelt assignments in list/show responses, or consumers can derive them from resolved profile/config if that remains the chosen wire contract.
   - Claude Code: `packages/eforge/src/cli/mcp-proxy.ts` and `eforge-plugin/skills/profile*` should display tier toolbelt assignments.
   - Pi: `packages/pi-eforge/extensions/eforge/profile-commands.ts`, profile payload helpers, and fallback skill docs should display the same assignments.
   - Per repo instructions, if `eforge-plugin/` changes, bump `eforge-plugin/.claude-plugin/plugin.json`; do not bump `packages/pi-eforge/package.json`.

9. Monitor/debug UI
   - `packages/monitor-ui/src/lib/reducer/handle-agent.ts`, `packages/monitor-ui/src/lib/reducer.ts`, and agent/thread UI components need to preserve/display new optional `agent:start` fields.
   - `packages/monitor-ui/src/components/profile/profile-badge.tsx` can show tier `toolbelt` values in the profile sheet once available in `session:profile.config` / resolved profile config.
   - Use shadcn/ui components for any monitor UI additions per project convention.

10. Docs and tests
    - Docs: `docs/config.md` and maybe `docs/prd/profile-toolbelts.md` if status/implementation notes need updating. Leave canonical Playwright docs mostly to `TOOLBELTS_06` unless small runtime examples are necessary.
    - Tests likely in existing/focused files:
      - config/toolbelt tests from `TOOLBELTS_03` for shape/reference assumptions;
      - `test/agent-wiring.test.ts` or new `test/toolbelt-runtime.test.ts` using `StubHarness` or real registry code to assert role/tier selection and no leakage;
      - harness-boundary tests for Claude SDK/Pi constructor/debug payload behavior without testing SDK internals;
      - client event schema and monitor reducer tests for optional observability fields;
      - profile wiring tests for Claude/Pi parity.

Validation commands:
- Targeted vitest for new runtime/profile/event tests.
- `pnpm type-check`.
- Full `pnpm test` if feasible before handoff.

### Assumptions And Validation

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|---|---|---:|---:|---|---|
| `TOOLBELTS_03` will add and validate `tools.toolbelts` plus tier `toolbelt`, so this unit can consume those config fields rather than designing schema from scratch. | `TOOLBELTS_03` queue PRD and Schaake OS dependency chain explicitly cover schema/static validation and block TOOLBELTS_04. | High | Low | Enqueue/build this plan after TOOLBELTS_03 lands; read final config types before implementation. | Medium: if 03 differs, runtime code may need adaptation but the desired semantics remain clear. |
| Harness-instance keying by effective project MCP server names is sufficient for this runtime slice. | Current harness APIs take `mcpServers` in constructors; registry already resolves role/tier before returning a harness. Design doc lists this as a viable approach. | Medium | Low | During implementation, add tests where two tiers share harness/provider but different toolbelts and assert no server leakage. | High: if keying is insufficient, agents could see wrong MCP tools; per-run `AgentRunOptions` MCP selection may be needed instead. |
| Adding optional fields to `agent:start` is the right monitor/debug observability path. | `agent:start` already carries model/harness/tier and monitor UI has reducer/tests for these fields; wire schema is centralized in `packages/client/src/events.schemas.ts`. | Medium | Low | Implement optional schema fields and monitor reducer tests; if UI ergonomics are poor, add a supplementary event later. | Medium: poor event shape could make monitor/debug output fragmented or hard to query. |
| User-facing observability should use MCP server names, not backend-visible MCP tool names. | `docs/prd/profile-toolbelts.md` repeatedly says users should reference server names only and not Claude SDK/Pi tool names. | High | Low | Keep docs/tests asserting no backend-visible names are required in profile/toolbelt UX. | Medium: exposing backend names would make profiles less portable and harder to understand. |
| `toolbelt: none` should result in no project MCP servers but still preserve built-ins and eforge custom tools. | Epic acceptance and design doc distinguish project MCP filtering from engine-internal tools. Code shows Claude custom tools are merged through `eforge_engine`; Pi custom tools are separate from bridged MCP tools. | High | Low | Add tests for planner/custom tool availability path or debug payload category counts when project MCP set is empty. | High: breaking planner submission/custom tools can break builds. |
| Profile UX can summarize toolbelt assignments without live-starting MCP servers. | TOOLBELTS_05 asks for MCP server names and avoids backend-specific tool names; design doc defers live doctor/tool listing. | High | Low | Render tier toolbelt and configured server names from resolved config; docs state live tool listing is out of scope. | Low/medium: users may still want tool-level doctoring, but that is explicitly future work. |
| Runtime should fail/warn on impossible missing selected servers rather than silently broadening access. | Static validation should normally prevent impossible states; security/least-surprise favors not falling back to all MCP servers when a named toolbelt cannot be resolved. | Medium | Low | Implement defensive error messages and tests for constructed invalid config if practical. | High: silent fallback could expose tools the user tried to withhold. |
| Profile list/show wire types should include typed summaries if opaque profile config is insufficient. | Current client types expose `profile: unknown | null` for show and minimal fields for list; consumers should not duplicate parsing if summaries are needed. | Medium | Low | After 02/03 land, inspect final profile metadata/toolbelt API shape; choose typed summaries or derive from resolved config consistently in one helper. | Medium: duplicated parsing across Pi/Claude/monitor could drift. |

Assumption review:
- No low-confidence/high-impact assumptions remain.
- The highest-impact medium-confidence point is harness keying vs per-run MCP selection. It has a cheap validation path: tests where shared harness/provider tiers use different toolbelts.
- The plan should not be marked blocked by the current code shape, but it should be built after `TOOLBELTS_03` so final config types are known.

## Scope

In scope:

- Implement runtime MCP server selection for agent runs based on resolved role → tier → tier `toolbelt`.
- Preserve compatibility semantics:
  - omitted `toolbelt` passes all discovered project MCP servers to that tier;
  - `toolbelt: none` passes no project MCP servers to that tier;
  - named `toolbelt` passes only the `.mcp.json` servers listed by `tools.toolbelts.<name>.mcpServers`.
- Apply filtering only to project MCP servers loaded from `.mcp.json`.
- Ensure Claude SDK and Pi harnesses receive the correct filtered project MCP server map at the harness boundary.
- Prevent cross-tier MCP leakage when two tiers share the same harness/provider but select different toolbelts.
- Preserve engine-internal custom tools such as planner submission tools and Pi/Claude built-ins.
- Add toolbelt/MCP-selection observability to agent/build diagnostics, likely via optional fields on `agent:start` plus clearer `HarnessDebugPayload.extra` fields.
- Add profile UX summaries of tier toolbelt assignments across shared API/client types and Claude Code/Pi-facing UX where relevant.
- Update monitor/debug payload rendering enough that users can diagnose selected profile, tier, harness, toolbelt, and project MCP server names.
- Add docs updates for runtime behavior and observability. `TOOLBELTS_06` can still provide the canonical Playwright UI profile example later.
- Add tests covering runtime resolution and observability for both Claude SDK and Pi harness boundaries.

Out of scope:

- No new schema/static validation beyond what `TOOLBELTS_03` should provide; this unit may add defensive runtime errors only if necessary.
- No multiple toolbelts per tier, toolbelt composition, per-role toolbelt assignment, generated per-tool allowlists, or live MCP doctor/tool listing.
- No automatic profile selection or extension-driven routing.
- No Pi-extension-backed or Claude-plugin-backed toolbelts.
- No filtering of engine-internal custom tools, Claude built-ins, Pi built-ins, user-installed Pi extensions, or future extension-contributed custom tools.
- No requirement to expose backend-visible tool names such as `mcp__playwright__browser_navigate` or `mcp_playwright_browser_navigate` in user-facing config/UX.

Roadmap alignment: this directly advances the Profile toolbelts roadmap item by delivering the behavior-changing runtime slice and the UX/debugging layer needed to make that behavior understandable.

## Acceptance Criteria

Runtime behavior:

- For every agent role, runtime resolves role → effective tier using existing precedence: plan override, role override, built-in `AGENT_ROLE_TIERS`.
- Runtime reads the selected tier's `toolbelt` value and computes the effective project MCP server set:
  - omitted `toolbelt` → all discovered project MCP servers from `.mcp.json`;
  - `toolbelt: none` → no project MCP servers;
  - named toolbelt → only server names listed by `tools.toolbelts.<name>.mcpServers`.
- Claude SDK harnesses receive only the filtered project MCP servers for the resolved tier while preserving the internal `eforge_engine` custom-tool MCP server.
- Pi harnesses receive only the filtered project MCP servers for the resolved tier while preserving built-in tools and eforge custom tools.
- Tiers that share the same harness/provider but select different toolbelts do not leak MCP servers across runs.
- Explicit allow/disallow tool filtering continues to apply after project MCP selection and does not conflate project MCP tools with engine-internal/custom tools.
- Omitted `toolbelt` preserves current behavior for existing projects with `.mcp.json`.
- `toolbelt: none` is visible as an intentional no-project-MCP choice and does not break planner/builder submission/custom tool paths.

Observability / UX:

- Agent/build/debug output exposes selected profile, resolved tier, harness, selected toolbelt state, and selected project MCP server names for each agent run where relevant.
- `HarnessDebugPayload` or equivalent debug artifacts distinguish project MCP servers from engine-internal custom tools and future extension-contributed tools.
- Monitor/debug payloads contain enough structured information to troubleshoot missing tool availability without requiring backend-visible Claude SDK or Pi MCP tool names.
- Profile show/list UX can summarize tier toolbelt assignments and referenced MCP server names when available.
- Missing/unavailable toolbelt state is reported with actionable messages; runtime does not silently broaden a tier from a bad named toolbelt to all project MCP servers.
- User-facing output avoids requiring names like `mcp__server__tool` or `mcp_server_tool`.

Docs:

- `docs/config.md` explains runtime semantics for omitted `toolbelt`, `toolbelt: none`, and named toolbelts.
- Docs explain that toolbelt filtering is MCP-only and applies only to project MCP servers from `.mcp.json`.
- Docs state that engine-internal tools, harness built-ins, and future extension-contributed custom tools are distinct from selected project MCP servers.
- Docs include concise observability/debug examples. The full Playwright UI profile example may remain for `TOOLBELTS_06` unless needed for clarity.

Tests / validation:

- Tests cover runtime MCP selection for omitted, `none`, and named toolbelt cases.
- Tests cover both Claude SDK and Pi harness boundary behavior, preferably by inspecting constructor/debug payload inputs rather than external SDK behavior.
- Tests cover same-harness/provider tiers with different toolbelts to prevent cross-tier leakage.
- Tests cover observability fields in shared event schema and monitor/reducer handling where new fields are added.
- Tests cover profile UX/list/show summaries or wiring parity for Claude Code and Pi surfaces if client/API shapes change.
- Standard validation passes: targeted vitest tests for touched units and `pnpm type-check`; run full `pnpm test` if feasible.

Dependency / sequencing:

- This work is enqueued after `TOOLBELTS_03 Add MCP toolbelt schema and static validation` and assumes that unit has landed successfully.
