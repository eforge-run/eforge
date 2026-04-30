---
id: plan-01-three-tier-config
name: Add project-local config tier (.eforge/) to eforge
branch: add-project-local-config-tier-to-eforge/three-tier-config
agents:
  builder:
    effort: high
    rationale: Three-tier extension touches packages/engine/src/config.ts plus a
      coupled ActiveProfileSource rename across engine, client, monitor,
      monitor-ui, CLI/MCP. Type rename must stay coherent across packages or
      type-check breaks.
  reviewer:
    effort: high
    rationale: Cross-package rename + new precedence semantics + shadow rules —
      needs careful review for symmetry between project/user/local code paths
      and consistent labelling.
---

# Add project-local config tier (.eforge/) to eforge

## Architecture Context

eforge currently supports two config tiers:

- **user** — `~/.config/eforge/` (cross-project, personal)
- **project** — `eforge/` (committed, team-canonical)

This plan adds a third tier — **project-local**, in `.eforge/` (gitignored, repo-relative, dev-personal) — at the highest precedence. The `.eforge/` directory already exists as a runtime-state location (`monitor.db`, `state.json`, `queue-locks/`, session logs) and is already covered by `.gitignore` via `/eforge:init`'s `ensureGitignoreEntries`. Adding `config.yaml`, `profiles/`, and `.active-profile` siblings inside it does not collide with anything.

All work extends existing functions in `packages/engine/src/config.ts` (1791 lines). No new module is introduced. The PRD's proposed `ConfigResolver` typed interface is explicitly out of scope.

### Internal naming rename

The existing `ActiveProfileSource` enum confusingly uses `'local'` to mean the *project-team* marker (`eforge/.active-profile`). To free up `'local'` for the new project-local tier, this plan performs the rename:

| Tier | Path | Internal label (after) |
|---|---|---|
| User | `~/.config/eforge/` | `user` |
| Project (existing) | `eforge/` | `project` (was `local`) |
| Project-local (new) | `.eforge/` | `local` |

Final `ActiveProfileSource` values: `'local' | 'project' | 'user-local' | 'missing' | 'none'` with precedence `local` → `project` → `user-local` → `none`.

The equivalent type in `packages/client/src/types.ts` (`AgentRuntimeProfileSource`), in `packages/engine/src/eforge.ts` (inline), in `packages/engine/src/events.ts` (`session:profile` event), and in `packages/monitor-ui/src/lib/types.ts` is widened the same way. The `scope` field on profile entries widens from `'project' | 'user'` to `'local' | 'project' | 'user'`.

## Implementation

### Overview

1. **Add path helpers in `packages/engine/src/config.ts`** that mirror the existing user-tier helpers (around line 983) but take `cwd` (project root) since `.eforge/` is repo-relative:
   - `LOCAL_CONFIG_SUBDIR = '.eforge'`
   - `localEforgeConfigDir(cwd)` → `<cwd>/.eforge`
   - `localProfilesDir(cwd)` → `<cwd>/.eforge/profiles`
   - `localProfilePath(cwd, name)` → `<cwd>/.eforge/profiles/<name>.yaml`
   - `localMarkerPath(cwd)` → `<cwd>/.eforge/.active-profile`
   - `localConfigPath(cwd)` → `<cwd>/.eforge/config.yaml`

2. **Extend `loadConfig()` (line 865)** to read `.eforge/config.yaml` and merge it after project. Sequence: user → project → local. Implement as `mergePartialConfigs(mergePartialConfigs(user, project), local)` — compose the existing two-arg function rather than widening its signature. Missing local config is silent (ENOENT swallowed, mirroring `loadUserConfig`).

3. **Extend `loadProfile()` (line 1270)** to check `.eforge/profiles/<name>.yaml` first, then existing project + user lookups. Return type widens from `{ profile, scope: 'project' | 'user' } | null` to `{ profile, scope: 'local' | 'project' | 'user' } | null`.

4. **Extend `listProfiles()` (line 1335)** to scan `.eforge/profiles/` (when `cwd`/`configDir` is available) plus project + user. Three-way shadow rule: `local` shadows `project` and `user`; `project` shadows `user`. Each entry reports `scope: 'local' | 'project' | 'user'` and `shadowedBy?: 'local' | 'project'`. Update `ScannedProfileEntry` and the `scanProfilesDir` scope parameter accordingly. Add a `scanProfilesDir(localProfilesDir(cwd), 'local')` call before the existing project + user scans.

5. **Extend `resolveActiveProfileName()` (line 1208)** to read `.eforge/.active-profile` first, then existing project marker, then user marker. Update its existing call site in `loadConfig` so it has access to `cwd` (or pass `cwd` alongside `configDir` — this function previously used `configDir` derived from the project config file location; the local marker is `cwd`-relative). Three-step precedence: local → project → user-local → none. Stale-marker warnings at each step fall through to the next source.

6. **Update `profileExistsInAnyScope()` (line 1004)** to also check `localProfilePath(cwd, name)` so stale-marker validation covers the new tier.

7. **Rename internal `ActiveProfileSource` literal**: every existing return of `source: 'local'` for the project marker becomes `source: 'project'`. Then add the new `source: 'local'` return for the new project-local marker. Update the type definition on line 962 and JSDoc on lines 953-961 to describe the new four-valued source set.

8. **Extend `setActiveProfile()` (line 1412)** to accept `scope: 'local' | 'project' | 'user'` (default still `'project'`). When `scope === 'local'`, write `.eforge/.active-profile` via `localMarkerPath(cwd)` (the function takes `configDir`; pass `cwd` separately or derive `cwd` as the parent of `configDir`).

9. **Extend `createAgentRuntimeProfile()` (line 1495)** and **`deleteAgentRuntimeProfile()` (line 1674)** to accept `scope: 'local' | 'project' | 'user'`. When `scope === 'local'`, target `localProfilesDir(cwd)`/`localProfilePath(cwd, name)` and the local marker for active-status checks. Update both branches of the `CreateProfileInput` discriminated union.

10. **Update consumers of `ActiveProfileSource` and the profile `scope` field**:
    - `packages/engine/src/eforge.ts` (lines 145, 147, plus `session:profile` event payloads on lines 233, 483, 1395, 1652, 1854, 2080) — widen the inline source type and the `scope` field. The private `configProfile` field's `scope` becomes `'local' | 'project' | 'user' | null`.
    - `packages/engine/src/events.ts` (line 150) — widen the `session:profile` event's `source` and `scope` types identically.
    - `packages/eforge/src/cli/index.ts` (lines 297, 458 — `loadConfig` callers) — verify nothing pattern-matches on `profile.source`/`profile.scope`. If they do, extend the match arms to handle `'local'`.
    - `packages/client/src/types.ts` — widen `AgentRuntimeProfileSource` (line 207) and `AgentRuntimeProfileInfo.scope` (line 202) and `AgentRuntimeProfileInfo.shadowedBy` (line 203). Same widening for any profile-related response types in this file (`ProfileListResponse`, `ProfileShowResponse`, etc.).
    - `packages/monitor/src/server.ts` — the `/api/profile/list` and `/api/profile/show` handlers (lines 1085-1174) parse the `scope` query param and filter; extend the validated literal set to include `'local'`. The `/api/profile/use`, `/api/profile/create`, and `/api/profile/delete` handlers (lines 1176-1326) read `body.scope` and validate against `'project' | 'user'`; extend to `'local' | 'project' | 'user'`. Pass `cwd` (already on `options.cwd`) so the engine can address `.eforge/`.
    - `packages/monitor-ui/src/lib/types.ts` (lines 65-66) — widen `source` and `scope` on `SessionProfile`.
    - `packages/monitor-ui/src/components/profile/profile-badge.tsx` (line 14, `sourceScopeBadgeText`) — render a label for the new `'local'` source/scope (e.g. "local" / "project-local").
    - `packages/monitor-ui/src/lib/reducer.ts` (line 295, `state.profile = { ... source: event.source, scope: event.scope ... }`) — no logic change, but verify the event-derived types flow correctly after widening.

11. **Extend `eforge_profile` MCP tool (`packages/eforge/src/cli/mcp-proxy.ts` lines 416-478)**: extend the `scope` enum from `['project', 'user', 'all']` to `['local', 'project', 'user', 'all']` for `list`, and from `['project', 'user']` to `['local', 'project', 'user']` for `use`/`create`/`delete`. Update the description string to document the new tier. The handler already forwards `scope` to the daemon — no body changes needed beyond the schema.

12. **Extend `eforge_config` MCP tool (`packages/eforge/src/cli/mcp-proxy.ts` lines 402-414)**: add an optional `verbose: boolean` parameter to the `show` action. When `verbose === true`, the handler queries a new daemon endpoint (or extends `/api/config/show` with a `?verbose=1` query) that returns per-tier file presence (`.eforge/config.yaml`, `eforge/config.yaml`, `~/.config/eforge/config.yaml` — found/absent for each) alongside the merged result. Implement the corresponding daemon-side logic in `packages/monitor/src/server.ts` (the existing `configShow` route at line 1371 currently calls `loadConfig` and serves the merged result; add a verbose branch that also probes the three tier paths and returns `{ resolved, sources: { local, project, user } }`).

13. **CLI labeling**: update `eforge config show` (`packages/eforge/src/cli/index.ts` line 458) and `eforge profile list` rendering to include source labels when `local` entries are present. Profile list output: `builder [local]  shadows project, user` style. Verify `renderProfileList` (or equivalent) handles the new scope; extend its switch/cases to include `'local'`.

14. **Verify `eforge_init` gitignore coverage**: confirm `ensureGitignoreEntries` in the `eforge_init` MCP tool definition (`packages/eforge/src/cli/mcp-proxy.ts` ~line 615) already covers `.eforge/`. No code change expected — only verification with a comment update if needed.

15. **Update skill markdown files (8 files)** with the new `local` scope, 6-step precedence chain, and Step 0 / Step 1.5 changes:
    - **Claude Code plugin** (`eforge-plugin/skills/`): `profile/profile.md`, `profile-new/profile-new.md`, `config/config.md`, `init/init.md`.
    - **Pi extension** (`packages/pi-eforge/skills/`): `eforge-profile/SKILL.md`, `eforge-profile-new/SKILL.md`, `eforge-config/SKILL.md`, `eforge-init/SKILL.md`.
    - Specific edits per the source PRD §4: `profile.md` precedence chain becomes 6 steps (local marker → project marker → project config → user marker → user config → none); `profile-new.md` Step 0 gains a `local` scope option; `config.md` notes that `.eforge/config.yaml` deep-merges over team and user; `init.md` Step 1.5 also surfaces local-scope profiles.
    - Both halves of each skill pair must stay byte-equivalent post-normalization (verified by `scripts/check-skill-parity.mjs`, which runs as part of `pnpm test`).

16. **Bump plugin version** in `eforge-plugin/.claude-plugin/plugin.json` from `0.16.1` to `0.17.0` per the AGENTS.md rule.

17. **Tests**:
    - `test/config-backend-profile.test.ts` — extend with cases:
      a. local-only profile resolves via `loadProfile` (`scope: 'local'`).
      b. local profile shadows same-named project profile (`loadProfile` returns the local one; `listProfiles` reports the project entry with `shadowedBy: 'local'`).
      c. local profile shadows same-named user profile when no project entry exists (`shadowedBy: 'local'` on the user entry).
      d. three-tier shadow chain: same name in all three tiers — `loadProfile` returns local; `listProfiles` reports project shadowed by local, user shadowed by local (or by project — define and assert the rule consistently).
      e. `.eforge/.active-profile` marker takes precedence over `eforge/.active-profile` (`resolveActiveProfileName` returns `source: 'local'`).
      f. `.eforge/.active-profile` stale marker (points at non-existent profile) falls through to `eforge/.active-profile` and emits one warning.
      g. missing `.eforge/` everywhere → behavior identical to existing two-tier tests (regression guard).
      h. Update existing tests that assert `source: 'local'` for the project-team marker (lines 94, 656, 693 of the test file) to assert `source: 'project'` instead.
    - `test/config.test.ts` — extend `mergePartialConfigs` chained-twice case for three-tier deep-merge: scalar override at leaf, object section merge across two layers, array replacement at the leaf.
    - No new test files; existing fixtures (`buildTestConfigDirs` or equivalent setup helpers in `test/`) are sufficient — extend them to support a `localDir` argument.

18. **Docs**:
    - `README.md` — add a brief section on the three config tiers and `.eforge/` (gitignored, project-local, highest precedence).
    - `AGENTS.md` — add a one-line note in the conventions section if the repo's own `.eforge/` becomes a developer-facing concern.

### Key Decisions

1. **Compose `mergePartialConfigs` twice rather than widen its signature.** This keeps the two-arg function unchanged, avoids ripple in any other call sites (e.g. `setActiveProfile` validation merge on line 1440), and makes the three-tier semantics explicit at the call site.

2. **Pass `cwd` (project root) through to all local-tier path helpers.** The `.eforge/` directory is repo-relative; deriving it from `configDir` (which points at `eforge/`) is fragile and breaks the no-`eforge/`-config case. Functions that previously took only `configDir` (`resolveActiveProfileName`, `loadProfile`, `listProfiles`, `setActiveProfile`, etc.) gain a `cwd` parameter or have one derived in their existing callers. `loadConfig` already accepts `cwd` — it just needs to thread it down.

3. **No backward-compat shim for the `ActiveProfileSource` rename.** Per repository memory feedback (`feedback_no_backward_compat`), the rename happens cleanly across all packages in this single plan. Type-check is the gate.

4. **`eforge_init` does not need to create `.eforge/`.** `.eforge/` is created lazily when daemon state is first written or when the user manually creates `.eforge/config.yaml`. The init skill only documents the new tier as an option.

5. **Plugin version bump rule applies (0.16.1 → 0.17.0).** This is a user-visible scope-enum extension in `eforge_profile`, so a minor bump is appropriate per AGENTS.md.

## Scope

### In Scope
- Path helpers and three-tier extensions in `packages/engine/src/config.ts` (`loadConfig`, `loadProfile`, `listProfiles`, `resolveActiveProfileName`, `setActiveProfile`, `createAgentRuntimeProfile`, `deleteAgentRuntimeProfile`, `profileExistsInAnyScope`, `scanProfilesDir`).
- `ActiveProfileSource` rename + the parallel rename of `AgentRuntimeProfileSource` in `packages/client/src/types.ts` and inline source unions in `packages/engine/src/eforge.ts`, `packages/engine/src/events.ts`, and `packages/monitor-ui/src/lib/types.ts`.
- `eforge_profile` MCP tool scope-enum extension to include `'local'`.
- `eforge_config` MCP tool optional `verbose` flag and supporting daemon route logic.
- CLI output labels for project-local sources in `eforge config show` and `eforge profile list`.
- Daemon route handlers in `packages/monitor/src/server.ts` extended to validate and forward `scope: 'local'`.
- Monitor UI badge rendering for the new `'local'` source.
- Test additions in `test/config-backend-profile.test.ts` and `test/config.test.ts` covering the seven new three-tier behaviors plus mergePartialConfigs three-tier deep-merge.
- Skill markdown updates in 8 files (4 plugin + 4 Pi) — scope value, 6-step precedence chain, Step 0 / Step 1.5 changes — verified by `scripts/check-skill-parity.mjs` (runs in `pnpm test`).
- Plugin version bump to 0.17.0.
- README and AGENTS doc touch-ups.

### Out of Scope
- The `ConfigResolver` typed interface from the original PRD. Existing functions stay; only their tier coverage expands.
- Environment-variable / CLI-flag overlay tier.
- Profile inheritance / partial overrides for set artifacts.
- New artifact types (playbooks).
- Encrypted / secrets-aware config.
- CHANGELOG edits (handled by release flow per repository memory).

## Files

### Modify
- `packages/engine/src/config.ts` — add `localEforgeConfigDir`/`localProfilesDir`/`localProfilePath`/`localMarkerPath`/`localConfigPath` helpers; extend `loadConfig`, `loadProfile`, `listProfiles`, `resolveActiveProfileName`, `setActiveProfile`, `createAgentRuntimeProfile`, `deleteAgentRuntimeProfile`, `profileExistsInAnyScope`, `scanProfilesDir`; rename `ActiveProfileSource` literal `'local'` → `'project'` and add new `'local'`.
- `packages/engine/src/eforge.ts` — widen inline source/scope types on `configProfile` private field (lines 145, 147) and on `session:profile` yields (lines 233, 483, 1395, 1652, 1854, 2080).
- `packages/engine/src/events.ts` — widen `session:profile` event source/scope types (line 150).
- `packages/eforge/src/cli/index.ts` — verify `loadConfig` callers (lines 297, 458) handle the renamed source values; extend `eforge config show` and `eforge profile list` rendering to label local-tier entries.
- `packages/eforge/src/cli/mcp-proxy.ts` — extend `eforge_profile` `scope` enum (line 430-432) to include `'local'`; add `verbose` flag to `eforge_config` `show` action (line 407); update tool descriptions accordingly. Verify `eforge_init` `ensureGitignoreEntries` (line ~615) covers `.eforge/`.
- `packages/client/src/types.ts` — widen `AgentRuntimeProfileSource` (line 207) and `AgentRuntimeProfileInfo.scope`/`shadowedBy` (lines 202-203).
- `packages/monitor/src/server.ts` — accept `scope: 'local'` on `/api/profile/list`, `/api/profile/use`, `/api/profile/create`, `/api/profile/delete` handlers (lines 1085-1326); add verbose branch to `/api/config/show` (line 1371) returning per-tier presence map.
- `packages/monitor-ui/src/lib/types.ts` — widen `source` and `scope` (lines 65-66).
- `packages/monitor-ui/src/components/profile/profile-badge.tsx` — extend `sourceScopeBadgeText` (line 14) to render the new `'local'` source/scope.
- `packages/monitor-ui/src/lib/reducer.ts` — verify event-derived types flow through correctly after widening (likely no logic change at line 295).
- `eforge-plugin/skills/profile/profile.md` — 6-step precedence chain; `local` scope value in `Scope` table; updated Source explanation.
- `eforge-plugin/skills/profile-new/profile-new.md` — Step 0 gains `local` scope option (gitignored, dev-personal).
- `eforge-plugin/skills/config/config.md` — note that `.eforge/config.yaml` deep-merges over team and user; document `verbose` flag.
- `eforge-plugin/skills/init/init.md` — Step 1.5 also surfaces local-scope profiles.
- `packages/pi-eforge/skills/eforge-profile/SKILL.md` — same edits as the plugin counterpart, kept byte-equivalent post-parity-normalization.
- `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` — same.
- `packages/pi-eforge/skills/eforge-config/SKILL.md` — same.
- `packages/pi-eforge/skills/eforge-init/SKILL.md` — same.
- `eforge-plugin/.claude-plugin/plugin.json` — version bump 0.16.1 → 0.17.0.
- `test/config-backend-profile.test.ts` — add 7 new three-tier cases; update 3 existing assertions that check `source: 'local'` for the project-team marker to expect `source: 'project'`.
- `test/config.test.ts` — add `mergePartialConfigs` chained-twice three-tier deep-merge test (scalar override at leaf, object section merge, array replacement at leaf).
- `README.md` — describe the three config tiers and when to use `.eforge/`.
- `AGENTS.md` — one-line note if the repo's `.eforge/` becomes developer-facing.

### Create
_None._ All work extends existing files per the source PRD constraint "No new module".

## Verification

- [ ] `pnpm type-check` passes across all packages — confirms `ActiveProfileSource` and `AgentRuntimeProfileSource` rename is consistent across engine, client, monitor, monitor-ui, and CLI/MCP.
- [ ] `pnpm test` passes, including `scripts/check-skill-parity.mjs` (runs first in the `test` script) — confirms all 4 plugin / 4 Pi skill pairs remain byte-equivalent post-normalization.
- [ ] New test `local-only profile resolves` in `test/config-backend-profile.test.ts` passes — `loadProfile(cwd, 'foo')` against a fixture with only `.eforge/profiles/foo.yaml` returns `{ profile, scope: 'local' }`.
- [ ] New test `local profile shadows project` passes — given both `.eforge/profiles/foo.yaml` and `eforge/profiles/foo.yaml`, `loadProfile` returns the local one and `listProfiles` includes the project entry with `shadowedBy: 'local'`.
- [ ] New test `local profile shadows user (no project)` passes — given `.eforge/profiles/foo.yaml` and `~/.config/eforge/profiles/foo.yaml` (no project entry), `loadProfile` returns the local one and `listProfiles` includes the user entry with `shadowedBy: 'local'`.
- [ ] New test `three-tier shadow chain` passes — same name in all three tiers; `listProfiles` output reports each shadow relation per the documented rule.
- [ ] New test `.eforge/.active-profile takes precedence over eforge/.active-profile` passes — `resolveActiveProfileName` returns `{ name, source: 'local' }`.
- [ ] New test `missing .eforge/ → behavior unchanged` passes — all existing two-tier behaviors hold when `.eforge/` is absent.
- [ ] New test `mergePartialConfigs chained-twice three-tier deep-merge` in `test/config.test.ts` passes — scalar override at leaf, object section merge across two layers, array replacement at leaf.
- [ ] Existing `config-backend-profile.test.ts` assertions on lines 94, 656, 693 updated from `source: 'local'` to `source: 'project'` and pass.
- [ ] Manual smoke: in a fixture project with `eforge/config.yaml`, add `.eforge/config.yaml` with one field; `eforge config show` deep-merge resolves with the local value winning; deleting `.eforge/config.yaml` reverts to two-tier behavior.
- [ ] Manual smoke: add `.eforge/profiles/builder.yaml` shadowing `eforge/profiles/builder.yaml`; `eforge profile list` shows `builder [local]  shadows project`.
- [ ] Manual smoke: `eforge_profile` MCP tool with `{ action: 'list', scope: 'local' }` returns only `.eforge/profiles/` entries; with `scope: 'all'` returns all three tiers.
- [ ] Bad `.eforge/config.yaml` fails fast via the existing zod schema with an error message naming the file.
- [ ] Missing `.eforge/config.yaml` and `.eforge/profiles/` are silent (no errors logged) on `loadConfig`.
- [ ] `eforge-plugin/.claude-plugin/plugin.json` `version` field is `0.17.0`.
- [ ] `git check-ignore .eforge/config.yaml` returns 0 in a fresh init (verifies `ensureGitignoreEntries` already covers `.eforge/`).
