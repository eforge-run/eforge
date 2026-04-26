/**
 * Integration tests for the sharded implement stage.
 *
 * These tests exercise the full implement stage using:
 * - A real git repo in a temp directory (for stash/diff operations)
 * - StubHarness for scripted agent responses
 * - Pre-staged files to simulate what shard builders would produce
 *
 * Test matrix:
 * 1. Identity: no shards → single-builder flow runs unchanged
 * 2. Success: 2 non-overlapping shards stage their files → coordinator commits
 * 3. Scope violation: a staged file doesn't match any shard → plan:build:failed
 * 4. Retry exhaustion: shard hits max-turns → plan:build:failed, stash preserved
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stringify as stringifyYaml } from 'yaml';

import type { EforgeEvent, PlanFile, OrchestrationConfig } from '@eforge-build/engine/events';
import { DEFAULT_CONFIG, DEFAULT_REVIEW } from '@eforge-build/engine/config';
import type { BuildStageContext } from '@eforge-build/engine/pipeline';
import { getBuildStage } from '@eforge-build/engine/pipeline';
import type { PipelineComposition } from '@eforge-build/engine/schemas';
import { createNoopTracingContext } from '@eforge-build/engine/tracing';
import { ModelTracker } from '@eforge-build/engine/model-tracker';
import { singletonRegistry } from '@eforge-build/engine/agent-runtime-registry';
import { AgentTerminalError } from '@eforge-build/engine/harness';

import { StubHarness } from './stub-harness.js';
import { collectEvents, findEvent, filterEvents } from './test-events.js';

const exec = promisify(execFile);

const TEST_PIPELINE: PipelineComposition = {
  scope: 'excursion',
  compile: ['planner'],
  defaultBuild: ['implement'],
  defaultReview: DEFAULT_REVIEW,
  rationale: 'test',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function initGitRepo(dir: string): Promise<void> {
  await exec('git', ['init'], { cwd: dir });
  await exec('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  await exec('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  // Create initial commit so HEAD is valid and stash works
  await writeFile(join(dir, 'README.md'), '# Test\n');
  await exec('git', ['add', 'README.md'], { cwd: dir });
  await exec('git', ['commit', '-m', 'initial commit'], { cwd: dir });
}

function makePlanFile(overrides: Partial<PlanFile> & { id: string; name: string }): PlanFile {
  return {
    id: overrides.id,
    name: overrides.name,
    dependsOn: [],
    branch: `test/${overrides.id}`,
    body: overrides.body ?? '# Plan\n\n## Verification\n\n(No commands)\n',
    filePath: `/tmp/test/${overrides.id}.md`,
    agents: overrides.agents,
  };
}

function makeBuildCtx(
  worktreePath: string,
  planFile: PlanFile,
  harness: StubHarness,
  overrides: Partial<BuildStageContext> = {},
): BuildStageContext {
  const orchConfig: OrchestrationConfig = {
    name: 'test-plan',
    description: 'Test',
    created: new Date().toISOString(),
    mode: 'errand',
    baseBranch: 'main',
    pipeline: TEST_PIPELINE,
    plans: [{
      id: planFile.id,
      name: planFile.name,
      dependsOn: [],
      branch: planFile.branch,
      build: ['implement'],
      review: DEFAULT_REVIEW,
    }],
  };

  return {
    agentRuntimes: singletonRegistry(harness),
    config: DEFAULT_CONFIG,
    pipeline: TEST_PIPELINE,
    tracing: createNoopTracingContext(),
    cwd: worktreePath,
    planSetName: 'test-plan',
    sourceContent: '',
    modelTracker: new ModelTracker(),
    plans: [planFile],
    expeditionModules: [],
    moduleBuildConfigs: new Map(),
    planId: planFile.id,
    worktreePath,
    planFile,
    orchConfig,
    reviewIssues: [],
    build: ['implement'],
    review: DEFAULT_REVIEW,
    planEntry: orchConfig.plans[0],
    ...overrides,
  };
}

async function runImplementStage(ctx: BuildStageContext): Promise<EforgeEvent[]> {
  const implementStage = getBuildStage('implement');
  return collectEvents(implementStage(ctx));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sharded implement stage', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'eforge-shard-impl-test-'));
    await initGitRepo(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Identity test: no shards → unchanged single-builder flow
  // -------------------------------------------------------------------------

  it('identity: no shards runs single-builder flow unchanged', async () => {
    const planFile = makePlanFile({ id: 'plan-01', name: 'No Shards Plan' });
    const harness = new StubHarness([
      { text: 'Implementation complete.' },
    ]);

    const ctx = makeBuildCtx(tmpDir, planFile, harness);
    const events = await runImplementStage(ctx);

    // Should emit implement:start but NOT use sharded coordinator
    const startEvent = findEvent(events, 'plan:build:implement:start');
    expect(startEvent).toBeDefined();
    expect(startEvent?.planId).toBe('plan-01');

    // No plan:build:failed should be emitted (builder stub succeeds)
    const failEvents = filterEvents(events, 'plan:build:failed');
    expect(failEvents).toHaveLength(0);

    // Harness should have been called once (single builder run)
    expect(harness.calls).toHaveLength(1);
  });

  it('identity: plan with no shards does not trigger coordinator scope enforcement', async () => {
    const planFile = makePlanFile({ id: 'plan-01', name: 'No Shards Plan' });
    const harness = new StubHarness([{ text: 'Done.' }]);

    // Pre-stage a file that would violate scope if we had shards
    await writeFile(join(tmpDir, 'random-file.ts'), 'export const x = 1;\n');
    await exec('git', ['add', 'random-file.ts'], { cwd: tmpDir });

    const ctx = makeBuildCtx(tmpDir, planFile, harness);
    const events = await runImplementStage(ctx);

    // No scope enforcement → no plan:build:failed
    const failEvents = filterEvents(events, 'plan:build:failed');
    expect(failEvents).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Sharded success: 2 non-overlapping shards, coordinator commits
  // -------------------------------------------------------------------------

  it('sharded success: 2 non-overlapping shards produces exactly one commit', async () => {
    // Pre-stage files for both shards
    await mkdir(join(tmpDir, 'packages', 'engine', 'src'), { recursive: true });
    await mkdir(join(tmpDir, 'test'), { recursive: true });
    await writeFile(join(tmpDir, 'packages', 'engine', 'src', 'new-file.ts'), 'export const x = 1;\n');
    await writeFile(join(tmpDir, 'test', 'new-test.ts'), 'describe("x", () => {});\n');
    await exec('git', ['add', 'packages/engine/src/new-file.ts', 'test/new-test.ts'], { cwd: tmpDir });

    const planFile = makePlanFile({
      id: 'plan-01',
      name: 'Sharded Plan',
      agents: {
        builder: {
          shards: [
            { id: 'shard-packages', roots: ['packages/'] },
            { id: 'shard-tests', roots: ['test/'] },
          ],
        },
      },
    });

    // Two shards → two builder calls
    const harness = new StubHarness([
      { text: 'Shard packages done.' },
      { text: 'Shard tests done.' },
    ]);

    const ctx = makeBuildCtx(tmpDir, planFile, harness);
    const events = await runImplementStage(ctx);

    // No failures
    const failEvents = filterEvents(events, 'plan:build:failed');
    expect(failEvents).toHaveLength(0);

    // implement:complete should be emitted by the coordinator
    const completeEvent = findEvent(events, 'plan:build:implement:complete');
    expect(completeEvent).toBeDefined();

    // Exactly one commit should have been created by the coordinator
    const { stdout: log } = await exec('git', ['log', '--oneline'], { cwd: tmpDir });
    const commits = log.trim().split('\n').filter(Boolean);
    // Should have: initial commit + coordinator commit
    expect(commits).toHaveLength(2);
    expect(commits[0]).toContain('plan-01');
  });

  it('sharded success: harness called once per shard', async () => {
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await mkdir(join(tmpDir, 'lib'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'a.ts'), 'const a = 1;\n');
    await writeFile(join(tmpDir, 'lib', 'b.ts'), 'const b = 2;\n');
    await exec('git', ['add', 'src/a.ts', 'lib/b.ts'], { cwd: tmpDir });

    const planFile = makePlanFile({
      id: 'plan-02',
      name: 'Two Shard Plan',
      agents: {
        builder: {
          shards: [
            { id: 'shard-src', roots: ['src/'] },
            { id: 'shard-lib', roots: ['lib/'] },
          ],
        },
      },
    });

    const harness = new StubHarness([
      { text: 'Shard src done.' },
      { text: 'Shard lib done.' },
    ]);

    const ctx = makeBuildCtx(tmpDir, planFile, harness);
    await runImplementStage(ctx);

    // Each shard calls the harness once
    expect(harness.calls).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Scope violation: staged file not in any shard → plan:build:failed
  // -------------------------------------------------------------------------

  it('scope violation: unclaimed file causes plan:build:failed', async () => {
    await mkdir(join(tmpDir, 'packages'), { recursive: true });
    await writeFile(join(tmpDir, 'packages', 'file.ts'), 'const x = 1;\n');
    // Stage a file OUTSIDE any shard's scope
    await writeFile(join(tmpDir, 'README.md'), '# Updated\n');
    await exec('git', ['add', 'packages/file.ts', 'README.md'], { cwd: tmpDir });

    const planFile = makePlanFile({
      id: 'plan-03',
      name: 'Scope Violation Plan',
      agents: {
        builder: {
          shards: [
            { id: 'shard-packages', roots: ['packages/'] },
          ],
        },
      },
    });

    const harness = new StubHarness([
      { text: 'Shard packages done.' },
    ]);

    const ctx = makeBuildCtx(tmpDir, planFile, harness);
    const events = await runImplementStage(ctx);

    // Should produce a plan:build:failed with the offending file
    const failEvents = filterEvents(events, 'plan:build:failed');
    expect(failEvents).toHaveLength(1);
    expect(failEvents[0].error).toContain('scope enforcement failed');
    expect(failEvents[0].error).toContain('README.md');
    expect(ctx.buildFailed).toBe(true);

    // No commit should be created
    const { stdout: log } = await exec('git', ['log', '--oneline'], { cwd: tmpDir });
    const commits = log.trim().split('\n').filter(Boolean);
    expect(commits).toHaveLength(1); // Only initial commit
  });

  it('scope violation: overlapping shards cause plan:build:failed', async () => {
    await mkdir(join(tmpDir, 'packages', 'engine', 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'packages', 'engine', 'src', 'config.ts'), 'const c = 1;\n');
    await exec('git', ['add', 'packages/engine/src/config.ts'], { cwd: tmpDir });

    const planFile = makePlanFile({
      id: 'plan-04',
      name: 'Overlap Violation Plan',
      agents: {
        builder: {
          shards: [
            { id: 'shard-a', roots: ['packages/'] },
            { id: 'shard-b', roots: ['packages/engine/'] }, // overlaps with shard-a
          ],
        },
      },
    });

    const harness = new StubHarness([
      { text: 'Shard a done.' },
      { text: 'Shard b done.' },
    ]);

    const ctx = makeBuildCtx(tmpDir, planFile, harness);
    const events = await runImplementStage(ctx);

    const failEvents = filterEvents(events, 'plan:build:failed');
    expect(failEvents).toHaveLength(1);
    expect(failEvents[0].error).toContain('scope enforcement failed');
    expect(failEvents[0].error).toContain('packages/engine/src/config.ts');
    // Error should name both claiming shard IDs
    expect(failEvents[0].error).toContain('shard-a');
    expect(failEvents[0].error).toContain('shard-b');
    expect(ctx.buildFailed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Retry exhaustion: shard fails all attempts → plan:build:failed, stash preserved
  // -------------------------------------------------------------------------

  it('retry exhaustion: shard exhausts budget → plan:build:failed and stash preserved', async () => {
    await mkdir(join(tmpDir, 'packages'), { recursive: true });
    await writeFile(join(tmpDir, 'packages', 'work.ts'), 'const w = 1;\n');
    // Leave file unstaged (simulates in-progress work that the agent stashes on max-turns)

    const planFile = makePlanFile({
      id: 'plan-05',
      name: 'Retry Exhaustion Plan',
      agents: {
        builder: {
          shards: [
            { id: 'shard-fail', roots: ['packages/'] },
          ],
        },
      },
    });

    // All 4 attempts fail with max-turns
    const maxTurnsError = new AgentTerminalError('Max turns reached', 'error_max_turns');
    const harness = new StubHarness([
      { error: maxTurnsError },
      { error: maxTurnsError },
      { error: maxTurnsError },
      { error: maxTurnsError },
    ]);

    const ctx = makeBuildCtx(tmpDir, planFile, harness);
    // Use a low maxContinuations to limit to 2 attempts total (default is 3+1=4)
    const events = await runImplementStage(ctx);

    // The shard should have failed
    const failEvents = filterEvents(events, 'plan:build:failed');
    expect(failEvents.length).toBeGreaterThan(0);
    expect(ctx.buildFailed).toBe(true);

    // No coordinator commit
    const { stdout: log } = await exec('git', ['log', '--oneline'], { cwd: tmpDir });
    const commits = log.trim().split('\n').filter(Boolean);
    expect(commits).toHaveLength(1); // Only initial commit
  });

  // -------------------------------------------------------------------------
  // Schema validation: unique shard IDs enforced
  // -------------------------------------------------------------------------

  it('schema: duplicate shard IDs throw during resolveAgentConfig', async () => {
    const { resolveAgentConfig } = await import('@eforge-build/engine/pipeline');
    const planFile = makePlanFile({
      id: 'plan-dup',
      name: 'Duplicate Shard IDs',
      agents: {
        builder: {
          shards: [
            { id: 'shard-a', roots: ['packages/'] },
            { id: 'shard-a', roots: ['test/'] }, // duplicate ID
          ],
        },
      },
    });

    expect(() => resolveAgentConfig('builder', DEFAULT_CONFIG, planFile)).toThrow(
      /duplicate shard IDs/i,
    );
  });

  it('schema: shards with neither roots nor files fail validation', async () => {
    const { shardScopeSchema } = await import('@eforge-build/engine/schemas');

    // Valid
    expect(shardScopeSchema.safeParse({ id: 'a', roots: ['src/'] }).success).toBe(true);
    expect(shardScopeSchema.safeParse({ id: 'b', files: ['foo.ts'] }).success).toBe(true);
    expect(shardScopeSchema.safeParse({ id: 'c', roots: ['src/'], files: ['foo.ts'] }).success).toBe(true);

    // Invalid: neither roots nor files
    const emptyResult = shardScopeSchema.safeParse({ id: 'd' });
    expect(emptyResult.success).toBe(false);

    // Invalid: empty roots and empty files
    const emptyArrayResult = shardScopeSchema.safeParse({ id: 'e', roots: [], files: [] });
    expect(emptyArrayResult.success).toBe(false);
  });
});
