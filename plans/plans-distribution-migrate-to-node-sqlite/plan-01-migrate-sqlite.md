---
id: plan-01-migrate-sqlite
name: Migrate from better-sqlite3 to node:sqlite
dependsOn: []
branch: plans-distribution-migrate-to-node-sqlite/migrate-sqlite
---

# Migrate from better-sqlite3 to node:sqlite

## Architecture Context

eforge targets Node 22+ and uses SQLite in two places: the monitor DB (`src/monitor/db.ts`) for event persistence and the eval harness (`eval/lib/build-result.ts`) for extracting metrics from monitor DBs. Both use the `better-sqlite3` package - the only native dependency in the project. Node 22.5+ ships `node:sqlite` with a near-identical synchronous API (`DatabaseSync`), making a 1:1 swap viable.

The `MonitorDB` interface and all its consumers remain unchanged - only the implementation behind `openDatabase()` shifts to a different SQLite driver.

## Implementation

### Overview

Replace all `better-sqlite3` usage with `node:sqlite`'s `DatabaseSync`, remove the dependency from package.json and build config, and suppress the ExperimentalWarning that `node:sqlite` emits on first use.

### Key Decisions

1. **Suppress ExperimentalWarning via `--disable-warning=ExperimentalWarning` in the tsup shebang banner** — this is the cleanest approach for the CLI entry point. The monitor server subprocess (`server-main.ts`) is launched via `node` by the engine, so its spawn call needs the flag too. The `eval/lib/build-result.ts` script uses a `tsx` shebang and runs outside the CLI - add `process.removeAllListeners('warning')` at the top as a simpler approach for eval scripts.
2. **`readOnly` is the correct option name** for `node:sqlite`'s `DatabaseSync` constructor (confirmed in `@types/node`). The `better-sqlite3` option is `readonly` (lowercase). Both happen to work on Node 24, but `readOnly` is the documented API.
3. **`lastInsertRowid` returns `number | bigint`** in `node:sqlite` — the existing `Number()` wrap on line 178 of `db.ts` already handles this. No change needed.
4. **`db.pragma()` does not exist** on `DatabaseSync` — replace `db.pragma('journal_mode = WAL')` with `db.exec('PRAGMA journal_mode = WAL')` and `db.pragma('table_info(runs)')` with `db.prepare('PRAGMA table_info(runs)').all()`.

## Scope

### In Scope
- `src/monitor/db.ts` — swap import, constructor, pragma calls
- `eval/lib/build-result.ts` — swap import, constructor (readonly option name change)
- `package.json` — remove `better-sqlite3`, `@types/better-sqlite3`, and `pnpm.onlyBuiltDependencies` entry
- `tsup.config.ts` — remove `better-sqlite3` from both `external` arrays
- Suppress ExperimentalWarning in CLI shebang and monitor server spawn

### Out of Scope
- `MonitorDB` interface or its consumers
- SQLite table schemas
- Monitor server logic, SSE, or `withRecording()` middleware
- Test changes (tests use `openDatabase` through the module — the interface is unchanged)

## Files

### Modify
- `src/monitor/db.ts` — replace `import Database from 'better-sqlite3'` with `import { DatabaseSync } from 'node:sqlite'`; change `new Database(dbPath)` to `new DatabaseSync(dbPath)`; replace `db.pragma('journal_mode = WAL')` with `db.exec('PRAGMA journal_mode = WAL')`; replace `db.pragma('table_info(runs)')` with `db.prepare('PRAGMA table_info(runs)').all()`
- `eval/lib/build-result.ts` — replace `import Database from 'better-sqlite3'` with `import { DatabaseSync } from 'node:sqlite'`; change `new Database(dbPath, { readonly: true })` to `new DatabaseSync(dbPath, { readOnly: true })`; remove the `Database.Database` type annotation (use inferred type); add `process.removeAllListeners('warning')` before the import to suppress ExperimentalWarning
- `package.json` — remove `better-sqlite3` from `dependencies`, `@types/better-sqlite3` from `devDependencies`, and `better-sqlite3` from `pnpm.onlyBuiltDependencies`
- `tsup.config.ts` — remove `"better-sqlite3"` from both `external` arrays (first entry: `["@anthropic-ai/claude-agent-sdk", "better-sqlite3"]` becomes `["@anthropic-ai/claude-agent-sdk"]`; second entry: `["better-sqlite3"]` becomes `[]` or remove the `external` key entirely)
- `tsup.config.ts` — update the CLI entry shebang banner from `#!/usr/bin/env node` to `#!/usr/bin/env -S node --disable-warning=ExperimentalWarning` to suppress the runtime warning
- `src/monitor/index.ts` — find where the monitor server subprocess is spawned and add `--disable-warning=ExperimentalWarning` to the node args

## Verification

- [ ] `pnpm type-check` exits with code 0
- [ ] `pnpm build` exits with code 0 and produces `dist/cli.js` with the updated shebang
- [ ] `pnpm test` exits with code 0
- [ ] `grep -r 'better-sqlite3' package.json` returns no matches
- [ ] `grep -r 'better-sqlite3' tsup.config.ts` returns no matches
- [ ] `head -1 dist/cli.js` contains `--disable-warning=ExperimentalWarning`
- [ ] `node dist/cli.js status 2>&1 | grep -c ExperimentalWarning` returns 0 (no warning printed)
- [ ] `import { DatabaseSync } from 'node:sqlite'` appears in `src/monitor/db.ts`
- [ ] `import { DatabaseSync } from 'node:sqlite'` appears in `eval/lib/build-result.ts`
