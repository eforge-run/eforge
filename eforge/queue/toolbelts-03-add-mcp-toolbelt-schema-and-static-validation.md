---
title: TOOLBELTS_03 Add MCP toolbelt schema and static validation
created: 2026-05-13
depends_on: ["add-profile-metadata-fields-toolbelts-02"]
profile: claude-sdk-4-7
---

# TOOLBELTS_03 Add MCP toolbelt schema and static validation

## Problem / Motivation

Eforge currently auto-loads all project MCP servers from `.mcp.json` and exposes the same server set to all agent tiers. The profile toolbelts MVP needs an initial schema/validation slice so users can declare named MCP-backed toolbelts and assign one toolbelt per tier before runtime filtering is implemented.

User-stated / epic-backed requirements:
- `tools.toolbelts.<name>` definitions must be accepted by config parsing.
- Each toolbelt must support `description` and `mcpServers`.
- Tier recipes must support singular `toolbelt: <name | none>`.
- Validation must catch unknown toolbelt references, unknown MCP server references, empty toolbelts, duplicate/invalid names, and invalid shapes.
- This unit must not change runtime tool behavior.
- Documentation must include minimal schema examples.

Why now: roadmap and `docs/prd/profile-toolbelts.md` identify profile toolbelts as the conservative MVP path for tier-specific MCP capability selection. This epic is the schema/static-validation prerequisite for later runtime filtering.

Evidence sources reviewed:
- `docs/prd/profile-toolbelts.md` defines the MVP: `tools.toolbelts.<name>` registry, singular tier-level `toolbelt`, reserved `none`, static validation against `.mcp.json`, and explicitly no runtime filtering in this unit.
- Schaake OS epic `TOOLBELTS_03` acceptance criteria require schema + static validation only, with no runtime behavior changes.
- `docs/roadmap.md` lists Profile toolbelts under Extensibility, aligned with this work.
- `packages/engine/src/config.ts` is the current config schema/loader/validator owner. It uses Zod for config, `PartialEforgeConfig` for both config and profile parsing, and `validateConfigFile()` for `eforge config validate` / daemon config validation.
- `packages/engine/src/eforge.ts` currently auto-loads all `.mcp.json` servers once and passes them globally into `buildAgentRuntimeRegistry()`.
- `packages/engine/src/agent-runtime-registry.ts` currently memoizes harnesses by harness/provider and passes the same global `mcpServers` to all runtime instances.
- `docs/config.md` currently says all agents receive the same MCP servers; this will become stale once schema examples are added, but runtime behavior must remain unchanged for this unit.
- Existing config tests live primarily in `test/config.test.ts`, `test/config.agent-runtimes.schema.test.ts`, and `packages/engine/test/config.legacy-rejection.test.ts`.

Current project evidence:
- This repo has `eforge/config.yaml` with all four standard tiers and no toolbelts yet.
- This repo has `.mcp.json` with `eval` and `schaake-os` MCP server entries. These are useful concrete names for static validation examples/tests.

Boundaries confirmed:
- Implement schema and validation data plumbing in config/profile parsing only.
- Do not change `EforgeEngine.create()`, `loadMcpServers()`, `buildAgentRuntimeRegistry()`, harness construction, or agent run options for effective MCP selection in this unit.
- Static validation should inspect `.mcp.json` server names but must not start MCP servers.

Early assumptions / unknowns:
- Assumption (medium confidence): toolbelt name validity should reuse the profile-name style character set (`[A-Za-z0-9._-]+`) plus reserve `none`, because the epic asks for duplicate/invalid names and the existing config has no dedicated name validator. Needs a design decision.
- Assumption (high confidence): duplicate YAML keys are not currently detected by the `yaml` parse path in `config.ts`; detecting duplicate toolbelt names may require parsing with duplicate-key reporting or accepting parser-level behavior if the library already errors. Needs cheap validation during implementation.
- Unknown: whether static toolbelt validation should run for profile files loaded without an `eforge/config.yaml` context. Likely it should run when validating/activating/merging resolved config, but profile-only parsing may only do shape validation.

## Goal

Land the schema and static-validation slice for profile toolbelts: extend config/profile parsing to accept a `tools.toolbelts` registry and per-tier singular `toolbelt` assignment, with actionable static validation against `.mcp.json`, while preserving today's runtime behavior so a future unit can introduce runtime MCP filtering.

## Approach

**Design Decisions:**

1. **Model toolbelts as a top-level `tools.toolbelts` registry in merged config.**
   - Shape: `tools?: { toolbelts?: Record<ToolbeltName, ToolbeltConfig> }`.
   - Rationale: matches `docs/prd/profile-toolbelts.md` and keeps MCP server command definitions in `.mcp.json`.
   - Merge behavior: `tools` should shallow-merge like other object sections; `toolbelts` should merge by name so user/project/local/profile layers can add or override individual named toolbelts without dropping unrelated definitions. If implementation complexity must be minimized, document and test the chosen merge semantics explicitly.

2. **Use `toolbelt?: string` on tier recipes.**
   - Supported values: omitted, `none`, or a named toolbelt.
   - Rationale: singular assignment is an explicit MVP constraint; omitted preserves backward compatibility.
   - Runtime note: the field is stored/resolved but not consumed for MCP filtering in this unit.

3. **Reserve `none` as a tier assignment sentinel, not a user-defined toolbelt name.**
   - Validation: `tools.toolbelts.none` should fail with an actionable error.
   - Rationale: avoids ambiguous interpretation between "toolbelt named none" and explicit opt-out.

4. **Adopt a conservative toolbelt name pattern.**
   - Proposed: non-empty names containing only letters, digits, dot, underscore, or dash (`^[A-Za-z0-9._-]+$`), matching existing profile-name constraints.
   - Rationale: portable YAML keys, readable CLI/config paths, and consistency with existing profile naming.
   - Assumption: this satisfies "invalid names" in the epic; if product intent allows broader names, implementation should adjust tests accordingly.

5. **Make `mcpServers` required and non-empty for a named toolbelt; keep `description` optional string unless requirements are clarified otherwise.**
   - Rationale: the PRD says description is "required or strongly recommended," while the epic says each toolbelt "supports" description and `mcpServers`; the validation acceptance criteria specifically call out empty toolbelts, which maps to missing/empty `mcpServers`.
   - If implementer chooses to require description, tests/docs should make that explicit. Current recommendation is optional to avoid over-constraining config.

6. **Static project validation should operate on the merged effective config plus project `.mcp.json` server names.**
   - Checks:
     - `agents.tiers.*.toolbelt` named reference exists in `tools.toolbelts` unless value is `none`.
     - each `tools.toolbelts.*.mcpServers[]` entry exists in `.mcp.json.mcpServers`.
     - missing `.mcp.json` with non-empty named toolbelts produces an actionable error.
   - Rationale: profile files and config layers can define complementary pieces; validating only a single raw file would create false negatives/positives.

7. **Do not start MCP servers during validation.**
   - Implementation should parse JSON and inspect keys only.
   - Rationale: MCP startup may be slow/flaky/environment-dependent and is explicitly deferred to future doctor/live validation.

8. **Keep runtime behavior unchanged by not consuming `tier.toolbelt` in runtime construction.**
   - `EforgeEngine.create()` should still auto-load `.mcp.json` and pass all discovered servers globally.
   - `buildAgentRuntimeRegistry()` should still receive the same `globalOptions.mcpServers` and memoize as it does today.
   - Rationale: acceptance criteria explicitly prohibit runtime behavior changes in this unit.

9. **Error messages should be path-specific and actionable.**
   - Examples to target:
     - `agents.tiers.implementation.toolbelt references "browser-ui", but no tools.toolbelts.browser-ui is defined.`
     - `tools.toolbelts.browser-ui references MCP server "playwright", but .mcp.json has no mcpServers.playwright entry.`
   - Rationale: mirrors design doc UX and makes `eforge config validate` useful.

10. **Documentation should be minimal and avoid promising runtime filtering until the dependent unit lands.**
    - Add syntax examples and validation behavior.
    - Phrase omitted toolbelt behavior as current compatibility/default behavior.
    - Avoid build/debug observability examples in this unit because those are runtime/UX work for later.

**Code Impact:**

Primary files:
- `packages/engine/src/config.ts`
  - Add `toolbeltNameSchema`, `toolbeltConfigSchema`, and top-level `tools` config schema.
  - Add optional `toolbelt` to `tierConfigSchema`.
  - Add `tools` to `EforgeConfig`, `DEFAULT_CONFIG`, `resolveConfig()`, `stripUndefinedSections()`, `mergePartialConfigs()`, and `mergeConfig`-adjacent config override handling if applicable.
  - Add static validation helper(s) for merged config: named tier toolbelt references and `.mcp.json` server references.
  - Extend `validateConfigFile(cwd?)` to parse `.mcp.json` server names from the project root found via `eforge/config.yaml`, without starting servers.
  - Ensure profile loading / active profile activation validates merged static references, not just per-file shape, when enough project context exists.
- `test/config.test.ts`, `test/config.agent-runtimes.schema.test.ts`, and/or a new focused test file such as `test/config.toolbelts.test.ts`
  - Add schema acceptance/rejection and static project validation coverage.
  - Existing tests use real parser/schema code and no mocks, matching project testing conventions.
- `docs/config.md`
  - Add minimal `tools.toolbelts` registry and tier `toolbelt` assignment examples.
  - Update the MCP Servers section from "all agents receive the same MCP servers" to note that this remains the default when `toolbelt` is omitted and that `toolbelt: none` / named toolbelts are schema-valid for future tier selection.

Secondary / likely no-change files:
- `packages/engine/src/eforge.ts`
  - Evidence: current `loadMcpServers()` auto-loads `.mcp.json` and passes all servers globally. This should not be changed for this unit.
- `packages/engine/src/agent-runtime-registry.ts`
  - Evidence: current registry memoizes by harness/provider and passes global `mcpServers` into harness constructors. This should not be changed for this unit.
- Harnesses under `packages/engine/src/harnesses/`
  - No runtime behavior changes; only types might be imported for MCP config shape if a reusable parser helper is extracted.

Test/validation commands:
- Focused tests first: `pnpm vitest run test/config.toolbelts.test.ts test/config.agent-runtimes.schema.test.ts test/config.test.ts` (adjust if the test file name differs).
- Then `pnpm type-check`.
- Full validation before handoff if feasible: `pnpm test`.

Evidence supporting this impact list:
- `rg` found current tool/config ownership in `packages/engine/src/config.ts` and MCP runtime loading in `packages/engine/src/eforge.ts` / `packages/engine/src/agent-runtime-registry.ts`.
- `docs/config.md` has the current user-facing MCP statement that needs a minimal update.
- Duplicate YAML keys are already surfaced by the `yaml` parser (`parse()` throws "Map keys must be unique"), so duplicate-name validation can be tested through file/string parse paths rather than object-level `parseRawConfig()`.

**Profile Signal:**

Recommended eforge profile: **Excursion**.

Rationale:
- This is cohesive feature/config work centered on `packages/engine/src/config.ts`, tests, and `docs/config.md`.
- It is not an Errand because it requires schema design, merged-config validation, `.mcp.json` static checks, and regression tests.
- It is not an Expedition because a single planner can enumerate the affected modules and sequencing; no delegated subsystem planning is needed.

Suggested build shape:
1. Add schema/types/default/merge plumbing.
2. Add static validation helpers and wire them into config validation/loading.
3. Add focused tests for schema and static reference validation.
4. Update minimal docs examples.

**Assumptions And Validation:**

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|---|---|---:|---:|---|---|
| Toolbelt names should use the same allowed character set as profile names (`[A-Za-z0-9._-]+`) and reserve `none`. | Existing `createAgentRuntimeProfile()` validates profile names with this pattern. The design doc explicitly reserves `none`. Epic asks for invalid names but does not define a pattern. | Medium | Low | Confirm product preference before implementation, or implement with tests and adjust if review requests broader names. | Low/medium: overly strict names could reject desired user config; easy to relax before runtime unit. |
| `description` should be optional string, while `mcpServers` is required/non-empty. | Design doc says description is "required or strongly recommended"; epic says supports `description` and `mcpServers`, and specifically requires empty toolbelt validation. | Medium | Low | Ask product owner or make implementation tests explicit. | Low: requiring description later is a small schema/docs/test change; optional is backward-compatible. |
| Static validation should run against merged effective config rather than raw profile/config files only. | `loadConfig()` merges user/project/local/profile layers; active profiles can override tier recipes. Design says definitions live in merged config. | High | Low | Implement a helper that accepts merged partial/resolved config and test split definitions across layers/profile. | Medium: validating only raw files could reject legitimate layered configs or miss active-profile errors. |
| `.mcp.json` server reference validation can inspect JSON keys only and should not use `loadMcpServers()` runtime behavior directly if that would alter runtime semantics. | Design explicitly forbids live startup. `loadMcpServers()` currently parses `.mcp.json` and deletes `eforge` before passing runtime servers. Static validation only needs names. | High | Low | Add a small project-root `.mcp.json` key reader used by validation, with tests for missing/malformed file. | Medium: using runtime loader carelessly could conflate validation semantics with runtime behavior. |
| Duplicate toolbelt YAML keys are detectable through the existing `yaml` parser path. | Cheap validation performed with `yaml.parse()` / `parseDocument()` on duplicate keys; parser throws `Map keys must be unique`. | High | None | Add a regression test for `validateConfigFile()` or a helper that parses duplicate-key YAML. | Low: if parsing path changes, duplicate detection may need explicit `parseDocument` error handling. |
| Adding `tools` to resolved `DEFAULT_CONFIG` as an empty registry is acceptable for `config show`. | Existing resolved config includes defaults for many sections. No evidence of consumers depending on absent `tools`. | Medium | Low | Run snapshot-like tests if any; inspect config show output in tests if present. | Low: can omit empty registry if necessary, but type/default consistency is simpler with a default. |
| No plugin/Pi parity updates are required because this is engine config/docs only and does not add CLI/MCP/skill commands. | AGENTS.md parity rule applies to consumer-facing commands/tools/skills/user behavior. This unit changes config schema and docs, not integration command surfaces. | High | Low | During implementation, check no MCP/Pi extension schema copy exists for config fields. | Low: if a consumer-facing profile editor schema mirrors config fields, it would need an update. |

Assumption review:
- No low-confidence/high-impact assumptions remain.
- The main medium-confidence decisions (name pattern, optional description, empty `tools` default) are low-cost to adjust during implementation review.
- Cheap validation performed: code search for config/MCP ownership, docs review, current project `.mcp.json` inspection, and duplicate YAML parser behavior check.

## Scope

**In scope:**
- Extend the Zod config schema in `packages/engine/src/config.ts` with a top-level `tools.toolbelts` registry.
- Extend tier recipes with optional singular `toolbelt?: string`.
- Add resolved/partial TypeScript types for toolbelt config by deriving from schema where possible.
- Preserve current omitted-`toolbelt` semantics: existing configs with `.mcp.json` remain valid and runtime still receives all discovered project MCP servers.
- Add static validation for:
  - invalid `tools.toolbelts` shapes;
  - empty or missing `mcpServers` arrays;
  - non-string `mcpServers` entries;
  - reserved/invalid toolbelt names, including `none` as a reserved non-user name;
  - tier `toolbelt` references to undefined named toolbelts;
  - toolbelt `mcpServers` references absent from project `.mcp.json`;
  - duplicate YAML keys for toolbelt names where the YAML parser surfaces them.
- Wire static validation into config validation/loading paths enough that invalid committed config and active-profile merged config fail with actionable errors.
- Add tests for schema acceptance, schema rejection, merged profile behavior, and `.mcp.json` reference validation.
- Add minimal docs examples to `docs/config.md` (and only touch design docs if necessary to clarify shipped status/constraints).

**Out of scope:**
- No runtime MCP filtering by tier.
- No changes to `EforgeEngine.create()` MCP loading behavior except any shared helper extraction that does not alter effective runtime input.
- No changes to harness memoization, `AgentRunOptions`, Claude SDK/Pi tool exposure, or debug/monitor payloads.
- No profile metadata (`description`, `whenToUse`, `tags`) unless already required by schema coupling; that belongs to a separate unit.
- No profile list/show UX changes for displaying toolbelts.
- No live MCP server startup, tool listing, or doctor command.
- No Pi extension- or Claude plugin-backed toolbelts.

Roadmap relation: this implements a bounded schema/validation slice of the Profile toolbelts roadmap item and intentionally leaves runtime selection for the dependent epic.

## Acceptance Criteria

**Functional/schema:**
- `parseRawConfig()` and `configYamlSchema` accept valid `tools.toolbelts.<name>` definitions with `mcpServers` and optional `description`.
- `tierConfigSchema` accepts optional singular `toolbelt` with values like `browser-ui` or `none`.
- `resolveConfig()` preserves `tools.toolbelts` and tier `toolbelt` values in the resolved config object.
- `mergePartialConfigs()` has tested behavior for `tools.toolbelts` across user/project/local/profile layers.

**Validation:**
- Invalid `tools.toolbelts` shapes fail with clear schema errors.
- Missing/empty `mcpServers` fails for a named toolbelt.
- Non-string entries in `mcpServers` fail.
- `tools.toolbelts.none` fails as a reserved name.
- Toolbelt names that violate the chosen name pattern fail.
- Duplicate YAML keys under `tools.toolbelts` fail through the file/YAML parse path.
- `agents.tiers.<tier>.toolbelt: <name>` fails when `<name>` is not defined in the merged `tools.toolbelts` registry.
- `toolbelt: none` is accepted as explicit opt-out.
- Omitted `toolbelt` remains accepted and does not require `tools.toolbelts`.
- A toolbelt reference to an MCP server absent from `.mcp.json.mcpServers` fails with an actionable error.
- If `.mcp.json` is missing and config defines named toolbelts with MCP server references, validation fails with an actionable error.
- Static validation does not start or contact MCP servers.

**No runtime behavior change:**
- Existing tests or new regression tests confirm `EforgeEngine.create()` / registry behavior is not changed to filter MCP servers by tier in this unit.
- No changes are made to harness run options or MCP bridge behavior for effective per-tier server selection.

**Documentation:**
- `docs/config.md` includes a minimal `tools.toolbelts` example and a tier-level `toolbelt` example.
- Docs state omitted `toolbelt` preserves current all-project-MCP default until runtime filtering is implemented.
- Docs explain `toolbelt: none` and reserved `none`.

**Validation commands:**
- Focused config/toolbelt tests pass.
- `pnpm type-check` passes.
- `pnpm test` passes or any failure is unrelated and documented.
