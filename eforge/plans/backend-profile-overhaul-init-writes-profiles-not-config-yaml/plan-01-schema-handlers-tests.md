---
id: plan-01-schema-handlers-tests
name: Schema, resolver, init handlers, Pi footer, docs, and tests
depends_on: []
branch: backend-profile-overhaul-init-writes-profiles-not-config-yaml/schema-handlers-tests
---

# Schema, resolver, init handlers, Pi footer, docs, and tests

## Architecture Context

The backend profile system currently has a type conflation: `backend:` in `config.yaml` is typed as the backend kind (`claude-sdk|pi`) but `resolveActiveProfileName` treats it as a profile filename for fallback resolution. The `eforge_init` handlers write `backend:` directly into `config.yaml` instead of creating named profile files. This plan eliminates the conflation by removing `backend:` from the config.yaml schema entirely, rewriting both init handlers to create real backend profiles, adding a `--migrate` mode for existing projects, simplifying the resolver, and adding Pi footer status for the active backend.

## Implementation

### Overview

This plan touches 10 files across 5 packages. The changes flow from the engine schema outward: (1) remove `backend:` from config.yaml schema, (2) add a profile-name sanitizer and `parseRawConfigLegacy`, (3) simplify `resolveActiveProfileName` to project-marker → user-marker → none, (4) narrow `ActiveProfileSource` and `BackendProfileSource` types, (5) rewrite both init handlers, (6) add Pi footer status, (7) update skill docs, (8) update tests, (9) bump versions.

### Key Decisions

1. **Hard break, not soft deprecation.** The config.yaml schema stops accepting `backend:` at the top level. Projects with the old format must run `--migrate`. This is intentional - the type conflation causes confusing behavior and the clean break is worth the migration cost.

2. **Separate schema paths for config.yaml vs profiles.** The `backend` field must remain valid in profile files (`eforge/backends/*.yaml`) but be rejected in `config.yaml`. Introduce a `configYamlSchema` (derived from `eforgeConfigBaseSchema` but omitting `backend`) for config.yaml validation, while keeping the existing schema (with `backend`) for profile validation. Update `parseRawConfig` to accept a `context` parameter (`'config'` vs `'profile'`) to select the right schema, or create a dedicated `parseConfigYaml` wrapper that rejects `backend:`.

3. **Deterministic profile names from init.** The sanitizer computes `[backend[-provider]]-[sanitized-max-model-id]` where sanitization is: lowercase, `.` → `-`, strip `claude-` prefix, collapse repeated dashes. Examples: `claude-sdk-opus-4-7`, `pi-anthropic-opus-4-7`, `pi-zai-glm-4-6`.

4. **Pi footer is best-effort.** The `refreshStatus` function calls `/api/backend/show` and sets footer text. If the daemon is unavailable or no backend is configured, the status is cleared. No hard dependency on daemon being up.

5. **`resolveActiveProfileName` stale-marker fallback simplification.** When the project marker is stale, the function now only tries user-marker as fallback (not `projectConfig.backend` or `userConfig.backend`, since those fields no longer exist).

## Scope

### In Scope
- Remove `backend:` from config.yaml schema (hard break)
- Add `sanitizeProfileName(backend, provider?, modelId)` function in `packages/engine/src/config.ts`
- Add `parseRawConfigLegacy` function in `packages/engine/src/config.ts`
- Simplify `resolveActiveProfileName` to project-marker → user-marker → none
- Drop `'team'` and `'user-team'` from `ActiveProfileSource` and `BackendProfileSource`
- Bump `DAEMON_API_VERSION` from 2 to 3
- Rewrite `eforge_init` in MCP proxy to create backend profile + activate via marker
- Add `migrate: boolean` parameter to `eforge_init`
- Rewrite `eforge_init` in Pi extension with same logic (hardcoded `backend: 'pi'`)
- Add Pi footer status via `session_start` event + `refreshStatus`
- Update both init skill docs
- Bump plugin version in `eforge-plugin/.claude-plugin/plugin.json`
- Tests for schema rejection, sanitizer, resolver, and migrate flow

### Out of Scope
- Claude Code status-line integration
- Bumping `packages/pi-eforge/package.json` version
- Changes to `createBackendProfile` or `setActiveBackend` (reused as-is)

## Files

### Modify
- `packages/engine/src/config.ts` — (1) Remove `backend: backendSchema` from `eforgeConfigBaseSchema` or create a separate config-yaml-only schema that omits it; ensure profile parsing still accepts `backend:`. (2) Update `parseRawConfigFallback` (lines 470-475) to no longer handle top-level `backend:` for config.yaml context. (3) Add exported `sanitizeProfileName(backend: string, provider: string | undefined, modelId: string): string` function near `createBackendProfile` - lowercase, replace `.` with `-`, strip `claude-` prefix from model ID, construct `[backend[-provider]]-[sanitized]`, collapse repeated dashes. (4) Add exported `parseRawConfigLegacy(data: Record<string, unknown>): { profile: { backend, pi?, agents? }, remaining: Record<string, unknown> }` that tolerates the old format - extracts `backend:`, `pi:`, `agents.models`, `agents.model`, `agents.effort`, `agents.thinking` into the profile portion, leaves everything else in `remaining`. (5) Simplify `resolveActiveProfileName` (lines 778-837): delete step 2 (lines 817-821, `projectConfig.backend` fallback) and step 4 (lines 829-833, `userConfig.backend` fallback). In the stale-marker fallback block (lines 800-814), remove lines 801-803 (`teamName` fallback) and lines 810-812 (`userTeamName` fallback). Resolution becomes: project-marker → user-marker → none, with stale-marker falling through to user-marker only. (6) Update `ActiveProfileSource` type (line 690) to `'local' | 'user-local' | 'missing' | 'none'` - remove `'team'` and `'user-team'`.
- `packages/client/src/types.ts` — Update `BackendProfileSource` (line 205) to `'local' | 'user-local' | 'missing' | 'none'` - remove `'team'` and `'user-team'`.
- `packages/client/src/api-version.ts` — Bump `DAEMON_API_VERSION` from 2 to 3.
- `packages/eforge/src/cli/mcp-proxy.ts` — Rewrite `eforge_init` tool handler (lines 740-877). New parameter schema: `{ force?: boolean, postMergeCommands?: string[], migrate?: boolean }`. New behavior: (a) If `migrate: true`, require existing `config.yaml`, parse with `parseRawConfigLegacy`, derive profile name via `sanitizeProfileName`, call `createBackendProfile` with `overwrite: true`, call `setActiveBackend`, rewrite `config.yaml` with remaining fields only, return summary of what moved. (b) If not migrate: elicit backend kind via existing form (lines 773-815), then elicit provider (if pi, via `/api/models/providers`), then elicit max model (via `/api/models/list`), compute profile name via `sanitizeProfileName`, call `createBackendProfile` (agents: `{ models: { max, balanced: max, fast: max } }`), call `setActiveBackend`, write `config.yaml` with only non-backend fields (postMergeCommands etc.), never emit `backend:`. (c) Ensure `.gitignore` entries for `.eforge/` and `eforge/.active-backend`. (d) Return response with `{ status, configPath, profileName, profilePath, backend }`.
- `packages/pi-eforge/extensions/eforge/index.ts` — (1) Rewrite `eforge_init` tool handler (lines 711-821). Add `migrate` parameter. Backend is hardcoded to `'pi'`. For fresh init: elicit provider via `/api/models/providers` and max model via `/api/models/list` (use Pi's tool parameter prompt descriptions since Pi doesn't have elicitation forms - add `provider` and `maxModel` as optional string parameters, with descriptions guiding the skill to supply them). Compute profile name via `sanitizeProfileName`, call `createBackendProfile`, call `setActiveBackend`, write config.yaml without `backend:`. For migrate: same as MCP version. Ensure `.gitignore` entries include both `.eforge/` and `eforge/.active-backend` (currently only `.eforge/` at line 757). (2) Add Pi footer status: after the tool registrations and before the command aliases section, add a `session_start` event listener via `pi.on("session_start", async (_ev, ctx) => { await refreshStatus(ctx); })`. Implement `refreshStatus(ctx: ExtensionContext)`: call `daemonRequest(ctx.cwd, 'GET', '/api/backend/show')`, read `{ name, source, backend }` from response's `resolved` field, call `ctx.ui.setStatus("eforge", "eforge: <name> (<backend>)")`. On error or no backend: `ctx.ui.setStatus("eforge", undefined)`. Stash latest `ctx` in module-scope variable. After `eforge_backend` tool runs `action: "use"` or `action: "create"` (around lines 403-438), call `refreshStatus` with stashed ctx.
- `eforge-plugin/skills/init/init.md` — Replace line 8 ("Presents a form to select a backend and creates `eforge/config.yaml` with sensible defaults.") with "Presents a form to select a backend, provider, and model, then creates a named backend profile under `eforge/backends/` and activates it. Also writes `eforge/config.yaml` for team-wide settings (postMergeCommands, etc.)." Add Step 1.5 between postMergeCommands (Step 1) and "Call the tool" (Step 2): pick backend kind (claude-sdk or pi), pick provider (if pi - call `mcp__eforge__eforge_models` with `{ action: "providers", backend: "pi" }`), pick max model (call `mcp__eforge__eforge_models` with `{ action: "list", backend, provider }` - default to newest). Mirror the pattern from `backend-new.md:36-69`. Update Step 2 to pass `backend`, `provider`, and `maxModel` parameters. Add `--migrate` documentation: when the project already has a pre-overhaul `config.yaml` with `backend:`, invoke with `migrate: true` - extracts backend config into a named profile and strips config.yaml. Update Step 4 closing message to mention the created profile name and that `/eforge:backend` can switch profiles.
- `packages/pi-eforge/skills/eforge-init/SKILL.md` — Same wording changes as the Claude Code init skill. Replace line 9 description. Add Step 1.5 for backend/provider/model selection. Update Step 2 to pass new parameters. Add `--migrate` documentation. Update closing message to mention created profile name.
- `eforge-plugin/.claude-plugin/plugin.json` — Bump `version` from `0.5.28` to `0.5.29`.
- `test/config.test.ts` — Add test: `config.yaml` with top-level `backend:` field is rejected by the config-yaml-only schema with a validation error. Add test for `sanitizeProfileName`: verify lowercase, `.` → `-`, `claude-` prefix stripping, repeated-dash collapsing. Inputs/outputs: `('claude-sdk', undefined, 'claude-opus-4.7')` → `'claude-sdk-opus-4-7'`; `('pi', 'anthropic', 'claude-opus-4.7')` → `'pi-anthropic-opus-4-7'`; `('pi', 'zai', 'glm-4.6')` → `'pi-zai-glm-4-6'`.
- `test/config-backend-profile.test.ts` — (1) Remove or update test at line 92 ("marker absent + config.yaml backend: pi + backends/pi.yaml → profile applied with source=team") - this path no longer exists; the result must now be `{ name: null, source: 'none' }` since there's no marker. (2) Remove or update test at line 100 ("unknown profile name in marker logs warning and falls back") - the `projectConfig.backend` fallback is gone; stale marker should now try user-marker, then return `{ name: null, source: 'missing' }`. (3) Remove or update test at line 521 ("returns source=user-team when only user config backend: matches") - this source no longer exists. (4) Remove or update test at line 806 that asserts `source: 'team'`. (5) Remove or update test at line 790 that asserts `source: 'user-team'`. (6) Remove test at line 815 ("user-team source only used when profile file actually exists"). (7) Add test for `parseRawConfigLegacy`: input a pre-overhaul config with `backend: claude-sdk`, `agents: { models: { max: { id: 'claude-opus-4.7' } } }`, `build: { postMergeCommands: ['pnpm test'] }` - assert profile portion has `{ backend: 'claude-sdk', agents: { models: { max: { id: 'claude-opus-4.7' } } } }` and remaining has `{ build: { postMergeCommands: ['pnpm test'] } }` with no `backend`, `pi`, or `agents` keys.

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm test` passes - all existing tests (updated) and new tests green
- [ ] Parsing a config.yaml containing `backend: claude-sdk` through the config.yaml schema path produces a validation error
- [ ] Parsing a profile file containing `backend: claude-sdk` through the profile parsing path succeeds
- [ ] `sanitizeProfileName('claude-sdk', undefined, 'claude-opus-4.7')` returns `'claude-sdk-opus-4-7'`
- [ ] `sanitizeProfileName('pi', 'anthropic', 'claude-opus-4.7')` returns `'pi-anthropic-opus-4-7'`
- [ ] `sanitizeProfileName('pi', 'zai', 'glm-4.6')` returns `'pi-zai-glm-4-6'`
- [ ] `resolveActiveProfileName` with no marker and no user marker returns `{ name: null, source: 'none' }` regardless of `projectConfig.backend` value
- [ ] `resolveActiveProfileName` with project marker returns `{ name, source: 'local' }`
- [ ] `resolveActiveProfileName` with only user marker returns `{ name, source: 'user-local' }`
- [ ] `ActiveProfileSource` type in `config.ts` is `'local' | 'user-local' | 'missing' | 'none'`
- [ ] `BackendProfileSource` type in `client/types.ts` is `'local' | 'user-local' | 'missing' | 'none'`
- [ ] `DAEMON_API_VERSION` in `api-version.ts` is 3
- [ ] MCP `eforge_init` handler creates a file in `eforge/backends/` and writes `eforge/.active-backend`
- [ ] MCP `eforge_init` handler's written `config.yaml` contains no `backend:` field
- [ ] MCP `eforge_init` with `migrate: true` extracts backend config from existing config.yaml into a profile and strips config.yaml
- [ ] Pi `eforge_init` handler creates a profile and sets the marker, same as MCP version
- [ ] Pi extension registers a `session_start` listener that calls `ctx.ui.setStatus`
- [ ] Pi extension's `refreshStatus` clears status when daemon is unavailable (no throw)
- [ ] Init skill docs reference creating backend profiles, not writing `backend:` to config.yaml
- [ ] Init skill docs document the `--migrate` flag
- [ ] Plugin version in `plugin.json` is `0.5.29`
- [ ] No test asserts `source: 'team'` or `source: 'user-team'`