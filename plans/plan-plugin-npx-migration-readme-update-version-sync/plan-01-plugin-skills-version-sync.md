---
id: plan-01-plugin-skills-version-sync
name: Plugin Skills npx Fallback and Version Sync Infrastructure
depends_on: []
branch: plan-plugin-npx-migration-readme-update-version-sync/plugin-skills-version-sync
---

# Plugin Skills npx Fallback and Version Sync Infrastructure

## Architecture Context

The eforge Claude Code plugin invokes the eforge CLI from three skill files (run, enqueue, config). Currently all three assume a global install (`eforge` on PATH). Users who install the plugin from the marketplace hit immediate failures if they haven't separately installed the CLI. The fix is a `command -v` fallback pattern that uses the local binary when available and falls back to `npx --yes eforge` otherwise.

The plugin version in `plugin.json` (1.7.2) has drifted from `package.json` (0.1.0). A sync script and CI check prevent future drift.

## Implementation

### Overview

Three changes:

1. Update the three CLI-invoking skills to use `command -v eforge` fallback instead of bare `eforge`, remove "must be installed and on PATH" prerequisites, and add version-mismatch error handling.
2. Realign `plugin.json` version to match `package.json` (0.1.0) and create `scripts/sync-version.mjs` to keep them in sync.
3. Wire the sync script into `package.json`'s `version` lifecycle hook and add a CI check.

### Key Decisions

1. `command -v` fallback over always-npx because local installs are faster and don't hit the network. Users who have eforge globally installed get the fast path; everyone else gets npx transparently.
2. No `@latest` tag on `npx --yes eforge` - npx resolves the latest version by default, and `@latest` can cause cache-busting re-downloads on every invocation.
3. The sync script is `.mjs` (ESM) to match the project's ESM-only stance. It reads `package.json`, patches `plugin.json`, and writes it back.
4. CI check is a simple shell assertion in the existing `test` job rather than a separate job - avoids a full checkout/install cycle for a 2-line check.

## Scope

### In Scope
- `eforge-plugin/skills/run/run.md` - `command -v` fallback pattern for all CLI invocations, remove prerequisite note, add version-mismatch error handling
- `eforge-plugin/skills/enqueue/enqueue.md` - same
- `eforge-plugin/skills/config/config.md` - same
- `eforge-plugin/.claude-plugin/plugin.json` - set version to 0.1.0
- `scripts/sync-version.mjs` - new file, copies version from `package.json` to `plugin.json`
- `package.json` - add `version` lifecycle script
- `.github/workflows/ci.yml` - add version sync check step

### Out of Scope
- `eforge-plugin/skills/status/status.md` - reads state.json directly, no CLI invocation
- Dogfood skills - they use the local binary directly, unaffected
- Engine or CLI code changes
- README changes (plan-02)

## Files

### Create
- `scripts/sync-version.mjs` — ESM script that reads version from `package.json` and writes it to `eforge-plugin/.claude-plugin/plugin.json`. Uses `node:fs` and `node:path` with `import.meta.dirname`.

### Modify
- `eforge-plugin/skills/run/run.md` — Replace all bare `eforge` commands with `command -v` fallback pattern (if/else blocks in bash code fences). Remove the "**Prerequisite**: `eforge` CLI must be installed and on PATH." line. Add version-mismatch row to the Error Handling table: if the command fails with "unknown option", "unknown command", or other CLI errors suggesting version mismatch, tell the user versions may be out of sync, suggest `npm update -g eforge` or clearing npx cache, suggest `/plugin update eforge@eforge`, and if both are latest report as a bug.
- `eforge-plugin/skills/enqueue/enqueue.md` — Same pattern: replace bare `eforge enqueue` with `command -v` fallback, remove prerequisite note, add version-mismatch error handling row.
- `eforge-plugin/skills/config/config.md` — Same pattern: replace bare `eforge config validate` with `command -v` fallback, remove prerequisite note, add version-mismatch error handling row.
- `eforge-plugin/.claude-plugin/plugin.json` — Change `"version": "1.7.2"` to `"version": "0.1.0"` to match `package.json`.
- `package.json` — Add `"version": "node scripts/sync-version.mjs && git add eforge-plugin/.claude-plugin/plugin.json"` to the `scripts` section. This hooks into `pnpm version` lifecycle.
- `.github/workflows/ci.yml` — Add a "Check version sync" step before the existing build step. Uses `node -p` to extract both versions and asserts equality.

## Verification

- [ ] `run.md` contains `command -v eforge` in a bash if/else block and does NOT contain bare `eforge run` outside of that pattern
- [ ] `enqueue.md` contains `command -v eforge` fallback and does NOT contain bare `eforge enqueue` outside of that pattern
- [ ] `config.md` contains `command -v eforge` fallback and does NOT contain bare `eforge config validate` outside of that pattern
- [ ] None of the three skill files contain the string "must be installed and on PATH"
- [ ] All three skill files have a version-mismatch row in their Error Handling table mentioning `npm update -g eforge`, npx cache, `/plugin update eforge@eforge`, and report-as-bug
- [ ] `plugin.json` version field is `"0.1.0"`
- [ ] `scripts/sync-version.mjs` exists and when run via `node scripts/sync-version.mjs` it sets `plugin.json` version to match `package.json` version
- [ ] `package.json` has a `"version"` key in `scripts` that runs the sync script and stages `plugin.json`
- [ ] Running `pnpm version patch --no-git-tag-version` updates both `package.json` and `plugin.json` to the same version
- [ ] `.github/workflows/ci.yml` has a "Check version sync" step that compares `package.json` and `plugin.json` versions
- [ ] `pnpm type-check` passes
- [ ] `pnpm test` passes
