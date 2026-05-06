import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  existsSync,
  copyFileSync,
  appendFileSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { EforgeEvent, EforgeState } from './events.js';

const STATE_FILENAME = '.eforge/state.json';
const EVENT_LOG_FILENAME = '.eforge/event-log.jsonl';

/**
 * Load the eforge state from a directory. Returns null if no state file exists.
 */
export function loadState(stateDir: string): EforgeState | null {
  const filePath = resolve(stateDir, STATE_FILENAME);
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as EforgeState;
  } catch {
    return null;
  }
}

/**
 * Save eforge state to a directory. Uses write-to-temp-then-rename for
 * atomic writes on POSIX (safe against SIGINT mid-write).
 *
 * Before the first overwrite, copies the existing state.json to state.json.bak
 * as a safety net. Also appends a snapshot to the event log so state can be
 * reconstructed when state.json is unavailable (e.g. after a daemon crash).
 */
export function saveState(stateDir: string, state: EforgeState): void {
  const filePath = resolve(stateDir, STATE_FILENAME);
  const bakPath = filePath + '.bak';
  const tmpPath = filePath + '.tmp';
  mkdirSync(dirname(filePath), { recursive: true });

  // Guard: write state.json.bak before the first overwrite so a mid-write crash
  // does not destroy the prior snapshot. initializeState() uses the .bak for recovery.
  if (!existsSync(bakPath) && existsSync(filePath)) {
    try { copyFileSync(filePath, bakPath); } catch { /* best-effort */ }
  }

  writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, filePath);

  // Append snapshot to event log for state reconstruction when state.json is missing.
  appendSnapshotToEventLog(stateDir, state);
}

/**
 * Append a full state snapshot to the event log file.
 * Each line is a JSON object with a `__snapshot` sentinel and the full state.
 * Best-effort — never throws.
 */
function appendSnapshotToEventLog(stateDir: string, state: EforgeState): void {
  const filePath = resolve(stateDir, EVENT_LOG_FILENAME);
  try {
    appendFileSync(filePath, JSON.stringify({ __snapshot: true, state }) + '\n', 'utf-8');
  } catch {
    // best-effort — do not fail saveState over a log-write error
  }
}

/**
 * Read the most recent valid state snapshot from the event log.
 *
 * Walks the log backward to find the last `__snapshot` row.
 * Returns null if the log does not exist, is empty, or contains no valid
 * snapshots. Invalid rows are skipped with a stderr warning (log-and-skip).
 */
export function readEventLogSnapshot(stateDir: string): EforgeState | null {
  const filePath = resolve(stateDir, EVENT_LOG_FILENAME);
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    // Walk backward to find the most recent valid snapshot
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const row = JSON.parse(lines[i]) as { __snapshot?: boolean; state?: unknown };
        if (row.__snapshot === true && row.state && typeof row.state === 'object') {
          return row.state as EforgeState;
        }
      } catch {
        process.stderr.write(`[event-log] skipping invalid row at line ${i + 1}\n`);
      }
    }
  } catch {
    // File not found or unreadable — return null (legacy session or first run)
  }
  return null;
}

/**
 * Single mutation entry point for EforgeState.
 *
 * Applies the given lifecycle event to the state in place and returns it.
 * Handles the five lifecycle event variants introduced in plan-01-foundation:
 *   plan:status:change, plan:error:set, plan:error:clear,
 *   merge:worktree:set, merge:worktree:clear.
 *
 * All other event types are ignored (no-op, returns state unchanged).
 *
 * Convention: All engine code that mutates plan.status, plan.error,
 * state.completedPlans, or state.mergeWorktreePath must go through this
 * function. Direct field assignments to those properties outside this file
 * are forbidden — the grep gate enforces zero hits outside state.ts.
 */
export function mutateState(state: EforgeState, event: EforgeEvent): EforgeState {
  switch (event.type) {
    case 'plan:status:change': {
      const plan = state.plans[event.planId];
      if (!plan) break;
      plan.status = event.status;
      if (
        (event.status === 'completed' || event.status === 'merged') &&
        !state.completedPlans.includes(event.planId)
      ) {
        state.completedPlans.push(event.planId);
      }
      break;
    }
    case 'plan:error:set': {
      const plan = state.plans[event.planId];
      if (!plan) break;
      plan.error = event.error;
      break;
    }
    case 'plan:error:clear': {
      const plan = state.plans[event.planId];
      if (!plan) break;
      delete plan.error;
      break;
    }
    case 'merge:worktree:set': {
      state.mergeWorktreePath = event.path;
      break;
    }
    case 'merge:worktree:clear': {
      delete state.mergeWorktreePath;
      break;
    }
    default:
      break;
  }
  return state;
}

/**
 * Convenience wrapper that directly sets a plan's status in state, updating
 * completedPlans when the status is 'completed' or 'merged'.
 *
 * Throws if planId is not present in state.plans. All callers must go through
 * this function rather than assigning plan.status directly.
 */
export function updatePlanStatus(
  state: EforgeState,
  planId: string,
  status: EforgeState['plans'][string]['status'],
): void {
  const plan = state.plans[planId];
  if (!plan) {
    throw new Error(`Unknown plan: ${planId}`);
  }
  plan.status = status;
  if (
    (status === 'completed' || status === 'merged') &&
    !state.completedPlans.includes(planId)
  ) {
    state.completedPlans.push(planId);
  }
}

/**
 * Check if a state is resumable: status is 'running' and at least one plan is not completed/merged.
 */
export function isResumable(state: EforgeState): boolean {
  if (state.status !== 'running') return false;

  return Object.values(state.plans).some(
    (p) => p.status !== 'completed' && p.status !== 'merged',
  );
}
