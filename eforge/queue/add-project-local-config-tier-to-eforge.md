---
title: Add project-local config tier to eforge
created: 2026-04-30
---

# Add project-local config tier to eforge

## Problem / Motivation

Today eforge supports two config tiers:

- **user** — `~/.config/eforge/` (cross-project, personal)
- **project** — `eforge/` (committed, team-canonical)

There is no home for **personal-to-this-repo** config: a tweak to a team profile on your dev box, an in-progress draft, or personalized settings on an OSS repo where you can't commit. The PRD at `tmp/three-tier-config-resolver.md` proposes filling that gap with a third tier: `.eforge/` (gitignored, project-local), highest precedence.

**Important framing correction.** The PRD describes building a new `ConfigResolver` module. We already have one — `packages/engine/src/config.ts` (1791 lines) does two-tier merging and shadow-by-name today. The work is **extend the existing functions to a third tier**, not stand up a parallel module. The API-reshape into a typed `ConfigResolver` interface is deferred (it would be churn without a clear payoff once the third tier exists).

`.eforge/` already exists as a runtime-state directory (`monitor.db`, `state.json`, `queue-locks/`, session logs). Adding `config.yaml`, `profiles/`, and `.active-profile` siblings inside it does not collide with anything. `.eforge/` is already covered by `.gitignore` via `/eforge:init`.

## Goal

Add a third, highest-precedence config tier (`.eforge/`, gitignored, project-local) to eforge by extending the existing `packages/engine/src/config.ts` functions, so users can keep personal-to-this-repo config alongside the existing team and user tiers without standing up a parallel module or changing the public API surface.

## Approach

Add a third tier to `packages/engine/src/config.ts` by extending the existing functions. Each tier-aware function gains a project-local read alongside its current user + project reads, with project-local at top precedence. No new module, no public API surface change.

### Naming

The PRD's tier names are `user` / `project-team` / `project-local`. The codebase's existing `ActiveProfileSource` enum confusingly uses `'local'` to mean "project-team marker" (because the marker lives in the *local repo*). To avoid collision with the new tier, do an internal rename:

| Tier | Path | Internal label (after) |
|---|---|---|
| User | `~/.config/eforge/` | `user` |
| Project (existing) | `eforge/` | `project` (was `local`) |
| Project-local (new) | `.eforge/` | `local` |

MCP tool scope arg today is `['project', 'user', 'all']`; adding `'local'` is the natural extension. CLI output labels follow the same vocabulary.

The renamed `ActiveProfileSource` becomes: `'local' | 'project' | 'user-local' | 'missing' | 'none'` (precedence: `local` → `project` → `user-local` → `none`).

### Changes by area

#### 1. `packages/engine/src/config.ts` — core tier logic

**Add path helpers** (mirror existing user-tier helpers; sibling to `userEforgeConfigDir` etc. around line 983):

```ts
const LOCAL_CONFIG_SUBDIR = '.eforge';
function localEforgeConfigDir(cwd: string): string;
function localProfilesDir(cwd: string): string;
function localProfilePath(cwd: string, name: string): string;
function localMarkerPath(cwd: string): string;
function localConfigPath(cwd: string): string;
```

These take `cwd` (project root) since `.eforge/` is repo-relative, unlike user-tier helpers which take no args.

**`loadConfig()` (line 865)** — read `.eforge/config.yaml` and merge it after project-team. Sequence becomes: user → project → local. `mergePartialConfigs(globalConfig, projectConfig)` already handles two layers; either call it twice (`mergePartialConfigs(mergePartialConfigs(user, project), local)`) or extend it to take a third arg. Prefer calling twice — it composes the existing function without changing its shape.

**`loadProfile()` (line 1270)** — check `.eforge/profiles/<name>.yaml` first, then existing project + user lookups. Return `scope: 'local' | 'project' | 'user'`.

**`listProfiles()` (line 1335)** — scan `.eforge/profiles/`, then existing project + user. Three-way shadow rule: a name in `local` shadows same-named entries in `project` and `user`; a name in `project` shadows `user`. Listing entries report `source: ConfigTier` and `shadows: ConfigTier[]`.

**`resolveActiveProfileName()` (line 1208)** — check `.eforge/.active-profile` first, then existing `eforge/.active-profile`, then user marker. Return source `'local' | 'project' | 'user-local' | 'missing' | 'none'`.

**Type rename**: `ActiveProfileSource` value `'local'` → `'project'`; new value `'local'` for `.eforge/.active-profile` source. Update the type definition (line 962) and every consumer in this file plus the small set of external callers.

**Validation**: per-tier files run through their existing zod schemas before merge, so a bad `.eforge/config.yaml` fails fast pointing at that file (this matches today's behavior for project/user tiers — no new logic, just one more call site).

**Missing-tier handling**: `.eforge/config.yaml` and `.eforge/profiles/` absence is silent (most users won't have them). Mirrors how `loadUserConfig()` already swallows ENOENT.

#### 2. `ActiveProfileSource` consumers — internal rename

Touch points outside `config.ts`:

- `packages/eforge/src/cli/index.ts` (lines 297, 458) — `loadConfig()` callers; check whether they pattern-match on `profile.source`.
- `packages/engine/src/eforge.ts` (line 169) — same.
- Any monitor / monitor-ui / pi-eforge code that reads the `source` field surfaced via the daemon API. Grep `ActiveProfileSource` and string literal `'local'` co-occurring with profile contexts to confirm.

The rename is mechanical: existing `'local'` → `'project'` everywhere it refers to the `eforge/.active-profile` marker. The new `'local'` label is then free for `.eforge/`.

#### 3. CLI commands — `packages/eforge/src/cli/`

`mcp-proxy.ts` (MCP tool definitions):

- **`eforge_profile`** (lines 416-478): extend `scope` enum from `['project', 'user', 'all']` to `['local', 'project', 'user', 'all']`. Update response `source` field documentation.
- **`eforge_config`** (lines 402-414): no scope param needed (deep-merge of all tiers is what callers want); add an optional `--show-sources` style verbose flag to the `show` action that prints per-tier file presence and the merged result.
- **`eforge_init`** (lines 579-865): `.gitignore` ensure already covers `.eforge/` (line 615 `ensureGitignoreEntries`). Verify and leave unchanged.

`eforge config show` and `eforge profile list` output: when project-local is present, label sources clearly (`builder [local]  shadows project, user`).

#### 4. Skills — Claude Code plugin and Pi extension parity

Both surfaces gain awareness of the new `local` scope. Updates are docs-only (skill markdown):

**Claude Code plugin** (`eforge-plugin/skills/`):
- `profile/profile.md` — add `local` to scope arg docs; update precedence chain to 6 steps (was 5): local marker → project marker → project config → user marker → user config → none.
- `profile-new/profile-new.md` — Step 0 scope choice gains a `local` option with explanation (gitignored, dev-personal).
- `config/config.md` — minor: note that local `.eforge/config.yaml` deep-merges over team and user.
- `init/init.md` — Step 1.5 also surfaces local-scope profiles (currently only checks user).

**Pi extension** (`packages/pi-eforge/skills/`): same edits to `eforge-config/`, `eforge-profile/`, `eforge-profile-new/`, `eforge-init/`. These are sibling copies; keep them in sync per the AGENTS.md plugin/Pi parity rule.

#### 5. Tests — `test/`

- `test/config-backend-profile.test.ts` (existing primary suite) — extend with three-tier cases:
  - local-only profile resolves
  - local profile shadows same-named project profile
  - local profile shadows same-named user profile (no project entry)
  - three-tier shadow chain reports correctly via `listProfiles()`
  - `.eforge/.active-profile` marker takes precedence over `eforge/.active-profile`
  - missing `.eforge/` everywhere → behavior unchanged from today
- `test/config.test.ts` — extend `mergePartialConfigs` chained-twice case for three-tier deep-merge: scalar override, object section merge, array replacement at the leaf.
- No new test files; the existing fixtures are sufficient.

### Files to modify

**Engine:**
- `packages/engine/src/config.ts` — primary changes (path helpers, `loadConfig`, `loadProfile`, `listProfiles`, `resolveActiveProfileName`, `ActiveProfileSource` rename)

**Engine consumers (rename touch-up only):**
- `packages/engine/src/eforge.ts` (line 169 region)
- `packages/eforge/src/cli/index.ts` (lines 297, 458 region)
- Any other grep hits for the old `'local'` source literal in profile contexts

**CLI / MCP:**
- `packages/eforge/src/cli/mcp-proxy.ts` (`eforge_profile` scope enum, source labels)

**Skills (8 markdown files, plugin + Pi):**
- `eforge-plugin/skills/{config,profile,profile-new,init}/*.md`
- `packages/pi-eforge/skills/eforge-{config,profile,profile-new,init}/SKILL.md`

**Tests:**
- `test/config-backend-profile.test.ts`
- `test/config.test.ts`

**Docs:**
- `README.md`, `AGENTS.md`, `eforge-plugin/.claude-plugin/plugin.json` (version bump per AGENTS.md rule), changelog handled by release flow per memory rule.

## Scope

### In scope

- Adding the `.eforge/` project-local tier with highest precedence to `loadConfig`, `loadProfile`, `listProfiles`, and `resolveActiveProfileName` in `packages/engine/src/config.ts`.
- New path helpers: `localEforgeConfigDir`, `localProfilesDir`, `localProfilePath`, `localMarkerPath`, `localConfigPath` (taking `cwd`).
- Internal rename of `ActiveProfileSource`: existing `'local'` → `'project'`; new `'local'` for `.eforge/.active-profile` source. Final values: `'local' | 'project' | 'user-local' | 'missing' | 'none'`.
- Updating consumers of `ActiveProfileSource` in `packages/engine/src/eforge.ts`, `packages/eforge/src/cli/index.ts`, and any monitor / monitor-ui / pi-eforge code reading the `source` field via the daemon API.
- Extending the `eforge_profile` MCP tool `scope` enum to `['local', 'project', 'user', 'all']`.
- Adding an optional `--show-sources` style verbose flag to `eforge_config` `show` action that prints per-tier file presence and the merged result.
- CLI output labeling for project-local sources in `eforge config show` and `eforge profile list` (e.g. `builder [local]  shadows project, user`).
- Verifying `eforge_init`'s existing `ensureGitignoreEntries` covers `.eforge/` (no change expected).
- Skills documentation updates in `eforge-plugin/skills/` (`config`, `profile`, `profile-new`, `init`) and matching Pi extension skills (`packages/pi-eforge/skills/eforge-{config,profile,profile-new,init}/`).
- Test additions to `test/config-backend-profile.test.ts` and `test/config.test.ts` covering the three-tier cases listed above.
- Doc updates to `README.md`, `AGENTS.md`, and a version bump in `eforge-plugin/.claude-plugin/plugin.json`.

### Out of scope (explicit non-goals)

- The `ConfigResolver` typed interface from the original PRD. Existing functions stay as-is; only their tier coverage expands. If a typed resolver is wanted later (e.g. when playbooks land), the refactor is cheap because the tier logic will already be uniform.
- Environment-variable / CLI-flag overlay tier.
- Profile inheritance / partial overrides for set artifacts.
- New artifact types (playbooks).
- Encrypted / secrets-aware config.
- CHANGELOG edits (handled by release flow).

### Notes for the playbooks PRD

Playbooks can build on this work without further refactoring: they get a new `loadPlaybook` / `listPlaybooks` pair that mirrors `loadProfile` / `listProfiles` (set-shape, three-tier, shadow-by-name). If the playbooks PRD wants the typed `ConfigResolver` abstraction, that refactor becomes a fast follow because all existing tier-aware functions will already share the same shape.

## Acceptance Criteria

1. **Type check**: `pnpm type-check` passes, confirming the `ActiveProfileSource` rename is clean across packages.
2. **Tests**: `pnpm test` passes — all existing tests pass (no behavioral change for users without `.eforge/` config), and new three-tier cases pass:
   - local-only profile resolves
   - local profile shadows same-named project profile
   - local profile shadows same-named user profile (no project entry)
   - three-tier shadow chain reports correctly via `listProfiles()`
   - `.eforge/.active-profile` marker takes precedence over `eforge/.active-profile`
   - missing `.eforge/` everywhere → behavior unchanged from today
   - `mergePartialConfigs` chained-twice case for three-tier deep-merge: scalar override, object section merge, array replacement at the leaf.
3. **End-to-end smoke (manual)**:
   - In a project with `eforge/config.yaml` and an active profile: behavior unchanged.
   - Add `.eforge/config.yaml` with one field: `eforge config show` reflects the field; other fields fall through to project then user.
   - Add `.eforge/profiles/builder.yaml` shadowing an existing `eforge/profiles/builder.yaml`: `eforge profile list` shows `builder [local]  shadows project`; `loadProfile('builder')` returns the local one.
   - Set `.eforge/.active-profile` to a name only present locally: `eforge config show` reports profile source `local`.
   - Delete `.eforge/` artifacts: behavior reverts to two-tier exactly as today.
4. **Daemon integration**: Daemon restart via `eforge-daemon-restart` skill, then run a small build to confirm the engine picks up the new tier in a real pipeline.
5. **Validation**: A bad `.eforge/config.yaml` fails fast via the existing zod schema, with an error pointing at that file.
6. **Silent absence**: Missing `.eforge/config.yaml` and `.eforge/profiles/` are silent (no errors), mirroring `loadUserConfig()`'s ENOENT behavior.
7. **MCP tool surface**: `eforge_profile`'s `scope` enum accepts `'local'`, and the response `source` field documentation reflects the new tier.
8. **CLI output**: When project-local is present, `eforge config show` and `eforge profile list` label sources clearly (e.g. `builder [local]  shadows project, user`).
9. **Plugin/Pi parity**: All eight skill markdown files (4 plugin + 4 Pi) are updated consistently with the new `local` scope, precedence chain (6 steps), and Step 0 / Step 1.5 changes.
10. **Plugin version**: `eforge-plugin/.claude-plugin/plugin.json` version is bumped per the AGENTS.md rule.
11. **No new module**: All changes extend existing functions in `packages/engine/src/config.ts`; no parallel `ConfigResolver` module is introduced.
12. **Gitignore**: `.eforge/` remains covered by `ensureGitignoreEntries` (verified, unchanged).
