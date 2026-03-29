/**
 * Pipeline — stage registry, compile pipeline, build pipeline.
 *
 * Tests the pipeline infrastructure: stage registration/retrieval,
 * pipeline runners (compile and build), agent config threading,
 * and mutable context passing between stages.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { EforgeEvent, PlanFile, OrchestrationConfig, ReviewIssue } from '../src/engine/events.js';
import type { EforgeConfig, ResolvedProfileConfig } from '../src/engine/config.js';
import type { AgentBackend } from '../src/engine/backend.js';
import { BUILTIN_PROFILES, DEFAULT_CONFIG, DEFAULT_REVIEW, DEFAULT_BUILD, DEFAULT_BUILD_WITH_DOCS } from '../src/engine/config.js';
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
    profile: BUILTIN_PROFILES['excursion'],
    plans: [{ id: 'plan-01', name: 'Test Plan', dependsOn: [], branch: 'test/plan-01', build: DEFAULT_BUILD, review: DEFAULT_REVIEW }],
  };

  const profile = overrides?.profile ?? BUILTIN_PROFILES['excursion'];

  return {
    backend: {} as AgentBackend,
    config: DEFAULT_CONFIG,
    profile,
    tracing: createNoopTracingContext(),
    cwd: '/tmp/test',
    planSetName: 'test-plan',
    sourceContent: '',
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
    registerCompileStage('test-compile-stage', fn);
    expect(getCompileStage('test-compile-stage')).toBe(fn);
  });

  it('registerBuildStage makes stage retrievable', () => {
    const fn: BuildStage = async function* () { /* noop */ };
    registerBuildStage('test-build-stage', fn);
    expect(getBuildStage('test-build-stage')).toBe(fn);
  });

  it('all built-in compile stages are registered', () => {
    const builtinCompileStages = ['prd-passthrough', 'planner', 'plan-review-cycle', 'module-planning', 'cohesion-review-cycle', 'compile-expedition'];
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

  it('skipped flag halts pipeline after the stage that sets it', async () => {
    const stagesRun: string[] = [];

    registerCompileStage('test-skip-planner', async function* (ctx) {
      stagesRun.push('planner');
      ctx.skipped = true;
      yield { type: 'plan:skip', reason: 'Already done' };
    });
    registerCompileStage('test-skip-review', async function* () {
      stagesRun.push('review');
      yield { type: 'plan:progress', message: 'review' };
    });

    const profile: ResolvedProfileConfig = {
      ...BUILTIN_PROFILES['excursion'],
      compile: ['test-skip-planner', 'test-skip-review'],
    };

    const ctx = makePipelineCtx({ profile });
    const events = await collect(runCompilePipeline(ctx));

    expect(stagesRun).toEqual(['planner']);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'plan:skip', reason: 'Already done' });
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

    const ctx = makeBuildCtx({ build: ['test-impl'] });
    const events = await collect(runBuildPipeline(ctx));

    expect(events[0]).toMatchObject({ type: 'build:start', planId: 'plan-01' });
    expect(events[events.length - 1]).toMatchObject({ type: 'build:complete', planId: 'plan-01' });
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

    const ctx = makeBuildCtx({ build: ['test-b-impl', 'test-b-review', 'test-b-fix', 'test-b-eval'] });
    const events = await collect(runBuildPipeline(ctx));

    expect(order).toEqual(['implement', 'review', 'review-fix', 'evaluate']);
    // build:start + 4 stage events + build:complete = 6
    expect(events).toHaveLength(6);
    expect(events[0].type).toBe('build:start');
    expect(events[events.length - 1].type).toBe('build:complete');
  });

  it('throws for unknown stage name in build list', async () => {
    const ctx = makeBuildCtx({ build: ['unknown-build-stage-xyz'] });

    await expect(collect(runBuildPipeline(ctx))).rejects.toThrow('Unknown build stage');
  });

  it('with custom profile build stages (implement + validate)', async () => {
    registerBuildStage('test-custom-impl', async function* (ctx) {
      yield { type: 'build:implement:start', planId: ctx.planId };
    });
    registerBuildStage('test-custom-validate', async function* () {
      yield { type: 'plan:progress', message: 'validate' };
    });

    const ctx = makeBuildCtx({ build: ['test-custom-impl', 'test-custom-validate'] });
    const events = await collect(runBuildPipeline(ctx));

    expect(events[0].type).toBe('build:start');
    expect(events[1]).toMatchObject({ type: 'build:implement:start', planId: 'plan-01' });
    expect(events[2]).toMatchObject({ type: 'plan:progress', message: 'validate' });
    expect(events[3]).toMatchObject({ type: 'build:complete', planId: 'plan-01' });
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
});

// ---------------------------------------------------------------------------
// Agent Config Threading Tests
// ---------------------------------------------------------------------------

describe('agent config threading', () => {
  it('resolveAgentConfig uses role default for builder', async () => {
    const { resolveAgentConfig } = await import('../src/engine/pipeline.js');
    const result = resolveAgentConfig('builder', DEFAULT_CONFIG);
    expect(result.maxTurns).toBe(50); // builder role default
  });

  it('resolveAgentConfig returns role default when no profile config set', async () => {
    const { resolveAgentConfig } = await import('../src/engine/pipeline.js');

    // Builder has a role default of 50, so it should return 50 (not the global 30)
    const result = resolveAgentConfig('builder', DEFAULT_CONFIG);
    expect(result.maxTurns).toBe(50);
  });

  it('resolveAgentConfig returns role default over global config', async () => {
    const { resolveAgentConfig } = await import('../src/engine/pipeline.js');

    // Builder has a role default of 50 - even with global maxTurns set differently
    const config = { ...DEFAULT_CONFIG, agents: { ...DEFAULT_CONFIG.agents, maxTurns: 25 } };
    const result = resolveAgentConfig('builder', config);
    expect(result.maxTurns).toBe(50);
  });

  it('resolveAgentConfig falls back to global maxTurns for roles without a specific default', async () => {
    const { resolveAgentConfig } = await import('../src/engine/pipeline.js');

    const config = { ...DEFAULT_CONFIG, agents: { ...DEFAULT_CONFIG.agents, maxTurns: 42 } };
    // reviewer has no role default, so it should fall back to the global config value
    const result = resolveAgentConfig('reviewer', config);
    expect(result.maxTurns).toBe(42);
  });

  it('resolveAgentConfig returns model class default for SDK fields when not configured', async () => {
    const { resolveAgentConfig } = await import('../src/engine/pipeline.js');
    const result = resolveAgentConfig('builder', DEFAULT_CONFIG);
    expect(result.maxTurns).toBe(50);
    // builder defaults to 'max' class, so claude-sdk default is 'claude-opus-4-6'
    expect(result.model).toBe('claude-opus-4-6');
    expect(result.thinking).toBeUndefined();
    expect(result.effort).toBeUndefined();
    expect(result.maxBudgetUsd).toBeUndefined();
    expect(result.fallbackModel).toBeUndefined();
    expect(result.allowedTools).toBeUndefined();
    expect(result.disallowedTools).toBeUndefined();
  });

  it('resolveAgentConfig returns global effort when no role override exists', async () => {
    const { resolveAgentConfig } = await import('../src/engine/pipeline.js');
    const config = {
      ...DEFAULT_CONFIG,
      agents: { ...DEFAULT_CONFIG.agents, effort: 'high' as const },
    };
    const result = resolveAgentConfig('reviewer', config);
    expect(result.effort).toBe('high');
  });

  it('resolveAgentConfig returns role-specific value over global', async () => {
    const { resolveAgentConfig } = await import('../src/engine/pipeline.js');
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
    const { resolveAgentConfig } = await import('../src/engine/pipeline.js');
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
    const { resolveAgentConfig } = await import('../src/engine/pipeline.js');
    const config = {
      ...DEFAULT_CONFIG,
      agents: { ...DEFAULT_CONFIG.agents, maxTurns: 20 },
    };
    // builder has built-in default of 50 which beats user global 20
    const result = resolveAgentConfig('builder', config);
    expect(result.maxTurns).toBe(50);
  });

  it('resolveAgentConfig: user global model propagates to roles without overrides (overriding class)', async () => {
    const { resolveAgentConfig } = await import('../src/engine/pipeline.js');
    const config = {
      ...DEFAULT_CONFIG,
      agents: { ...DEFAULT_CONFIG.agents, model: 'claude-sonnet' },
    };
    const result = resolveAgentConfig('reviewer', config);
    expect(result.model).toBe('claude-sonnet');
  });

  it('resolveAgentConfig: user per-role thinking overrides user global thinking', async () => {
    const { resolveAgentConfig } = await import('../src/engine/pipeline.js');
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

    registerBuildStage('test-par-a', async function* (ctx) {
      stagesRun.push('a');
      yield { type: 'plan:progress', message: 'par-a' };
    });
    registerBuildStage('test-par-b', async function* (ctx) {
      stagesRun.push('b');
      yield { type: 'plan:progress', message: 'par-b' };
    });

    const ctx = makeBuildCtx({ build: [['test-par-a', 'test-par-b']] });
    const events = await collect(runBuildPipeline(ctx));

    // Both stages ran
    expect(stagesRun).toContain('a');
    expect(stagesRun).toContain('b');

    // build:start + 2 stage events + auto-commit progress event + build:complete
    const progressEvents = events.filter((e) => e.type === 'plan:progress');
    expect(progressEvents.length).toBeGreaterThanOrEqual(2);
    expect(events[0]).toMatchObject({ type: 'build:start', planId: 'plan-01' });
    expect(events[events.length - 1]).toMatchObject({ type: 'build:complete', planId: 'plan-01' });
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

    const ctx = makeBuildCtx({ build: [['test-mix-a', 'test-mix-b'], 'test-mix-c'] });
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

    const ctx = makeBuildCtx({ build: [['test-fail-par-a', 'test-fail-par-b'], 'test-fail-after'] });
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
  it('excursion profile compile stages match today\'s hardcoded sequence', () => {
    const excursion = BUILTIN_PROFILES['excursion'];
    expect(excursion.compile).toEqual(['planner', 'plan-review-cycle']);
  });

  it('errand profile compile stages use prd-passthrough', () => {
    const errand = BUILTIN_PROFILES['errand'];
    expect(errand.compile).toEqual(['prd-passthrough']);
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
          compile: ['planner', 'plan-review-cycle'],
        },
      },
    };
    expect(opts.profileOverrides).toBeDefined();
    expect(opts.profileOverrides!['custom-profile'].compile).toEqual(['planner', 'plan-review-cycle']);
  });
});

// ---------------------------------------------------------------------------
// Re-export Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Model Class Resolution Tests
// ---------------------------------------------------------------------------

describe('model class resolution', () => {
  it('all roles default to max class, resolving to claude-opus-4-6 on claude-sdk', async () => {
    const { resolveAgentConfig, AGENT_MODEL_CLASSES } = await import('../src/engine/pipeline.js');
    for (const role of Object.keys(AGENT_MODEL_CLASSES) as Array<keyof typeof AGENT_MODEL_CLASSES>) {
      expect(AGENT_MODEL_CLASSES[role]).toBe('max');
      const result = resolveAgentConfig(role, DEFAULT_CONFIG);
      expect(result.model).toBe('claude-opus-4-6');
    }
  });

  it('per-role modelClass override to balanced resolves to sonnet on claude-sdk', async () => {
    const { resolveAgentConfig } = await import('../src/engine/pipeline.js');
    const config = {
      ...DEFAULT_CONFIG,
      agents: {
        ...DEFAULT_CONFIG.agents,
        roles: {
          builder: { modelClass: 'balanced' as const },
        },
      },
    };
    const result = resolveAgentConfig('builder', config);
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('per-role model overrides class-based resolution', async () => {
    const { resolveAgentConfig } = await import('../src/engine/pipeline.js');
    const config = {
      ...DEFAULT_CONFIG,
      agents: {
        ...DEFAULT_CONFIG.agents,
        roles: {
          planner: { model: 'custom-model' },
        },
      },
    };
    const result = resolveAgentConfig('planner', config);
    expect(result.model).toBe('custom-model');
  });

  it('global model overrides class-based resolution', async () => {
    const { resolveAgentConfig } = await import('../src/engine/pipeline.js');
    const config = {
      ...DEFAULT_CONFIG,
      agents: { ...DEFAULT_CONFIG.agents, model: 'global-override' },
    };
    const result = resolveAgentConfig('planner', config);
    expect(result.model).toBe('global-override');
  });

  it('auto class on claude-sdk returns undefined model', async () => {
    const { resolveAgentConfig } = await import('../src/engine/pipeline.js');
    const config = {
      ...DEFAULT_CONFIG,
      agents: {
        ...DEFAULT_CONFIG.agents,
        roles: {
          builder: { modelClass: 'auto' as const },
        },
      },
    };
    const result = resolveAgentConfig('builder', config);
    expect(result.model).toBeUndefined();
  });

  it('pi backend with no model config throws for default max class', async () => {
    const { resolveAgentConfig } = await import('../src/engine/pipeline.js');
    expect(() => resolveAgentConfig('builder', DEFAULT_CONFIG, 'pi')).toThrow(
      /No model configured for role "builder".*model class "max".*backend "pi"/,
    );
  });

  it('auto class on pi backend throws without explicit config', async () => {
    const { resolveAgentConfig } = await import('../src/engine/pipeline.js');
    const config = {
      ...DEFAULT_CONFIG,
      agents: {
        ...DEFAULT_CONFIG.agents,
        roles: {
          builder: { modelClass: 'auto' as const },
        },
      },
    };
    expect(() => resolveAgentConfig('builder', config, 'pi')).toThrow(
      /No model configured for role "builder".*model class "auto".*backend "pi"/,
    );
  });

  it('pi backend with agents.models.max configured resolves correctly', async () => {
    const { resolveAgentConfig } = await import('../src/engine/pipeline.js');
    const config = {
      ...DEFAULT_CONFIG,
      agents: {
        ...DEFAULT_CONFIG.agents,
        models: { max: 'openrouter/auto' } as Record<string, string>,
      },
    };
    const result = resolveAgentConfig('builder', config, 'pi');
    expect(result.model).toBe('openrouter/auto');
  });

  it('user agents.models override applies to class resolution', async () => {
    const { resolveAgentConfig } = await import('../src/engine/pipeline.js');
    const config = {
      ...DEFAULT_CONFIG,
      agents: {
        ...DEFAULT_CONFIG.agents,
        models: { max: 'my-custom-max-model' } as Record<string, string>,
      },
    };
    const result = resolveAgentConfig('planner', config);
    expect(result.model).toBe('my-custom-max-model');
  });
});

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
