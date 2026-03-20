---
title: Plan: Plugin npx migration + README update + version sync
created: 2026-03-20
status: pending
---

## Problem / Motivation

eforge@0.1.0 is published on npm, but three gaps remain in the distribution story:

1. **Plugin skills invoke bare `eforge` commands** - this fails if the CLI isn't globally installed. Users who rely on npx or haven't installed globally hit immediate errors.
2. **README Install section shows git clone + build from source as the only path** - now that eforge is on npm, the install docs are outdated and friction-heavy.
3. **No enforcement that plugin version stays in sync with CLI version** - version drift between `package.json` and `plugin.json` can cause subtle breakage with no guardrails to catch it.

## Goal

Complete the npm distribution story by making plugin skills work without a global install (via `command -v` fallback to npx), restructuring the README to lead with the plugin as the primary install path, and adding version sync infrastructure between the CLI and plugin.

## Approach

Four sequential steps:

### Step 1: Update plugin skills to use `command -v` fallback pattern

The PRD at `plans/distribution/plugin-npx-invocations.md` needs two tweaks before running through eforge:
- Change `npx --yes eforge@latest` to a `command -v` fallback pattern (use local if available, npx otherwise)
- Remove `@latest` references

The pattern for all CLI invocations in skills becomes:

```bash
if command -v eforge &>/dev/null; then
  eforge run $SOURCE --auto --verbose
else
  npx --yes eforge run $SOURCE --auto --verbose
fi
```

Then feed to eforge:

```bash
eforge run plans/distribution/plugin-npx-invocations.md --auto --verbose
```

This updates:
- `eforge-plugin/skills/run/run.md` - command-v fallback pattern
- `eforge-plugin/skills/enqueue/enqueue.md` - same
- `eforge-plugin/skills/config/config.md` - same
- `eforge-plugin/.claude-plugin/plugin.json` - version realigned to match package.json
- Removes "must be installed and on PATH" prerequisite notes
- Adds version-mismatch error handling to each skill's Error Handling section

**Version-mismatch error handling**: If the eforge command fails with "unknown option", "unknown command", or other CLI errors that suggest a version mismatch between the plugin and CLI, the skill should:
1. Tell the user the plugin and CLI versions may be out of sync
2. Suggest updating: `npm update -g eforge` (global) or clearing npx cache
3. Suggest updating the plugin: `/plugin update eforge@eforge`
4. If both are latest, report as a bug

### Step 2: Version sync infrastructure

**Realign versions**: Set `plugin.json` version to match `package.json` (currently 0.1.0). The plugin version number has no semver implications in the Claude Code marketplace.

**Create `scripts/sync-version.mjs`**: Copies version from `package.json` → `plugin.json`. Wired into the `version` lifecycle hook so `pnpm version patch/minor/major` auto-updates both.

```json
"version": "node scripts/sync-version.mjs && git add eforge-plugin/.claude-plugin/plugin.json"
```

**CI check** in `.github/workflows/ci.yml`: Assert package.json version === plugin.json version. Fails the PR if they diverge.

```yaml
- name: Check version sync
  run: |
    PKG=$(node -p "require('./package.json').version")
    PLUGIN=$(node -p "require('./eforge-plugin/.claude-plugin/plugin.json').version")
    [ "$PKG" = "$PLUGIN" ] || { echo "Version mismatch: package.json=$PKG plugin.json=$PLUGIN"; exit 1; }
```

### Step 3: Update README.md

Restructure Getting Started to lead with the plugin as the primary install path:

**Install section** (currently lines 84-113): Plugin is the primary path. Standalone CLI is secondary.

- **Claude Code Plugin (recommended)**: Install the plugin, first invocation downloads eforge via npx automatically. No global install needed.
- **Standalone CLI**: `npx eforge run my-feature.md` or `npm install -g eforge` for global install.

Remove the separate "Claude Code Plugin (recommended)" subsection (currently lines 95-113) since it merges into Install.

Dogfooding section stays as-is - `pnpm link --global` is correct for development.

### Step 4: Roadmap + cleanup

- Remove "npm distribution" bullet from `docs/roadmap.md` (shipped)
- Delete `plans/distribution/` directory (all 3 PRDs complete per overview.md)

## Scope

**In scope:**
- Plugin skill files: `run/run.md`, `enqueue/enqueue.md`, `config/config.md`
- `eforge-plugin/.claude-plugin/plugin.json` version alignment
- `scripts/sync-version.mjs` creation
- `package.json` - add `version` lifecycle script
- `.github/workflows/ci.yml` - add version sync check step
- `README.md` Install section restructure
- `docs/roadmap.md` - remove shipped npm distribution item
- `plans/distribution/` directory deletion

**Out of scope:**
- Dogfooding section in README (stays as-is - `pnpm link --global` is correct for development)
- Any semver implications of the plugin version number in the Claude Code marketplace
- Changes to eforge engine or CLI code

## Acceptance Criteria

1. eforge run completes on the updated `plans/distribution/plugin-npx-invocations.md` PRD with all validation passing
2. Plugin skills use `command -v eforge` fallback pattern (not bare `eforge` or `npx --yes eforge@latest`)
3. Each skill's Error Handling section includes version-mismatch guidance (suggest `npm update -g eforge`, clearing npx cache, `/plugin update eforge@eforge`, and report-as-bug fallback)
4. `plugin.json` version matches `package.json` version (currently 0.1.0)
5. `scripts/sync-version.mjs` exists and copies version from `package.json` → `plugin.json`
6. `package.json` has a `version` lifecycle script that runs the sync script and stages `plugin.json`
7. `pnpm version patch --no-git-tag-version` updates both `package.json` and `plugin.json`
8. `.github/workflows/ci.yml` includes a version sync check that fails the PR if versions diverge
9. README Install section leads with plugin as primary path, shows npx/npm as standalone secondary
10. The separate "Claude Code Plugin (recommended)" subsection (previously lines 95-113) is merged into the main Install section
11. `plans/distribution/` directory is deleted
12. `docs/roadmap.md` no longer mentions npm distribution
