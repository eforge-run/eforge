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

// --- builder ---

// --- reviewer ---

// --- orchestration ---

// --- config ---
export type { ForgeConfig } from './config.js';
export { DEFAULT_CONFIG, findConfigFile, resolveConfig, loadConfig } from './config.js';
export type { TracingContext, SpanHandle } from './tracing.js';
export { createTracingContext, createNoopTracingContext } from './tracing.js';

// --- forge-core ---
