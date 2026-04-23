import type { AgentBackend, SdkPassthroughConfig } from '../backend.js';
import { pickSdkOptions } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent, type PrdValidationGap, type OrchestrationConfig, type PlanFile } from '../events.js';
import type { EforgeConfig, BuildStageSpec, ReviewProfileConfig } from '../config.js';
import { DEFAULT_REVIEW } from '../config.js';
import type { PipelineComposition } from '../schemas.js';
import type { TracingContext } from '../tracing.js';
import { loadPrompt } from '../prompts.js';
import { resolveAgentConfig } from '../pipeline.js';
import { ModelTracker } from '../model-tracker.js';

export interface GapCloserContext extends SdkPassthroughConfig {
  backend: AgentBackend;
  cwd: string;
  gaps: PrdValidationGap[];
  prdContent: string;
  completionPercent?: number;
  /** Build pipeline context for constructing BuildStageContext */
  pipelineContext: {
    config: EforgeConfig;
    pipeline: PipelineComposition;
    tracing: TracingContext;
    planSetName: string;
    orchConfig: OrchestrationConfig;
    planFileMap: Map<string, PlanFile>;
  };
  /** Function to run the build pipeline */
  runBuildPipeline: (ctx: import('../pipeline.js').BuildStageContext) => AsyncGenerator<EforgeEvent>;
  verbose?: boolean;
  abortController?: AbortController;
}

/**
 * Gap closer agent - two-stage approach:
 * 1. Plan generation agent produces a markdown plan scoped to the gaps
 * 2. Plan is executed through runBuildPipeline with implement + review-cycle stages
 */
export async function* runGapCloser(
  options: GapCloserContext,
): AsyncGenerator<EforgeEvent> {
  yield { timestamp: new Date().toISOString(), type: 'gap_close:start', gapCount: options.gaps.length, completionPercent: options.completionPercent };

  const gapsContext = options.gaps
    .map(
      (g) =>
        `Requirement: ${g.requirement}\nGap: ${g.explanation}`,
    )
    .join('\n\n---\n\n');

  const prompt = await loadPrompt('gap-closer', {
    prd: options.prdContent,
    gaps: gapsContext,
  }, options.promptAppend);

  // Stage 1: Plan generation
  const agentConfig = resolveAgentConfig('gap-closer', options.pipelineContext.config, options.pipelineContext.config.backend);
  const maxTurns = agentConfig.maxTurns ?? 20;

  let planMarkdown: string | undefined;

  try {
    let lastMessage = '';
    for await (const event of options.backend.run(
      {
        prompt,
        cwd: options.cwd,
        maxTurns,
        tools: 'coding',
        abortSignal: options.abortController?.signal,
        ...pickSdkOptions(options),
      },
      'gap-closer',
    )) {
      if (isAlwaysYieldedAgentEvent(event) || options.verbose) {
        yield event;
      }
      // Capture the last agent:message content as the plan output
      if (event.type === 'agent:message' && 'content' in event) {
        lastMessage = (event as { content: string }).content;
      }
    }

    // Extract plan from agent output
    if (lastMessage.trim()) {
      planMarkdown = lastMessage;
    }
  } catch (err) {
    // Re-throw abort errors so the orchestrator can respect cancellation
    if (err instanceof Error && err.name === 'AbortError') throw err;
    // Plan generation failure is non-fatal
    yield { timestamp: new Date().toISOString(), type: 'gap_close:complete', passed: false };
    return;
  }

  if (!planMarkdown) {
    // No parseable plan produced - non-fatal
    yield { timestamp: new Date().toISOString(), type: 'gap_close:complete', passed: false };
    return;
  }

  // Emit the generated plan so the monitor UI can display it
  yield { timestamp: new Date().toISOString(), type: 'gap_close:plan_ready', planBody: planMarkdown, gaps: options.gaps };

  // Stage 2: Execute the generated plan via runBuildPipeline
  const { config, pipeline, tracing, planSetName, orchConfig, planFileMap } = options.pipelineContext;

  const syntheticPlanFile: PlanFile = {
    id: 'gap-close',
    name: 'PRD Gap Close',
    dependsOn: [],
    branch: '',
    body: planMarkdown,
    filePath: '',
  };

  const build: BuildStageSpec[] = ['implement', 'review-cycle'];
  const review: ReviewProfileConfig = { ...DEFAULT_REVIEW };

  const buildCtx: import('../pipeline.js').BuildStageContext = {
    backend: options.backend,
    config,
    pipeline,
    tracing,
    cwd: options.cwd,
    planSetName,
    sourceContent: '',
    verbose: options.verbose,
    abortController: options.abortController,
    plans: Array.from(planFileMap.values()),
    expeditionModules: [],
    moduleBuildConfigs: new Map(),
    planId: 'gap-close',
    worktreePath: options.cwd,
    planFile: syntheticPlanFile,
    orchConfig,
    planEntry: orchConfig.plans.find((p) => p.id === 'gap-close'),
    reviewIssues: [],
    build,
    review,
    modelTracker: new ModelTracker(),
  };

  try {
    yield* options.runBuildPipeline(buildCtx);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    // Build pipeline failure is non-fatal for gap closing
    yield { timestamp: new Date().toISOString(), type: 'gap_close:complete', passed: false };
    return;
  }

  yield { timestamp: new Date().toISOString(), type: 'gap_close:complete', passed: true };
}
