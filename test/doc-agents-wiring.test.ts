import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StubHarness } from './stub-harness.js';
import { collectEvents, findEvent } from './test-events.js';
import { useTempDir } from './test-tmpdir.js';
import { runDocAuthor } from '@eforge-build/engine/agents/doc-author';
import { runDocSyncer } from '@eforge-build/engine/agents/doc-syncer';
import {
  getBuildStage,
  type BuildStageContext,
} from '@eforge-build/engine/pipeline';
import { createNoopTracingContext } from '@eforge-build/engine/tracing';
import { ModelTracker } from '@eforge-build/engine/model-tracker';
import { DEFAULT_CONFIG, DEFAULT_REVIEW } from '@eforge-build/engine/config';
import { singletonRegistry } from '@eforge-build/engine/agent-runtime-registry';
import type { EforgeEvent, PlanFile, OrchestrationConfig } from '@eforge-build/engine/events';
import type { AgentHarness } from '@eforge-build/engine/harness';

// ---------------------------------------------------------------------------
// runDocAuthor wiring
// ---------------------------------------------------------------------------

describe('runDocAuthor wiring', () => {
  it('emits lifecycle events in order: start then complete', async () => {
    const backend = new StubHarness([{
      text: '<doc-author-summary count="2" created="docs/a.md" updated="docs/b.md">Authored two docs.</doc-author-summary>',
    }]);

    const events = await collectEvents(runDocAuthor({
      harness: backend,
      cwd: '/tmp/test',
      planId: 'plan-01',
      planContent: '# Test plan content',
    }));

    const startEvent = findEvent(events, 'plan:build:doc-author:start');
    const completeEvent = findEvent(events, 'plan:build:doc-author:complete');

    expect(startEvent).toBeDefined();
    expect(startEvent!.planId).toBe('plan-01');
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.planId).toBe('plan-01');

    // Start comes before complete
    const startIdx = events.indexOf(startEvent!);
    const completeIdx = events.indexOf(completeEvent!);
    expect(startIdx).toBeLessThan(completeIdx);
  });

  it('prompt composition includes plan_id and plan_content', async () => {
    const backend = new StubHarness([{ text: '<doc-author-summary count="0">Nothing needed.</doc-author-summary>' }]);

    await collectEvents(runDocAuthor({
      harness: backend,
      cwd: '/tmp/test',
      planId: 'plan-42',
      planContent: 'Some plan body here',
    }));

    expect(backend.prompts).toHaveLength(1);
    const prompt = backend.prompts[0];
    expect(prompt).toContain('plan-42');
    expect(prompt).toContain('Some plan body here');
  });

  it('backend options include tools: coding and maxTurns: 20', async () => {
    const backend = new StubHarness([{ text: '' }]);

    await collectEvents(runDocAuthor({
      harness: backend,
      cwd: '/tmp/test',
      planId: 'plan-01',
      planContent: '# Plan',
    }));

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0].tools).toBe('coding');
    expect(backend.calls[0].maxTurns).toBe(20);
  });

  it('parses docsAuthored count from XML summary', async () => {
    const backend = new StubHarness([{
      text: '<doc-author-summary count="3" created="a.md,b.md" updated="c.md">Authored three docs.</doc-author-summary>',
    }]);

    const events = await collectEvents(runDocAuthor({
      harness: backend,
      cwd: '/tmp/test',
      planId: 'plan-01',
      planContent: '# Plan',
    }));

    const complete = findEvent(events, 'plan:build:doc-author:complete');
    expect(complete!.docsAuthored).toBe(3);
  });

  it('zero docsAuthored when count="0"', async () => {
    const backend = new StubHarness([{
      text: '<doc-author-summary count="0">No docs needed.</doc-author-summary>',
    }]);

    const events = await collectEvents(runDocAuthor({
      harness: backend,
      cwd: '/tmp/test',
      planId: 'plan-01',
      planContent: '# Plan',
    }));

    const complete = findEvent(events, 'plan:build:doc-author:complete');
    expect(complete!.docsAuthored).toBe(0);
  });

  it('missing summary XML defaults to 0', async () => {
    const backend = new StubHarness([{
      text: 'Done authoring docs, all good.',
    }]);

    const events = await collectEvents(runDocAuthor({
      harness: backend,
      cwd: '/tmp/test',
      planId: 'plan-01',
      planContent: '# Plan',
    }));

    const complete = findEvent(events, 'plan:build:doc-author:complete');
    expect(complete!.docsAuthored).toBe(0);
  });

  it('verbose gating via isAlwaysYieldedAgentEvent', async () => {
    const backend = new StubHarness([{
      text: 'Some agent output',
      toolCalls: [
        { tool: 'Read', toolUseId: 'tc-1', input: { path: '/tmp/README.md' }, output: '# Readme' },
      ],
    }]);

    // Non-verbose: agent:result, agent:tool_use, agent:tool_result, agent:start, agent:stop should appear
    const events = await collectEvents(runDocAuthor({
      harness: backend,
      cwd: '/tmp/test',
      planId: 'plan-01',
      planContent: '# Plan',
      verbose: false,
    }));

    const agentResult = events.find((e) => e.type === 'agent:result');
    expect(agentResult).toBeDefined();

    const toolUse = events.find((e) => e.type === 'agent:tool_use');
    expect(toolUse).toBeDefined();

    // agent:message should NOT be yielded when not verbose
    const agentMessage = events.find((e) => e.type === 'agent:message');
    expect(agentMessage).toBeUndefined();
  });

  it('verbose mode yields agent:message events', async () => {
    const backend = new StubHarness([{ text: 'Some output' }]);

    const events = await collectEvents(runDocAuthor({
      harness: backend,
      cwd: '/tmp/test',
      planId: 'plan-01',
      planContent: '# Plan',
      verbose: true,
    }));

    const agentMessage = events.find((e) => e.type === 'agent:message');
    expect(agentMessage).toBeDefined();
  });

  it('non-abort errors are swallowed, complete event still yielded', async () => {
    const backend = new StubHarness([{
      error: new Error('Some random failure'),
    }]);

    const events = await collectEvents(runDocAuthor({
      harness: backend,
      cwd: '/tmp/test',
      planId: 'plan-01',
      planContent: '# Plan',
    }));

    const startEvent = findEvent(events, 'plan:build:doc-author:start');
    const completeEvent = findEvent(events, 'plan:build:doc-author:complete');
    expect(startEvent).toBeDefined();
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.docsAuthored).toBe(0);
  });

  it('AbortError is re-thrown', async () => {
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    const backend = new StubHarness([{
      error: abortError,
    }]);

    await expect(
      collectEvents(runDocAuthor({
        harness: backend,
        cwd: '/tmp/test',
        planId: 'plan-01',
        planContent: '# Plan',
      })),
    ).rejects.toThrow('Aborted');
  });
});

// ---------------------------------------------------------------------------
// runDocSyncer wiring
// ---------------------------------------------------------------------------

describe('runDocSyncer wiring', () => {
  // For tests that verify diff template fields, use a real git fixture
  const makeTempDir = useTempDir('eforge-doc-syncer-test-');

  /** Set up a minimal git repo with two commits; returns { cwd, preImplementCommit }. */
  function setupGitWithDiff(cwd: string): { preImplementCommit: string } {
    execFileSync('git', ['init'], { cwd });
    execFileSync('git', ['config', 'user.email', 'test@eforge.build'], { cwd });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
    writeFileSync(join(cwd, 'README.md'), '# Readme\n');
    execFileSync('git', ['add', 'README.md'], { cwd });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd });
    const preImplementCommit = execFileSync(
      'git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' },
    ).trim();
    // Second commit to produce a non-empty diff
    writeFileSync(join(cwd, 'src.ts'), 'export const API_URL = "/v2/items";\n');
    execFileSync('git', ['add', 'src.ts'], { cwd });
    execFileSync('git', ['commit', '-m', 'Implement feature'], { cwd });
    return { preImplementCommit };
  }

  it('emits lifecycle events in order: start then complete', async () => {
    const backend = new StubHarness([{
      text: '<doc-sync-summary count="2">Synced two docs.</doc-sync-summary>',
    }]);

    const events = await collectEvents(runDocSyncer({
      harness: backend,
      cwd: '/tmp/test',
      planId: 'plan-01',
      planContent: '# Test plan content',
      preImplementCommit: 'fake-sha',
    }));

    const startEvent = findEvent(events, 'plan:build:doc-sync:start');
    const completeEvent = findEvent(events, 'plan:build:doc-sync:complete');

    expect(startEvent).toBeDefined();
    expect(startEvent!.planId).toBe('plan-01');
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.planId).toBe('plan-01');

    // Start comes before complete
    const startIdx = events.indexOf(startEvent!);
    const completeIdx = events.indexOf(completeEvent!);
    expect(startIdx).toBeLessThan(completeIdx);
  });

  it('prompt composition includes plan_id, plan_content, diff_summary, and diff', async () => {
    const cwd = makeTempDir();
    const { preImplementCommit } = setupGitWithDiff(cwd);

    const backend = new StubHarness([{ text: '<doc-sync-summary count="0">Nothing to sync.</doc-sync-summary>' }]);

    await collectEvents(runDocSyncer({
      harness: backend,
      cwd,
      planId: 'plan-42',
      planContent: 'Some plan body here',
      preImplementCommit,
    }));

    expect(backend.prompts).toHaveLength(1);
    const prompt = backend.prompts[0];
    expect(prompt).toContain('plan-42');
    expect(prompt).toContain('Some plan body here');
    // The diff should mention the file added in the second commit
    expect(prompt).toContain('src.ts');
  });

  it('backend options include tools: coding and maxTurns: 20', async () => {
    const backend = new StubHarness([{ text: '' }]);

    await collectEvents(runDocSyncer({
      harness: backend,
      cwd: '/tmp/test',
      planId: 'plan-01',
      planContent: '# Plan',
      preImplementCommit: 'fake-sha',
    }));

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0].tools).toBe('coding');
    expect(backend.calls[0].maxTurns).toBe(20);
  });

  it('parses docsSynced count from XML summary', async () => {
    const backend = new StubHarness([{
      text: '<doc-sync-summary count="3">Synced three docs.</doc-sync-summary>',
    }]);

    const events = await collectEvents(runDocSyncer({
      harness: backend,
      cwd: '/tmp/test',
      planId: 'plan-01',
      planContent: '# Plan',
      preImplementCommit: 'fake-sha',
    }));

    const complete = findEvent(events, 'plan:build:doc-sync:complete');
    expect(complete!.docsSynced).toBe(3);
  });

  it('zero docsSynced when count="0"', async () => {
    const backend = new StubHarness([{
      text: '<doc-sync-summary count="0">Nothing needed.</doc-sync-summary>',
    }]);

    const events = await collectEvents(runDocSyncer({
      harness: backend,
      cwd: '/tmp/test',
      planId: 'plan-01',
      planContent: '# Plan',
      preImplementCommit: 'fake-sha',
    }));

    const complete = findEvent(events, 'plan:build:doc-sync:complete');
    expect(complete!.docsSynced).toBe(0);
  });

  it('missing summary XML defaults to 0', async () => {
    const backend = new StubHarness([{
      text: 'Done syncing docs, all good.',
    }]);

    const events = await collectEvents(runDocSyncer({
      harness: backend,
      cwd: '/tmp/test',
      planId: 'plan-01',
      planContent: '# Plan',
      preImplementCommit: 'fake-sha',
    }));

    const complete = findEvent(events, 'plan:build:doc-sync:complete');
    expect(complete!.docsSynced).toBe(0);
  });

  it('verbose gating via isAlwaysYieldedAgentEvent', async () => {
    const backend = new StubHarness([{
      text: 'Some agent output',
      toolCalls: [
        { tool: 'Read', toolUseId: 'tc-1', input: { path: '/tmp/README.md' }, output: '# Readme' },
      ],
    }]);

    const events = await collectEvents(runDocSyncer({
      harness: backend,
      cwd: '/tmp/test',
      planId: 'plan-01',
      planContent: '# Plan',
      preImplementCommit: 'fake-sha',
      verbose: false,
    }));

    const agentResult = events.find((e) => e.type === 'agent:result');
    expect(agentResult).toBeDefined();

    const toolUse = events.find((e) => e.type === 'agent:tool_use');
    expect(toolUse).toBeDefined();

    // agent:message should NOT be yielded when not verbose
    const agentMessage = events.find((e) => e.type === 'agent:message');
    expect(agentMessage).toBeUndefined();
  });

  it('verbose mode yields agent:message events', async () => {
    const backend = new StubHarness([{ text: 'Some output' }]);

    const events = await collectEvents(runDocSyncer({
      harness: backend,
      cwd: '/tmp/test',
      planId: 'plan-01',
      planContent: '# Plan',
      preImplementCommit: 'fake-sha',
      verbose: true,
    }));

    const agentMessage = events.find((e) => e.type === 'agent:message');
    expect(agentMessage).toBeDefined();
  });

  it('non-abort errors are swallowed, complete event still yielded', async () => {
    const backend = new StubHarness([{
      error: new Error('Some random failure'),
    }]);

    const events = await collectEvents(runDocSyncer({
      harness: backend,
      cwd: '/tmp/test',
      planId: 'plan-01',
      planContent: '# Plan',
      preImplementCommit: 'fake-sha',
    }));

    const startEvent = findEvent(events, 'plan:build:doc-sync:start');
    const completeEvent = findEvent(events, 'plan:build:doc-sync:complete');
    expect(startEvent).toBeDefined();
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.docsSynced).toBe(0);
  });

  it('AbortError is re-thrown', async () => {
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    const backend = new StubHarness([{
      error: abortError,
    }]);

    await expect(
      collectEvents(runDocSyncer({
        harness: backend,
        cwd: '/tmp/test',
        planId: 'plan-01',
        planContent: '# Plan',
        preImplementCommit: 'fake-sha',
      })),
    ).rejects.toThrow('Aborted');
  });
});

// ---------------------------------------------------------------------------
// doc-author and doc-sync stage registrations (stage-level, real git fixture)
// ---------------------------------------------------------------------------

describe('doc-author and doc-sync stage registrations', () => {
  const makeTempDir = useTempDir('eforge-doc-stage-test-');

  /** Set up a minimal git repo with an initial commit; returns the initial commit SHA. */
  function setupGitRepo(cwd: string): string {
    execFileSync('git', ['init'], { cwd });
    execFileSync('git', ['config', 'user.email', 'test@eforge.build'], { cwd });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
    writeFileSync(join(cwd, 'README.md'), '# Test\n');
    execFileSync('git', ['add', 'README.md'], { cwd });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  }

  /** Create a minimal BuildStageContext for stage tests. */
  function makeBuildCtx(
    cwd: string,
    stub: StubHarness,
    overrides: Partial<BuildStageContext> = {},
  ): BuildStageContext {
    const planFile: PlanFile = {
      id: 'plan-01',
      name: 'Test Plan',
      dependsOn: [],
      branch: 'test/plan-01',
      body: '# Plan body',
      filePath: join(cwd, 'plan-01.md'),
    };
    const pipeline = {
      scope: 'excursion' as const,
      compile: ['planner'],
      defaultBuild: ['implement'],
      defaultReview: DEFAULT_REVIEW,
      rationale: 'test',
    };
    const orchConfig: OrchestrationConfig = {
      name: 'test-plan',
      description: 'Test',
      created: new Date().toISOString(),
      mode: 'errand',
      baseBranch: 'main',
      pipeline,
      plans: [{ id: 'plan-01', name: 'Test Plan', dependsOn: [], branch: 'test/plan-01', build: ['doc-author'], review: DEFAULT_REVIEW }],
    };
    return {
      agentRuntimes: singletonRegistry(stub as unknown as AgentHarness),
      config: DEFAULT_CONFIG,
      pipeline,
      tracing: createNoopTracingContext(),
      cwd,
      planSetName: 'test-plan',
      sourceContent: '',
      modelTracker: new ModelTracker(),
      plans: [planFile],
      expeditionModules: [],
      moduleBuildConfigs: new Map(),
      planId: 'plan-01',
      worktreePath: cwd,
      planFile,
      orchConfig,
      reviewIssues: [],
      build: ['doc-author'],
      review: DEFAULT_REVIEW,
      ...overrides,
    };
  }

  it('doc-author stage commits when files are touched', async () => {
    const cwd = makeTempDir();
    setupGitRepo(cwd);

    // Write a file to simulate what the doc-author agent would create
    writeFileSync(join(cwd, 'new-doc.md'), '# New Doc\n');

    const stub = new StubHarness([{
      text: '<doc-author-summary count="1" created="new-doc.md" updated="">Created new doc.</doc-author-summary>',
    }]);
    const ctx = makeBuildCtx(cwd, stub);

    const stage = getBuildStage('doc-author');
    for await (const _ of stage(ctx)) { /* consume events */ }

    const log = execFileSync('git', ['log', '--oneline'], { cwd, encoding: 'utf8' });
    // The commit message starts with the docs(...) subject line
    expect(log).toContain('docs(plan-01): author documentation');
  });

  it('doc-author stage skips commit when no working-tree changes exist', async () => {
    const cwd = makeTempDir();
    setupGitRepo(cwd);

    // No unstaged changes — only the initial commit exists
    const stub = new StubHarness([{
      text: '<doc-author-summary count="0">Nothing needed.</doc-author-summary>',
    }]);
    const ctx = makeBuildCtx(cwd, stub);

    const stage = getBuildStage('doc-author');
    for await (const _ of stage(ctx)) { /* consume */ }

    const log = execFileSync('git', ['log', '--oneline'], { cwd, encoding: 'utf8' });
    const lines = log.trim().split('\n');
    // Only the initial commit — no new commit made
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Initial commit');
  });

  it('doc-sync stage commits when files are touched', async () => {
    const cwd = makeTempDir();
    const preImplementCommit = setupGitRepo(cwd);

    // Simulate an implement commit after preImplementCommit
    writeFileSync(join(cwd, 'src.ts'), 'export const API_URL = "/v2";\n');
    execFileSync('git', ['add', 'src.ts'], { cwd });
    execFileSync('git', ['commit', '-m', 'Implement feature'], { cwd });

    // Write a doc file to simulate what doc-syncer would edit
    writeFileSync(join(cwd, 'api-docs.md'), '# API docs\n');

    const stub = new StubHarness([{
      text: '<doc-sync-summary count="1">Synced api-docs.md.</doc-sync-summary>',
    }]);
    const ctx = makeBuildCtx(cwd, stub, { preImplementCommit, build: ['doc-sync'] });

    const stage = getBuildStage('doc-sync');
    for await (const _ of stage(ctx)) { /* consume */ }

    const log = execFileSync('git', ['log', '--oneline'], { cwd, encoding: 'utf8' });
    expect(log).toContain('docs(plan-01): sync documentation with implementation');
  });

  it('doc-sync stage skips agent and emits lifecycle pair when preImplementCommit is missing', async () => {
    const cwd = makeTempDir();
    setupGitRepo(cwd);

    // No preImplementCommit — agent should be skipped entirely
    const stub = new StubHarness([]); // no responses needed
    const ctx = makeBuildCtx(cwd, stub, { preImplementCommit: undefined, build: ['doc-sync'] });

    const stage = getBuildStage('doc-sync');
    const events: EforgeEvent[] = [];
    for await (const event of stage(ctx)) {
      events.push(event);
    }

    const startEvent = events.find((e) => e.type === 'plan:build:doc-sync:start');
    const completeEvent = events.find((e) => e.type === 'plan:build:doc-sync:complete');
    expect(startEvent).toBeDefined();
    expect(completeEvent).toBeDefined();
    if (completeEvent?.type === 'plan:build:doc-sync:complete') {
      expect(completeEvent.docsSynced).toBe(0);
    }

    // Agent was never called since preImplementCommit was missing
    expect(stub.calls).toHaveLength(0);
  });
});
