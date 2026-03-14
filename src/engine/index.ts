// Foundation barrel — re-exports all shared types and utilities

// --- events ---
export type {
  EforgeEvent,
  AgentRole,
  EforgeResult,
  ClarificationQuestion,
  ReviewIssue,
  PlanFile,
  OrchestrationConfig,
  EforgeState,
  PlanState,
  PlanOptions,
  BuildOptions,
  EforgeStatus,
  ScopeAssessment,
} from './events.js';

// --- plan ---
export {
  deriveNameFromSource,
  parsePlanFile,
  parseOrchestrationConfig,
  resolveDependencyGraph,
  validatePlanSet,
  validatePlanSetName,
} from './plan.js';

// --- prompts ---
export { loadPrompt } from './prompts.js';

// --- backend ---
export type { AgentBackend, AgentRunOptions, ToolPreset } from './backend.js';
export { ClaudeSDKBackend } from './backends/claude-sdk.js';
export type { ClaudeSDKBackendOptions } from './backends/claude-sdk.js';

// --- agents/common ---
export { parseClarificationBlocks } from './agents/common.js';

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

// --- plan-reviewer ---
export { runPlanReview } from './agents/plan-reviewer.js';
export type { PlanReviewerOptions } from './agents/plan-reviewer.js';

// --- plan-evaluator ---
export { runPlanEvaluate } from './agents/plan-evaluator.js';
export type { PlanEvaluatorOptions } from './agents/plan-evaluator.js';

// --- validation-fixer ---
export { runValidationFixer } from './agents/validation-fixer.js';
export type { ValidationFixerOptions } from './agents/validation-fixer.js';

// --- orchestration ---
export { Orchestrator } from './orchestrator.js';
export type { PlanRunner, ValidationFixer, OrchestratorOptions } from './orchestrator.js';
export {
  computeWorktreeBase,
  createWorktree,
  removeWorktree,
  mergeWorktree,
  cleanupWorktrees,
} from './worktree.js';
export { Semaphore, AsyncEventQueue } from './concurrency.js';

// --- config ---
export type { EforgeConfig, PluginConfig } from './config.js';
export { DEFAULT_CONFIG, findConfigFile, resolveConfig, loadConfig } from './config.js';
export type { TracingContext, SpanHandle, ToolCallHandle } from './tracing.js';
export { createTracingContext, createNoopTracingContext } from './tracing.js';

// --- eforge-core ---
export { EforgeEngine } from './eforge.js';
export type { EforgeEngineOptions } from './eforge.js';
