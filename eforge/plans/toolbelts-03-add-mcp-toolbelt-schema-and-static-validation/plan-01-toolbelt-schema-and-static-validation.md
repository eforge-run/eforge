---
id: plan-01-toolbelt-schema-and-static-validation
name: Toolbelt schema and static validation
branch: toolbelts-03-add-mcp-toolbelt-schema-and-static-validation/plan-01-toolbelt-schema-and-static-validation
---

## Architecture Context

Eforge config is parsed and merged in `packages/engine/src/config.ts` (single owner of both `eforge/config.yaml` and profile YAML parsing). Today the engine auto-loads all `.mcp.json` MCP servers in `packages/engine/src/eforge.ts` (`loadMcpServers()`) and passes the same global set to every tier via `buildAgentRuntimeRegistry()` in `packages/engine/src/agent-runtime-registry.ts`.

This plan introduces the **schema and static validation** for profile toolbelts as defined in `docs/prd/profile-toolbelts.md`. It deliberately does **not** change runtime MCP behavior — runtime filtering by tier is a follow-up unit. The deliverable is: users can author `tools.toolbelts.<name>` registries and per-tier `toolbelt: <name | none>` assignments in config and profile YAML, and `eforge config validate` (and the related programmatic paths) catch shape errors and broken cross-references against `.mcp.json`.

Key constraints from the PRD:
- No changes to `EforgeEngine.create()`, `loadMcpServers()`, `buildAgentRuntimeRegistry()`, harness construction, or `AgentRunOptions`.
- Static validation must inspect `.mcp.json` JSON keys only; no MCP server startup.
- `none` is reserved as a tier-assignment sentinel; it must not be a valid user-defined toolbelt name.
- Toolbelt names follow the existing profile-name pattern `^[A-Za-z0-9._-]+$`.
- `description` on a toolbelt is optional; `mcpServers` is required and non-empty.
- Static validation runs against the **merged effective config** (user + project + local + active profile), not just per-file shape, so layered/profile contributions can satisfy each other.

Project context: this worktree's `eforge/config.yaml` has the four standard tiers and no toolbelts. There is no `.mcp.json` in this worktree, so the test fixtures must construct their own temp dirs (matching the pattern in `test/config.agent-runtimes.schema.test.ts`).

## Implementation

### Overview

1. Extend the Zod schema in `packages/engine/src/config.ts` with:
   - `toolbeltNameSchema` — `z.string().regex(/^[A-Za-z0-9._-]+$/)`, with a separate `RESERVED_TOOLBELT_NAMES = new Set(['none'])` constant.
   - `toolbeltConfigSchema` — `{ description?: string; mcpServers: string[] (nonempty, every entry a non-empty string) }`.
   - `toolsConfigSchema` — `{ toolbelts?: Record<string, ToolbeltConfig> }` with a `superRefine` that rejects `none` as a key and rejects keys not matching `toolbeltNameSchema`.
   - Add `tools: toolsConfigSchema.optional()` to `eforgeConfigBaseSchema`. Because `knownConfigYamlKeys`, `stripUndefinedSections()`, and `loadProfileFromPath()`'s key-copy loop are all derived from `Object.keys(eforgeConfigBaseSchema.shape)`, this single addition is automatically picked up by `configYamlSchema`, partial parsing, profile parsing, and round-trip validation. **Confirm by inspection** that no other places hard-code the list of top-level keys; if any do, add `tools` there too.
   - Add `toolbelt: z.string().optional()` to `tierConfigSchema`. Tier-level shape validation only checks `typeof === 'string'` and non-empty; cross-reference validation lives in the static helper.

2. Extend `EforgeConfig`, `DEFAULT_CONFIG`, and `resolveConfig()`:
   - Add `tools: { toolbelts: Record<string, { description?: string; mcpServers: string[] }> }` to the `EforgeConfig` interface.
   - Add `tools: Object.freeze({ toolbelts: {} })` to `DEFAULT_CONFIG` so `config show` always emits a stable shape.
   - In `resolveConfig()`, freeze and propagate `fileConfig.tools?.toolbelts ?? {}` plus pass through `tier.toolbelt` (already preserved by passing the tiers object through unchanged).

3. Extend `mergePartialConfigs()` to deep-merge `tools.toolbelts` by name across user / project / local / profile layers (per-name shallow-merge — later layers win on a per-toolbelt basis without dropping unrelated entries). Mirror the existing `agents.tiers` per-name merge logic.

4. Add static validation helpers in `packages/engine/src/config.ts`:
   - `loadProjectMcpServerNames(projectRoot: string): Promise<{ exists: boolean; names: string[] }>`. Reads `<projectRoot>/.mcp.json`, parses it as JSON only, and returns the keys of `mcpServers` (or `exists: false` on ENOENT, throws `ConfigValidationError` with the file path on malformed JSON). **Does not** call `loadMcpServers()` from `eforge.ts` — that helper deletes `eforge` and is part of runtime semantics.
   - `validateToolbeltReferences(merged: PartialEforgeConfig, mcpProbe: { exists: boolean; names: string[] } | null): string[]`. Returns an array of human-readable error messages (path-prefixed). Checks performed:
     * For each entry in `merged.tools?.toolbelts`: name matches `toolbeltNameSchema`; key is not `'none'`; `mcpServers` is present and non-empty (caught by schema, but include a defense-in-depth check for the merged-only case where schema parsing may have happened separately on each layer).
     * For each `merged.agents?.tiers?.<tier>?.toolbelt` value: if it is `'none'`, accept; otherwise it must exist as a key in `merged.tools?.toolbelts`. Error: `agents.tiers.<tier>.toolbelt references "<name>", but no tools.toolbelts.<name> is defined.`
     * For each `merged.tools?.toolbelts.<name>.mcpServers[i]`: if `mcpProbe === null` (no project root context), skip; if `!mcpProbe.exists`, emit one error per toolbelt: `tools.toolbelts.<name> declares MCP servers, but .mcp.json was not found.`; if `mcpProbe.exists`, each entry must be present in `mcpProbe.names`. Error: `tools.toolbelts.<name> references MCP server "<server>", but .mcp.json has no mcpServers.<server> entry.`

5. Wire static validation into the existing config paths:
   - In `validateConfigFile(cwd?)`: after `configYamlSchema.safeParse()` succeeds, locate the project root (parent of `configDir`), call `loadProjectMcpServerNames(projectRoot)`, and run `validateToolbeltReferences(parsedData, probe)`. Append any errors to the `errors` array. The function still returns its existing `{ configFound, valid, errors }` shape — no breaking change to callers (`packages/eforge/src/cli/index.ts:476`, `packages/monitor/src/server.ts:2664`).
   - In `loadConfig()`: after computing `merged` (post-profile merge) and **before** `resolveConfig()`, run `validateToolbeltReferences(merged, probe)` where `probe` comes from `loadProjectMcpServerNames(projectRoot)`. On any error, throw `ConfigValidationError` listing all errors. This catches active-profile + project layered errors before the engine boots.
   - In `setActiveProfile()`: after the existing `eforgeConfigSchema.safeParse(merged)` block, run the same toolbelt cross-reference check against the merged config + project `.mcp.json`. On any error, throw `Error` with the joined messages (matching the existing 'invalid merged config' phrasing pattern).
   - In `createAgentRuntimeProfile()`: after the existing merged-validation block, run the same check against `merged` + project `.mcp.json`. On any error, throw `Error`.

6. **Do not** modify `packages/engine/src/eforge.ts`, `packages/engine/src/agent-runtime-registry.ts`, or any harness file. The `tier.toolbelt` field is parsed and stored but never consumed by runtime construction in this unit. Add a regression test (see test plan below) that asserts this remains true.

### Key Decisions

1. **Single-file schema change.** Toolbelt schemas live in `packages/engine/src/config.ts` next to the existing tier/profile schemas — no new module needed. Rationale: keeps the schema source of truth in one place; `knownConfigYamlKeys`, `stripUndefinedSections`, and `loadProfileFromPath` automatically discover `tools` because they iterate `Object.keys(eforgeConfigBaseSchema.shape)`.

2. **Static validation in a plain TypeScript helper, not a Zod refinement.** Cross-file checks against `.mcp.json` are async filesystem reads and depend on a project root that is not available inside Zod parsing. A separate `validateToolbeltReferences()` returning string errors keeps Zod schemas pure and lets the same helper be reused by `validateConfigFile`, `loadConfig`, `setActiveProfile`, and `createAgentRuntimeProfile`.

3. **`.mcp.json` parse-only, never `loadMcpServers()`.** The new helper reads `<projectRoot>/.mcp.json` directly and inspects keys. It does **not** import or call `loadMcpServers()` from `eforge.ts`, because that helper deletes the `eforge` server entry as part of runtime semantics — static validation should report on the file as written.

4. **Merge `tools.toolbelts` by name.** Mirror the existing per-name merge pattern used for `agents.tiers` so layered config can compose toolbelts without one layer wiping another. Document this in the merge tests.

5. **Default `tools: { toolbelts: {} }`.** Always present in `DEFAULT_CONFIG` and `resolveConfig()` so `config show` output is stable and consumer code can assume the shape exists. Empty registry means "no named toolbelts defined," which is fully backward compatible.

6. **Optional `description`.** PRD wording (`required or strongly recommended`) is non-binding; the epic only lists `description` as supported. Optional matches the principle of least surprise and is the easier-to-tighten direction. Tests assert both shapes (with and without description).

### Worked example (for builder)

Valid merged config:

```yaml
tools:
  toolbelts:
    browser-ui:
      description: Browser automation for UI work.
      mcpServers:
        - playwright
agents:
  tiers:
    implementation:
      harness: claude-sdk
      model: claude-sonnet-4-6
      effort: medium
      toolbelt: browser-ui
    review:
      harness: claude-sdk
      model: claude-opus-4-7
      effort: high
      toolbelt: none
```

With `.mcp.json` containing `{ "mcpServers": { "playwright": { ... } } }`, this passes both schema and static validation.

If `agents.tiers.implementation.toolbelt: browser-ui` were changed to `browser-foo`, static validation should report: `agents.tiers.implementation.toolbelt references "browser-foo", but no tools.toolbelts.browser-foo is defined.`

If `mcpServers: [playwright]` were changed to `[chromium]`, static validation should report: `tools.toolbelts.browser-ui references MCP server "chromium", but .mcp.json has no mcpServers.chromium entry.`

## Scope

### In Scope

- Add `tools.toolbelts` registry + `tier.toolbelt` field to the Zod schema and TypeScript types in `packages/engine/src/config.ts`.
- Add `tools` to `EforgeConfig`, `DEFAULT_CONFIG`, and `resolveConfig()`.
- Deep-merge `tools.toolbelts` by name in `mergePartialConfigs()`.
- New `loadProjectMcpServerNames()` and `validateToolbeltReferences()` helpers in `packages/engine/src/config.ts`.
- Wire static validation into `validateConfigFile()`, `loadConfig()`, `setActiveProfile()`, and `createAgentRuntimeProfile()`.
- Reject `tools.toolbelts.none` (reserved name).
- Reject toolbelt names not matching `^[A-Za-z0-9._-]+$`.
- Reject empty/missing `mcpServers` and non-string entries via Zod.
- Detect duplicate YAML keys via the existing `parseYaml()` path (the `yaml` package throws `Map keys must be unique` — verified by the PRD's cheap-validation step).
- Update `docs/config.md`: add minimal `tools.toolbelts` example, tier `toolbelt: <name | none>` example, and update the MCP Servers section to clarify that omitted `toolbelt` preserves the current all-MCP default until runtime filtering is implemented.
- Add a focused test file `test/config.toolbelts.test.ts` covering schema, merge, `.mcp.json` reference validation, and the no-runtime-change regression.

### Out of Scope

- No changes to `packages/engine/src/eforge.ts` (`loadMcpServers()`, `EforgeEngine.create()`).
- No changes to `packages/engine/src/agent-runtime-registry.ts` or harness files.
- No runtime per-tier MCP filtering, no harness memoization changes, no `AgentRunOptions` changes.
- No profile metadata expansion (`description`, `whenToUse`, `tags` already exist; this plan does not add to them).
- No CLI subcommand for toolbelts (no `eforge toolbelt list` etc.).
- No live MCP doctor / startup probe.
- No Pi extension or Claude plugin toolbelt backings.
- No monitor UI changes, no event payload changes.
- No `eforge-plugin/` or `packages/pi-eforge/` consumer-facing changes (this is engine config and docs only; no CLI/MCP/skill commands added — confirmed by the PRD's parity assumption).

## Files

### Create

- `test/config.toolbelts.test.ts` — focused tests for the new schema, merge semantics, static validation, and no-runtime-change regression. Follow the patterns in `test/config.agent-runtimes.schema.test.ts` (real parser/schema, no mocks; `mkdtemp` for filesystem fixtures).

### Modify

- `packages/engine/src/config.ts` — add `toolbeltNameSchema`, `toolbeltConfigSchema`, `toolsConfigSchema`, `RESERVED_TOOLBELT_NAMES`; add `tools` to `eforgeConfigBaseSchema`; add `toolbelt` to `tierConfigSchema`; extend `EforgeConfig` and `DEFAULT_CONFIG`; extend `resolveConfig()`; deep-merge `tools.toolbelts` in `mergePartialConfigs()`; add `loadProjectMcpServerNames()` and `validateToolbeltReferences()`; wire into `validateConfigFile()`, `loadConfig()`, `setActiveProfile()`, `createAgentRuntimeProfile()`.
- `docs/config.md` — append a new `### Toolbelts` subsection under the existing `## MCP Servers` section showing the `tools.toolbelts` registry shape, the per-tier `toolbelt` assignment with `none` and named values, and a sentence stating that omitted `toolbelt` continues to pass all discovered project MCP servers (runtime filtering by toolbelt is not yet implemented). Update the existing one-liner `All eforge agents receive the same MCP servers.` to explicitly note the omitted-`toolbelt` default and that named toolbelts and `toolbelt: none` are now schema-valid for forthcoming runtime selection.

### Test plan (cases to write in `test/config.toolbelts.test.ts`)

Schema acceptance:
- Valid `tools.toolbelts.<name>` with `description` + `mcpServers`.
- Valid toolbelt with `mcpServers` only (no `description`).
- Valid tier with `toolbelt: <name>`.
- Valid tier with `toolbelt: none`.
- Valid tier with omitted `toolbelt`.
- `parseRawConfig({...}, 'config')` round-trips a `tools.toolbelts` registry.
- `parseRawConfig({...}, 'profile')` accepts the same shape (profile context).

Schema rejection:
- `tools.toolbelts.none: { ... }` is rejected (reserved name).
- Toolbelt name `bad name!` is rejected (pattern violation).
- `mcpServers: []` is rejected (non-empty).
- `mcpServers: [123]` is rejected (string entries only).
- `mcpServers` missing entirely is rejected.
- `tools: { toolbelts: { foo: 'bar' } }` is rejected (shape).
- Tier `toolbelt: 42` is rejected (must be string).

`mergePartialConfigs`:
- Project layer adds toolbelt B without dropping user-layer toolbelt A.
- Project layer overrides toolbelt A's `mcpServers` while keeping user-layer toolbelt B intact.
- Project tier `toolbelt: foo` overrides user tier `toolbelt: bar`.

`validateToolbeltReferences`:
- Tier references named toolbelt that exists → no error.
- Tier references `none` → no error.
- Tier references undefined name → error message contains `agents.tiers.<tier>.toolbelt references "<name>"` and `no tools.toolbelts.<name> is defined`.
- Toolbelt `mcpServers` entry exists in `.mcp.json` → no error.
- Toolbelt `mcpServers` entry missing from `.mcp.json` → error message contains `tools.toolbelts.<name> references MCP server "<server>"` and `no mcpServers.<server> entry`.
- `.mcp.json` missing + named toolbelt with mcpServers → actionable error mentioning `.mcp.json was not found`.
- `.mcp.json` missing + no named toolbelts → no error.
- Static validation does not start any subprocess (no spy needed; assert by structure: `loadProjectMcpServerNames` only does `readFile` + `JSON.parse`).

`validateConfigFile()` integration (uses `mkdtemp` to construct `eforge/config.yaml` and an optional `.mcp.json`):
- Config with valid toolbelts + matching `.mcp.json` → `valid: true`.
- Config with tier `toolbelt: missing` → `valid: false`, error in returned array.
- Config with toolbelt referencing missing MCP server → `valid: false`.
- Config with duplicate YAML keys under `tools.toolbelts` → falls through the YAML parse error path (`Map keys must be unique`), `valid: false`.

No-runtime-change regression:
- Construct an `EforgeConfig` with a tier `toolbelt: foo` and `tools.toolbelts.foo.mcpServers: ['playwright']`. Build the registry inputs the way `EforgeEngine.create()` does today and assert that `globalOptions.mcpServers` is unchanged (still the full `.mcp.json` set, not filtered by toolbelt). The simplest form of this test is to verify that no code path in `packages/engine/src/eforge.ts` or `packages/engine/src/agent-runtime-registry.ts` reads `tier.toolbelt` — implement as a `grep`-style assertion using `readFile` on those two source files and `expect(content).not.toMatch(/toolbelt/i)`. Keep the assertion permissive on test files.

## Verification

- [ ] `pnpm vitest run test/config.toolbelts.test.ts test/config.agent-runtimes.schema.test.ts test/config.test.ts packages/engine/test/config.legacy-rejection.test.ts` exits 0.
- [ ] `pnpm type-check` exits 0.
- [ ] `pnpm test` exits 0 (full suite).
- [ ] `eforge config validate` (manual or scripted) reports `Config valid` for `eforge/config.yaml` + an `.mcp.json` containing `playwright`, and reports a path-prefixed error like `agents.tiers.implementation.toolbelt references "missing", but no tools.toolbelts.missing is defined.` when the tier reference is broken.
- [ ] `grep -n 'toolbelt' packages/engine/src/eforge.ts packages/engine/src/agent-runtime-registry.ts packages/engine/src/harnesses/ -r` returns zero matches (no runtime consumption of `tier.toolbelt`).
- [ ] `docs/config.md` contains a `tools.toolbelts` example block, a per-tier `toolbelt` example, and a sentence stating that omitted `toolbelt` preserves the current all-MCP default.
- [ ] Reading back `eforge/config.yaml` via `loadConfig()` returns a `config.tools.toolbelts` object (empty `{}` when no toolbelts are declared).