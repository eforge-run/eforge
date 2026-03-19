# Distribution Strategy: Plugin-to-CLI Zero-Friction Install

## The Problem

A user discovers eforge through the Claude Code plugin marketplace, installs the plugin, and tries `/eforge:run`. It fails - the CLI isn't on PATH. They have to figure out installation separately, clone the repo, build from source, and link the binary. That's not an onboarding, it's a scavenger hunt.

## The Solution

Publish eforge to npm and have plugin skills invoke via `npx` instead of bare `eforge` commands. A user with Node.js installed adds the plugin, runs `/eforge:run`, and npx transparently downloads and executes the CLI. No global install, no build step, no PATH wrangling.

One thing stands in the way of a clean `npx` experience: `better-sqlite3` requires native compilation via node-gyp. On machines without build tools (no Xcode CLI tools on macOS, no `build-essential` on Linux), the install fails. Node 22.5+ ships a built-in `node:sqlite` module that eliminates this dependency entirely - same synchronous API, WAL mode support, zero install overhead.

## PRD Ordering

The three PRDs form a dependency chain - each unblocks the next:

```
migrate-to-node-sqlite  →  npm-publish  →  plugin-npx-invocations
```

1. **migrate-to-node-sqlite** - Swap `better-sqlite3` for `node:sqlite`. Eliminates the only native dependency, making npm installs fast and friction-free.
2. **npm-publish** - Configure `package.json` for distribution and publish to npm. Depends on the sqlite migration being done first so users don't hit native compilation.
3. **plugin-npx-invocations** - Update plugin skills to use `npx --yes eforge@latest` instead of bare `eforge`. Depends on the package being on npm.

## How to Execute

Feed each PRD into eforge in order. Wait for each to land before starting the next - the dependency chain means later PRDs assume earlier ones are complete.

```bash
eforge run plans/distribution/migrate-to-node-sqlite.md
# verify, merge
eforge run plans/distribution/npm-publish.md
# verify, publish to npm
eforge run plans/distribution/plugin-npx-invocations.md
# verify, bump plugin version
```

Delete this directory once all three are built - the code and git history are the record.
