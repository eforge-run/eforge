---
id: plan-01-eval-metrics
name: Eval Metrics Extraction
dependsOn: []
branch: eval-metrics-extraction/eval-metrics
---

# Eval Metrics Extraction

## Architecture Context

The eval harness (`eval/run.sh`, `eval/lib/run-scenario.sh`) runs eforge against fixture projects and captures pass/fail + wall-clock duration. The engine already emits rich `AgentResultData` on every `agent:result` event and stores all events to `.eforge/monitor.db` via the monitor's SQLite recorder. This plan extracts structured metrics from the monitor DB and surfaces them in eval results.

The shell harness stays as bash - it does genuinely shell-y work (fixture copying, temp dir management, subprocesses). All data processing moves to TypeScript so we can import engine types (`AgentResultData`, `AgentRole`) directly for type-safe deserialization.

## Implementation

### Overview

Three coordinated changes: (1) preserve the monitor DB from the eval workspace before cleanup, (2) replace `build-result.mjs` with a TypeScript script that builds the complete `result.json` including metrics extracted from the monitor DB, (3) update the summary table and `summary.json` with token/cost/duration aggregates.

### Key Decisions

1. **TypeScript over JS for build-result** - The current `build-result.mjs` is plain Node.js. Converting to TypeScript lets us import `AgentResultData` and `AgentRole` types directly from the engine, giving type-safe deserialization of event data without guessing field names. Run via `npx tsx`.
2. **`better-sqlite3` reuse** - Already a project dependency used by `src/monitor/db.ts`. The build-result script opens the copied DB read-only and queries event data directly - no new tables or schema changes needed.
3. **Graceful degradation** - If the monitor DB is missing (eforge crashed early, or `--no-monitor` was used), the metrics fields are simply omitted from `result.json`. No crash, no null sentinels.
4. **Aggregate totals in summary.json** - Sum tokens, cost, and duration across all scenarios for a quick glance at total eval resource consumption.

## Scope

### In Scope
- Copying `.eforge/monitor.db` from the eval workspace to the scenario results directory before cleanup in `run-scenario.sh`
- New `eval/lib/build-result.ts` that replaces `eval/lib/build-result.mjs` - builds `result.json` with base fields plus metrics extracted from the monitor DB
- Deleting `eval/lib/build-result.mjs`
- Updating `run-scenario.sh` to call `npx tsx eval/lib/build-result.ts` instead of `node eval/lib/build-result.mjs` and pass the monitor DB path as a 9th argument
- Updating `print_summary()` in `eval/run.sh` to show tokens and cost columns
- Adding aggregated `totals` object to `summary.json` in `eval/run.sh`

### Out of Scope
- Multi-backend comparison (this is the prerequisite - backend field comes later)
- Changes to the monitor DB schema, event types, or engine code
- New eval scenarios
- Changes to the monitor web dashboard

## Files

### Create
- `eval/lib/build-result.ts` — TypeScript replacement for `build-result.mjs`. Accepts the same 8 CLI args plus an optional 9th (monitor DB path). Builds `result.json` with base fields (scenario, timestamp, version, commit, exit code, duration, validation, langfuseTraceId) and, when a monitor DB is present, a `metrics` object containing: `profile` (from `plan:profile` event), `tokens` (input/output/total from summing `agent:result` events' `usage` fields), `costUsd` (sum of `totalCostUsd`), `phases` (compile/build `durationMs` from `phase:start`/`phase:end` timestamps), `agents` (per-role aggregates: count, tokens, costUsd, durationMs, turns from `agent:result` events keyed by `agent` field), `review` (issueCount and bySeverity from `build:review:complete` events' `issues` arrays, accepted/rejected from `build:evaluate:complete` events), `models` (per-model inputTokens/outputTokens/costUsd from merging `modelUsage` records across all `agent:result` events). Uses `better-sqlite3` for DB access and imports `AgentResultData`, `AgentRole`, and `ReviewIssue` types from `src/engine/events.ts`.

### Modify
- `eval/lib/run-scenario.sh` — Two changes: (1) After Step 4 (validation) and before workspace cleanup, copy `.eforge/monitor.db` to `$scenario_dir/monitor.db` if it exists. (2) Replace the `node "$SCRIPT_DIR/lib/build-result.mjs"` call with `npx tsx "$SCRIPT_DIR/lib/build-result.ts"` and add `"$scenario_dir/monitor.db"` as the 9th argument.
- `eval/run.sh` — Two changes: (1) Update `print_summary()` to add Tokens and Cost columns between Validate and Duration. Format tokens as `57k` (divide by 1000, round), cost as `$0.42`. Read from `result.metrics.tokens.total` and `result.metrics.costUsd` (show `-` when metrics are absent). (2) Update the summary.json generation to include a `totals` object aggregating `tokens` (input/output/total), `costUsd`, and `durationSeconds` across all scenario results.

### Delete
- `eval/lib/build-result.mjs` — Replaced by `eval/lib/build-result.ts`

## Verification

- [ ] `pnpm build` exits 0
- [ ] `pnpm type-check` exits 0
- [ ] `eval/lib/build-result.mjs` does not exist
- [ ] `eval/lib/build-result.ts` exists and is valid TypeScript
- [ ] `eval/lib/build-result.ts` imports `AgentResultData` from `../../src/engine/events.js`
- [ ] `eval/lib/build-result.ts` uses `better-sqlite3` to open the monitor DB read-only
- [ ] `eval/lib/run-scenario.sh` contains a `cp` command for `.eforge/monitor.db`
- [ ] `eval/lib/run-scenario.sh` calls `npx tsx` with `build-result.ts` (not `node` with `build-result.mjs`)
- [ ] Running `npx tsx eval/lib/build-result.ts /tmp/test-result.json test-scenario 0.1.0 abc123 0 60 /dev/null '{}'` without a monitor DB arg produces a valid JSON file with no `metrics` field and no crash
- [ ] Running `npx tsx eval/lib/build-result.ts /tmp/test-result.json test-scenario 0.1.0 abc123 0 60 /dev/null '{}' /nonexistent/monitor.db` with a nonexistent DB path produces a valid JSON file with no `metrics` field and no crash
- [ ] `eval/run.sh` `print_summary` output includes "Tokens" and "Cost" column headers
- [ ] The `summary.json` generation block references `totals` with `tokens`, `costUsd`, and `durationSeconds` fields
