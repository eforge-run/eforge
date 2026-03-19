---
title: Migrate from better-sqlite3 to node:sqlite
priority: 1
---

## Problem / Motivation

`better-sqlite3` is eforge's only native dependency. It requires node-gyp compilation at install time, which needs platform-specific build tools (Python, make, C++ compiler). While prebuilt binaries cover common platforms, failures happen - and any friction during `npx eforge` install undermines the zero-setup plugin experience we're building toward.

Node 22.5+ ships a built-in `node:sqlite` module (`DatabaseSync`) with the same synchronous API paradigm, WAL mode support, and zero install overhead. It's part of the runtime eforge already targets.

## Goal

Replace `better-sqlite3` with `node:sqlite` so eforge has no native dependencies. Install via npm becomes a pure JavaScript download with no compilation step.

## Approach

Swap `DatabaseSync` from `node:sqlite` into the two files that use `better-sqlite3`:

**`src/monitor/db.ts`** (primary usage):
- Replace `import Database from 'better-sqlite3'` with `import { DatabaseSync } from 'node:sqlite'`
- Constructor: `new Database(dbPath)` becomes `new DatabaseSync(dbPath)`
- `db.pragma('journal_mode = WAL')` becomes `db.exec('PRAGMA journal_mode = WAL')`
- `lastInsertRowid` returns `BigInt` in node:sqlite - wrap with `Number()` where the current code expects a number (the `insertEvent` method returns it)
- `db.pragma('table_info(runs)')` for migrations becomes `db.prepare('PRAGMA table_info(runs)').all()`
- Statement API (`.prepare()`, `.run()`, `.get()`, `.all()`) is the same shape

**`eval/lib/build-result.ts`** (eval harness):
- Same import swap pattern
- Constructor uses `{ readonly: true }` option - maps to `{ readOnly: true }` in node:sqlite (different property name)
- Extensive read-only usage: multiple `.prepare().all()` and `.prepare().get()` queries for extracting metrics from monitor DBs

**`package.json`**:
- Remove `better-sqlite3` from `dependencies`
- Remove `@types/better-sqlite3` from `devDependencies`
- Remove `better-sqlite3` from `pnpm.onlyBuiltDependencies`

**`tsup.config.ts`**:
- Remove `better-sqlite3` from the `external` arrays in both entry configs
- `node:sqlite` is a Node built-in, no need to externalize

**Runtime warning**: `node:sqlite` emits an `ExperimentalWarning` on first use. Suppress it in the CLI shebang or entry point with `--disable-warning=ExperimentalWarning`, or via `process.removeAllListeners('warning')` before the import. The module is stability 1.1 (Active Development) on Node 22/24 and 1.2 (Release Candidate) on Node 25.

## Scope

**In scope**:
- `src/monitor/db.ts` - full migration
- `eval/lib/build-result.ts` - full migration
- `package.json` - dependency removal
- `tsup.config.ts` - external removal
- Suppress ExperimentalWarning

**Out of scope**:
- No changes to the `MonitorDB` interface or its consumers
- No schema changes to the SQLite tables
- No changes to the monitor server or SSE logic
- No changes to `withRecording()` middleware

## Acceptance Criteria

- `pnpm test` passes with no test changes (or minimal changes if tests reference better-sqlite3 directly)
- `pnpm type-check` passes
- `pnpm build` produces a working CLI
- Monitor concurrent access works: start a build with `--verbose`, open `localhost:4567`, verify events stream in real-time via SSE
- `better-sqlite3` does not appear in `node_modules/` after `pnpm install` (fully removed from dependency tree)
- No `ExperimentalWarning` printed to stderr during normal CLI usage
