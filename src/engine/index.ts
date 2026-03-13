// Foundation barrel — re-exports all shared types and utilities

// --- events ---
export type {
  ForgeEvent,
  AgentRole,
  ForgeResult,
  ClarificationQuestion,
  ReviewIssue,
  PlanFile,
  OrchestrationConfig,
  ForgeState,
  PlanState,
  PlanOptions,
  BuildOptions,
  ReviewOptions,
  ForgeStatus,
} from './events.js';

// --- plan ---
export {
  parsePlanFile,
  parseOrchestrationConfig,
  resolveDependencyGraph,
  validatePlanSet,
} from './plan.js';

// --- prompts ---
export { loadPrompt } from './prompts.js';

// --- agents/common ---
export { mapSDKMessages, parseClarificationBlocks } from './agents/common.js';

// --- state ---
export { loadState, saveState, updatePlanStatus, isResumable } from './state.js';

// --- planner ---
export { runPlanner } from './agents/planner.js';
export type { PlannerOptions } from './agents/planner.js';

// --- builder ---

// --- reviewer ---

// --- orchestration ---

// --- config ---

// --- forge-core ---
