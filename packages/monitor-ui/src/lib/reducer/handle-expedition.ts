/**
 * Handlers for expedition planning events.
 *
 * expedition:architecture:complete — synthesizes an early OrchestrationConfig from
 *   the module list and seeds moduleStatuses to 'pending'. This gives the UI a
 *   plan graph to render before the actual orchestration.yaml is compiled.
 *
 * expedition:module:start    — marks a module as 'planning'.
 * expedition:module:complete — marks a module as 'complete'.
 */
import type { BuildStageSpec } from '../types';
import type { EventHandler } from './handler-types';

export const handleExpeditionArchitectureComplete: EventHandler<'expedition:architecture:complete'> = (event, _state) => {
  const moduleStatuses: Record<string, 'pending' | 'planning' | 'complete'> = {};
  for (const mod of event.modules) {
    moduleStatuses[mod.id] = 'pending';
  }

  const earlyOrchestration = {
    name: '',
    description: '',
    created: '',
    mode: 'expedition' as const,
    baseBranch: '',
    pipeline: {
      scope: 'expedition' as const,
      compile: [] as string[],
      defaultBuild: [] as BuildStageSpec[],
      defaultReview: {
        strategy: 'auto' as const,
        perspectives: [],
        maxRounds: 1,
        evaluatorStrictness: 'standard' as const,
      },
      rationale: '',
    },
    plans: event.modules.map((mod) => ({
      id: mod.id,
      name: mod.description,
      dependsOn: mod.dependsOn,
      branch: '',
      build: [] as BuildStageSpec[],
      review: {
        strategy: 'auto' as const,
        perspectives: [],
        maxRounds: 1,
        evaluatorStrictness: 'standard' as const,
      },
    })),
  };

  return {
    expeditionModules: event.modules,
    moduleStatuses,
    earlyOrchestration,
  };
};

export const handleExpeditionModuleStart: EventHandler<'expedition:module:start'> = (event, state) => ({
  moduleStatuses: { ...state.moduleStatuses, [event.moduleId]: 'planning' },
});

export const handleExpeditionModuleComplete: EventHandler<'expedition:module:complete'> = (event, state) => ({
  moduleStatuses: { ...state.moduleStatuses, [event.moduleId]: 'complete' },
});
