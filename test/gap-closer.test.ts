import { describe, it, expect, vi } from 'vitest';
import type { EforgeEvent } from '@eforge-build/engine/events';
import { StubHarness } from './stub-harness.js';
import { collectEvents, findEvent, filterEvents } from './test-events.js';
import { runGapCloser, type GapCloserContext } from '@eforge-build/engine/agents/gap-closer';
import type { BuildStageContext } from '@eforge-build/engine/pipeline';

const GAPS = [
  { requirement: 'Must support dark mode', explanation: 'No dark mode CSS classes found in the theme configuration' },
];

const PRD_CONTENT = '# Feature PRD\n\n## Requirements\n\n- Must support dark mode\n- Must have responsive layout';

function makePipelineContext() {
  return {
    config: { agents: { maxTurns: 30 }, agentRuntimes: { default: { harness: 'claude-sdk' } }, defaultAgentRuntime: 'default' } as never,
    pipeline: { compile: [], build: [] } as never,
    tracing: { createSpan: () => ({ setInput: () => {}, end: () => {}, error: () => {} }) } as never,
    planSetName: 'test-set',
    orchConfig: { name: 'test', description: '', created: '', mode: 'errand' as const, baseBranch: 'main', pipeline: { compile: [], build: [] }, plans: [] } as never,
    planFileMap: new Map(),
  };
}

function makeOptions(backend: StubHarness, overrides?: Partial<GapCloserContext>): GapCloserContext {
  return {
    harness: backend,
    cwd: '/tmp',
    gaps: GAPS,
    prdContent: PRD_CONTENT,
    pipelineContext: makePipelineContext(),
    runBuildPipeline: async function* () {
      yield { timestamp: new Date().toISOString(), type: 'plan:build:start', planId: 'gap-close' } as EforgeEvent;
      yield { timestamp: new Date().toISOString(), type: 'plan:build:complete', planId: 'gap-close' } as EforgeEvent;
    },
    ...overrides,
  };
}

describe('runGapCloser two-stage flow', () => {
  it('emits gap_close:start with gapCount', async () => {
    const backend = new StubHarness([{ text: '## Overview\nFix dark mode\n\n## Files\n- src/theme.ts: Add dark classes' }]);

    const events = await collectEvents(runGapCloser(makeOptions(backend)));

    const start = findEvent(events, 'gap_close:start');
    expect(start).toBeDefined();
    expect((start as { gapCount?: number }).gapCount).toBe(1);
  });

  it('calls plan generation agent with maxTurns from AGENT_ROLE_DEFAULTS', async () => {
    const backend = new StubHarness([{ text: '## Overview\nFix it\n\n## Files\n- src/a.ts: change' }]);

    await collectEvents(runGapCloser(makeOptions(backend)));

    expect(backend.calls).toHaveLength(1);
    // gap-closer role defaults to maxTurns: 20 in AGENT_ROLE_DEFAULTS
    // But since we pass a stub config with maxTurns: 30 as global, and no per-role override,
    // resolveAgentConfig will use the built-in per-role default of 20
    expect(backend.calls[0].maxTurns).toBe(20);
    expect(backend.calls[0].tools).toBe('coding');
  });

  it('passes generated plan to runBuildPipeline with planId gap-close', async () => {
    const backend = new StubHarness([{ text: '## Overview\nFix dark mode\n\n## Files\n- src/theme.ts: Add dark classes' }]);

    let capturedCtx: BuildStageContext | undefined;
    const runBuildPipeline = async function* (ctx: BuildStageContext): AsyncGenerator<EforgeEvent> {
      capturedCtx = ctx;
      yield { timestamp: new Date().toISOString(), type: 'plan:build:start', planId: ctx.planId } as EforgeEvent;
      yield { timestamp: new Date().toISOString(), type: 'plan:build:complete', planId: ctx.planId } as EforgeEvent;
    };

    await collectEvents(runGapCloser(makeOptions(backend, { runBuildPipeline })));

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.planId).toBe('gap-close');
    expect(capturedCtx!.build).toEqual(['implement', 'review-cycle']);
  });

  it('emits gap_close:complete with passed: true on success', async () => {
    const backend = new StubHarness([{ text: '## Overview\nFix\n\n## Files\n- src/a.ts: change' }]);

    const events = await collectEvents(runGapCloser(makeOptions(backend)));

    const complete = findEvent(events, 'gap_close:complete');
    expect(complete).toBeDefined();
    expect((complete as { passed?: boolean }).passed).toBe(true);
  });

  it('emits gap_close:complete with passed: false when plan generation fails', async () => {
    const backend = new StubHarness([{ error: new Error('Agent crashed') }]);

    const events = await collectEvents(runGapCloser(makeOptions(backend)));

    const complete = findEvent(events, 'gap_close:complete');
    expect(complete).toBeDefined();
    expect((complete as { passed?: boolean }).passed).toBe(false);

    // runBuildPipeline should NOT have been called
    const buildStarts = filterEvents(events, 'plan:build:start');
    expect(buildStarts).toHaveLength(0);
  });

  it('emits gap_close:complete with passed: false when agent returns no plan', async () => {
    const backend = new StubHarness([{ text: '' }]);

    const events = await collectEvents(runGapCloser(makeOptions(backend)));

    const complete = findEvent(events, 'gap_close:complete');
    expect(complete).toBeDefined();
    expect((complete as { passed?: boolean }).passed).toBe(false);
  });

  it('re-throws AbortError', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const backend = new StubHarness([{ error: abortError }]);

    let thrown: Error | undefined;
    const events: EforgeEvent[] = [];
    try {
      for await (const event of runGapCloser(makeOptions(backend))) {
        events.push(event);
      }
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.name).toBe('AbortError');

    // Start event emitted before the error
    expect(findEvent(events, 'gap_close:start')).toBeDefined();
    // Complete event NOT emitted - generator threw
    expect(findEvent(events, 'gap_close:complete')).toBeUndefined();
  });

  it('forwards completionPercent to gap_close:start event', async () => {
    const backend = new StubHarness([{ text: '## Overview\nFix\n\n## Files\n- src/a.ts: change' }]);

    const events = await collectEvents(runGapCloser(makeOptions(backend, { completionPercent: 82 })));

    const start = findEvent(events, 'gap_close:start');
    expect(start).toBeDefined();
    expect((start as { completionPercent?: number }).completionPercent).toBe(82);
  });

  it('omits completionPercent from gap_close:start when not provided', async () => {
    const backend = new StubHarness([{ text: '## Overview\nFix\n\n## Files\n- src/a.ts: change' }]);

    const events = await collectEvents(runGapCloser(makeOptions(backend)));

    const start = findEvent(events, 'gap_close:start');
    expect(start).toBeDefined();
    expect((start as { completionPercent?: number }).completionPercent).toBeUndefined();
  });

  it('emits gap_close:complete with passed: false when build pipeline throws', async () => {
    const backend = new StubHarness([{ text: '## Overview\nFix\n\n## Files\n- src/a.ts: change' }]);

    const runBuildPipeline = async function* (): AsyncGenerator<EforgeEvent> {
      yield { timestamp: new Date().toISOString(), type: 'plan:build:start', planId: 'gap-close' } as EforgeEvent;
      throw new Error('Build pipeline exploded');
    };

    const events = await collectEvents(runGapCloser(makeOptions(backend, { runBuildPipeline })));

    const complete = findEvent(events, 'gap_close:complete');
    expect(complete).toBeDefined();
    expect((complete as { passed?: boolean }).passed).toBe(false);
  });

  it('re-throws AbortError from build pipeline', async () => {
    const backend = new StubHarness([{ text: '## Overview\nFix\n\n## Files\n- src/a.ts: change' }]);

    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const runBuildPipeline = async function* (): AsyncGenerator<EforgeEvent> {
      throw abortError;
    };

    let thrown: Error | undefined;
    try {
      await collectEvents(runGapCloser(makeOptions(backend, { runBuildPipeline })));
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.name).toBe('AbortError');
  });

  it('formats gaps and PRD content into prompt', async () => {
    const backend = new StubHarness([{ text: '## Overview\nPlan\n\n## Files\n- f.ts: change' }]);

    await collectEvents(runGapCloser(makeOptions(backend)));

    expect(backend.prompts).toHaveLength(1);
    expect(backend.prompts[0]).toContain('Must support dark mode');
    expect(backend.prompts[0]).toContain('No dark mode CSS classes found');
    expect(backend.prompts[0]).toContain('Feature PRD');
  });
});
