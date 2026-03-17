/**
 * Pipeline — stage registry, compile pipeline, build pipeline.
 *
 * Tests the pipeline infrastructure: stage registration/retrieval,
 * pipeline runners (compile and build), agent config threading,
 * and mutable context passing between stages.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { EforgeEvent, PlanFile, OrchestrationConfig, ReviewIssue, ScopeAssessment } from '../src/engine/events.js';
import type { EforgeConfig, ResolvedProfileConfig } from '../src/engine/config.js';
import type { AgentBackend } from '../src/engine/backend.js';
import { BUILTIN_PROFILES, DEFAULT_CONFIG } from '../src/engine/config.js';
import { createNoopTracingContext } from '../src/engine/tracing.js';
import {
  getCompileStage,
  getBuildStage,
  registerCompileStage,
  registerBuildStage,
  runCompilePipeline,
  runBuildPipeline,
  type PipelineContext,
  type BuildStageContext,
  type CompileStage,
  type BuildStage,
} from '../src/engine/pipeline.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    backend: {} as AgentBackend,
    config: DEFAULT_CONFIG,
    profile: BUILTIN_PROFILES['excursion'],
    tracing: createNoopTracingContext(),
    cwd: '/tmp/test',
    planSetName: 'test-plan',
    sourceContent: '# Test',
    plans: [],
    expeditionModules: [],
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
    plans: [{ id: 'plan-01', name: 'Test Plan', dependsOn: [], branch: 'test/plan-01' }],
  };

  return {
    backend: {} as AgentBackend,
    config: DEFAULT_CONFIG,
    profile: BUILTIN_PROFILES['excursion'],
    tracing: createNoopTracingContext(),
    cwd: '/tmp/test',
    planSetName: 'test-plan',
    sourceContent: '',
    plans: [planFile],
    expeditionModules: [],
    planId: 'plan-01',
    worktreePath: '/tmp/test-worktree',
    planFile,
    orchConfig,
    reviewIssues: [],
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
    registerCompileStage('test-compile-stage', fn);
    expect(getCompileStage('test-compile-stage')).toBe(fn);
  });

  it('registerBuildStage makes stage retrievable', () => {
    const fn: BuildStage = async function* () { /* noop */ };
    registerBuildStage('test-build-stage', fn);
    expect(getBuildStage('test-build-stage')).toBe(fn);
  });

  it('all built-in compile stages are registered', () => {
    const builtinCompileStages = ['planner', 'plan-review-cycle', 'module-planning', 'cohesion-review-cycle', 'compile-expedition'];
    for (const name of builtinCompileStages) {
      expect(() => getCompileStage(name)).not.toThrow();
      expect(typeof getCompileStage(name)).toBe('function');
    }
  });

  it('all built-in build stages are registered', () => {
    const builtinBuildStages = ['implement', 'review', 'review-fix', 'evaluate', 'validate', 'doc-update'];
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
  it('calls stages in order from profile compile list', async () => {
    const order: string[] = [];

    registerCompileStage('test-stage-a', async function* () {
      order.push('a');
      yield { type: 'plan:progress', message: 'stage-a' };
    });
    registerCompileStage('test-stage-b', async function* () {
      order.push('b');
      yield { type: 'plan:progress', message: 'stage-b' };
    });

    const profile: ResolvedProfileConfig = {
      ...BUILTIN_PROFILES['excursion'],
      compile: ['test-stage-a', 'test-stage-b'],
    };

    const ctx = makePipelineCtx({ profile });
    const events = await collect(runCompilePipeline(ctx));

    expect(order).toEqual(['a', 'b']);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'plan:progress', message: 'stage-a' });
    expect(events[1]).toEqual({ type: 'plan:progress', message: 'stage-b' });
  });

  it('yields zero events with empty compile list', async () => {
    const profile: ResolvedProfileConfig = {
      ...BUILTIN_PROFILES['excursion'],
      compile: [],
    };

    const ctx = makePipelineCtx({ profile });
    const events = await collect(runCompilePipeline(ctx));

    expect(events).toHaveLength(0);
  });

  it('throws for unknown stage name in compile list', async () => {
    const profile: ResolvedProfileConfig = {
      ...BUILTIN_PROFILES['excursion'],
      compile: ['unknown-stage-xyz'],
    };

    const ctx = makePipelineCtx({ profile });

    await expect(collect(runCompilePipeline(ctx))).rejects.toThrow('Unknown compile stage');
  });

  it('with planner only (no plan-review-cycle), only planner stage runs', async () => {
    const stagesRun: string[] = [];

    registerCompileStage('test-planner-only', async function* () {
      stagesRun.push('planner');
      yield { type: 'plan:progress', message: 'planned' };
    });

    const profile: ResolvedProfileConfig = {
      ...BUILTIN_PROFILES['excursion'],
      compile: ['test-planner-only'],
    };

    const ctx = makePipelineCtx({ profile });
    const events = await collect(runCompilePipeline(ctx));

    expect(stagesRun).toEqual(['planner']);
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// runBuildPipeline Tests
// ---------------------------------------------------------------------------

describe('runBuildPipeline', () => {
  it('emits build:start and build:complete around stages', async () => {
    registerBuildStage('test-impl', async function* (ctx) {
      yield { type: 'build:implement:start', planId: ctx.planId };
      yield { type: 'build:implement:complete', planId: ctx.planId };
    });

    const profile: ResolvedProfileConfig = {
      ...BUILTIN_PROFILES['excursion'],
      build: ['test-impl'],
    };

    const ctx = makeBuildCtx({ profile });
    const events = await collect(runBuildPipeline(ctx));

    expect(events[0]).toEqual({ type: 'build:start', planId: 'plan-01' });
    expect(events[events.length - 1]).toEqual({ type: 'build:complete', planId: 'plan-01' });
  });

  it('calls all four default build stages in order', async () => {
    const order: string[] = [];

    registerBuildStage('test-b-impl', async function* () {
      order.push('implement');
      yield { type: 'plan:progress', message: 'impl' };
    });
    registerBuildStage('test-b-review', async function* () {
      order.push('review');
      yield { type: 'plan:progress', message: 'review' };
    });
    registerBuildStage('test-b-fix', async function* () {
      order.push('review-fix');
      yield { type: 'plan:progress', message: 'fix' };
    });
    registerBuildStage('test-b-eval', async function* () {
      order.push('evaluate');
      yield { type: 'plan:progress', message: 'eval' };
    });

    const profile: ResolvedProfileConfig = {
      ...BUILTIN_PROFILES['excursion'],
      build: ['test-b-impl', 'test-b-review', 'test-b-fix', 'test-b-eval'],
    };

    const ctx = makeBuildCtx({ profile });
    const events = await collect(runBuildPipeline(ctx));

    expect(order).toEqual(['implement', 'review', 'review-fix', 'evaluate']);
    // build:start + 4 stage events + build:complete = 6
    expect(events).toHaveLength(6);
    expect(events[0].type).toBe('build:start');
    expect(events[events.length - 1].type).toBe('build:complete');
  });

  it('throws for unknown stage name in build list', async () => {
    const profile: ResolvedProfileConfig = {
      ...BUILTIN_PROFILES['excursion'],
      build: ['unknown-build-stage-xyz'],
    };

    const ctx = makeBuildCtx({ profile });

    await expect(collect(runBuildPipeline(ctx))).rejects.toThrow('Unknown build stage');
  });

  it('with custom profile build stages (implement + validate)', async () => {
    registerBuildStage('test-custom-impl', async function* (ctx) {
      yield { type: 'build:implement:start', planId: ctx.planId };
    });
    registerBuildStage('test-custom-validate', async function* () {
      yield { type: 'plan:progress', message: 'validate' };
    });

    const profile: ResolvedProfileConfig = {
      ...BUILTIN_PROFILES['excursion'],
      build: ['test-custom-impl', 'test-custom-validate'],
    };

    const ctx = makeBuildCtx({ profile });
    const events = await collect(runBuildPipeline(ctx));

    expect(events[0].type).toBe('build:start');
    expect(events[1]).toEqual({ type: 'build:implement:start', planId: 'plan-01' });
    expect(events[2]).toEqual({ type: 'plan:progress', message: 'validate' });
    expect(events[3]).toEqual({ type: 'build:complete', planId: 'plan-01' });
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

    registerCompileStage('test-set-plans', async function* (ctx) {
      ctx.plans = [testPlan];
      yield { type: 'plan:progress', message: 'set-plans' };
    });

    let readPlans: PlanFile[] = [];
    registerCompileStage('test-read-plans', async function* (ctx) {
      readPlans = ctx.plans;
      yield { type: 'plan:progress', message: 'read-plans' };
    });

    const profile: ResolvedProfileConfig = {
      ...BUILTIN_PROFILES['excursion'],
      compile: ['test-set-plans', 'test-read-plans'],
    };

    const ctx = makePipelineCtx({ profile });
    await collect(runCompilePipeline(ctx));

    expect(readPlans).toEqual([testPlan]);
  });

  it('scopeAssessment set by first stage is readable by subsequent stage', async () => {
    registerCompileStage('test-set-scope', async function* (ctx) {
      ctx.scopeAssessment = 'expedition';
      yield { type: 'plan:progress', message: 'set-scope' };
    });

    let readScope: ScopeAssessment | undefined;
    registerCompileStage('test-read-scope', async function* (ctx) {
      readScope = ctx.scopeAssessment;
      yield { type: 'plan:progress', message: 'read-scope' };
    });

    const profile: ResolvedProfileConfig = {
      ...BUILTIN_PROFILES['excursion'],
      compile: ['test-set-scope', 'test-read-scope'],
    };

    const ctx = makePipelineCtx({ profile });
    await collect(runCompilePipeline(ctx));

    expect(readScope).toBe('expedition');
  });
});

// ---------------------------------------------------------------------------
// Agent Config Threading Tests
// ---------------------------------------------------------------------------

describe('agent config threading', () => {
  it('profile agents config is accessible in stage context', async () => {
    let observedMaxTurns: number | undefined;

    registerBuildStage('test-config-read', async function* (ctx) {
      observedMaxTurns = ctx.profile.agents.builder?.maxTurns;
      yield { type: 'plan:progress', message: 'config-read' };
    });

    const profile: ResolvedProfileConfig = {
      ...BUILTIN_PROFILES['excursion'],
      build: ['test-config-read'],
      agents: {
        builder: { maxTurns: 25 },
      },
    };

    const ctx = makeBuildCtx({ profile });
    await collect(runBuildPipeline(ctx));

    expect(observedMaxTurns).toBe(25);
  });

  it('resolveAgentConfig returns role default when no profile config set', async () => {
    const { resolveAgentConfig } = await import('../src/engine/pipeline.js');

    const profile: ResolvedProfileConfig = {
      ...BUILTIN_PROFILES['excursion'],
      agents: {}, // No builder config
    };

    // Builder has a role default of 50, so it should return 50 (not the global 30)
    const result = resolveAgentConfig(profile, 'builder', DEFAULT_CONFIG);
    expect(result.maxTurns).toBe(50);
  });

  it('resolveAgentConfig returns profile value when set', async () => {
    const { resolveAgentConfig } = await import('../src/engine/pipeline.js');

    const profile: ResolvedProfileConfig = {
      ...BUILTIN_PROFILES['excursion'],
      agents: {
        builder: { maxTurns: 25 },
      },
    };

    const result = resolveAgentConfig(profile, 'builder', DEFAULT_CONFIG);
    expect(result.maxTurns).toBe(25);
  });

  it('resolveAgentConfig falls back to global maxTurns for roles without a specific default', async () => {
    const { resolveAgentConfig } = await import('../src/engine/pipeline.js');

    const profile: ResolvedProfileConfig = {
      ...BUILTIN_PROFILES['excursion'],
      agents: {},
    };

    const config = { ...DEFAULT_CONFIG, agents: { ...DEFAULT_CONFIG.agents, maxTurns: 42 } };
    // reviewer has no role default, so it should fall back to the global config value
    const result = resolveAgentConfig(profile, 'reviewer', config);
    expect(result.maxTurns).toBe(42);
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

    registerBuildStage('test-par-a', async function* (ctx) {
      stagesRun.push('a');
      yield { type: 'plan:progress', message: 'par-a' };
    });
    registerBuildStage('test-par-b', async function* (ctx) {
      stagesRun.push('b');
      yield { type: 'plan:progress', message: 'par-b' };
    });

    const profile: ResolvedProfileConfig = {
      ...BUILTIN_PROFILES['excursion'],
      build: [['test-par-a', 'test-par-b']],
    };

    const ctx = makeBuildCtx({ profile });
    const events = await collect(runBuildPipeline(ctx));

    // Both stages ran
    expect(stagesRun).toContain('a');
    expect(stagesRun).toContain('b');

    // build:start + 2 stage events + auto-commit progress event + build:complete
    const progressEvents = events.filter((e) => e.type === 'plan:progress');
    expect(progressEvents.length).toBeGreaterThanOrEqual(2);
    expect(events[0]).toEqual({ type: 'build:start', planId: 'plan-01' });
    expect(events[events.length - 1]).toEqual({ type: 'build:complete', planId: 'plan-01' });
  });

  it('mixed config [["a", "b"], "c"] runs a+b in parallel then c sequentially', async () => {
    const order: string[] = [];

    registerBuildStage('test-mix-a', async function* () {
      order.push('a');
      yield { type: 'plan:progress', message: 'mix-a' };
    });
    registerBuildStage('test-mix-b', async function* () {
      order.push('b');
      yield { type: 'plan:progress', message: 'mix-b' };
    });
    registerBuildStage('test-mix-c', async function* () {
      order.push('c');
      yield { type: 'plan:progress', message: 'mix-c' };
    });

    const profile: ResolvedProfileConfig = {
      ...BUILTIN_PROFILES['excursion'],
      build: [['test-mix-a', 'test-mix-b'], 'test-mix-c'],
    };

    const ctx = makeBuildCtx({ profile });
    const events = await collect(runBuildPipeline(ctx));

    // a and b ran (order among them is nondeterministic), c ran after both
    expect(order).toContain('a');
    expect(order).toContain('b');
    expect(order.indexOf('c')).toBeGreaterThanOrEqual(2); // c is always after a and b

    const progressEvents = events.filter((e) => e.type === 'plan:progress');
    expect(progressEvents.length).toBeGreaterThanOrEqual(3);
    expect(events[0].type).toBe('build:start');
    expect(events[events.length - 1].type).toBe('build:complete');
  });

  it('buildFailed set during parallel group stops pipeline after group completes', async () => {
    const stagesRun: string[] = [];

    registerBuildStage('test-fail-par-a', async function* (ctx) {
      stagesRun.push('a');
      ctx.buildFailed = true;
      yield { type: 'plan:progress', message: 'fail-par-a' };
    });
    registerBuildStage('test-fail-par-b', async function* () {
      stagesRun.push('b');
      yield { type: 'plan:progress', message: 'fail-par-b' };
    });
    registerBuildStage('test-fail-after', async function* () {
      stagesRun.push('after');
      yield { type: 'plan:progress', message: 'after' };
    });

    const profile: ResolvedProfileConfig = {
      ...BUILTIN_PROFILES['excursion'],
      build: [['test-fail-par-a', 'test-fail-par-b'], 'test-fail-after'],
    };

    const ctx = makeBuildCtx({ profile });
    const events = await collect(runBuildPipeline(ctx));

    // Both parallel stages ran, but the sequential stage after did not
    expect(stagesRun).toContain('a');
    expect(stagesRun).toContain('b');
    expect(stagesRun).not.toContain('after');

    // No build:complete because pipeline was stopped
    expect(events.find((e) => e.type === 'build:complete')).toBeUndefined();
  });
});

describe('default profile behavior', () => {
  it('excursion profile build stages match today\'s hardcoded sequence', () => {
    const excursion = BUILTIN_PROFILES['excursion'];
    expect(excursion.build).toEqual([['implement', 'doc-update'], 'review', 'review-fix', 'evaluate']);
  });

  it('errand profile compile stages include planner and plan-review-cycle', () => {
    const errand = BUILTIN_PROFILES['errand'];
    expect(errand.compile).toEqual(['planner', 'plan-review-cycle']);
  });

  it('expedition profile compile stages include module-planning and compile-expedition', () => {
    const expedition = BUILTIN_PROFILES['expedition'];
    expect(expedition.compile).toContain('module-planning');
    expect(expedition.compile).toContain('compile-expedition');
    expect(expedition.compile).toContain('cohesion-review-cycle');
  });
});

// ---------------------------------------------------------------------------
// EforgeEngineOptions profileOverrides Tests
// ---------------------------------------------------------------------------

describe('EforgeEngineOptions.profileOverrides type', () => {
  it('profileOverrides is optional on EforgeEngineOptions', async () => {
    // Runtime check: the option type accepts undefined
    const opts: import('../src/engine/eforge.js').EforgeEngineOptions = {};
    expect(opts.profileOverrides).toBeUndefined();
  });

  it('profileOverrides accepts Record<string, PartialProfileConfig>', async () => {
    const opts: import('../src/engine/eforge.js').EforgeEngineOptions = {
      profileOverrides: {
        'custom-profile': {
          description: 'Custom profile',
          build: ['implement', 'validate'],
        },
      },
    };
    expect(opts.profileOverrides).toBeDefined();
    expect(opts.profileOverrides!['custom-profile'].build).toEqual(['implement', 'validate']);
  });
});

// ---------------------------------------------------------------------------
// Re-export Tests
// ---------------------------------------------------------------------------

describe('index.ts re-exports', () => {
  it('PipelineContext type is re-exported', async () => {
    const mod = await import('../src/engine/index.js');
    // Types don't exist at runtime, but the pipeline functions should be exported
    expect(typeof mod.getCompileStage).toBe('function');
    expect(typeof mod.getBuildStage).toBe('function');
    expect(typeof mod.registerCompileStage).toBe('function');
    expect(typeof mod.registerBuildStage).toBe('function');
    expect(typeof mod.runCompilePipeline).toBe('function');
    expect(typeof mod.runBuildPipeline).toBe('function');
  });
});
