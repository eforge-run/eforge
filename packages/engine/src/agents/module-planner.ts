import type { AgentBackend, SdkPassthroughConfig } from '../backend.js';
import { pickSdkOptions } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent, type ClarificationQuestion } from '../events.js';
import { loadPrompt } from '../prompts.js';

export interface ModulePlannerOptions extends SdkPassthroughConfig {
  backend: AgentBackend;
  cwd: string;
  planSetName: string;
  moduleId: string;
  moduleDescription: string;
  moduleDependsOn: string[];
  architectureContent: string;
  sourceContent: string;
  /** Concatenated plan content from completed dependency modules */
  dependencyPlanContent?: string;
  verbose?: boolean;
  onClarification?: (questions: ClarificationQuestion[]) => Promise<Record<string, string>>;
  abortController?: AbortController;
  /** Override max conversation turns (default: 20) */
  maxTurns?: number;
  /** Plan output directory (defaults to 'eforge/plans'). */
  outputDir?: string;
}

/**
 * Run the module planner agent for a single expedition module.
 * One-shot query that reads the architecture and writes a detailed
 * module plan to plans/{planSetName}/modules/{moduleId}.md.
 */
export async function* runModulePlanner(
  options: ModulePlannerOptions,
): AsyncGenerator<EforgeEvent> {
  yield { timestamp: new Date().toISOString(), type: 'expedition:module:start', moduleId: options.moduleId };

  const prompt = await loadPrompt('module-planner', {
    source: options.sourceContent,
    planSetName: options.planSetName,
    moduleId: options.moduleId,
    moduleDescription: options.moduleDescription,
    moduleDependsOn: options.moduleDependsOn.join(', ') || 'none',
    architectureContent: options.architectureContent,
    dependencyPlans: options.dependencyPlanContent || 'No dependencies - this module is planned independently.',
    cwd: options.cwd,
    outputDir: options.outputDir ?? 'eforge/plans',
  });

  for await (const event of options.backend.run(
    { prompt, cwd: options.cwd, maxTurns: options.maxTurns ?? 20, tools: 'coding', abortSignal: options.abortController?.signal, ...pickSdkOptions(options) },
    'module-planner',
  )) {
    // Always yield agent:result + tool events for tracing; gate streaming text on verbose
    if (isAlwaysYieldedAgentEvent(event) || options.verbose) {
      yield event;
    }
  }

  yield { timestamp: new Date().toISOString(), type: 'expedition:module:complete', moduleId: options.moduleId };
}
