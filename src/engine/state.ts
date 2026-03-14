import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { ForgeState, PlanState } from './events.js';

const STATE_FILENAME = '.forge/state.json';

/**
 * Load the forge state from a directory. Returns null if no state file exists.
 */
export function loadState(stateDir: string): ForgeState | null {
  const filePath = resolve(stateDir, STATE_FILENAME);
  if (!existsSync(filePath)) {
    return null;
  }
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as ForgeState;
}

/**
 * Save forge state to a directory (sync write, not atomic).
 */
export function saveState(stateDir: string, state: ForgeState): void {
  const filePath = resolve(stateDir, STATE_FILENAME);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

/**
 * Update a plan's status within the state. Mutates the state in place and returns it.
 * Automatically updates completedPlans when a plan transitions to 'completed' or 'merged'.
 */
export function updatePlanStatus(
  state: ForgeState,
  planId: string,
  status: PlanState['status'],
): ForgeState {
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
export function isResumable(state: ForgeState): boolean {
  if (state.status !== 'running') return false;

  return Object.values(state.plans).some(
    (p) => p.status !== 'completed' && p.status !== 'merged',
  );
}
