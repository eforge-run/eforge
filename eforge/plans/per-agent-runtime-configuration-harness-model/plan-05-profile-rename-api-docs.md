---
id: plan-05-profile-rename-api-docs
name: Profile Rename + MCP/Slash/HTTP Surface + Docs
depends_on:
  - plan-04-legacy-removal-events
branch: per-agent-runtime-configuration-harness-model/profile-rename-api-docs
agents:
  builder:
    effort: high
    rationale: Rename spans Claude Code plugin + Pi extension + daemon HTTP + shared
      client package + monitor UI; skill-parity check must pass across plugin
      and Pi; DAEMON_API_VERSION bump is a breaking HTTP contract change.
  reviewer:
    effort: high
    rationale: Cross-surface rename; reviewer must verify parity between
      eforge-plugin/skills and packages/pi-eforge per AGENTS.md, correctness of
      DAEMON_API_VERSION bump, plugin version bump, and that auto-migration of
      eforge/backends/*.yaml -> eforge/profiles/ is safe.
  doc-updater:
    effort: medium
    rationale: README, AGENTS.md, and plugin READMEs need coordinated copy updates
      for the new terminology; CHANGELOG.md is release-flow-owned and must NOT
      be edited (per memory).
---

# Profile Rename + MCP/Slash/HTTP Surface + Docs

## Architecture Context

This is steps 8-9 of the PRD's 9-step ordered implementation. With the engine, events, and monitor UI now on the new harness/runtime model (plans 01-04), this plan renames the **profile** system — the marker-file system for swapping config fragments — from "backend" terminology to "profile" terminology. This is the last place the word "backend" still exists in the user-facing surface. It also bumps the plugin version and the daemon HTTP API version (both are breaking-surface changes).

Reference:
- `packages/engine/src/config.ts` — `listBackendProfiles`, `loadBackendProfile`, `setActiveBackend` at ~L748-1073; directory `eforge/backends/`; marker `.active-backend`.
- `packages/pi-eforge/extensions/eforge/index.ts` — `eforge_backend` MCP tool at ~L598.
- `packages/eforge/src/cli/mcp-proxy.ts` — `eforge_backend` MCP tool at ~L415.
- `eforge-plugin/skills/backend/` + `eforge-plugin/skills/backend-new/` — slash command skill dirs (confirmed by directory listing).
- `packages/monitor/src/server.ts` — `/backends` and `/backends/active` routes at ~L910-930.
- `packages/client/src/api-version.ts` — `DAEMON_API_VERSION = 5`.
- `packages/client/src/api/*.ts` — typed helpers including `backend.ts`.
- `eforge-plugin/.claude-plugin/plugin.json` — version `0.7.1`, plugin-registered skills list.
- `packages/pi-eforge/` skill set — must stay in sync with `eforge-plugin/skills/` per AGENTS.md; `scripts/check-skill-parity.mjs` runs as part of `pnpm test`.
- Memory: CHANGELOG managed by release flow — do NOT edit `CHANGELOG.md`.
- Memory: Use shadcn/ui components in monitor UI.

## Implementation

### Overview

Rename the profile system end-to-end: directory, marker file, loader function names, MCP tool name, slash command skill directories, HTTP routes, and typed API client helpers. Auto-migrate existing `eforge/backends/*.yaml` to `eforge/profiles/` on first load so users' on-disk state keeps working. Bump `DAEMON_API_VERSION` (breaking HTTP surface). Bump plugin version to `0.8.0`. Update README, AGENTS.md, plugin READMEs — but NOT `CHANGELOG.md`.

### Key Decisions

1. **Auto-migrate `eforge/backends/*.yaml` → `eforge/profiles/`.** Per PRD implementation order, auto-move on first load with a log message announcing the move. If `eforge/profiles/` already exists with content, warn and leave `eforge/backends/` untouched (human resolves). The marker file `.active-backend` is renamed to `.active-profile` inside the migration.
2. **MCP tool name contract is a breaking change.** Any on-the-fly clients calling `eforge_backend` break; this is a breaking release per the PRD.
3. **Keep plugin and Pi extension in parity.** `scripts/check-skill-parity.mjs` runs in `pnpm test`. Every rename on `eforge-plugin/skills/` has a matching rename in `packages/pi-eforge/`.
4. **`DAEMON_API_VERSION` bump.** `/backends` → `/profiles` and `/backends/active` → `/profiles/active` are breaking route renames; bump from `5` to `6`. Register via `API_ROUTES` in `packages/client/src/api-version.ts` so renames surface as type errors rather than silent drift (per AGENTS.md).
5. **Typed client helper rename.** `packages/client/src/api/backend.ts` → `packages/client/src/api/profile.ts`; `apiBackends` etc. renamed to `apiProfiles`. Monitor UI `packages/monitor-ui/src/lib/api.ts` calls get updated.
6. **Plugin version bump to `0.8.0`** per PRD. Pi package version untouched (per AGENTS.md).
7. **CHANGELOG.md not edited.** Per memory, release flow owns it.

## Scope

### In Scope
- Directory rename `eforge/backends/` → `eforge/profiles/` (config loader default path).
- Marker file rename `.active-backend` → `.active-profile`.
- Loader function renames in `packages/engine/src/config.ts`:
  - `loadBackendProfile` → `loadProfile`
  - `setActiveBackend` → `setActiveProfile`
  - `listBackendProfiles` → `listProfiles`
  - Plus any supporting helpers (e.g. reading the marker file).
- Auto-migrate on first load: if `eforge/backends/` exists and `eforge/profiles/` does not, move the directory and rename the marker file; log the action. If both exist, warn and leave untouched.
- Profile files themselves now define `agentRuntimes:` + optional `defaultAgentRuntime` / `agents:` overrides (the schema is already live from plan-01; no schema changes here, just user-facing doc updates).
- MCP tool rename: `eforge_backend` → `eforge_profile` in BOTH:
  - `packages/pi-eforge/extensions/eforge/index.ts`
  - `packages/eforge/src/cli/mcp-proxy.ts`
- Slash command skill rename in `eforge-plugin/skills/`:
  - `backend/` → `profile/` (and rename the command from `/eforge:backend` to `/eforge:profile`)
  - `backend-new/` → `profile-new/` (command `/eforge:profile-new`; scaffolds a profile file with `agentRuntimes:` + `defaultAgentRuntime`)
- Register the renamed skills in `eforge-plugin/.claude-plugin/plugin.json` (replace `eforge-backend` and `eforge-backend-new` entries with `eforge-profile` and `eforge-profile-new`).
- Same skill set in `packages/pi-eforge/` — rename dirs + update Pi extension registration so `pnpm test` skill-parity check passes.
- HTTP route rename in `packages/monitor/src/server.ts`: `/backends` → `/profiles`, `/backends/active` → `/profiles/active`. Dispatch via `API_ROUTES` (per AGENTS.md daemon-dispatch rule).
- `packages/client/src/api-version.ts`: rename `API_ROUTES.backends` / `.backendsActive` to `.profiles` / `.profilesActive`; bump `DAEMON_API_VERSION` from `5` to `6`.
- Rename `packages/client/src/api/backend.ts` → `packages/client/src/api/profile.ts`; rename exported helpers (`apiBackends`, `apiActiveBackend`, `apiSetActiveBackend`, etc.) to `apiProfiles`, `apiActiveProfile`, `apiSetActiveProfile`. Update index exports.
- Update all callers: `packages/monitor-ui/src/lib/api.ts`, any CLI code using the client, etc.
- Bump `eforge-plugin/.claude-plugin/plugin.json` version from `0.7.1` to `0.8.0`.
- Update `eforge-plugin/skills/init/init.md` and `packages/pi-eforge/skills/eforge-init/SKILL.md` so the init skill scaffolds configs using the new `agentRuntimes:` + `defaultAgentRuntime:` shape (not scalar `backend:`), writes profile files to `eforge/profiles/` (not `eforge/backends/`), manages the `eforge/.active-profile` marker (not `.active-backend`), and the success-message copy references `/eforge:profile` and `/eforge:profile-new` (not `/eforge:backend` / `/eforge:backend:new`). This satisfies the PRD acceptance criterion "`eforge init` scaffolds a config using `agentRuntimes:`".
- Sweep all remaining skill files under `eforge-plugin/skills/` and `packages/pi-eforge/skills/` for stale "backend" / `/eforge:backend` references (e.g. `config/config.md` has ~18 occurrences); rewrite to the new terminology. Keep the two skill sets in parity.
- Documentation updates (per PRD step 9): `README.md`, `AGENTS.md`, `packages/pi-eforge/README.md`, `eforge-plugin/README.md` (if present). Update terminology: "backend" (when meaning runtime/profile) → "harness"/"agentRuntime"/"profile" per context. Update code examples to use `agentRuntimes:` config shape.

### Out of Scope
- `CHANGELOG.md` — release-flow-owned per memory.
- `packages/pi-eforge/package.json` version — untouched per AGENTS.md.
- Eval harness updates (`--backend` → `--profile`, `eval/eforge/backends/` → `eval/eforge/profiles/`, `backend-envs.yaml` → `profile-envs.yaml`, `result.json`) — tracked in separate follow-on PRD per the source (`tmp/eval-harness-per-agent-config.md`).
- `eforge init --migrate` helper — PRD defers this; rejection-message path from plan-04 covers config migration.

## Files

### Create
- `packages/client/src/api/profile.ts` — created via `git mv` from `backend.ts`; rename exports inside.
- `eforge-plugin/skills/profile/SKILL.md` + assets — via `git mv` from `eforge-plugin/skills/backend/`.
- `eforge-plugin/skills/profile-new/SKILL.md` + assets — via `git mv` from `eforge-plugin/skills/backend-new/`.
- Equivalent renames inside `packages/pi-eforge/` skill dir structure.
- `packages/engine/test/config.profile-migration.test.ts` — auto-migration of `eforge/backends/` → `eforge/profiles/` (happy path + collision-warning path).
- `packages/monitor/test/profile-routes.test.ts` or an integration-level test asserting the new routes answer and the old routes 404.

### Modify
- `packages/engine/src/config.ts` — rename loader functions; update default directory path; rename marker-file constant; add auto-migration logic.
- `packages/pi-eforge/extensions/eforge/index.ts` — rename `eforge_backend` tool registration to `eforge_profile`; update tool description copy.
- `packages/eforge/src/cli/mcp-proxy.ts` — same rename on the proxy side.
- `eforge-plugin/.claude-plugin/plugin.json` — bump version to `0.8.0`; replace skill registrations.
- `eforge-plugin/skills/profile/SKILL.md` + `profile-new/SKILL.md` — update command names, copy, examples to use `agentRuntimes:` / `defaultAgentRuntime:`.
- `packages/pi-eforge/` — matching skill content updates.
- `packages/monitor/src/server.ts` — route rename via `API_ROUTES`.
- `packages/client/src/api-version.ts` — bump `DAEMON_API_VERSION` to `6`; rename keys inside `API_ROUTES`.
- `packages/client/src/api/index.ts` (or barrel) — export `apiProfiles` etc. in place of `apiBackends`.
- `packages/client/src/api/profile.ts` — exported helper renames.
- `packages/monitor-ui/src/lib/api.ts` — update `fetch` call sites to use `API_ROUTES.profiles` / `.profilesActive`.
- `packages/monitor-ui/src/**/*.tsx` — any UI copy referring to "backend" in the profile-picker sense now says "profile" (UI components stay shadcn/ui per memory).
- Any CLI code that imported `apiBackends` — updated imports + call sites.
- `README.md`, `AGENTS.md`, `packages/pi-eforge/README.md`, `eforge-plugin/README.md` — terminology and example updates.
- `scripts/check-skill-parity.mjs` — no change needed if it reads both dirs dynamically; verify it still passes. If skill name lists are hard-coded, update them to the renamed set.

## Verification

- [ ] `pnpm type-check` passes (no stale `apiBackends` references anywhere).
- [ ] `pnpm test` passes — includes `scripts/check-skill-parity.mjs` verifying plugin + Pi skill sets match the renamed list.
- [ ] `pnpm build` succeeds.
- [ ] Given a workspace with `eforge/backends/default.yaml` and `eforge/backends/.active-backend`, first load moves both to `eforge/profiles/default.yaml` and `eforge/profiles/.active-profile`; a log line names the migration.
- [ ] Given a workspace with both `eforge/backends/` and `eforge/profiles/` present, first load leaves both intact and emits a warning naming both paths.
- [ ] `curl http://localhost:<port>/profiles` returns the profile list (integration test) and `/backends` returns 404.
- [ ] `DAEMON_API_VERSION` in `packages/client/src/api-version.ts` equals `6`.
- [ ] `eforge-plugin/.claude-plugin/plugin.json` has `"version": "0.8.0"` and lists skills `eforge-profile` + `eforge-profile-new`; does NOT list `eforge-backend` / `eforge-backend-new`.
- [ ] `packages/pi-eforge/package.json` version is unchanged from its state at the start of this plan.
- [ ] `CHANGELOG.md` diff vs. `HEAD~` for this plan is empty.
- [ ] `grep -R "eforge_backend\|\\bbackend-new\\b\\|listBackendProfiles\\|loadBackendProfile\\|setActiveBackend\\|apiBackends\\|/backends" packages/ eforge-plugin/ README.md AGENTS.md` returns zero matches (except possibly inside migration-path code in `config.ts` that references the old directory name to migrate FROM — that is acceptable).
- [ ] Running `/eforge:profile` in a plugin session lists profiles; `/eforge:profile-new <name>` scaffolds a file under `eforge/profiles/` whose template includes `agentRuntimes:` and `defaultAgentRuntime:` keys.
- [ ] Running `/eforge:init` scaffolds a `config.yaml` whose top-level keys include `agentRuntimes:` and `defaultAgentRuntime:` (and no scalar `backend:`), writes the selected profile to `eforge/profiles/<name>.yaml`, and manages the `.active-profile` marker (verified by invoking the init flow end-to-end or by snapshotting the templates referenced in `skills/init/init.md`).
- [ ] `grep -R "\\bbackend\\b\\|/eforge:backend" eforge-plugin/skills/ packages/pi-eforge/skills/` returns zero matches (the rename/rewrite of skill copy is complete).
- [ ] Monitor UI profile picker (if present) labels profiles as "Profiles" not "Backends".
- [ ] `pnpm -r type-check && pnpm test && pnpm build` succeed when run from the repo root as a final end-to-end gate.
