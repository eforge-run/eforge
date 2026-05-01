/**
 * Tests for EforgeEngine.applyRecovery — all four verdict dispatches plus error paths.
 *
 * Each test builds a real git fixture, seeds the failed PRD + both sidecar files,
 * calls engine.applyRecovery(), then asserts post-conditions on the working tree
 * and git log.
 *
 * Per AGENTS.md: no harness or git mocks — all tests use real git operations.
 */

import { describe, it, expect } from 'vitest';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { EforgeEngine } from '@eforge-build/engine/eforge';
import { useTempDir } from './test-tmpdir.js';
import { StubHarness } from './stub-harness.js';
import type { EforgeEvent } from '@eforge-build/engine/events';
import type { ApplyRecoveryResult } from '@eforge-build/engine/schemas';

const execAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/**
 * Set up a minimal git repository with:
 * - 1 commit on `main`
 * - `eforge/queue/failed/` directory created
 */
function seedGitRepo(dir: string): void {
  const gitOpts = { cwd: dir };
  execFileSync('git', ['init', '-b', 'main'], gitOpts);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], gitOpts);
  execFileSync('git', ['config', 'user.name', 'Test'], gitOpts);
  execFileSync('git', ['commit', '--allow-empty', '-m', 'chore: initial commit'], gitOpts);
}

/** Seed the failed PRD + both sidecar files for a given verdict. */
async function seedFailedPrd(
  dir: string,
  prdId: string,
  verdict: 'retry' | 'split' | 'abandon' | 'manual',
  opts?: { suggestedSuccessorPrd?: string },
): Promise<void> {
  const failedDir = join(dir, 'eforge', 'queue', 'failed');
  await mkdir(failedDir, { recursive: true });

  // Write the PRD file
  const prdContent = `# Test PRD: ${prdId}\n\nBuild something.`;
  await writeFile(join(failedDir, `${prdId}.md`), prdContent, 'utf-8');

  // Write the recovery markdown sidecar
  const recoveryMd = `## Recovery Report\n\nVerdict: ${verdict.toUpperCase()}`;
  await writeFile(join(failedDir, `${prdId}.recovery.md`), recoveryMd, 'utf-8');

  // Write the recovery JSON sidecar
  const verdictJson: Record<string, unknown> = {
    verdict,
    confidence: 'high',
    rationale: 'Test rationale.',
    completedWork: [],
    remainingWork: [],
    risks: [],
  };
  if (verdict === 'split') {
    verdictJson.suggestedSuccessorPrd =
      opts?.suggestedSuccessorPrd ?? '# Successor Feature\n\nContinue the work.';
  }
  const sidecarJson = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    summary: {
      prdId,
      setName: 'test-set',
      featureBranch: 'eforge/test-set',
      baseBranch: 'main',
      plans: [],
      failingPlan: { planId: 'plan-01' },
      landedCommits: [],
      diffStat: '',
      modelsUsed: [],
      failedAt: new Date().toISOString(),
    },
    verdict: verdictJson,
  };
  await writeFile(
    join(failedDir, `${prdId}.recovery.json`),
    JSON.stringify(sidecarJson, null, 2),
    'utf-8',
  );

  // Stage and commit all files so they are tracked by git
  const gitOpts = { cwd: dir };
  execFileSync('git', ['add', '--', failedDir], gitOpts);
  execFileSync('git', ['commit', '-m', `chore: seed failed prd ${prdId}`], gitOpts);
}

/** Drive an async generator, returning both events and the final result. */
async function driveGenerator(
  gen: AsyncGenerator<EforgeEvent, ApplyRecoveryResult>,
): Promise<{ events: EforgeEvent[]; result: ApplyRecoveryResult }> {
  const events: EforgeEvent[] = [];
  while (true) {
    const next = await gen.next();
    if (next.done) {
      return { events, result: next.value };
    }
    events.push(next.value);
  }
}

/** Check whether a path exists in the filesystem. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Get the subject of the most recent commit. */
async function gitLogSubject(cwd: string): Promise<string> {
  const { stdout } = await execAsync('git', ['log', '-1', '--format=%s'], { cwd });
  return stdout.trim();
}

/** Get the full body of the most recent commit. */
async function gitLogBody(cwd: string): Promise<string> {
  const { stdout } = await execAsync('git', ['log', '-1', '--format=%B'], { cwd });
  return stdout.trim();
}

/** Get the HEAD SHA. */
async function gitHeadSha(cwd: string): Promise<string> {
  const { stdout } = await execAsync('git', ['rev-parse', 'HEAD'], { cwd });
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// retry verdict
// ---------------------------------------------------------------------------

describe('applyRecovery — retry', () => {
  const makeTempDir = useTempDir('eforge-apply-recovery-retry-');

  it('moves failed PRD to queue and removes sidecars', async () => {
    const dir = makeTempDir();
    const prdId = 'test-retry-prd';
    seedGitRepo(dir);
    await seedFailedPrd(dir, prdId, 'retry');

    const engine = await EforgeEngine.create({ cwd: dir, agentRuntimes: new StubHarness([]) });
    const { events, result } = await driveGenerator(engine.applyRecovery(prdId));

    // Result shape
    expect(result.verdict).toBe('retry');
    expect(result.noAction).toBe(false);
    expect(result.commitSha).toBeDefined();
    expect(typeof result.commitSha).toBe('string');
    expect(result.commitSha!.length).toBe(40);

    // Working tree: queued PRD present
    expect(await pathExists(join(dir, 'eforge', 'queue', `${prdId}.md`))).toBe(true);
    // Working tree: failed PRD absent
    expect(await pathExists(join(dir, 'eforge', 'queue', 'failed', `${prdId}.md`))).toBe(false);
    // Working tree: sidecar files absent
    expect(await pathExists(join(dir, 'eforge', 'queue', 'failed', `${prdId}.recovery.md`))).toBe(false);
    expect(await pathExists(join(dir, 'eforge', 'queue', 'failed', `${prdId}.recovery.json`))).toBe(false);

    // Git log
    const subject = await gitLogSubject(dir);
    expect(subject).toContain(`recover(${prdId}): requeue`);

    // Events
    const startEvent = events.find((e) => e.type === 'recovery:apply:start');
    expect(startEvent).toBeDefined();
    const completeEvent = events.find((e) => e.type === 'recovery:apply:complete');
    expect(completeEvent).toBeDefined();
    expect((completeEvent as Extract<EforgeEvent, { type: 'recovery:apply:complete' }>).verdict).toBe('retry');
    expect((completeEvent as Extract<EforgeEvent, { type: 'recovery:apply:complete' }>).noAction).toBe(false);
  });

  it('commit carries Co-Authored-By: forged-by-eforge trailer', async () => {
    const dir = makeTempDir();
    const prdId = 'test-retry-trailer';
    seedGitRepo(dir);
    await seedFailedPrd(dir, prdId, 'retry');

    const engine = await EforgeEngine.create({ cwd: dir, agentRuntimes: new StubHarness([]) });
    await driveGenerator(engine.applyRecovery(prdId));

    const body = await gitLogBody(dir);
    expect(body).toContain('Co-Authored-By: forged-by-eforge');
  });
});

// ---------------------------------------------------------------------------
// split verdict
// ---------------------------------------------------------------------------

describe('applyRecovery — split', () => {
  const makeTempDir = useTempDir('eforge-apply-recovery-split-');

  it('writes successor PRD to queue, leaves failed PRD and sidecars', async () => {
    const dir = makeTempDir();
    const prdId = 'test-split-prd';
    seedGitRepo(dir);
    await seedFailedPrd(dir, prdId, 'split', {
      suggestedSuccessorPrd: '# Successor Feature\n\nContinue the API work.',
    });

    const engine = await EforgeEngine.create({ cwd: dir, agentRuntimes: new StubHarness([]) });
    const { events, result } = await driveGenerator(engine.applyRecovery(prdId));

    // Result shape
    expect(result.verdict).toBe('split');
    expect(result.noAction).toBe(false);
    expect(result.successorPrdId).toBeDefined();
    expect(result.commitSha).toBeDefined();

    const successorPrdId = result.successorPrdId!;

    // Working tree: successor PRD present in queue
    expect(await pathExists(join(dir, 'eforge', 'queue', `${successorPrdId}.md`))).toBe(true);
    // Working tree: failed PRD still present
    expect(await pathExists(join(dir, 'eforge', 'queue', 'failed', `${prdId}.md`))).toBe(true);
    // Working tree: sidecars still present
    expect(await pathExists(join(dir, 'eforge', 'queue', 'failed', `${prdId}.recovery.md`))).toBe(true);
    expect(await pathExists(join(dir, 'eforge', 'queue', 'failed', `${prdId}.recovery.json`))).toBe(true);

    // Successor content matches suggestedSuccessorPrd
    const successorContent = await readFile(
      join(dir, 'eforge', 'queue', `${successorPrdId}.md`),
      'utf-8',
    );
    expect(successorContent).toContain('Successor Feature');

    // Git log subject
    const subject = await gitLogSubject(dir);
    expect(subject).toContain(`recover(${prdId}): enqueue successor ${successorPrdId}`);

    // Events
    const completeEvent = events.find((e) => e.type === 'recovery:apply:complete') as
      | Extract<EforgeEvent, { type: 'recovery:apply:complete' }>
      | undefined;
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.verdict).toBe('split');
    expect(completeEvent!.successorPrdId).toBe(successorPrdId);

    // Co-Authored-By trailer
    const body = await gitLogBody(dir);
    expect(body).toContain('Co-Authored-By: forged-by-eforge');
  });

  it('strips agent-emitted frontmatter and rebuilds clean frontmatter with no depends_on', async () => {
    const dir = makeTempDir();
    const prdId = 'test-split-frontmatter-strip';
    seedGitRepo(dir);
    await seedFailedPrd(dir, prdId, 'split', {
      suggestedSuccessorPrd: [
        '---',
        'title: Wrong Title',
        'depends_on: ["the-failed-prd-id"]',
        '---',
        '',
        '# Real Title',
        '',
        'Body content here.',
      ].join('\n'),
    });

    const engine = await EforgeEngine.create({ cwd: dir, agentRuntimes: new StubHarness([]) });
    const { result } = await driveGenerator(engine.applyRecovery(prdId));

    // Successor ID should come from the body heading, not the agent frontmatter
    expect(result.successorPrdId).toBe('real-title');

    // Successor file should exist
    const successorPath = join(dir, 'eforge', 'queue', 'real-title.md');
    expect(await pathExists(successorPath)).toBe(true);

    const successorContent = await readFile(successorPath, 'utf-8');

    // Frontmatter should have title from the H1 heading
    expect(successorContent).toContain('title: Real Title');

    // Frontmatter must not contain depends_on
    expect(successorContent).not.toMatch(/depends_on:/);

    // Body section (after trailing ---) must not begin with ---
    const fmEnd = successorContent.indexOf('\n---\n', successorContent.indexOf('---'));
    const bodySection = successorContent.slice(fmEnd + 5).replace(/^\s+/, '');
    expect(bodySection).not.toMatch(/^---/);
  });

  it('derives successor ID from the first heading', async () => {
    const dir = makeTempDir();
    const prdId = 'test-split-slug';
    seedGitRepo(dir);
    await seedFailedPrd(dir, prdId, 'split', {
      suggestedSuccessorPrd: '# REST API Layer\n\nBuild the REST layer.',
    });

    const engine = await EforgeEngine.create({ cwd: dir, agentRuntimes: new StubHarness([]) });
    const { result } = await driveGenerator(engine.applyRecovery(prdId));

    expect(result.successorPrdId).toBe('rest-api-layer');
  });
});

// ---------------------------------------------------------------------------
// abandon verdict
// ---------------------------------------------------------------------------

describe('applyRecovery — abandon', () => {
  const makeTempDir = useTempDir('eforge-apply-recovery-abandon-');

  it('removes failed PRD and both sidecars', async () => {
    const dir = makeTempDir();
    const prdId = 'test-abandon-prd';
    seedGitRepo(dir);
    await seedFailedPrd(dir, prdId, 'abandon');

    const engine = await EforgeEngine.create({ cwd: dir, agentRuntimes: new StubHarness([]) });
    const { events, result } = await driveGenerator(engine.applyRecovery(prdId));

    // Result shape
    expect(result.verdict).toBe('abandon');
    expect(result.noAction).toBe(false);
    expect(result.commitSha).toBeDefined();

    // Working tree: all three paths absent
    expect(await pathExists(join(dir, 'eforge', 'queue', 'failed', `${prdId}.md`))).toBe(false);
    expect(await pathExists(join(dir, 'eforge', 'queue', 'failed', `${prdId}.recovery.md`))).toBe(false);
    expect(await pathExists(join(dir, 'eforge', 'queue', 'failed', `${prdId}.recovery.json`))).toBe(false);

    // Git log
    const subject = await gitLogSubject(dir);
    expect(subject).toContain(`recover(${prdId}): abandon`);

    // Events
    const completeEvent = events.find((e) => e.type === 'recovery:apply:complete') as
      | Extract<EforgeEvent, { type: 'recovery:apply:complete' }>
      | undefined;
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.verdict).toBe('abandon');
    expect(completeEvent!.noAction).toBe(false);

    // Co-Authored-By trailer
    const body = await gitLogBody(dir);
    expect(body).toContain('Co-Authored-By: forged-by-eforge');
  });
});

// ---------------------------------------------------------------------------
// manual verdict
// ---------------------------------------------------------------------------

describe('applyRecovery — manual', () => {
  const makeTempDir = useTempDir('eforge-apply-recovery-manual-');

  it('makes no git changes and returns noAction: true', async () => {
    const dir = makeTempDir();
    const prdId = 'test-manual-prd';
    seedGitRepo(dir);
    await seedFailedPrd(dir, prdId, 'manual');

    const headBefore = await gitHeadSha(dir);

    const engine = await EforgeEngine.create({ cwd: dir, agentRuntimes: new StubHarness([]) });
    const { events, result } = await driveGenerator(engine.applyRecovery(prdId));

    // Result shape
    expect(result.verdict).toBe('manual');
    expect(result.noAction).toBe(true);
    expect(result.commitSha).toBeUndefined();

    // No new commit
    const headAfter = await gitHeadSha(dir);
    expect(headAfter).toBe(headBefore);

    // Working tree: files still present
    expect(await pathExists(join(dir, 'eforge', 'queue', 'failed', `${prdId}.md`))).toBe(true);
    expect(await pathExists(join(dir, 'eforge', 'queue', 'failed', `${prdId}.recovery.md`))).toBe(true);
    expect(await pathExists(join(dir, 'eforge', 'queue', 'failed', `${prdId}.recovery.json`))).toBe(true);

    // Events
    const startEvent = events.find((e) => e.type === 'recovery:apply:start');
    expect(startEvent).toBeDefined();
    const completeEvent = events.find((e) => e.type === 'recovery:apply:complete') as
      | Extract<EforgeEvent, { type: 'recovery:apply:complete' }>
      | undefined;
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.verdict).toBe('manual');
    expect(completeEvent!.noAction).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('applyRecovery — error paths', () => {
  const makeTempDir = useTempDir('eforge-apply-recovery-errors-');

  it('throws with recover() message when sidecar JSON is missing', async () => {
    const dir = makeTempDir();
    const prdId = 'no-sidecar-prd';
    seedGitRepo(dir);

    // Only create the PRD file, no sidecar
    const failedDir = join(dir, 'eforge', 'queue', 'failed');
    await mkdir(failedDir, { recursive: true });
    await writeFile(join(failedDir, `${prdId}.md`), '# PRD', 'utf-8');

    const engine = await EforgeEngine.create({ cwd: dir, agentRuntimes: new StubHarness([]) });

    await expect(
      driveGenerator(engine.applyRecovery(prdId)),
    ).rejects.toThrow(/recover\(\)/);
  });

  it('throws with suggestedSuccessorPrd message for split without successor content', async () => {
    const dir = makeTempDir();
    const prdId = 'split-no-successor';
    seedGitRepo(dir);

    const failedDir = join(dir, 'eforge', 'queue', 'failed');
    await mkdir(failedDir, { recursive: true });
    await writeFile(join(failedDir, `${prdId}.md`), '# PRD', 'utf-8');
    await writeFile(join(failedDir, `${prdId}.recovery.md`), '# Report', 'utf-8');

    // Write a split verdict with NO suggestedSuccessorPrd
    const sidecarJson = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      summary: {
        prdId,
        setName: 'test-set',
        featureBranch: 'eforge/test-set',
        baseBranch: 'main',
        plans: [],
        failingPlan: { planId: 'plan-01' },
        landedCommits: [],
        diffStat: '',
        modelsUsed: [],
        failedAt: new Date().toISOString(),
      },
      verdict: {
        verdict: 'split',
        confidence: 'medium',
        rationale: 'Foundation done; API remains.',
        completedWork: [],
        remainingWork: [],
        risks: [],
        // suggestedSuccessorPrd intentionally omitted
      },
    };
    await writeFile(
      join(failedDir, `${prdId}.recovery.json`),
      JSON.stringify(sidecarJson, null, 2),
      'utf-8',
    );

    // Stage and commit
    execFileSync('git', ['add', '--', failedDir], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'chore: seed split-no-successor'], { cwd: dir });

    const engine = await EforgeEngine.create({ cwd: dir, agentRuntimes: new StubHarness([]) });

    await expect(
      driveGenerator(engine.applyRecovery(prdId)),
    ).rejects.toThrow(/suggestedSuccessorPrd/);
  });

  it('emits recovery:apply:start before throwing on missing sidecar', async () => {
    const dir = makeTempDir();
    const prdId = 'no-sidecar-events';
    seedGitRepo(dir);

    const engine = await EforgeEngine.create({ cwd: dir, agentRuntimes: new StubHarness([]) });
    const gen = engine.applyRecovery(prdId);
    const events: EforgeEvent[] = [];

    // Drive generator manually so we can catch and inspect events before throw
    try {
      while (true) {
        const next = await gen.next();
        if (next.done) break;
        events.push(next.value);
      }
    } catch {
      // Expected throw
    }

    const startEvent = events.find((e) => e.type === 'recovery:apply:start');
    expect(startEvent).toBeDefined();

    const errorEvent = events.find((e) => e.type === 'recovery:apply:error');
    expect(errorEvent).toBeDefined();
  });
});
