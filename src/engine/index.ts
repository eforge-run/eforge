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
  StalenessVerdict,
  ReconciliationReport,
  PrdValidationGap,
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
  injectPipelineIntoOrchestrationYaml,
} from './plan.js';
export type { WritePlanArtifactsOptions } from './plan.js';

// --- prompts ---
export { loadPrompt } from './prompts.js';

// --- backend ---
export type { AgentBackend, AgentRunOptions, ToolPreset } from './backend.js';
export { ClaudeSDKBackend } from './backends/claude-sdk.js';
export type { ClaudeSDKBackendOptions } from './backends/claude-sdk.js';

// --- eforge:region plan-02-pi-backend ---
export { PiBackend } from './backends/pi.js';
export type { PiBackendOptions } from './backends/pi.js';
export { PiMcpBridge, jsonSchemaToTypeBox } from './backends/pi-mcp-bridge.js';
export { discoverPiExtensions } from './backends/pi-extensions.js';
export type { PiExtensionConfig } from './backends/pi-extensions.js';
// --- eforge:endregion plan-02-pi-backend ---

// --- agents/common ---
export { parseClarificationBlocks, parseStalenessBlock, parseBuildConfigBlock } from './agents/common.js';
export type { StalenessVerdict as StalenessVerdictResult } from './agents/common.js';

// --- state ---
export { loadState, saveState, updatePlanStatus, isResumable } from './state.js';

// --- planner ---
export { runPlanner } from './agents/planner.js';
export type { PlannerOptions } from './agents/planner.js';

// --- agents/common (evaluation parsing) ---
export { parseEvaluationBlock } from './agents/common.js';
export type { EvaluationVerdict, EvaluationEvidence } from './agents/common.js';

// --- builder ---
export { builderImplement, builderEvaluate, formatBuilderParallelNotice } from './agents/builder.js';
export type { BuilderOptions } from './agents/builder.js';

// --- reviewer ---
export { runReview, parseReviewIssues, composeReviewPrompt } from './agents/reviewer.js';
export type { ReviewerOptions } from './agents/reviewer.js';

// --- review-fixer ---
export { runReviewFixer } from './agents/review-fixer.js';
export type { ReviewFixerOptions } from './agents/review-fixer.js';

// --- parallel-reviewer ---
export { runParallelReview, deduplicateIssues } from './agents/parallel-reviewer.js';
export type { ParallelReviewerOptions } from './agents/parallel-reviewer.js';

// --- review-heuristics ---
export { categorizeFiles, determineApplicableReviews, shouldParallelizeReview } from './review-heuristics.js';
export type { ReviewPerspective, FileCategories, DiffStats } from './review-heuristics.js';

// --- plan-reviewer ---
export { runPlanReview } from './agents/plan-reviewer.js';
export type { PlanReviewerOptions } from './agents/plan-reviewer.js';

// --- plan-evaluator ---
export { runPlanEvaluate, runCohesionEvaluate, runArchitectureEvaluate } from './agents/plan-evaluator.js';
export type { PlanEvaluatorOptions, CohesionEvaluatorOptions, ArchitectureEvaluatorOptions } from './agents/plan-evaluator.js';

// --- cohesion-reviewer ---
export { runCohesionReview } from './agents/cohesion-reviewer.js';
export type { CohesionReviewerOptions } from './agents/cohesion-reviewer.js';

// --- architecture-reviewer ---
export { runArchitectureReview } from './agents/architecture-reviewer.js';
export type { ArchitectureReviewerOptions } from './agents/architecture-reviewer.js';

// --- validation-fixer ---
export { runValidationFixer } from './agents/validation-fixer.js';
export type { ValidationFixerOptions } from './agents/validation-fixer.js';

// --- prd-validator ---
export { runPrdValidator } from './agents/prd-validator.js';
export type { PrdValidatorOptions } from './agents/prd-validator.js';

// --- doc-updater ---
export { runDocUpdater } from './agents/doc-updater.js';
export type { DocUpdaterOptions } from './agents/doc-updater.js';

// --- orchestration ---
export { Orchestrator } from './orchestrator.js';
export type { PlanRunner, ValidationFixer, PrdValidator, OrchestratorOptions } from './orchestrator.js';
export {
  computeWorktreeBase,
} from './worktree-ops.js';
export type { MergeResolver, MergeConflictInfo } from './worktree-ops.js';
export { WorktreeManager } from './worktree-manager.js';
export type { CleanupReport } from './worktree-manager.js';
export { Semaphore, AsyncEventQueue, runParallel } from './concurrency.js';
export type { ParallelTask, RunParallelOptions } from './concurrency.js';

// --- session ---
export { withSessionId, runSession } from './session.js';
export type { SessionOptions } from './session.js';

// --- hooks ---
export type { HookConfig } from './config.js';
export { withHooks, matchesPattern } from './hooks.js';

// --- config ---
export type { EforgeConfig, PartialEforgeConfig, PluginConfig, ModelRef, ReviewProfileConfig, BuildStageSpec, PiConfig } from './config.js';
export { DEFAULT_CONFIG, DEFAULT_REVIEW, AGENT_ROLES, eforgeConfigSchema, backendSchema, piConfigSchema, buildStageSpecSchema, reviewProfileConfigSchema, findConfigFile, resolveConfig, loadConfig, getUserConfigPath, mergePartialConfigs, validateConfigFile } from './config.js';
export type { TracingContext, SpanHandle, ToolCallHandle } from './tracing.js';
export { createTracingContext, createNoopTracingContext } from './tracing.js';

// --- pipeline ---
export type { PipelineContext, BuildStageContext, CompileStage, BuildStage } from './pipeline.js';
export { getCompileStage, getBuildStage, registerCompileStage, registerBuildStage, runCompilePipeline, runBuildPipeline, getCompileStageNames, getBuildStageNames } from './pipeline.js';

// --- prd-queue ---
export { loadQueue, resolveQueueOrder, validatePrdFrontmatter, enqueuePrd, cleanupCompletedPrd, inferTitle, movePrdToSubdir, isPrdRunning } from './prd-queue.js';
export type { QueuedPrd, PrdFrontmatter, EnqueuePrdOptions, EnqueuePrdResult } from './prd-queue.js';

// --- formatter ---
export { runFormatter } from './agents/formatter.js';
export type { FormatterOptions, FormatterResult } from './agents/formatter.js';

// --- staleness-assessor ---
export { runStalenessAssessor } from './agents/staleness-assessor.js';
export type { StalenessAssessorOptions } from './agents/staleness-assessor.js';

// --- eforge-core ---
export { EforgeEngine } from './eforge.js';
export type { EforgeEngineOptions, QueueOptions } from './eforge.js';
