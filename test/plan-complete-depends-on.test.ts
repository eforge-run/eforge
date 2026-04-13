import { describe, it, expect } from 'vitest';
import { backfillDependsOn } from '@eforge-build/engine/pipeline';
import type { PlanFile, OrchestrationConfig } from '@eforge-build/engine/events';
import type { ResolvedProfileConfig } from '@eforge-build/engine/config';

const STUB_PROFILE: ResolvedProfileConfig = {
  description: 'stub',
  compile: ['planner'],
  build: ['implement', 'review', 'evaluate'],
  agents: {},
  review: { strategy: 'auto', perspectives: [], maxRounds: 1, evaluatorStrictness: 'standard' },
};

function makePlan(overrides: Partial<PlanFile> & { id: string }): PlanFile {
  return {
    name: overrides.id,
    dependsOn: [],
    branch: `feature/${overrides.id}`,
    body: 'plan body',
    filePath: `/plans/${overrides.id}.md`,
    ...overrides,
  };
}

function makeOrchConfig(plans: OrchestrationConfig['plans']): OrchestrationConfig {
  return {
    name: 'test',
    description: 'test',
    created: '2026-01-01',
    mode: 'excursion',
    baseBranch: 'main',
    profile: STUB_PROFILE,
    plans,
  };
}

describe('backfillDependsOn', () => {
  it('enriches plans with dependsOn from orchestration config', () => {
    const plans: PlanFile[] = [
      makePlan({ id: 'plan-01-core' }),
      makePlan({ id: 'plan-02-api' }),
      makePlan({ id: 'plan-03-ui' }),
    ];

    const orchConfig = makeOrchConfig([
      { id: 'plan-01-core', name: 'Core', dependsOn: [], branch: 'feature/core' },
      { id: 'plan-02-api', name: 'API', dependsOn: ['plan-01-core'], branch: 'feature/api' },
      { id: 'plan-03-ui', name: 'UI', dependsOn: ['plan-01-core', 'plan-02-api'], branch: 'feature/ui' },
    ]);

    const enriched = backfillDependsOn(plans, orchConfig);

    expect(enriched[0].dependsOn).toEqual([]);
    expect(enriched[1].dependsOn).toEqual(['plan-01-core']);
    expect(enriched[2].dependsOn).toEqual(['plan-01-core', 'plan-02-api']);
  });

  it('does not overwrite existing dependsOn in plan files', () => {
    const plans: PlanFile[] = [
      makePlan({ id: 'plan-01-core' }),
      makePlan({ id: 'plan-02-api', dependsOn: ['already-set'] }),
    ];

    const orchConfig = makeOrchConfig([
      { id: 'plan-01-core', name: 'Core', dependsOn: [], branch: 'feature/core' },
      { id: 'plan-02-api', name: 'API', dependsOn: ['plan-01-core'], branch: 'feature/api' },
    ]);

    const enriched = backfillDependsOn(plans, orchConfig);

    // Should keep the existing dependsOn since it's non-empty
    expect(enriched[1].dependsOn).toEqual(['already-set']);
  });

  it('handles plans not found in orchestration config gracefully', () => {
    const plans: PlanFile[] = [
      makePlan({ id: 'plan-01-unknown' }),
    ];

    const orchConfig = makeOrchConfig([
      { id: 'plan-01-core', name: 'Core', dependsOn: [], branch: 'feature/core' },
    ]);

    const enriched = backfillDependsOn(plans, orchConfig);

    // Plan not in orchestration config — returns unchanged
    expect(enriched[0].dependsOn).toEqual([]);
  });

  it('handles empty orchestration plans gracefully', () => {
    const plans: PlanFile[] = [
      makePlan({ id: 'plan-01-core' }),
    ];

    const orchConfig = makeOrchConfig([]);

    const enriched = backfillDependsOn(plans, orchConfig);

    expect(enriched[0].dependsOn).toEqual([]);
  });
});
