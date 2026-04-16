---
id: plan-01-engine-daemon
name: Engine backend profile loader, models adapter, daemon endpoints, client types
depends_on: []
branch: backend-profiles-arbitrary-named-profiles-smart-creator/engine-daemon
---

# Engine backend profile loader, models adapter, daemon endpoints, client types

## Architecture Context

Config is loaded fresh per-build via `loadConfig` inside every `EforgeEngine.create()` (the daemon holds no config), so any file-based switch takes effect on the next build with no daemon restart. Today `eforge/config.yaml` holds everything including `backend:` and backend-specific settings (`pi:`, `agents.model*`). The schema at `packages/engine/src/config.ts:179` uses `superRefine` to enforce that pi needs `provider` in model refs while claude-sdk forbids it — a single swap cascades into several dependent edits.

This plan introduces a third merge layer between project `config.yaml` and env-var resolution: an active backend profile loaded from `eforge/backends/<name>.yaml` with the active name supplied by a gitignored `eforge/.active-backend` marker or, as a team fallback, by `config.yaml`'s existing `backend:` field when a profile file with that name exists.

The pi backend already depends on `@mariozechner/pi-ai`'s `getModel` and `ModelRegistry` (see `packages/engine/src/backends/pi.ts:17` and `:271-288`). We reuse the same registry to surface available providers/models through a small engine-side adapter. The adapter is imported lazily so claude-sdk-only users do not pay for pi-ai at resolution time.

Daemon HTTP (`packages/monitor/src/server.ts`) exposes engine operations to MCP tools and the monitor UI. This plan adds backend-profile and model-listing endpoints, keeping the existing url-switch + `parseJsonBody` + `sendJson` pattern. New request/response shapes go into `@eforge-build/client` and the `DAEMON_API_VERSION` is bumped per project convention (`AGENTS.md`).

Tests for the engine changes live alongside this plan (vitest, `test/`), matching the style of `test/config.test.ts`.

## Implementation

### Overview

1. Extend the engine config layer with helpers to enumerate, load, activate, create, and delete named backend profiles under `eforge/backends/*.yaml`, plus marker-file resolution.
2. Thread an active-profile merge layer through `loadConfig`.
3. Add a tiny `models.ts` adapter over pi-ai's `ModelRegistry` / `getModel`.
4. Wire six new daemon endpoints covering backend profile lifecycle and model listing.
5. Export request/response types from `@eforge-build/client` and bump `DAEMON_API_VERSION`.
6. Land unit tests for profile resolution, mutation helpers, and model listing.

### Key Decisions

1. **Reuse `parseRawConfig` / `mergePartialConfigs`.** Profile files use the same partial-config schema as `config.yaml` — no separate schema. Validation of a created/activated profile runs the merged result through `eforgeConfigSchema` (with `superRefine`) so invalid combinations (e.g., pi + model ref without `provider`) are rejected at write/activate time.
2. **Marker overrides team default.** Resolution precedence: `eforge/.active-backend` (dev-local) beats `config.yaml` `backend:` + matching `backends/<that>.yaml` (team default) beats legacy (no profile layer).
3. **Unknown profile name degrades gracefully.** If the marker points at a missing profile, log a stderr warning once and fall back to the team default (or legacy). This keeps `loadConfig` total even when the marker is stale.
4. **Lazy pi-ai import in `models.ts`.** Use `await import('@mariozechner/pi-ai')` and `await import('@mariozechner/pi-agent-core')` inside the helpers so claude-sdk-only users do not pull the pi runtime unless they call a model-listing endpoint.
5. **`claude-sdk` provider surface.** `listProviders('claude-sdk')` returns `[]` (providers are implicit). `listModels('claude-sdk')` reuses pi-ai's `anthropic` provider entries filtered to Claude models — same model ids the Claude SDK backend accepts. No live Anthropic `/v1/models` fetch in MVP.
6. **`DAEMON_API_VERSION` bump is additive.** New endpoints only — no removals or shape changes to existing responses. Per `AGENTS.md`, bump the version because the surface changes.
7. **Profile file writes serialize via `yaml.stringify`.** Keep output deterministic; omit undefined sections. Parse-then-validate after write so the on-disk file is guaranteed to round-trip through `parseRawConfig` + `eforgeConfigSchema`.

## Scope

### In Scope
- Engine: `resolveActiveProfileName`, `loadBackendProfile`, `listBackendProfiles`, `setActiveBackend`, `createBackendProfile`, `deleteBackendProfile`, and integration of the profile merge layer into `loadConfig`.
- Engine: new `models.ts` adapter with `listProviders(backend)` and `listModels(backend, provider?)`.
- Daemon: six new HTTP endpoints (list, show, use, create, delete, models providers, models list).
- Client: new request/response types; `DAEMON_API_VERSION` bumped from 1 to 2.
- Tests: `test/config-backend-profile.test.ts` and `test/models-listing.test.ts`.

### Out of Scope
- MCP tool registration (handled in plan-02).
- Skills (handled in plan-02).
- Pi extension wiring (handled in plan-02).
- `.gitignore` and `plugin.json` updates (handled in plan-02).
- Init skill changes (handled in plan-02).
- Live Anthropic `/v1/models` polish.
- Monitor UI changes.
- Any mutation of `eforge/config.yaml` content (only the schema-level role of `backend:` as fallback is respected).

## Files

### Create
- `packages/engine/src/models.ts` — thin adapter over pi-ai's `ModelRegistry` / `getModel`. Exports `listProviders(backend: 'claude-sdk' | 'pi'): Promise<string[]>` and `listModels(backend, provider?): Promise<Array<{ id: string; provider?: string; contextWindow?: number; releasedAt?: string; deprecated?: boolean }>>`. Uses lazy `await import()` for pi-ai and pi-agent-core AuthStorage. Sorts models newest-first when release metadata is present; otherwise falls back to registry order.
- `test/config-backend-profile.test.ts` — vitest suite covering the acceptance cases listed under Verification below.
- `test/models-listing.test.ts` — vitest suite covering `listProviders('pi')` non-empty and `listModels('pi', 'anthropic')` returning at least one entry with stable `{ id, provider }` shape.

### Modify
- `packages/engine/src/config.ts` —
  - Add `resolveActiveProfileName(configDir: string, projectConfig: PartialEforgeConfig): Promise<{ name: string | null; source: 'local' | 'team' | 'missing' | 'none' }>`. Reads `eforge/.active-backend` (trimmed) when present; else uses `projectConfig.backend` when `backends/<that>.yaml` exists; else returns `{ name: null, source: 'none' }`. Missing file referenced by marker returns `source: 'missing'` and logs a one-shot warning.
  - Add `loadBackendProfile(configDir: string, name: string): Promise<PartialEforgeConfig | null>` — reads `backends/<name>.yaml`, parses via `parseRawConfig`, returns null when missing.
  - Add `listBackendProfiles(configDir: string): Promise<Array<{ name: string; backend: 'claude-sdk' | 'pi' | undefined; path: string }>>` — scans the dir, parses each file just enough to extract `backend`, ignores non-YAML and unreadable entries.
  - Add `setActiveBackend(configDir: string, name: string): Promise<void>` — validates `backends/<name>.yaml` exists, validates the merged result (global + project + profile) through `eforgeConfigSchema`, then writes `eforge/.active-backend` atomically (tmp file + rename) with a single trimmed line.
  - Add `createBackendProfile(configDir: string, input: { name: string; backend: 'claude-sdk' | 'pi'; pi?: PartialEforgeConfig['pi']; agents?: PartialEforgeConfig['agents']; overwrite?: boolean }): Promise<{ path: string }>` — constructs a partial-config object, runs it through `partialEforgeConfigSchema` and the merged `eforgeConfigSchema`, serializes via `yaml.stringify`, refuses when the target exists without `overwrite: true`.
  - Add `deleteBackendProfile(configDir: string, name: string, force?: boolean): Promise<void>` — errors when the profile is currently active unless `force: true`; when `force` is used, also removes the marker if it pointed at the deleted profile.
  - Extend `loadConfig` to discover the config directory (`dirname(configPath)`), call `resolveActiveProfileName`, load the profile when present, and splice it between the project and env merge steps via `mergePartialConfigs` (merge order: global -> project -> profile).
  - Export a small `getConfigDir(cwd?): Promise<string | null>` helper if one does not already exist implicitly from `findConfigFile`, so daemon handlers can locate the dir without re-walking.
  - No schema additions — `backend:` on `config.yaml` keeps its existing role as the team-default fallback. `stripUndefinedSections` does not need changes because profile files use existing sections only.
- `packages/monitor/src/server.ts` —
  - `GET /api/backend/list` -> `{ profiles: Array<{ name: string; backend: 'claude-sdk' | 'pi' | undefined; path: string }>; active: string | null; source: 'local' | 'team' | 'missing' | 'none' }`.
  - `GET /api/backend/show` -> `{ active: string | null; source: ...; resolved: { backend: 'claude-sdk' | 'pi' | undefined; profile: PartialEforgeConfig | null } }`.
  - `POST /api/backend/use` with body `{ name: string }` -> `{ active: string }` on success; 400 with `{ error }` on validation failure; 404 when the profile is missing.
  - `POST /api/backend/create` with body `{ name, backend, pi?, agents?, overwrite? }` -> `{ path: string }`; 400 on schema failure; 409 when the file exists without `overwrite`.
  - `DELETE /api/backend/:name` reading `{ force?: boolean }` from body -> `{ deleted: string }`; 409 when active without `force`.
  - `GET /api/models/providers?backend=pi|claude-sdk` -> `{ providers: string[] }`.
  - `GET /api/models/list?backend=pi|claude-sdk&provider=<optional>` -> `{ models: Array<{ id; provider?; contextWindow?; releasedAt?; deprecated? }> }`.
  - All handlers call the engine helpers above; shapes mirror `packages/client/src/types.ts`. Follow the existing `parseJsonBody` + `sendJson` pattern; add branches in the URL switch.
- `packages/client/src/types.ts` — add `BackendProfileInfo`, `BackendListResponse`, `BackendShowResponse`, `BackendUseRequest`, `BackendUseResponse`, `BackendCreateRequest`, `BackendCreateResponse`, `BackendDeleteRequest`, `BackendDeleteResponse`, `ModelProvidersResponse`, `ModelInfo`, `ModelListResponse`. Re-exported from the package root.
- `packages/client/src/api-version.ts` — `export const DAEMON_API_VERSION = 2;`.
- `packages/engine/src/eforge.ts` (only if `loadConfig` integration needs a surface adjustment — otherwise untouched). Verify that `EforgeEngine.create()` still receives an `EforgeConfig` and that no downstream consumer needs to know the active profile name directly.

## Verification

- [ ] `pnpm test -- config-backend-profile` passes with these cases: marker present overrides `config.yaml` `backend:`; marker absent + `config.yaml` `backend: pi` + `backends/pi.yaml` -> profile applied with `source: 'team'`; unknown profile name in marker -> warning logged (captured via `vi.spyOn(console, 'error')`) and fallback applied; `setActiveBackend` rejects when the target profile file is missing; `createBackendProfile` rejects a `backend: pi` profile whose `agents.model` lacks `provider`; `createBackendProfile` refuses overwrite without `overwrite: true`; `createBackendProfile` with `overwrite: true` replaces the file; `deleteBackendProfile` refuses to delete the active profile without `force: true`; `deleteBackendProfile(..., true)` removes the file and clears the marker; project with no `backends/` dir produces the same resolved config as before the change.
- [ ] `pnpm test -- models-listing` passes: `listProviders('pi')` returns a non-empty array containing `'anthropic'`; `listProviders('claude-sdk')` returns `[]`; `listModels('pi', 'anthropic')` returns at least one entry with `typeof entry.id === 'string'` and `entry.provider === 'anthropic'`.
- [ ] `pnpm type-check` succeeds across all packages (engine, monitor, client).
- [ ] `pnpm build` succeeds — engine, monitor, monitor-ui, client bundles compile.
- [ ] A direct HTTP smoke test via `curl` against a running daemon hits `GET /api/backend/list` and `GET /api/models/providers?backend=pi` with 200 JSON responses shaped as declared in client types. (Documented in the plan-02 verification; this plan only requires the endpoints to be reachable.)
- [ ] `DAEMON_API_VERSION` is 2 and `packages/client/src/types.ts` exports every new type listed under Files > Modify.
