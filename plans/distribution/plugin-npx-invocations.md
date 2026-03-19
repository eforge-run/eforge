---
title: Update plugin skills to use npx
priority: 3
depends_on: [npm-publish]
---

## Problem / Motivation

The eforge Claude Code plugin's skills invoke bare `eforge` commands (`eforge run`, `eforge enqueue`, `eforge config validate`). If the CLI isn't globally installed and on PATH, every skill fails. Users have to install eforge separately before the plugin works - a broken first-run experience.

Claude Code plugins have no lifecycle hooks (`onInstall`, `onFirstRun`), so there's no way to trigger installation automatically at plugin install time. The fix has to happen at invocation time.

## Goal

Plugin skills work out of the box for any user with Node.js. No global install, no PATH setup, no separate onboarding step. First invocation of `/eforge:run` just works.

## Approach

Replace bare `eforge` commands with `npx --yes eforge@latest` in the three skills that invoke the CLI:

**`eforge-plugin/skills/run/run.md`**:
- `eforge run $SOURCE --auto --verbose` becomes `npx --yes eforge@latest run $SOURCE --auto --verbose`
- Same for `--queue`, `--watch`, and `--poll-interval` variants

**`eforge-plugin/skills/enqueue/enqueue.md`**:
- `eforge enqueue $SOURCE` becomes `npx --yes eforge@latest enqueue $SOURCE`

**`eforge-plugin/skills/config/config.md`**:
- `eforge config validate` becomes `npx --yes eforge@latest config validate`

The `--yes` flag skips npx's interactive "Install the following packages?" confirmation, which would block the non-interactive skill execution.

**`eforge-plugin/skills/status/status.md`** - no changes. It reads `.eforge/state.json` directly and doesn't invoke the CLI.

**`eforge-plugin/.claude-plugin/plugin.json`** - bump version.

No Node.js availability guard is needed - Claude Code itself requires Node.js, so it's always present.

## Scope

**In scope**:
- `eforge-plugin/skills/run/run.md` - npx invocation
- `eforge-plugin/skills/enqueue/enqueue.md` - npx invocation
- `eforge-plugin/skills/config/config.md` - npx invocation
- `eforge-plugin/.claude-plugin/plugin.json` - version bump
- Update prerequisite notes in skill files (remove "must be installed and on PATH")

**Out of scope**:
- `/eforge:setup` skill for global install preference (nice-to-have follow-up)
- Version pinning strategy (using `@latest` for now, revisit if stability concerns arise)
- `status.md` changes (doesn't use CLI)

## Acceptance Criteria

- `/eforge:run` works in a Claude Code session where eforge is NOT globally installed
- npx transparently downloads and executes the eforge CLI on first invocation
- Subsequent invocations use the npx cache (fast startup, no re-download)
- All skill files reference `npx --yes eforge@latest` consistently
- Plugin version is bumped in `plugin.json`
