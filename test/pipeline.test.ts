/**
 * Pipeline — stage registry, compile pipeline, build pipeline.
 *
 * Tests the pipeline infrastructure: stage registration/retrieval,
 * pipeline runners (compile and build), agent config threading,
 * and mutable context passing between stages.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { EforgeEvent, PlanFile, OrchestrationConfig, ReviewIssue } from '@eforge-build/engine/events';
import type { EforgeConfig } from '@eforge-build/engine/config';
import type { PipelineComposition } from '@eforge-build/engine/schemas';
import { DEFAULT_CONFIG, DEFAULT_REVIEW } from '@eforge-build/engine/config';

const DEFAULT_BUILD = ['implement', 'review-cycle'];

const TEST_PIPELINE: PipelineComposition = {
  scope: 'excursion',
  compile: ['planner', 'plan-review-cycle'],
  defaultBuild: DEFAULT_BUILD,
  defaultReview: DEFAULT_REVIEW,
  rationale: 'test pipeline',
};
import { createNoopTracingContext } from '@eforge-build/engine/tracing';
import { ModelTracker } from '@eforge-build/engine/model-tracker';
import {
  getCompileStage,
  getBuildStage,
  getCompileStageNames,
  registerCompileStage,
  registerBuildStage,
  runCompilePipeline,
  runBuildPipeline,
  type PipelineContext,
  type BuildStageContext,
  type CompileStage,
  type BuildStage,
  type StageDescriptor,
} from '@eforge-build/engine/pipeline';
import { StubHarness } from './stub-harness.js';
import { singletonRegistry } from '@eforge-build/engine/agent-runtime-registry';
import { useTempDir } from './test-tmpdir.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal StageDescriptor for testing. */
function testDescriptor(name: string, phase: 'compile' | 'build'): StageDescriptor {
  return { name, phase, description: `Test ${name}`, whenToUse: 'testing', costHint: 'low' };
}

/** Collect all events from an async generator. */
async function collect(gen: AsyncGenerator<EforgeEvent>): Promise<EforgeEvent[]> {
  const events: EforgeEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

/** Create a minimal PipelineContext for testing. */
function makePipelineCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    agentRuntimes: singletonRegistry({} as AgentHarness),
    config: DEFAULT_CONFIG,
    pipeline: TEST_PIPELINE,
    tracing: createNoopTracingContext(),
    cwd: '/tmp/test',
    planSetName: 'test-plan',
    sourceContent: '# Test',
    modelTracker: new ModelTracker(),
    plans: [],
    expeditionModules: [],
    moduleBuildConfigs: new Map(),
    ...overrides,
  };
}

/** Create a minimal BuildStageContext for testing. */
function makeBuildCtx(overrides: Partial<BuildStageContext> = {}): BuildStageContext {
  const planFile: PlanFile = {
    id: 'plan-01',
    name: 'Test Plan',
    dependsOn: [],
    branch: 'test/plan-01',
    body: '# Plan body',
    filePath: '/tmp/test/plans/test-plan/plan-01.md',
  };
  const orchConfig: OrchestrationConfig = {
    name: 'test-plan',
    description: 'Test',
    created: new Date().toISOString(),
    mode: 'errand',
    baseBranch: 'main',
    pipeline: TEST_PIPELINE,
    plans: [{ id: 'plan-01', name: 'Test Plan', dependsOn: [], branch: 'test/plan-01', build: DEFAULT_BUILD, review: DEFAULT_REVIEW }],
  };

  return {
    agentRuntimes: singletonRegistry({} as AgentHarness),
    config: DEFAULT_CONFIG,
    pipeline: overrides?.pipeline ?? TEST_PIPELINE,
    tracing: createNoopTracingContext(),
    cwd: '/tmp/test',
    planSetName: 'test-plan',
    sourceContent: '',
    modelTracker: new ModelTracker(),
    plans: [planFile],
    expeditionModules: [],
    moduleBuildConfigs: new Map(),
    planId: 'plan-01',
    worktreePath: '/tmp/test-worktree',
    planFile,
    orchConfig,
    reviewIssues: [],
    build: overrides?.build ?? DEFAULT_BUILD,
    review: overrides?.review ?? DEFAULT_REVIEW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Stage Registry Tests
// ---------------------------------------------------------------------------

describe('stage registry', () => {
  it('getCompileStage returns a function for built-in planner stage', () => {
    const stage = getCompileStage('planner');
    expect(typeof stage).toBe('function');
  });

  it('getCompileStage throws for nonexistent stage', () => {
    expect(() => getCompileStage('nonexistent')).toThrow('Unknown compile stage');
  });

  it('getBuildStage returns a function for built-in implement stage', () => {
    const stage = getBuildStage('implement');
    expect(typeof stage).toBe('function');
  });

  it('getBuildStage throws for nonexistent stage', () => {
    expect(() => getBuildStage('nonexistent')).toThrow('Unknown build stage');
  });

  it('registerCompileStage makes stage retrievable', () => {
    const fn: CompileStage = async function* () { /* noop */ };
    registerCompileStage(testDescriptor('test-compile-stage', 'compile'), fn);
    expect(getCompileStage('test-compile-stage')).toBe(fn);
  });

  it('registerBuildStage makes stage retrievable', () => {
    const fn: BuildStage = async function* () { /* noop */ };
    registerBuildStage(testDescriptor('test-build-stage', 'build'), fn);
    expect(getBuildStage('test-build-stage')).toBe(fn);
  });

  it('all built-in compile stages are registered', () => {
    const builtinCompileStages = ['planner', 'plan-review-cycle', 'architecture-review-cycle', 'module-planning', 'cohesion-review-cycle', 'compile-expedition'];
    for (const name of builtinCompileStages) {
      expect(() => getCompileStage(name)).not.toThrow();
      expect(typeof getCompileStage(name)).toBe('function');
    }
  });

  it('all built-in build stages are registered', () => {
    const builtinBuildStages = ['implement', 'review', 'evaluate', 'validate', 'doc-update'];
    for (const name of builtinBuildStages) {
      expect(() => getBuildStage(name)).not.toThrow();
      expect(typeof getBuildStage(name)).toBe('function');
    }
  });
});

// ---------------------------------------------------------------------------
// runCompilePipeline Tests
// ---------------------------------------------------------------------------

describe('runCompilePipeline', () => {
  it('calls stages in order from pipeline compile list', async () => {
    const order: string[] = [];

    registerCompileStage(testDescriptor('test-stage-a', 'compile'), async function* () {
      order.push('a');
      yield { type: 'planning:progress', message: 'stage-a' };
    });
    registerCompileStage(testDescriptor('test-stage-b', 'compile'), async function* () {
      order.push('b');
      yield { type: 'planning:progress', message: 'stage-b' };
    });

    const pipeline: PipelineComposition = {
      ...TEST_PIPELINE,
      compile: ['test-stage-a', 'test-stage-b'],
    };

    const ctx = makePipelineCtx({ pipeline });
    const events = await collect(runCompilePipeline(ctx));

    expect(order).toEqual(['a', 'b']);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'planning:progress', message: 'stage-a' });
    expect(events[1]).toEqual({ type: 'planning:progress', message: 'stage-b' });
  });

  it('yields zero events with empty compile list', async () => {
    const pipeline: PipelineComposition = {
      ...TEST_PIPELINE,
      compile: [],
    };

    const ctx = makePipelineCtx({ pipeline });
    const events = await collect(runCompilePipeline(ctx));

    expect(events).toHaveLength(0);
  });

  it('skipped flag halts pipeline after the stage that sets it', async () => {
    const stagesRun: string[] = [];

    registerCompileStage(testDescriptor('test-skip-planner', 'compile'), async function* (ctx) {
      stagesRun.push('planner');
      ctx.skipped = true;
      yield { type: 'planning:skip', reason: 'Already done' };
    });
    registerCompileStage(testDescriptor('test-skip-review', 'compile'), async function* () {
      stagesRun.push('review');
      yield { type: 'planning:progress', message: 'review' };
    });

    const pipeline: PipelineComposition = {
      ...TEST_PIPELINE,
      compile: ['test-skip-planner', 'test-skip-review'],
    };

    const ctx = makePipelineCtx({ pipeline });
    const events = await collect(runCompilePipeline(ctx));

    expect(stagesRun).toEqual(['planner']);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'planning:skip', reason: 'Already done' });
  });

  it('throws for unknown stage name in compile list', async () => {
    const pipeline: PipelineComposition = {
      ...TEST_PIPELINE,
      compile: ['unknown-stage-xyz'],
    };

    const ctx = makePipelineCtx({ pipeline });

    await expect(collect(runCompilePipeline(ctx))).rejects.toThrow('Unknown compile stage');
  });

  it('with planner only (no plan-review-cycle), only planner stage runs', async () => {
    const stagesRun: string[] = [];

    registerCompileStage(testDescriptor('test-planner-only', 'compile'), async function* () {
      stagesRun.push('planner');
      yield { type: 'planning:progress', message: 'planned' };
    });

    const pipeline: PipelineComposition = {
      ...TEST_PIPELINE,
      compile: ['test-planner-only'],
    };

    const ctx = makePipelineCtx({ pipeline });
    const events = await collect(runCompilePipeline(ctx));

    expect(stagesRun).toEqual(['planner']);
    expect(events).toHaveLength(1);
  });

  it('restarts loop when a stage replaces ctx.pipeline.compile', async () => {
    const stagesRun: string[] = [];

    // Stage that mutates the compile list to ['stage-x']
    registerCompileStage(testDescriptor('test-mutator', 'compile'), async function* (ctx) {
      stagesRun.push('mutator');
      ctx.pipeline = { ...ctx.pipeline, compile: ['test-stage-x'] };
      yield { type: 'planning:progress', message: 'mutated' };
    });

    registerCompileStage(testDescriptor('test-stage-x', 'compile'), async function* () {
      stagesRun.push('stage-x');
      yield { type: 'planning:progress', message: 'stage-x ran' };
    });

    const pipeline: PipelineComposition = {
      ...TEST_PIPELINE,
      compile: ['test-mutator'],
    };

    const ctx = makePipelineCtx({ pipeline });
    const events = await collect(runCompilePipeline(ctx));

    expect(stagesRun).toEqual(['mutator', 'stage-x']);
    expect(events.map((e) => (e as any).message)).toEqual(['mutated', 'stage-x ran']);
  });

  it('does not run old remaining stages after compile list replacement', async () => {
    const stagesRun: string[] = [];

    // First stage replaces compile list, removing 'test-old-next'
    registerCompileStage(testDescriptor('test-replacer', 'compile'), async function* (ctx) {
      stagesRun.push('replacer');
      ctx.pipeline = { ...ctx.pipeline, compile: ['test-new-stage'] };
      yield { type: 'planning:progress', message: 'replaced' };
    });

    registerCompileStage(testDescriptor('test-old-next', 'compile'), async function* () {
      stagesRun.push('old-next');
      yield { type: 'planning:progress', message: 'should not run' };
    });

    registerCompileStage(testDescriptor('test-new-stage', 'compile'), async function* () {
      stagesRun.push('new-stage');
      yield { type: 'planning:progress', message: 'new stage ran' };
    });

    const pipeline: PipelineComposition = {
      ...TEST_PIPELINE,
      compile: ['test-replacer', 'test-old-next'],
    };

    const ctx = makePipelineCtx({ pipeline });
    const events = await collect(runCompilePipeline(ctx));

    // 'test-old-next' should NOT have run; only replacer + new-stage
    expect(stagesRun).toEqual(['replacer', 'new-stage']);
    expect(events.map((e) => (e as any).message)).toEqual(['replaced', 'new stage ran']);
  });

  it('does not re-run a stage when its composer shrinks the compile list but keeps the stage at position 0', async () => {
    // Regression: plannerStage's composer call shrinks compile from
    // ['planner', 'plan-review-cycle'] to ['planner']. The planner stage then
    // runs the planner agent and writes plan files. Previously the compile
    // loop would detect the list change and restart at i=0, re-running
    // plannerStage (and its composer) a second time — producing a duplicate
    // set of plan files with a conflicting ID.
    let runCount = 0;

    registerCompileStage(testDescriptor('test-shrink-planner', 'compile'), async function* (ctx) {
      runCount++;
      // Simulate composer shrinking the list before running the agent body
      ctx.pipeline = { ...ctx.pipeline, compile: ['test-shrink-planner'] };
      yield { type: 'planning:progress', message: `planner ran ${runCount}` };
    });

    registerCompileStage(testDescriptor('test-shrink-review', 'compile'), async function* () {
      yield { type: 'planning:progress', message: 'review ran' };
    });

    const pipeline: PipelineComposition = {
      ...TEST_PIPELINE,
      compile: ['test-shrink-planner', 'test-shrink-review'],
    };

    const ctx = makePipelineCtx({ pipeline });
    await collect(runCompilePipeline(ctx));

    // Planner stage must run exactly once — no duplicate invocation from a loop restart.
    expect(runCount).toBe(1);
  });

  it('does not restart when a stage replaces ctx.pipeline with the same compile stages', async () => {
    let runCount = 0;

    // Stage that replaces ctx.pipeline (new object reference) but keeps the same stages
    registerCompileStage(testDescriptor('test-same-replace', 'compile'), async function* (ctx) {
      runCount++;
      ctx.pipeline = { ...ctx.pipeline, compile: ['test-same-replace', 'test-after'] };
      yield { type: 'planning:progress', message: `ran ${runCount}` };
    });

    registerCompileStage(testDescriptor('test-after', 'compile'), async function* () {
      yield { type: 'planning:progress', message: 'after' };
    });

    const pipeline: PipelineComposition = {
      ...TEST_PIPELINE,
      compile: ['test-same-replace', 'test-after'],
    };

    const ctx = makePipelineCtx({ pipeline });
    await collect(runCompilePipeline(ctx));

    // Stage should run exactly once - no restart despite new object reference
    expect(runCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// plannerStage expedition wiring (regression)
// ---------------------------------------------------------------------------

describe('plannerStage expedition wiring', () => {
  const makeTempDir = useTempDir('eforge-planner-stage-expedition-');

  const ARCH_PAYLOAD = {
    architecture: '# Architecture\n\nTest architecture.',
    modules: [
      { id: 'foundation', description: 'Core types and utilities', dependsOn: [] },
      { id: 'auth', description: 'Authentication system', dependsOn: ['foundation'] },
    ],
    index: {
      name: 'test-plan',
      description: 'Test',
      mode: 'expedition' as const,
      validate: [],
      modules: {
        foundation: { description: 'Core types and utilities', depends_on: [] },
        auth: { description: 'Authentication system', depends_on: ['foundation'] },
      },
    },
  };

  function composerResponse(compile: string[]) {
    return {
      resultText: JSON.stringify({
        scope: 'expedition',
        compile,
        defaultBuild: ['implement'],
        defaultReview: {
          strategy: 'single',
          perspectives: ['general'],
          maxRounds: 1,
          evaluatorStrictness: 'standard',
        },
        rationale: 'test',
      }),
    };
  }

  function plannerSubmitArchResponse() {
    return {
      toolCalls: [{
        tool: 'submit_architecture',
        toolUseId: 'tu-1',
        input: ARCH_PAYLOAD,
        output: '',
      }],
      text: 'Architecture submitted.',
    };
  }

  it('captures expedition modules into ctx.expeditionModules after planner submits architecture', async () => {
    const backend = new StubHarness([
      composerResponse(['planner', 'architecture-review-cycle', 'module-planning', 'cohesion-review-cycle', 'compile-expedition']),
      plannerSubmitArchResponse(),
    ]);

    const ctx = makePipelineCtx({ agentRuntimes: singletonRegistry(backend), cwd: makeTempDir(), auto: true });
    const plannerStageFn = getCompileStage('planner');

    await collect(plannerStageFn(ctx));

    expect(ctx.expeditionModules).toHaveLength(2);
    expect(ctx.expeditionModules.map((m) => m.id)).toEqual(['foundation', 'auth']);
    expect(ctx.expeditionModules[1].dependsOn).toEqual(['foundation']);
  });

  it('throws when planner produces modules but compile-expedition is missing from the pipeline', async () => {
    const backend = new StubHarness([
      composerResponse(['planner', 'architecture-review-cycle']),
      plannerSubmitArchResponse(),
    ]);

    const ctx = makePipelineCtx({ agentRuntimes: singletonRegistry(backend), cwd: makeTempDir(), auto: true });
    const plannerStageFn = getCompileStage('planner');

    await expect(collect(plannerStageFn(ctx))).rejects.toThrow(/compile-expedition/);
  });
});

// ---------------------------------------------------------------------------
// runBuildPipeline Tests
// ---------------------------------------------------------------------------

describe('runBuildPipeline', () => {
  it('emits build:start and build:complete around stages', async () => {
    registerBuildStage(testDescriptor('test-impl', 'build'), async function* (ctx) {
      yield { type: 'plan:build:implement:start', planId: ctx.planId };
      yield { type: 'plan:build:implement:complete', planId: ctx.planId };
    });

    const ctx = makeBuildCtx({ build: ['test-impl'] });
    const events = await collect(runBuildPipeline(ctx));

    expect(events[0]).toMatchObject({ type: 'plan:build:start', planId: 'plan-01' });
    expect(events[events.length - 1]).toMatchObject({ type: 'plan:build:complete', planId: 'plan-01' });
  });

  it('calls all four default build stages in order', async () => {
    const order: string[] = [];

    registerBuildStage(testDescriptor('test-b-impl', 'build'), async function* () {
      order.push('implement');
      yield { type: 'planning:progress', message: 'impl' };
    });
    registerBuildStage(testDescriptor('test-b-review', 'build'), async function* () {
      order.push('review');
      yield { type: 'planning:progress', message: 'review' };
    });
    registerBuildStage(testDescriptor('test-b-eval', 'build'), async function* () {
      order.push('evaluate');
      yield { type: 'planning:progress', message: 'eval' };
    });

    const ctx = makeBuildCtx({ build: ['test-b-impl', 'test-b-review', 'test-b-eval'] });
    const events = await collect(runBuildPipeline(ctx));

    expect(order).toEqual(['implement', 'review', 'evaluate']);
    // build:start + 3 stage events + build:complete = 5
    expect(events).toHaveLength(5);
    expect(events[0].type).toBe('plan:build:start');
    expect(events[events.length - 1].type).toBe('plan:build:complete');
  });

  it('throws for unknown stage name in build list', async () => {
    const ctx = makeBuildCtx({ build: ['unknown-build-stage-xyz'] });

    await expect(collect(runBuildPipeline(ctx))).rejects.toThrow('Unknown build stage');
  });

  it('with custom profile build stages (implement + validate)', async () => {
    registerBuildStage(testDescriptor('test-custom-impl', 'build'), async function* (ctx) {
      yield { type: 'plan:build:implement:start', planId: ctx.planId };
    });
    registerBuildStage(testDescriptor('test-custom-validate', 'build'), async function* () {
      yield { type: 'planning:progress', message: 'validate' };
    });

    const ctx = makeBuildCtx({ build: ['test-custom-impl', 'test-custom-validate'] });
    const events = await collect(runBuildPipeline(ctx));

    expect(events[0].type).toBe('plan:build:start');
    expect(events[1]).toMatchObject({ type: 'plan:build:implement:start', planId: 'plan-01' });
    expect(events[2]).toMatchObject({ type: 'planning:progress', message: 'validate' });
    expect(events[3]).toMatchObject({ type: 'plan:build:complete', planId: 'plan-01' });
  });
});

// ---------------------------------------------------------------------------
// Mutable Context Tests
// ---------------------------------------------------------------------------

describe('PipelineContext mutable state', () => {
  it('plans set by first stage are readable by subsequent stage', async () => {
    const testPlan: PlanFile = {
      id: 'plan-01',
      name: 'Test',
      dependsOn: [],
      branch: 'test',
      body: '# test',
      filePath: '/tmp/test.md',
    };

    registerCompileStage(testDescriptor('test-set-plans', 'compile'), async function* (ctx) {
      ctx.plans = [testPlan];
      yield { type: 'planning:progress', message: 'set-plans' };
    });

    let readPlans: PlanFile[] = [];
    registerCompileStage(testDescriptor('test-read-plans', 'compile'), async function* (ctx) {
      readPlans = ctx.plans;
      yield { type: 'planning:progress', message: 'read-plans' };
    });

    const pipeline: PipelineComposition = {
      ...TEST_PIPELINE,
      compile: ['test-set-plans', 'test-read-plans'],
    };

    const ctx = makePipelineCtx({ pipeline });
    await collect(runCompilePipeline(ctx));

    expect(readPlans).toEqual([testPlan]);
  });
});

// ---------------------------------------------------------------------------
// Agent Config Threading Tests
// ---------------------------------------------------------------------------

describe('agent config threading', () => {
  it('resolveAgentConfig uses role default for builder', async () => {
    const { resolveAgentConfig } = await import('@eforge-build/engine/pipeline');
    const result = resolveAgentConfig('builder', DEFAULT_CONFIG);
    expect(result.maxTurns).toBe(80); // builder role default
  });

  it('resolveAgentConfig returns role default when no profile config set', async () => {
    const { resolveAgentConfig } = await import('@eforge-build/engine/pipeline');

    // Builder has a role default of 80, so it should return 80 (not the global 30)
    const result = resolveAgentConfig('builder', DEFAULT_CONFIG);
    expect(result.maxTurns).toBe(80);
  });

  it('resolveAgentConfig returns role default over global config', async () => {
    const { resolveAgentConfig } = await import('@eforge-build/engine/pipeline');

    // Builder has a role default of 80 - even with global maxTurns set differently
    const config = { ...DEFAULT_CONFIG, agents: { ...DEFAULT_CONFIG.agents, maxTurns: 25 } };
    const result = resolveAgentConfig('builder', config);
    expect(result.maxTurns).toBe(80);
  });

  it('resolveAgentConfig falls back to global maxTurns for roles without a specific default', async () => {
    const { resolveAgentConfig } = await import('@eforge-build/engine/pipeline');

    const config = { ...DEFAULT_CONFIG, agents: { ...DEFAULT_CONFIG.agents, maxTurns: 42 } };
    // reviewer has no role default, so it should fall back to the global config value
    const result = resolveAgentConfig('reviewer', config);
    expect(result.maxTurns).toBe(42);
  });

  it('resolveAgentConfig returns model class default for SDK fields when not configured', async () => {
    const { resolveAgentConfig } = await import('@eforge-build/engine/pipeline');
    const result = resolveAgentConfig('builder', DEFAULT_CONFIG, 'claude-sdk');
    expect(result.maxTurns).toBe(80);
    // builder defaults to 'balanced' class, so claude-sdk default is { id: 'claude-sonnet-4-6' }
    expect(result.model).toEqual({ id: 'claude-sonnet-4-6' });
    expect(result.thinking).toBeUndefined();
    expect(result.effort).toBe('high'); // builder per-role default
    expect(result.effortSource).toBe('default');
    expect(result.maxBudgetUsd).toBeUndefined();
    expect(result.fallbackModel).toBeUndefined();
    expect(result.allowedTools).toBeUndefined();
    expect(result.disallowedTools).toBeUndefined();
  });

  it('resolveAgentConfig returns global effort when no role override exists', async () => {
    const { resolveAgentConfig } = await import('@eforge-build/engine/pipeline');
    const config = {
      ...DEFAULT_CONFIG,
      agents: { ...DEFAULT_CONFIG.agents, effort: 'high' as const },
    };
    const result = resolveAgentConfig('reviewer', config);
    expect(result.effort).toBe('high');
  });

  it('resolveAgentConfig returns role-specific value over global', async () => {
    const { resolveAgentConfig } = await import('@eforge-build/engine/pipeline');
    const config = {
      ...DEFAULT_CONFIG,
      agents: {
        ...DEFAULT_CONFIG.agents,
        effort: 'high' as const,
        roles: {
          formatter: { effort: 'low' as const },
        },
      },
    };
    const result = resolveAgentConfig('formatter', config);
    expect(result.effort).toBe('low');
  });

  it('resolveAgentConfig: user per-role maxTurns overrides built-in role default', async () => {
    const { resolveAgentConfig } = await import('@eforge-build/engine/pipeline');
    const config = {
      ...DEFAULT_CONFIG,
      agents: {
        ...DEFAULT_CONFIG.agents,
        roles: {
          builder: { maxTurns: 100 },
        },
      },
    };
    const result = resolveAgentConfig('builder', config);
    expect(result.maxTurns).toBe(100);
  });

  it('resolveAgentConfig: built-in role maxTurns beats user global maxTurns', async () => {
    const { resolveAgentConfig } = await import('@eforge-build/engine/pipeline');
    const config = {
      ...DEFAULT_CONFIG,
      agents: { ...DEFAULT_CONFIG.agents, maxTurns: 20 },
    };
    // builder has built-in default of 80 which beats user global 20
    const result = resolveAgentConfig('builder', config);
    expect(result.maxTurns).toBe(80);
  });

  it('resolveAgentConfig: user global model propagates to roles without overrides (overriding class)', async () => {
    const { resolveAgentConfig } = await import('@eforge-build/engine/pipeline');
    const config = {
      ...DEFAULT_CONFIG,
      agents: { ...DEFAULT_CONFIG.agents, model: { id: 'claude-sonnet' } },
    };
    const result = resolveAgentConfig('reviewer', config);
    expect(result.model).toEqual({ id: 'claude-sonnet' });
  });

  it('resolveAgentConfig: user per-role thinking overrides user global thinking', async () => {
    const { resolveAgentConfig } = await import('@eforge-build/engine/pipeline');
    const config = {
      ...DEFAULT_CONFIG,
      agents: {
        ...DEFAULT_CONFIG.agents,
        thinking: { type: 'adaptive' as const },
        roles: {
          builder: { thinking: { type: 'disabled' as const } },
        },
      },
    };
    const result = resolveAgentConfig('builder', config);
    expect(result.thinking).toEqual({ type: 'disabled' });
  });
});

// ---------------------------------------------------------------------------
// Default Profile Behavior Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Parallel Stage Group Tests
// ---------------------------------------------------------------------------

describe('runBuildPipeline parallel stage groups', () => {
  it('parallel group runs both stages and yields events from both', async () => {
    const stagesRun: string[] = [];

    registerBuildStage(testDescriptor('test-par-a', 'build'), async function* (ctx) {
      stagesRun.push('a');
      yield { type: 'planning:progress', message: 'par-a' };
    });
    registerBuildStage(testDescriptor('test-par-b', 'build'), async function* (ctx) {
      stagesRun.push('b');
      yield { type: 'planning:progress', message: 'par-b' };
    });

    const ctx = makeBuildCtx({ build: [['test-par-a', 'test-par-b']] });
    const events = await collect(runBuildPipeline(ctx));

    // Both stages ran
    expect(stagesRun).toContain('a');
    expect(stagesRun).toContain('b');

    // build:start + 2 stage events + auto-commit progress event + build:complete
    const progressEvents = events.filter((e) => e.type === 'planning:progress');
    expect(progressEvents.length).toBeGreaterThanOrEqual(2);
    expect(events[0]).toMatchObject({ type: 'plan:build:start', planId: 'plan-01' });
    expect(events[events.length - 1]).toMatchObject({ type: 'plan:build:complete', planId: 'plan-01' });
  });

  it('mixed config [["a", "b"], "c"] runs a+b in parallel then c sequentially', async () => {
    const order: string[] = [];

    registerBuildStage(testDescriptor('test-mix-a', 'build'), async function* () {
      order.push('a');
      yield { type: 'planning:progress', message: 'mix-a' };
    });
    registerBuildStage(testDescriptor('test-mix-b', 'build'), async function* () {
      order.push('b');
      yield { type: 'planning:progress', message: 'mix-b' };
    });
    registerBuildStage(testDescriptor('test-mix-c', 'build'), async function* () {
      order.push('c');
      yield { type: 'planning:progress', message: 'mix-c' };
    });

    const ctx = makeBuildCtx({ build: [['test-mix-a', 'test-mix-b'], 'test-mix-c'] });
    const events = await collect(runBuildPipeline(ctx));

    // a and b ran (order among them is nondeterministic), c ran after both
    expect(order).toContain('a');
    expect(order).toContain('b');
    expect(order.indexOf('c')).toBeGreaterThanOrEqual(2); // c is always after a and b

    const progressEvents = events.filter((e) => e.type === 'planning:progress');
    expect(progressEvents.length).toBeGreaterThanOrEqual(3);
    expect(events[0].type).toBe('plan:build:start');
    expect(events[events.length - 1].type).toBe('plan:build:complete');
  });

  it('buildFailed set during parallel group stops pipeline after group completes', async () => {
    const stagesRun: string[] = [];

    registerBuildStage(testDescriptor('test-fail-par-a', 'build'), async function* (ctx) {
      stagesRun.push('a');
      ctx.buildFailed = true;
      yield { type: 'planning:progress', message: 'fail-par-a' };
    });
    registerBuildStage(testDescriptor('test-fail-par-b', 'build'), async function* () {
      stagesRun.push('b');
      yield { type: 'planning:progress', message: 'fail-par-b' };
    });
    registerBuildStage(testDescriptor('test-fail-after', 'build'), async function* () {
      stagesRun.push('after');
      yield { type: 'planning:progress', message: 'after' };
    });

    const ctx = makeBuildCtx({ build: [['test-fail-par-a', 'test-fail-par-b'], 'test-fail-after'] });
    const events = await collect(runBuildPipeline(ctx));

    // Both parallel stages ran, but the sequential stage after did not
    expect(stagesRun).toContain('a');
    expect(stagesRun).toContain('b');
    expect(stagesRun).not.toContain('after');

    // No build:complete because pipeline was stopped
    expect(events.find((e) => e.type === 'plan:build:complete')).toBeUndefined();
  });
});

describe('default pipeline compile stages', () => {
  it('getCompileStageNames includes planner and plan-review-cycle', () => {
    const names = getCompileStageNames();
    expect(names.has('planner')).toBe(true);
    expect(names.has('plan-review-cycle')).toBe(true);
  });

  it('getCompileStageNames includes module-planning, compile-expedition, cohesion-review-cycle', () => {
    const names = getCompileStageNames();
    expect(names.has('module-planning')).toBe(true);
    expect(names.has('compile-expedition')).toBe(true);
    expect(names.has('cohesion-review-cycle')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EforgeEngineOptions Tests
// ---------------------------------------------------------------------------

describe('EforgeEngineOptions type', () => {
  it('EforgeEngineOptions accepts empty object', async () => {
    const opts: import('@eforge-build/engine/eforge').EforgeEngineOptions = {};
    expect(opts.cwd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Re-export Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Model Class Resolution Tests
// ---------------------------------------------------------------------------

describe('model class resolution', () => {
  it('nine roles default to balanced class, the rest default to max', async () => {
    const { resolveAgentConfig, AGENT_MODEL_CLASSES } = await import('@eforge-build/engine/pipeline');
    const balancedRoles = [
      'builder',
      'review-fixer',
      'validation-fixer',
      'test-writer',
      'tester',
      'staleness-assessor',
      'prd-validator',
      'dependency-detector',
      'recovery-analyst',
    ];
    for (const role of Object.keys(AGENT_MODEL_CLASSES) as Array<keyof typeof AGENT_MODEL_CLASSES>) {
      if (balancedRoles.includes(role)) {
        expect(AGENT_MODEL_CLASSES[role]).toBe('balanced');
        const result = resolveAgentConfig(role, DEFAULT_CONFIG, 'claude-sdk');
        expect(result.model).toEqual({ id: 'claude-sonnet-4-6' });
      } else {
        expect(AGENT_MODEL_CLASSES[role]).toBe('max');
        const result = resolveAgentConfig(role, DEFAULT_CONFIG, 'claude-sdk');
        expect(result.model).toEqual({ id: 'claude-opus-4-7' });
      }
    }
  });

  it('per-role modelClass override to max resolves to opus on claude-sdk over the balanced default', async () => {
    const { resolveAgentConfig } = await import('@eforge-build/engine/pipeline');
    const config = {
      ...DEFAULT_CONFIG,
      agents: {
        ...DEFAULT_CONFIG.agents,
        roles: {
          builder: { modelClass: 'max' as const },
        },
      },
    };
    const result = resolveAgentConfig('builder', config, 'claude-sdk');
    expect(result.model).toEqual({ id: 'claude-opus-4-7' });
  });

  it('per-role model overrides class-based resolution', async () => {
    const { resolveAgentConfig } = await import('@eforge-build/engine/pipeline');
    const config = {
      ...DEFAULT_CONFIG,
      agents: {
        ...DEFAULT_CONFIG.agents,
        roles: {
          planner: { model: { id: 'custom-model' } },
        },
      },
    };
    const result = resolveAgentConfig('planner', config);
    expect(result.model).toEqual({ id: 'custom-model' });
  });

  it('global model overrides class-based resolution', async () => {
    const { resolveAgentConfig } = await import('@eforge-build/engine/pipeline');
    const config = {
      ...DEFAULT_CONFIG,
      agents: { ...DEFAULT_CONFIG.agents, model: { id: 'global-override' } },
    };
    const result = resolveAgentConfig('planner', config);
    expect(result.model).toEqual({ id: 'global-override' });
  });

  it('pi harness with no model config throws for default balanced class with fallback tiers listed', async () => {
    const { resolveAgentConfig } = await import('@eforge-build/engine/pipeline');
    const piConfig = { ...DEFAULT_CONFIG, agentRuntimes: { pi: { harness: 'pi' as const } }, defaultAgentRuntime: 'pi' };
    expect(() => resolveAgentConfig('builder', piConfig)).toThrow(
      /No model configured for role "builder".*model class "balanced".*harness "pi".*Tried fallback: max, fast/,
    );
  });

  it('fallback ascending: balanced role resolves to max model when only max is configured', async () => {
    const { resolveAgentConfig } = await import('@eforge-build/engine/pipeline');
    const config = {
      ...DEFAULT_CONFIG,
      agentRuntimes: { pi: { harness: 'pi' as const } },
      defaultAgentRuntime: 'pi',
      agents: {
        ...DEFAULT_CONFIG.agents,
        models: { max: { provider: 'openrouter', id: 'big-model' } } as Record<string, import('@eforge-build/engine/config').ModelRef>,
      },
    };
    // staleness-assessor defaults to balanced
    const result = resolveAgentConfig('staleness-assessor', config);
    expect(result.model).toEqual({ provider: 'openrouter', id: 'big-model' });
    expect(result.fallbackFrom).toBe('balanced');
  });

  it('fallback descending: max role resolves to balanced model when only balanced is configured', async () => {
    const { resolveAgentConfig } = await import('@eforge-build/engine/pipeline');
    const config = {
      ...DEFAULT_CONFIG,
      agentRuntimes: { pi: { harness: 'pi' as const } },
      defaultAgentRuntime: 'pi',
      agents: {
        ...DEFAULT_CONFIG.agents,
        models: { balanced: { provider: 'openrouter', id: 'medium-model' } } as Record<string, import('@eforge-build/engine/config').ModelRef>,
      },
    };
    const result = resolveAgentConfig('reviewer', config);
    expect(result.model).toEqual({ provider: 'openrouter', id: 'medium-model' });
    expect(result.fallbackFrom).toBe('max');
  });

  it('fallback total failure lists attempted tiers in error', async () => {
    const { resolveAgentConfig } = await import('@eforge-build/engine/pipeline');
    const piConfig = { ...DEFAULT_CONFIG, agentRuntimes: { pi: { harness: 'pi' as const } }, defaultAgentRuntime: 'pi' };
    expect(() => resolveAgentConfig('builder', piConfig)).toThrow(
      /Tried fallback: max, fast/,
    );
  });

  it('fallbackFrom metadata is populated on fallback resolution', async () => {
    const { resolveAgentConfig } = await import('@eforge-build/engine/pipeline');
    const config = {
      ...DEFAULT_CONFIG,
      agentRuntimes: { pi: { harness: 'pi' as const } },
      defaultAgentRuntime: 'pi',
      agents: {
        ...DEFAULT_CONFIG.agents,
        models: { max: { provider: 'openrouter', id: 'big-model' } } as Record<string, import('@eforge-build/engine/config').ModelRef>,
      },
    };
    // prd-validator defaults to balanced, should fall back to max
    const result = resolveAgentConfig('prd-validator', config);
    expect(result.fallbackFrom).toBe('balanced');
    expect(result.model).toEqual({ provider: 'openrouter', id: 'big-model' });
  });

  it('pi harness with agents.models.max configured resolves correctly', async () => {
    const { resolveAgentConfig } = await import('@eforge-build/engine/pipeline');
    const config = {
      ...DEFAULT_CONFIG,
      agentRuntimes: { pi: { harness: 'pi' as const } },
      defaultAgentRuntime: 'pi',
      agents: {
        ...DEFAULT_CONFIG.agents,
        models: { max: { provider: 'openrouter', id: 'auto' } } as Record<string, import('@eforge-build/engine/config').ModelRef>,
      },
    };
    const result = resolveAgentConfig('builder', config);
    expect(result.model).toEqual({ provider: 'openrouter', id: 'auto' });
  });

  it('user agents.models override applies to class resolution', async () => {
    const { resolveAgentConfig } = await import('@eforge-build/engine/pipeline');
    const config = {
      ...DEFAULT_CONFIG,
      agents: {
        ...DEFAULT_CONFIG.agents,
        models: { max: { id: 'my-custom-max-model' } } as Record<string, import('@eforge-build/engine/config').ModelRef>,
      },
    };
    const result = resolveAgentConfig('planner', config);
    expect(result.model).toEqual({ id: 'my-custom-max-model' });
  });
});

// ---------------------------------------------------------------------------
// plannerStage graceful fallback when orchestration.yaml is missing
// ---------------------------------------------------------------------------

describe('plannerStage missing orchestration.yaml', () => {
  it('emits plan:complete with unenriched plans when orchestration.yaml does not exist', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    // Create a temp dir with no orchestration.yaml
    const tempDir = await mkdtemp(join(tmpdir(), 'eforge-test-'));

    const testPlans: PlanFile[] = [
      {
        id: 'plan-01',
        name: 'Test Plan',
        dependsOn: [],
        branch: 'test/plan-01',
        body: '# Plan body',
        filePath: join(tempDir, 'plans', 'test-plan', 'plan-01.md'),
      },
    ];

    // Register a custom planner stage that emits plan:complete
    registerCompileStage(
      testDescriptor('test-missing-orch-planner', 'compile'),
      async function* () {
        yield {
          type: 'planning:complete' as const,
          plans: testPlans,
        };
      },
    );

    const pipeline: PipelineComposition = {
      ...TEST_PIPELINE,
      compile: ['test-missing-orch-planner'],
    };

    const ctx = makePipelineCtx({ pipeline, cwd: tempDir, planSetName: 'test-plan' });
    const events = await collect(runCompilePipeline(ctx));

    // Should emit the plan:complete event without throwing
    const planComplete = events.find((e) => e.type === 'planning:complete');
    expect(planComplete).toBeDefined();
    // Plans should be the original unenriched plans (no dependsOn backfill)
    expect((planComplete as any).plans).toEqual(testPlans);

    // Clean up temp directory
    await rm(tempDir, { recursive: true });
  });
});

// index.ts re-exports test removed: the engine barrel export was deleted as part
// of the monorepo restructuring. Consumers use subpath imports directly.
