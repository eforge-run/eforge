---
title: Publish eforge to npm
priority: 2
depends_on: [migrate-to-node-sqlite]
---

## Problem / Motivation

eforge has no distribution path. The only way to install it is `pnpm link` from a local clone of the repo. Users can't run `npx eforge` or `npm install -g eforge`, which blocks the plugin auto-install story and limits adoption to people willing to build from source.

## Goal

Publish eforge to npm so `npx eforge` works from any machine with Node 22.5+. After the `node:sqlite` migration, this should be a clean install with no native compilation.

## Approach

**`package.json` configuration**:
- Add `files` field to control tarball contents. `dist/` contains the bundled CLI and monitor server (tsup entries), prompt files (copied by tsup's `onSuccess` hook), and monitor UI assets (built by `pnpm --filter monitor-ui build`). Verify with `npm pack --dry-run` that no source code, tests, eval fixtures, or config files leak in.
- Add `repository` field: `{ "type": "git", "url": "https://github.com/eforge-run/eforge.git" }`
- Consider adding `exports` field for future library consumers, but the primary use case is CLI via `bin`
- `engines` field: `{ "node": ">=22.5.0" }` to document the `node:sqlite` requirement

**Tarball verification**:
- Run `npm pack --dry-run` and review the file list
- Verify `dist/cli.js` has the shebang (`#!/usr/bin/env node`)
- Verify `dist/prompts/` directory is included (agent prompts)
- Verify `dist/server-main.js` is included (monitor server)
- Verify monitor UI assets are included (built by `pnpm --filter monitor-ui build`)
- Verify no source files, test files, eval fixtures, `.eforge/`, or dotfiles are included

**Local test before publish**:
- `npm pack` to create the tarball
- `npx ./eforge-*.tgz --version` to verify it runs
- `npx ./eforge-*.tgz run --help` to verify subcommands load
- Test in a clean directory outside the repo

**Publish**:
- `npm publish` (unscoped package, public by default)
- The GitHub repo can remain private - npm doesn't require public source
- Verify `npx eforge --version` works from a clean environment afterward

## Scope

**In scope**:
- `package.json` fields (`files`, `repository`, `engines`, optionally `exports`)
- Tarball verification
- Initial manual publish to npm

**Out of scope**:
- CI/CD publish workflow (GitHub Actions on tag push) - follow-up work
- Monorepo migration - separate effort on the roadmap
- Version bump strategy / changelog automation
- npm org or scope setup

## Acceptance Criteria

- `npm pack --dry-run` shows only intended files (dist/, package.json, README, LICENSE)
- `npx eforge --version` works from a clean environment with no prior eforge install
- Package installs without native compilation errors (post-sqlite migration)
- `npx eforge run --help` shows the expected subcommand help
- `docs/roadmap.md` updated to reflect npm distribution as shipped
