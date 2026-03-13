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
export { builderImplement, builderEvaluate, parseEvaluationBlock } from './agents/builder.js';
export type { BuilderOptions, EvaluationVerdict } from './agents/builder.js';

// --- reviewer ---
export { runReview, parseReviewIssues, composeReviewPrompt } from './agents/reviewer.js';
export type { ReviewerOptions } from './agents/reviewer.js';

// --- orchestration ---
export { Orchestrator } from './orchestrator.js';
export type { PlanRunner, OrchestratorOptions } from './orchestrator.js';
export {
  computeWorktreeBase,
  createWorktree,
  removeWorktree,
  mergeWorktree,
  cleanupWorktrees,
} from './worktree.js';
export { Semaphore, AsyncEventQueue } from './concurrency.js';

// --- config ---
export type { ForgeConfig } from './config.js';
export { DEFAULT_CONFIG, findConfigFile, resolveConfig, loadConfig } from './config.js';
export type { TracingContext, SpanHandle } from './tracing.js';
export { createTracingContext, createNoopTracingContext } from './tracing.js';

// --- forge-core ---
export { ForgeEngine } from './forge.js';
export type { ForgeEngineOptions } from './forge.js';
