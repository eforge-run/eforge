import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { EforgeState, PlanState } from './events.js';

const STATE_FILENAME = '.eforge/state.json';

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
 */
export function saveState(stateDir: string, state: EforgeState): void {
  const filePath = resolve(stateDir, STATE_FILENAME);
  const tmpPath = filePath + '.tmp';
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, filePath);
}

/**
 * Update a plan's status within the state. Mutates the state in place and returns it.
 * Automatically updates completedPlans when a plan transitions to 'completed' or 'merged'.
 */
export function updatePlanStatus(
  state: EforgeState,
  planId: string,
  status: PlanState['status'],
): EforgeState {
  const plan = state.plans[planId];
  if (!plan) {
    throw new Error(`Unknown plan ID: '${planId}'`);
  }

  plan.status = status;

  if ((status === 'completed' || status === 'merged') && !state.completedPlans.includes(planId)) {
    state.completedPlans.push(planId);
  }

  return state;
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
