/**
 * Handlers for compile-phase planning events.
 *
 * planning:complete — seeds planStatuses with 'plan' for every submitted plan
 *   and synthesizes earlyOrchestration so the UI can render the dependency graph
 *   before the SWR-fetched orchestration config arrives.
 *   All other planning:* variants have no state effect and live in IGNORED_EVENT_TYPES.
 */
import type { BuildStageSpec, ReviewProfileConfig, OrchestrationConfig } from '../types';
import type { EventHandler } from './handler-types';

export const handlePlanningComplete: EventHandler<'planning:complete'> = (event, state) => {
  const updated = { ...state.planStatuses };
  for (const plan of event.plans) {
    updated[plan.id] = 'plan';
  }

  // Build a lookup for planConfigs by id so we can enrich each plan entry.
  const planConfigsById: Record<string, { build?: BuildStageSpec[]; review?: ReviewProfileConfig }> = {};
  for (const pc of event.planConfigs ?? []) {
    planConfigsById[pc.id] = pc;
  }

  const defaultReview: ReviewProfileConfig = {
    strategy: 'auto',
    perspectives: [],
    maxRounds: 1,
    evaluatorStrictness: 'standard',
  };

  // Synthesize an early orchestration so the UI can render dependency bars,
  // tooltips, and graph edges immediately — before the SWR fetch returns.
  // mode: 'compile' and pipeline.scope: 'plan' identify this as a compile-mode
  // synthesized config (as opposed to the expedition variant).
  const earlyOrchestration = {
    name: '',
    description: '',
    created: '',
    mode: 'compile',
    baseBranch: '',
    pipeline: {
      scope: 'plan',
      compile: [] as string[],
      defaultBuild: [] as BuildStageSpec[],
      defaultReview,
      rationale: '',
    },
    plans: event.plans.map((plan) => {
      const config = planConfigsById[plan.id];
      return {
        id: plan.id,
        name: plan.name,
        dependsOn: plan.dependsOn,
        branch: plan.branch,
        build: config?.build ?? ([] as BuildStageSpec[]),
        review: config?.review ?? defaultReview,
      };
    }),
  } as unknown as OrchestrationConfig;

  return { planStatuses: updated, earlyOrchestration };
};
