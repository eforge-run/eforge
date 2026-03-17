// Foundation barrel — re-exports all shared types and utilities

// --- events ---
export { isAlwaysYieldedAgentEvent } from './events.js';
export type {
  EforgeEvent,
  QueueEvent,
  AgentRole,
  EforgeResult,
  ClarificationQuestion,
  ReviewIssue,
  PlanFile,
  OrchestrationConfig,
  EforgeState,
  PlanState,
  CompileOptions,
  BuildOptions,
  EnqueueOptions,
  EforgeStatus,
  ScopeAssessment,
  StalenessVerdict,
} from './events.js';

// --- plan ---
export {
  deriveNameFromSource,
  parsePlanFile,
  parseOrchestrationConfig,
  resolveDependencyGraph,
  validatePlanSet,
  validatePlanSetName,
  extractPlanTitle,
  detectValidationCommands,
  writePlanArtifacts,
} from './plan.js';
export type { WritePlanArtifactsOptions } from './plan.js';

// --- prompts ---
export { loadPrompt } from './prompts.js';

// --- backend ---
export type { AgentBackend, AgentRunOptions, ToolPreset } from './backend.js';
export { ClaudeSDKBackend } from './backends/claude-sdk.js';
export type { ClaudeSDKBackendOptions } from './backends/claude-sdk.js';

// --- agents/common ---
export { parseClarificationBlocks, parseProfileBlock, parseGeneratedProfileBlock, parseStalenessBlock } from './agents/common.js';
export type { ProfileSelection, GeneratedProfileBlock } from './agents/common.js';
export type { StalenessVerdict as StalenessVerdictResult } from './agents/common.js';

// --- state ---
export { loadState, saveState, updatePlanStatus, isResumable } from './state.js';

// --- planner ---
export { runPlanner } from './agents/planner.js';
export type { PlannerOptions } from './agents/planner.js';

// --- builder ---
export { builderImplement, builderEvaluate, parseEvaluationBlock } from './agents/builder.js';
export type { BuilderOptions, EvaluationVerdict, EvaluationEvidence } from './agents/builder.js';

// --- reviewer ---
export { runReview, parseReviewIssues, composeReviewPrompt } from './agents/reviewer.js';
export type { ReviewerOptions } from './agents/reviewer.js';

// --- parallel-reviewer ---
export { runParallelReview, deduplicateIssues } from './agents/parallel-reviewer.js';
export type { ParallelReviewerOptions } from './agents/parallel-reviewer.js';

// --- review-fixer ---
export { runReviewFixer } from './agents/review-fixer.js';
export type { ReviewFixerOptions } from './agents/review-fixer.js';

// --- review-heuristics ---
export { categorizeFiles, determineApplicableReviews, shouldParallelizeReview } from './review-heuristics.js';
export type { ReviewPerspective, FileCategories, DiffStats } from './review-heuristics.js';

// --- plan-reviewer ---
export { runPlanReview } from './agents/plan-reviewer.js';
export type { PlanReviewerOptions } from './agents/plan-reviewer.js';

// --- plan-evaluator ---
export { runPlanEvaluate } from './agents/plan-evaluator.js';
export type { PlanEvaluatorOptions } from './agents/plan-evaluator.js';

// --- cohesion-reviewer ---
export { runCohesionReview } from './agents/cohesion-reviewer.js';
export type { CohesionReviewerOptions } from './agents/cohesion-reviewer.js';

// --- cohesion-evaluator ---
export { runCohesionEvaluate } from './agents/cohesion-evaluator.js';
export type { CohesionEvaluatorOptions } from './agents/cohesion-evaluator.js';

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
export type { MergeResolver, MergeConflictInfo } from './worktree.js';
export { Semaphore, AsyncEventQueue, runParallel } from './concurrency.js';
export type { ParallelTask, RunParallelOptions } from './concurrency.js';

// --- session ---
export { withSessionId } from './session.js';
export type { SessionOptions } from './session.js';

// --- hooks ---
export type { HookConfig } from './config.js';
export { withHooks, matchesPattern } from './hooks.js';

// --- config ---
export type { EforgeConfig, PartialEforgeConfig, PluginConfig, ProfileConfig, ResolvedProfileConfig, AgentProfileConfig, ReviewProfileConfig, PartialProfileConfig } from './config.js';
export { DEFAULT_CONFIG, BUILTIN_PROFILES, findConfigFile, resolveConfig, loadConfig, getUserConfigPath, mergePartialConfigs, resolveProfileExtensions, parseProfilesFile, validateProfileConfig, resolveGeneratedProfile } from './config.js';
export type { TracingContext, SpanHandle, ToolCallHandle } from './tracing.js';
export { createTracingContext, createNoopTracingContext } from './tracing.js';

// --- pipeline ---
export type { PipelineContext, BuildStageContext, CompileStage, BuildStage } from './pipeline.js';
export { getCompileStage, getBuildStage, registerCompileStage, registerBuildStage, runCompilePipeline, runBuildPipeline, getCompileStageNames, getBuildStageNames } from './pipeline.js';

// --- prd-queue ---
export { loadQueue, resolveQueueOrder, validatePrdFrontmatter, enqueuePrd, inferTitle } from './prd-queue.js';
export type { QueuedPrd, PrdFrontmatter, PrdStatus, EnqueuePrdOptions, EnqueuePrdResult } from './prd-queue.js';

// --- formatter ---
export { runFormatter } from './agents/formatter.js';
export type { FormatterOptions, FormatterResult } from './agents/formatter.js';

// --- staleness-assessor ---
export { runStalenessAssessor } from './agents/staleness-assessor.js';
export type { StalenessAssessorOptions } from './agents/staleness-assessor.js';

// --- eforge-core ---
export { EforgeEngine } from './eforge.js';
export type { EforgeEngineOptions, QueueOptions } from './eforge.js';
