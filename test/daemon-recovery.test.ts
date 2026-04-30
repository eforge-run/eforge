/**
 * Tests for the new inline atomic recovery architecture.
 *
 * Architecture change: recovery now runs inline in the queue parent's finalize
 * handler (no daemon polling loop). The PRD move + both sidecar files are
 * committed atomically via moveAndCommitFailedWithSidecar. The daemon's
 * POST /api/recover route still exists for manual backfill.
 *
 * Tests covered:
 * 1. moveAndCommitFailedWithSidecar produces a single atomic commit with
 *    the moved PRD + both sidecar paths.
 * 2. Sidecar path uses prdId not planId (multi-plan scenario).
 * 3. Recovery analyst parse error -> manual-verdict sidecar still written.
 * 4. EforgeEngine.recover() with no state.json + populated event DB -> partial sidecar.
 * 5. EforgeEngine.recover() with no state.json AND no event DB -> partial sidecar.
 * 6. GET /api/recovery/sidecar reads v2 sidecar.
 * 7. POST /api/recover: manual trigger route returns sessionId and pid.
 *
 * Follows AGENTS.md conventions:
 * - No mocks. Real git repos, real SQLite, stub harness for agents.
 * - useTempDir for filesystem cleanup.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { useTempDir } from './test-tmpdir.js';
import { openDatabase } from '@eforge-build/monitor/db';
import { startServer, type WorkerTracker, type MonitorServer } from '@eforge-build/monitor/server';
import { moveAndCommitFailedWithSidecar } from '@eforge-build/engine/prd-queue';
import { EforgeEngine } from '@eforge-build/engine/eforge';
import { StubHarness } from './stub-harness.js';
import { API_ROUTES, DAEMON_API_VERSION } from '@eforge-build/client';
import type { EforgeEvent } from '@eforge-build/engine/events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function initGitRepo(dir: string): void {
  const opts = { cwd: dir };
  execFileSync('git', ['init', '-b', 'main'], opts);
  execFileSync('git', ['config', 'user.email', 'test@eforge.test'], opts);
  execFileSync('git', ['config', 'user.name', 'Test'], opts);
  execFileSync('git', ['commit', '--allow-empty', '-m', 'initial'], opts);
}

async function collectEvents(gen: AsyncGenerator<EforgeEvent>): Promise<EforgeEvent[]> {
  const events: EforgeEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

interface SpawnCall {
  command: string;
  args: string[];
  sessionId: string;
  pid: number;
}

/** Stub WorkerTracker that records spawn calls without actually spawning. */
function makeStubTracker(): { tracker: WorkerTracker; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  let pidCounter = 10000;
  let sessionCounter = 0;

  const tracker: WorkerTracker = {
    spawnWorker(command: string, args: string[]): { sessionId: string; pid: number } {
      const sessionId = `stub-${++sessionCounter}`;
      const pid = ++pidCounter;
      calls.push({ command, args, sessionId, pid });
      return { sessionId, pid };
    },
    cancelWorker(_sessionId: string): boolean {
      return false;
    },
  };

  return { tracker, calls };
}

// ---------------------------------------------------------------------------
// Test setup for HTTP server tests
// ---------------------------------------------------------------------------

const makeTempDir = useTempDir();

let tmpDir: string;
let dbPath: string;
let server: MonitorServer;
let tracker: WorkerTracker;
let spawnCalls: SpawnCall[];

async function setupServer(): Promise<void> {
  const { tracker: t, calls } = makeStubTracker();
  tracker = t;
  spawnCalls = calls;

  server = await startServer(
    openDatabase(dbPath),
    0,
    {
      strictPort: true,
      cwd: tmpDir,
      workerTracker: tracker,
    },
  );
}

beforeEach(async () => {
  tmpDir = makeTempDir();
  dbPath = resolve(tmpDir, 'monitor.db');
});

afterEach(async () => {
  await server?.stop();
});

// ---------------------------------------------------------------------------
// DAEMON_API_VERSION
// ---------------------------------------------------------------------------

describe('DAEMON_API_VERSION', () => {
  it('is 12', () => {
    expect(DAEMON_API_VERSION).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// API_ROUTES exports
// ---------------------------------------------------------------------------

describe('API_ROUTES', () => {
  it('exposes recover route', () => {
    expect(API_ROUTES.recover).toBe('/api/recover');
  });

  it('exposes readRecoverySidecar route', () => {
    expect(API_ROUTES.readRecoverySidecar).toBe('/api/recovery/sidecar');
  });
});

// ---------------------------------------------------------------------------
// 7. POST /api/recover — manual trigger
// ---------------------------------------------------------------------------

describe('POST /api/recover', () => {
  beforeEach(async () => {
    await setupServer();
  });

  it('spawns recover with setName and prdId and returns sessionId + pid', async () => {
    const res = await fetch(`http://localhost:${server.port}${API_ROUTES.recover}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setName: 'my-set', prdId: 'plan-01' }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { sessionId: string; pid: number };
    expect(typeof data.sessionId).toBe('string');
    expect(typeof data.pid).toBe('number');

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('recover');
    expect(spawnCalls[0].args).toEqual(['my-set', 'plan-01']);
  });

  it('returns 400 when setName is missing', async () => {
    const res = await fetch(`http://localhost:${server.port}${API_ROUTES.recover}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prdId: 'plan-01' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when prdId is missing', async () => {
    const res = await fetch(`http://localhost:${server.port}${API_ROUTES.recover}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setName: 'my-set' }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 6. GET /api/recovery/sidecar reads v2 sidecar
// ---------------------------------------------------------------------------

describe('GET /api/recovery/sidecar', () => {
  beforeEach(async () => {
    await setupServer();
  });

  it('reads v2 sidecar (schemaVersion: 2, partial: true)', async () => {
    // Create sidecar at the computed path: cwd/eforge/queue/failed/<prdId>.recovery.*
    const failedDir = join(tmpDir, 'eforge', 'queue', 'failed');
    await mkdir(failedDir, { recursive: true });

    const v2Sidecar = {
      schemaVersion: 2,
      summary: { prdId: 'test-prd', setName: 'test-set', partial: true },
      verdict: { verdict: 'manual', confidence: 'low', rationale: 'Missing context', completedWork: [], remainingWork: [], risks: [], partial: true, recoveryError: 'state.json was missing' },
      generatedAt: new Date().toISOString(),
    };
    await writeFile(join(failedDir, 'test-prd.recovery.md'), '# Recovery Analysis: test-prd\n\nPartial summary.');
    await writeFile(join(failedDir, 'test-prd.recovery.json'), JSON.stringify(v2Sidecar, null, 2));

    const url = `http://localhost:${server.port}${API_ROUTES.readRecoverySidecar}?setName=test-set&prdId=test-prd`;
    const res = await fetch(url);

    expect(res.status).toBe(200);
    const data = await res.json() as { markdown: string; json: typeof v2Sidecar };
    expect(data.json.schemaVersion).toBe(2);
    expect(data.json.verdict.partial).toBe(true);
    expect(data.markdown).toContain('Recovery Analysis');
  });

  it('returns 404 when sidecar files do not exist', async () => {
    const url = `http://localhost:${server.port}${API_ROUTES.readRecoverySidecar}?setName=nonexistent&prdId=plan-99`;
    const res = await fetch(url);
    expect(res.status).toBe(404);
  });

  it('returns 400 when query params are missing', async () => {
    const url = `http://localhost:${server.port}${API_ROUTES.readRecoverySidecar}?setName=my-set`;
    const res = await fetch(url);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 1. moveAndCommitFailedWithSidecar creates single atomic commit
// ---------------------------------------------------------------------------

describe('moveAndCommitFailedWithSidecar', () => {
  const makeTestDir = useTempDir('eforge-inline-recovery-test-');

  it('produces a single commit with git mv + both sidecar files', async () => {
    const dir = makeTestDir();
    initGitRepo(dir);

    // Create queue dir and PRD file, then commit it
    const queueDir = join(dir, 'eforge', 'queue');
    await mkdir(queueDir, { recursive: true });
    const prdPath = join(queueDir, 'my-prd.md');
    await writeFile(prdPath, '---\ntitle: My PRD\ncreated: 2024-01-01\n---\n\n# My PRD\n\nDo a thing.\n');
    execFileSync('git', ['add', '--', prdPath], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'queue(my-prd): enqueue'], { cwd: dir });

    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();

    // Build a stub summary and verdict
    const summary = {
      prdId: 'my-prd',
      setName: 'test-set',
      featureBranch: 'eforge/test-set',
      baseBranch: 'main',
      plans: [{ planId: 'plan-01', status: 'failed', error: 'Type error' }],
      failingPlan: { planId: 'plan-01', errorMessage: 'Type error' },
      landedCommits: [],
      diffStat: '',
      modelsUsed: [],
      failedAt: new Date().toISOString(),
    };
    const verdict = {
      verdict: 'manual' as const,
      confidence: 'low' as const,
      rationale: 'Insufficient evidence.',
      completedWork: [],
      remainingWork: [],
      risks: [],
    };

    const { mdPath, jsonPath, destPath } = await moveAndCommitFailedWithSidecar(
      prdPath,
      summary,
      verdict,
      undefined,
      dir,
    );

    // Exactly one new commit since headBefore
    const newCommits = execFileSync(
      'git', ['log', '--format=%s', `${headBefore}..HEAD`],
      { cwd: dir },
    ).toString().trim().split('\n').filter(Boolean);
    expect(newCommits).toHaveLength(1);
    expect(newCommits[0]).toMatch(/^queue\(my-prd\): failed - manual/);

    // Commit shows exactly 3 paths: renamed PRD + both sidecars
    const nameStatus = execFileSync(
      'git', ['show', '--name-status', '--format=', 'HEAD'],
      { cwd: dir },
    ).toString().trim().split('\n').filter(Boolean);

    // Check renamed PRD
    const renamedLines = nameStatus.filter(l => l.startsWith('R'));
    expect(renamedLines).toHaveLength(1);
    expect(renamedLines[0]).toContain('my-prd.md');

    // Check both sidecar files are added
    const addedLines = nameStatus.filter(l => l.startsWith('A'));
    expect(addedLines).toHaveLength(2);
    const addedPaths = addedLines.map(l => l.split('\t')[1]);
    expect(addedPaths.some(p => p.endsWith('.recovery.md'))).toBe(true);
    expect(addedPaths.some(p => p.endsWith('.recovery.json'))).toBe(true);

    // Verify the sidecar JSON is v2
    const sidecarJson = JSON.parse(await readFile(jsonPath, 'utf-8'));
    expect(sidecarJson.schemaVersion).toBe(2);
    expect(sidecarJson.verdict.verdict).toBe('manual');

    // Verify the PRD moved to failed/
    expect(destPath).toContain('failed');
    expect(mdPath).toContain('.recovery.md');
    expect(jsonPath).toContain('.recovery.json');
  });
});

// ---------------------------------------------------------------------------
// 2. Sidecar path uses prdId not planId
// ---------------------------------------------------------------------------

describe('sidecar path uses prdId not planId', () => {
  const makeTestDir = useTempDir('eforge-sidecar-path-test-');

  it('writeRecoverySidecar uses prdId for filename, not planId', async () => {
    const { writeRecoverySidecar } = await import('@eforge-build/engine/recovery/sidecar');
    const dir = makeTestDir();
    const failedDir = join(dir, 'failed');

    const summary = {
      prdId: 'my-feature-prd',
      setName: 'test-set',
      featureBranch: 'eforge/test-set',
      baseBranch: 'main',
      plans: [
        { planId: 'plan-01', status: 'merged' },
        { planId: 'plan-02', status: 'merged' },
        { planId: 'plan-03', status: 'failed', error: 'Compilation error' },
      ],
      failingPlan: { planId: 'plan-03', errorMessage: 'Compilation error' },
      landedCommits: [],
      diffStat: '',
      modelsUsed: [],
      failedAt: new Date().toISOString(),
    };
    const verdict = {
      verdict: 'manual' as const,
      confidence: 'low' as const,
      rationale: 'See plan-03 failure.',
      completedWork: ['plan-01 merged', 'plan-02 merged'],
      remainingWork: ['plan-03: compilation error'],
      risks: [],
    };

    const { mdPath, jsonPath } = await writeRecoverySidecar({ failedPrdDir: failedDir, prdId: 'my-feature-prd', summary, verdict });

    // Sidecar names use prdId, not planId
    expect(mdPath).toContain('my-feature-prd.recovery.md');
    expect(jsonPath).toContain('my-feature-prd.recovery.json');

    // No plan-03 sidecar exists
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(failedDir, 'plan-03.recovery.json'))).toBe(false);
    expect(existsSync(join(failedDir, 'plan-03.recovery.md'))).toBe(false);

    // prdId sidecar exists
    expect(existsSync(join(failedDir, 'my-feature-prd.recovery.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Recovery analyst parse error -> manual-verdict sidecar still written
// ---------------------------------------------------------------------------

describe('recovery analyst parse error -> manual-verdict sidecar', () => {
  const makeTestDir = useTempDir('eforge-parse-error-test-');

  it('writes sidecar with manual verdict and recoveryError when analyst returns garbage', async () => {
    const dir = makeTestDir();
    initGitRepo(dir);

    // Create failed PRD
    const failedDir = join(dir, 'eforge', 'queue', 'failed');
    await mkdir(failedDir, { recursive: true });
    await writeFile(join(failedDir, 'test-prd.md'), '# Test PRD\n\nDo a thing.', 'utf-8');

    // Create state.json so buildFailureSummary has something to work with
    await mkdir(join(dir, '.eforge'), { recursive: true });
    const state = {
      setName: 'test-set',
      status: 'failed',
      baseBranch: 'main',
      featureBranch: 'eforge/test-set',
      startedAt: new Date().toISOString(),
      plans: { 'plan-01': { status: 'failed', error: 'type error' } },
      completedPlans: [],
    };
    await writeFile(join(dir, '.eforge', 'state.json'), JSON.stringify(state, null, 2), 'utf-8');

    // Stub that returns unparseable garbage
    const stub = new StubHarness([{ text: 'This is unparseable garbage with no XML block.' }]);
    const engine = await EforgeEngine.create({ cwd: dir, agentRuntimes: stub });

    const events = await collectEvents(engine.recover('test-set', 'test-prd'));

    const complete = events.find(e => e.type === 'recovery:complete') as Extract<EforgeEvent, { type: 'recovery:complete' }> | undefined;
    expect(complete).toBeDefined();
    expect(complete!.sidecarJsonPath).toBeDefined();

    const sidecarContent = JSON.parse(await readFile(complete!.sidecarJsonPath!, 'utf-8'));
    expect(sidecarContent.verdict.verdict).toBe('manual');
    expect(sidecarContent.verdict.recoveryError).toBeDefined();
    expect(sidecarContent.verdict.recoveryError).toBeTruthy();
    expect(sidecarContent.schemaVersion).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Manual EforgeEngine.recover() with no state.json + populated event db
// ---------------------------------------------------------------------------

describe('EforgeEngine.recover() with no state.json + populated event db', () => {
  const makeTestDir = useTempDir('eforge-partial-eventdb-test-');

  it('produces partial sidecar with partial:true and failingPlan.planId from events', async () => {
    const dir = makeTestDir();
    initGitRepo(dir);

    // Create failed PRD (no state.json)
    const failedDir = join(dir, 'eforge', 'queue', 'failed');
    await mkdir(failedDir, { recursive: true });
    await writeFile(join(failedDir, 'test-prd.md'), '# Test PRD\n\nDo a thing.', 'utf-8');

    // Create monitor DB with hand-rolled events
    const dbDir = join(dir, '.eforge');
    await mkdir(dbDir, { recursive: true });
    const monitorDbPath = join(dbDir, 'monitor.db');
    const db = openDatabase(monitorDbPath);
    db.insertRun({
      id: 'run-partial-01',
      sessionId: 'session-partial-01',
      planSet: 'test-set',
      command: 'build',
      status: 'failed',
      startedAt: new Date().toISOString(),
      cwd: dir,
      pid: 99999,
    });
    db.insertEvent({
      runId: 'run-partial-01',
      type: 'plan:build:failed',
      planId: 'plan-01-foundation',
      data: JSON.stringify({ type: 'plan:build:failed', planId: 'plan-01-foundation', error: 'Type error in foundation' }),
      timestamp: new Date().toISOString(),
    });
    db.insertEvent({
      runId: 'run-partial-01',
      type: 'agent:start',
      data: JSON.stringify({ type: 'agent:start', model: 'claude-sonnet-4-5', agent: 'builder' }),
      timestamp: new Date().toISOString(),
    });
    db.close();

    // Stub that returns a valid manual verdict (partial hint nudges analyst)
    const manualVerdictText = `<recovery verdict="manual" confidence="low">
  <rationale>Partial context — state.json was missing, summary synthesized from event DB.</rationale>
  <completedWork></completedWork>
  <remainingWork><item>All work remains</item></remainingWork>
  <risks><item>Root cause unknown without full state</item></risks>
</recovery>`;
    const stub = new StubHarness([{ text: manualVerdictText }]);
    const engine = await EforgeEngine.create({ cwd: dir, agentRuntimes: stub });

    const events = await collectEvents(engine.recover('test-set', 'test-prd'));

    const complete = events.find(e => e.type === 'recovery:complete') as Extract<EforgeEvent, { type: 'recovery:complete' }> | undefined;
    expect(complete).toBeDefined();
    expect(complete!.sidecarJsonPath).toBeDefined();

    const sidecarContent = JSON.parse(await readFile(complete!.sidecarJsonPath!, 'utf-8'));
    expect(sidecarContent.summary.partial).toBe(true);
    // failingPlan should come from the event DB event
    expect(sidecarContent.summary.failingPlan.planId).toBe('plan-01-foundation');
    expect(sidecarContent.schemaVersion).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. EforgeEngine.recover() with no state.json AND no event db
// ---------------------------------------------------------------------------

describe('EforgeEngine.recover() with no state.json AND no event db', () => {
  const makeTestDir = useTempDir('eforge-no-context-test-');

  it('produces partial sidecar with manual verdict and recoveryError when context is fully absent', async () => {
    const dir = makeTestDir();
    initGitRepo(dir);

    // Create failed PRD — no state.json, no event DB
    const failedDir = join(dir, 'eforge', 'queue', 'failed');
    await mkdir(failedDir, { recursive: true });
    await writeFile(join(failedDir, 'test-prd.md'), '# Test PRD\n\nDo a thing.', 'utf-8');

    // Stub that returns garbage to trigger fallback manual verdict with recoveryError
    const stub = new StubHarness([{ text: 'Completely unparseable output with no XML.' }]);
    const engine = await EforgeEngine.create({ cwd: dir, agentRuntimes: stub });

    const events = await collectEvents(engine.recover('test-set', 'test-prd'));

    const complete = events.find(e => e.type === 'recovery:complete') as Extract<EforgeEvent, { type: 'recovery:complete' }> | undefined;
    expect(complete).toBeDefined();
    expect(complete!.sidecarJsonPath).toBeDefined();

    const sidecarContent = JSON.parse(await readFile(complete!.sidecarJsonPath!, 'utf-8'));
    // Summary is partial (no state.json, no event DB)
    expect(sidecarContent.summary.partial).toBe(true);
    // Fallback verdict is manual with recoveryError (parse failure)
    expect(sidecarContent.verdict.verdict).toBe('manual');
    expect(sidecarContent.verdict.recoveryError).toBeDefined();
    expect(typeof sidecarContent.verdict.recoveryError).toBe('string');
    expect(sidecarContent.verdict.recoveryError.length).toBeGreaterThan(0);
    expect(sidecarContent.schemaVersion).toBe(2);
  });
});
