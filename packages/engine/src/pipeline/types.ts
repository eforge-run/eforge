/**
 * Pipeline types — context interfaces and stage type aliases.
 */

import type {
  EforgeEvent,
  PlanFile,
  ClarificationQuestion,
  ExpeditionModule,
  ReviewIssue,
  OrchestrationConfig,
} from '../events.js';
import type { EforgeConfig, BuildStageSpec, ReviewProfileConfig } from '../config.js';
import type { PipelineComposition } from '../schemas.js';
import type { AgentBackend } from '../backend.js';
import type { TracingContext } from '../tracing.js';
import type { ModelTracker } from '../model-tracker.js';

export interface PipelineContext {
  backend: AgentBackend;
  config: EforgeConfig;
  pipeline: PipelineComposition;
  tracing: TracingContext;
  cwd: string;
  planSetName: string;
  sourceContent: string;
  verbose?: boolean;
  auto?: boolean;
  abortController?: AbortController;
  onClarification?: (questions: ClarificationQuestion[]) => Promise<Record<string, string>>;

  /** Working directory for plan artifact commits (merge worktree during compile, defaults to cwd). */
  planCommitCwd?: string;

  /** The actual base branch from repoRoot (before worktree creation). When cwd is a merge worktree,
   *  `git rev-parse --abbrev-ref HEAD` returns the feature branch, not the real base. */
  baseBranch?: string;

  /** Accumulates model IDs from agent:start events during this pipeline run. Used for Models-Used: commit trailer. */
  modelTracker: ModelTracker;

  // Mutable state passed between stages
  plans: PlanFile[];
  expeditionModules: ExpeditionModule[];
  moduleBuildConfigs: Map<string, { build: BuildStageSpec[]; review: ReviewProfileConfig }>;
  /** Set by planner stage when plan:skip is emitted — halts further compile stages. */
  skipped?: boolean;
}

/** Context for build stages, extends PipelineContext with per-plan fields. */
export interface BuildStageContext extends PipelineContext {
  planId: string;
  worktreePath: string;
  planFile: PlanFile;
  orchConfig: OrchestrationConfig;
  reviewIssues: ReviewIssue[];
  /** Per-plan build stage sequence (resolved from per-plan config or pipeline fallback). */
  build: BuildStageSpec[];
  /** Per-plan review config (resolved from per-plan config or pipeline fallback). */
  review: ReviewProfileConfig;
  /** Cached plan entry from orchConfig for this planId. Populated once per build stage. */
  planEntry?: OrchestrationConfig['plans'][number];
  /** Set to true by the implement stage on failure — signals the pipeline runner to stop. */
  buildFailed?: boolean;
  /** Commit SHA captured before the implement stage runs — used as reset target by the evaluator. */
  preImplementCommit?: string;
}

export type CompileStage = (ctx: PipelineContext) => AsyncGenerator<EforgeEvent>;
export type BuildStage = (ctx: BuildStageContext) => AsyncGenerator<EforgeEvent>;

/** Phase a stage belongs to. */
export type StagePhase = 'compile' | 'build';

/** Rich metadata describing a pipeline stage for downstream consumers (e.g., pipeline composer). */
export interface StageDescriptor {
  /** Unique stage name (must match the registration key). */
  name: string;
  /** Which pipeline phase this stage belongs to. */
  phase: StagePhase;
  /** Human-readable description of what the stage does. */
  description: string;
  /** Guidance for when this stage should be included in a pipeline. */
  whenToUse: string;
  /** Rough cost hint: 'low', 'medium', or 'high'. */
  costHint: 'low' | 'medium' | 'high';
  /** Stage names that must appear before this stage in the pipeline (same phase). */
  predecessors?: string[];
  /** Stage names that conflict with this stage (cannot both appear). */
  conflictsWith?: string[];
  /** Whether this stage can run in a parallel group with other stages. Defaults to true. */
  parallelizable?: boolean;
}
