---
title: Eval Metrics Extraction
created: 2026-03-19
status: pending
---

# Eval Metrics Extraction

## Problem / Motivation

The eval harness captures pass/fail and wall-clock duration but nothing else. The engine already emits rich `AgentResultData` on every `agent:result` event (tokens, cost, duration, turns, per-model breakdown) and stores all events to `.eforge/monitor.db`. We're leaving data on the floor.

The near-term goal is multi-backend comparison (Claude SDK vs OpenRouter/OpenAI) - running the same eval scenario on different backends and comparing outcomes. Metrics extraction is the prerequisite: without structured token/cost/timing data, there's nothing to compare.

## Goal

Extract structured metrics (tokens, cost, timing, review stats) from the monitor DB after each eval scenario run and surface them in result files and the summary table, enabling future multi-backend comparison.

## Approach

Three changes: (1) preserve the monitor DB from the eval workspace, (2) consolidate result-building into a single TypeScript script that produces the complete `result.json` (exit codes + validation + metrics), (3) surface metrics in the summary table.

The shell harness (`run.sh`, `run-scenario.sh`) stays as bash - it's doing genuinely shell-y work (copying fixtures, managing temp dirs, running subprocesses). All data processing moves to TypeScript so we can import engine types directly.

### 1. Preserve monitor DB in `run-scenario.sh`

Before the workspace is cleaned up, copy `.eforge/monitor.db` to the scenario results directory.

**File**: `eval/lib/run-scenario.sh`

After Step 4 (validation) and before the workspace cleanup (`rm -rf`), add:

```bash
# Copy monitor DB for metrics extraction
if [[ -f "$workspace/.eforge/monitor.db" ]]; then
  cp "$workspace/.eforge/monitor.db" "$scenario_dir/monitor.db"
fi
```

### 2. Replace `build-result.mjs` with `build-result.ts`

Convert the existing `build-result.mjs` to TypeScript and merge metrics extraction into it. One script that builds the complete `result.json`.

**File**: `eval/lib/build-result.ts` (replaces `eval/lib/build-result.mjs`)

Run via `npx tsx` from the shell harness. Same CLI arguments as before, plus an optional monitor DB path.

The script:
1. Builds the base result (scenario ID, version, commit, exit code, duration, validation, Langfuse trace ID) - same as `build-result.mjs` today
2. If a monitor DB path is provided and exists, opens it with `better-sqlite3` and extracts metrics:
   - Queries `agent:result` events, deserializes `data` JSON using engine types (`AgentResultData`, `AgentRole`)
   - Queries `phase:start`/`phase:end` events for per-phase timing
   - Queries `build:review:complete` events for review issue counts
   - Queries `build:evaluate:complete` events for acceptance rates
   - Queries `plan:profile` events for the selected profile name
3. Writes the complete `result.json` with metrics included

TypeScript gives us type-safe deserialization of event data against the engine's own types - no guessing field names.

**Updated call in `run-scenario.sh`**:

```bash
npx tsx "$SCRIPT_DIR/lib/build-result.ts" \
  "$scenario_dir/result.json" \
  "$id" \
  "$eforge_version" \
  "$eforge_commit" \
  "$eforge_exit" \
  "$duration" \
  "$scenario_dir/eforge.log" \
  "$validation_results" \
  "$scenario_dir/monitor.db"
```

**Metrics schema** (added to `result.json`):

```jsonc
{
  // ... existing fields (scenario, timestamp, version, exitCode, validation, duration, langfuseTraceId) ...
  "metrics": {
    "profile": "errand",
    "tokens": {
      "input": 45000,
      "output": 12000,
      "total": 57000
    },
    "costUsd": 0.42,
    "phases": {
      "compile": { "durationMs": 15000 },
      "build": { "durationMs": 180000 }
    },
    "agents": {
      "formatter": { "count": 1, "tokens": 3000, "costUsd": 0.02, "durationMs": 2100, "turns": 1 },
      "builder": { "count": 1, "tokens": 25000, "costUsd": 0.20, "durationMs": 45000, "turns": 12 },
      "reviewer": { "count": 1, "tokens": 8000, "costUsd": 0.05, "durationMs": 6000, "turns": 1 }
    },
    "review": {
      "issueCount": 3,
      "bySeverity": { "critical": 0, "warning": 2, "suggestion": 1 },
      "accepted": 2,
      "rejected": 1
    },
    "models": {
      "claude-sonnet-4-20250514": { "inputTokens": 40000, "outputTokens": 10000, "costUsd": 0.35 }
    }
  }
}
```

### 3. Update summary table in `run.sh`

Add columns to `print_summary()` for tokens and cost:

```
Scenario                           Eforge  Validate  Tokens     Cost    Duration
────────────────────────────────────────────────────────────────────────────────
todo-api-health-check              PASS    PASS      57k        $0.42   4m 8s
```

### 4. Update `summary.json` with aggregated metrics

Add top-level aggregates to `summary.json`:

```jsonc
{
  // ... existing fields ...
  "totals": {
    "tokens": { "input": 120000, "output": 35000, "total": 155000 },
    "costUsd": 1.25,
    "durationSeconds": 480
  }
}
```

### Key reuse

- `better-sqlite3` - already a project dependency (used by `src/monitor/db.ts`)
- `AgentResultData`, `AgentRole`, `EforgeEvent` types from `src/engine/events.ts` - import directly for type-safe deserialization
- Monitor DB schema - same schema as `src/monitor/db.ts:62-88`, no new tables needed

### Backend comparison readiness

The metrics schema is backend-agnostic by design - `AgentResultData` is defined at the engine level, not the backend level. When a second backend lands:
- Add a `backend` field to `result.json` (populated from eforge config or CLI flag)
- Scenarios can specify `backend: openrouter` to override
- The same metrics extraction works regardless of backend since all backends emit `agent:result` events through the same `AgentBackend` interface

No backend-specific work needed now - just noting the design accommodates it.

### Files to modify

| File | Change |
|------|--------|
| `eval/lib/run-scenario.sh` | Copy monitor.db before cleanup, call `build-result.ts` instead of `build-result.mjs` |
| `eval/lib/build-result.ts` | **New file** - replaces `build-result.mjs`, builds complete result.json with metrics |
| `eval/lib/build-result.mjs` | **Delete** - replaced by `build-result.ts` |
| `eval/run.sh` | Update `print_summary()` table format, add totals to summary.json |

## Scope

**In scope:**
- Preserving the monitor DB from eval workspaces before cleanup
- Replacing `build-result.mjs` with a TypeScript equivalent that also extracts metrics from the monitor DB
- Extracting token counts, cost, per-phase timing, per-agent stats, review issue counts/severity/acceptance, per-model breakdowns, and selected profile from the monitor DB
- Surfacing tokens and cost columns in the CLI summary table
- Adding aggregated totals (tokens, cost, duration) to `summary.json`

**Out of scope:**
- Multi-backend comparison implementation (this is the prerequisite; backend field and scenario-level backend overrides come later)
- Changes to the monitor DB schema or event types
- Changes to the engine or agent implementations
- New eval scenarios

## Acceptance Criteria

1. `pnpm build` succeeds
2. Running the health-check eval (`./eval/run.sh todo-api-health-check --env-file .env`) produces `eval/results/<timestamp>/todo-api-health-check/monitor.db`
3. The scenario's `result.json` contains a `metrics` object with `profile`, `tokens` (input/output/total), `costUsd`, `phases` (compile/build with durationMs), `agents` (per-role with count/tokens/costUsd/durationMs/turns), `review` (issueCount/bySeverity/accepted/rejected), and `models` (per-model with inputTokens/outputTokens/costUsd)
4. The CLI summary table shows tokens and cost columns
5. `summary.json` contains a `totals` object with aggregated `tokens` (input/output/total), `costUsd`, and `durationSeconds`
6. `eval/lib/build-result.mjs` is deleted; `eval/lib/build-result.ts` is its replacement
7. Metrics extraction gracefully handles a missing monitor DB (fields omitted or null, no crash)
