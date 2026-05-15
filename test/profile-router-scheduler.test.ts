/**
 * Scheduler integration tests for profile router dispatch.
 *
 * Uses an in-memory bus + stub spawnPrdChild against a real QueueScheduler
 * with a stub registry containing one router.
 *
 * Asserts:
 * - Routing runs before session:profile emission.
 * - Routed profile appears in session:profile.profileName.
 * - spawnPrdChild is invoked with a PRD whose frontmatter.profile is the
 *   routed profile (persisted path) or with routedProfileOverride (fallback path).
 * - queue:profile:selected is emitted with all required fields.
 * - Explicit frontmatter.profile PRDs emit zero queue:profile:* events.
 * - The test cwd has no .active-profile file after routing.
 * - Abort during routing exits cleanly without enqueuing session:start.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { QueueScheduler, type QueueSchedulerOptions } from '@eforge-build/engine/queue/scheduler';
import { AsyncEventQueue } from '@eforge-build/engine/concurrency';
import type { EforgeEvent } from '@eforge-build/engine/events';
import type { QueuedPrd } from '@eforge-build/engine/prd-queue';
import type { EforgeConfig } from '@eforge-build/engine/config';
import { DEFAULT_CONFIG } from '@eforge-build/engine/config';
import type { ProfileRouterRegistration } from '@eforge-build/engine/extensions/types';
import type { QueueOptions } from '@eforge-build/engine/eforge';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'profile-router-sched-test-'));
}

function initGitRepo(cwd: string): void {
  try {
    execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd, stdio: 'ignore' });
  } catch {
    // git may not be available in all test environments — best-effort
  }
}

function setupProjectWithProfile(cwd: string, profileName: string): void {
  mkdirSync(join(cwd, 'eforge', 'profiles'), { recursive: true });
  writeFileSync(
    join(cwd, 'eforge', 'profiles', `${profileName}.yaml`),
    'agents:\n  tiers:\n    planning:\n      harness: claude-sdk\n      model: claude-haiku-4-5\n      effort: low\n',
    'utf-8',
  );
  mkdirSync(join(cwd, 'eforge'), { recursive: true });
  if (!existsSync(join(cwd, 'eforge', 'config.yaml'))) {
    writeFileSync(join(cwd, 'eforge', 'config.yaml'), 'agents:\n  tiers: {}\n', 'utf-8');
  }
}

function makePrd(id: string, filePath: string, overrides: Partial<QueuedPrd['frontmatter']> = {}): QueuedPrd {
  return {
    id,
    filePath,
    frontmatter: { title: `PRD ${id}`, ...overrides },
    content: `---\ntitle: PRD ${id}\n---\n\n# ${id}\n\nContent.`,
    lastCommitHash: '',
    lastCommitDate: '',
  };
}

function makeConfig(cwd: string, extensions: Partial<EforgeConfig['extensions']> = {}): EforgeConfig {
  return {
    ...DEFAULT_CONFIG,
    prdQueue: {
      ...DEFAULT_CONFIG.prdQueue,
      dir: 'eforge/queue',
    },
    extensions: {
      ...DEFAULT_CONFIG.extensions,
      profileRouterTimeoutMs: 500,
      ...extensions,
    },
  };
}

function makeRouterRegistration(
  name: string,
  handler: (ctx: unknown) => unknown,
): ProfileRouterRegistration {
  return {
    kind: 'profileRouter',
    extensionName: 'test-ext',
    extensionPath: '/test/ext.ts',
    name,
    value: {
      name,
      selectBuildProfile: handler,
    } as ProfileRouterRegistration['value'],
  };
}

async function collectEvents(
  eventQueue: AsyncEventQueue<EforgeEvent>,
  stopAfterType: string,
  timeoutMs = 5000,
): Promise<EforgeEvent[]> {
  const collected: EforgeEvent[] = [];
  const deadline = Date.now() + timeoutMs;

  for await (const event of eventQueue) {
    collected.push(event);
    if (event.type === stopAfterType) break;
    if (Date.now() > deadline) break;
  }

  return collected;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QueueScheduler profile routing integration', () => {
  let cwd: string;
  /** True when git is functional in the test environment (needed for persist path). */
  let gitFunctional = false;

  beforeEach(() => {
    cwd = makeTempDir();
    initGitRepo(cwd);
    // Determine whether git actually committed so we know which code path will run.
    try {
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd, stdio: 'ignore' });
      gitFunctional = true;
    } catch {
      gitFunctional = false;
    }
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('routed profile flows into session:profile.profileName before session:start', async () => {
    setupProjectWithProfile(cwd, 'routed-profile');
    mkdirSync(resolve(cwd, 'eforge', 'queue'), { recursive: true });

    const prdFilePath = resolve(cwd, 'eforge', 'queue', 'test-prd.md');
    writeFileSync(prdFilePath, '---\ntitle: Test PRD\n---\n\nContent.', 'utf-8');

    const { getConfigDir, getConventionalConfigDir } = await import('@eforge-build/engine/config');
    const configDir = (await getConfigDir(cwd)) ?? getConventionalConfigDir(cwd);

    const bus = new EventEmitter();
    const eventQueue = new AsyncEventQueue<EforgeEvent>();

    const spawnCalls: Array<{ prd: QueuedPrd; override?: string }> = [];
    const spawnPrdChild = vi.fn(async (prd: QueuedPrd, _opts: QueueOptions, _sessionId: string, override?: string) => {
      spawnCalls.push({ prd, override });
      return 'completed' as const;
    });

    const abortController = new AbortController();

    const scheduler = new QueueScheduler({
      bus,
      cwd,
      queueDir: 'eforge/queue',
      config: makeConfig(cwd),
      configProfile: { name: 'default-profile', source: 'local', scope: 'project', config: null },
      parallelism: 1,
      abortController,
      eventQueue,
      spawnPrdChild,
      options: { auto: true },
      initialPrds: [makePrd('test-prd', prdFilePath)],
      extensionRegistry: {
        profileRouters: [
          makeRouterRegistration('test-router', async () => ({
            profile: 'routed-profile',
            reason: 'test routing',
            confidence: 'high',
          })),
        ],
      },
      configDir,
    });

    eventQueue.addProducer();

    await scheduler.start();

    const events: EforgeEvent[] = [];
    const deadline = Date.now() + 5000;
    for await (const event of eventQueue) {
      events.push(event);
      if (event.type === 'queue:prd:complete') break;
      if (Date.now() > deadline) break;
    }

    eventQueue.removeProducer();
    abortController.abort();

    // queue:profile:selected should appear before session:start
    const selectedIdx = events.findIndex((e) => e.type === 'queue:profile:selected');
    const sessionStartIdx = events.findIndex((e) => e.type === 'session:start');
    const sessionProfileIdx = events.findIndex((e) => e.type === 'session:profile');

    expect(selectedIdx).toBeGreaterThan(-1);
    expect(sessionStartIdx).toBeGreaterThan(-1);
    expect(selectedIdx).toBeLessThan(sessionStartIdx);

    // session:profile should use the routed profile
    const sessionProfileEvent = events[sessionProfileIdx] as Extract<EforgeEvent, { type: 'session:profile' }>;
    expect(sessionProfileEvent.profileName).toBe('routed-profile');

    // queue:profile:selected should have all required fields
    const selectedEvent = events[selectedIdx] as Extract<EforgeEvent, { type: 'queue:profile:selected' }>;
    expect(selectedEvent.prdId).toBe('test-prd');
    expect(selectedEvent.profile).toBe('routed-profile');
    expect(selectedEvent.routerName).toBe('test-router');
    expect(selectedEvent.extensionName).toBe('test-ext');
    expect(selectedEvent.reason).toBe('test routing');
    expect(selectedEvent.confidence).toBe('high');

    // spawnPrdChild must have been called with the routed profile reaching the child:
    // either via persisted frontmatter.profile or the in-memory routedProfileOverride.
    expect(spawnCalls).toHaveLength(1);
    const childInvocation = spawnCalls[0]!;
    const profileForChild = childInvocation.prd.frontmatter.profile ?? childInvocation.override;
    expect(profileForChild).toBe('routed-profile');

    // Assert the path taken deterministically based on whether git is functional:
    // - git functional -> persistence succeeded -> frontmatter has the routed profile
    // - git missing -> persistence failed -> in-memory override path was taken
    const persistedContent = readFileSync(prdFilePath, 'utf-8');
    if (gitFunctional) {
      // Persisted path: no router-failed events, frontmatter on disk updated, prd.frontmatter set
      const routerFailedEvents = events.filter((e) => e.type === 'queue:profile:router-failed');
      expect(routerFailedEvents).toHaveLength(0);
      expect(persistedContent).toContain('profile: routed-profile');
      expect(childInvocation.prd.frontmatter.profile).toBe('routed-profile');
    } else {
      // Override path: persist failed, in-memory override carries the routed profile
      expect(childInvocation.override).toBe('routed-profile');
    }
  }, 10_000);

  it('explicit frontmatter.profile bypasses routing (no queue:profile:* events)', async () => {
    setupProjectWithProfile(cwd, 'explicit-profile');
    mkdirSync(resolve(cwd, 'eforge', 'queue'), { recursive: true });

    const prdFilePath = resolve(cwd, 'eforge', 'queue', 'explicit-prd.md');
    writeFileSync(
      prdFilePath,
      '---\ntitle: Explicit PRD\nprofile: explicit-profile\n---\n\nContent.',
      'utf-8',
    );

    const { getConfigDir, getConventionalConfigDir } = await import('@eforge-build/engine/config');
    const configDir = (await getConfigDir(cwd)) ?? getConventionalConfigDir(cwd);

    const bus = new EventEmitter();
    const eventQueue = new AsyncEventQueue<EforgeEvent>();

    const routerCalled = vi.fn().mockResolvedValue({ profile: 'routed-profile' });
    const spawnPrdChild = vi.fn(async () => 'completed' as const);
    const abortController = new AbortController();

    const scheduler = new QueueScheduler({
      bus,
      cwd,
      queueDir: 'eforge/queue',
      config: makeConfig(cwd),
      configProfile: { name: null, source: 'none', scope: null, config: null },
      parallelism: 1,
      abortController,
      eventQueue,
      spawnPrdChild,
      options: { auto: true },
      initialPrds: [makePrd('explicit-prd', prdFilePath, { profile: 'explicit-profile' })],
      extensionRegistry: {
        profileRouters: [makeRouterRegistration('should-not-run', routerCalled)],
      },
      configDir,
    });

    eventQueue.addProducer();
    await scheduler.start();

    const events: EforgeEvent[] = [];
    const deadline = Date.now() + 5000;
    for await (const event of eventQueue) {
      events.push(event);
      if (event.type === 'queue:prd:complete') break;
      if (Date.now() > deadline) break;
    }

    eventQueue.removeProducer();
    abortController.abort();

    // No queue:profile:* events should appear
    const profileEvents = events.filter((e) => e.type.startsWith('queue:profile:'));
    expect(profileEvents).toHaveLength(0);

    // Router should not have been called
    expect(routerCalled).not.toHaveBeenCalled();
  }, 10_000);

  it('no .active-profile file is created or modified during routing', async () => {
    setupProjectWithProfile(cwd, 'routed-no-marker');
    mkdirSync(resolve(cwd, 'eforge', 'queue'), { recursive: true });

    const prdFilePath = resolve(cwd, 'eforge', 'queue', 'marker-test-prd.md');
    writeFileSync(prdFilePath, '---\ntitle: Marker Test\n---\n\nContent.', 'utf-8');

    const { getConfigDir, getConventionalConfigDir } = await import('@eforge-build/engine/config');
    const configDir = (await getConfigDir(cwd)) ?? getConventionalConfigDir(cwd);

    const bus = new EventEmitter();
    const eventQueue = new AsyncEventQueue<EforgeEvent>();
    const spawnPrdChild = vi.fn(async () => 'completed' as const);
    const abortController = new AbortController();

    const scheduler = new QueueScheduler({
      bus,
      cwd,
      queueDir: 'eforge/queue',
      config: makeConfig(cwd),
      configProfile: { name: null, source: 'none', scope: null, config: null },
      parallelism: 1,
      abortController,
      eventQueue,
      spawnPrdChild,
      options: { auto: true },
      initialPrds: [makePrd('marker-test-prd', prdFilePath)],
      extensionRegistry: {
        profileRouters: [
          makeRouterRegistration('router-a', async () => ({ profile: 'routed-no-marker' })),
        ],
      },
      configDir,
    });

    eventQueue.addProducer();
    await scheduler.start();

    const deadline = Date.now() + 5000;
    for await (const event of eventQueue) {
      if (event.type === 'queue:prd:complete') break;
      if (Date.now() > deadline) break;
    }

    eventQueue.removeProducer();
    abortController.abort();

    // Verify no .active-profile file was created in cwd or eforge dir
    const activeProfilePaths = [
      join(cwd, '.active-profile'),
      join(cwd, 'eforge', '.active-profile'),
      join(cwd, '.eforge', '.active-profile'),
    ];
    for (const p of activeProfilePaths) {
      expect(existsSync(p)).toBe(false);
    }
  }, 10_000);

  it('abort during routing exits cleanly without session:start', async () => {
    setupProjectWithProfile(cwd, 'slow-profile');
    mkdirSync(resolve(cwd, 'eforge', 'queue'), { recursive: true });

    const prdFilePath = resolve(cwd, 'eforge', 'queue', 'slow-abort-prd.md');
    writeFileSync(prdFilePath, '---\ntitle: Slow Abort Test\n---\n\nContent.', 'utf-8');

    const { getConfigDir, getConventionalConfigDir } = await import('@eforge-build/engine/config');
    const configDir = (await getConfigDir(cwd)) ?? getConventionalConfigDir(cwd);

    const bus = new EventEmitter();
    const eventQueue = new AsyncEventQueue<EforgeEvent>();
    const spawnPrdChild = vi.fn(async () => 'completed' as const);
    const abortController = new AbortController();

    // A router that signals when it starts, then resolves only after abort is called.
    let routerStartedResolve!: () => void;
    const routerStarted = new Promise<void>((res) => { routerStartedResolve = res; });

    const scheduler = new QueueScheduler({
      bus,
      cwd,
      queueDir: 'eforge/queue',
      config: makeConfig(cwd, { profileRouterTimeoutMs: 10_000 }),
      configProfile: { name: null, source: 'none', scope: null, config: null },
      parallelism: 1,
      abortController,
      eventQueue,
      spawnPrdChild,
      options: { auto: true },
      initialPrds: [makePrd('slow-abort-prd', prdFilePath)],
      extensionRegistry: {
        profileRouters: [
          makeRouterRegistration('slow-router', async () => {
            routerStartedResolve();
            // Block until abort fires
            await new Promise<void>((res) => {
              if (abortController.signal.aborted) { res(); return; }
              abortController.signal.addEventListener('abort', () => res(), { once: true });
            });
            return { profile: 'slow-profile' };
          }),
        ],
      },
      configDir,
    });

    eventQueue.addProducer();
    const startPromise = scheduler.start();

    // Wait for the router to start, then abort while it is in flight
    await routerStarted;
    abortController.abort();

    await startPromise;

    eventQueue.removeProducer();
    const events = eventQueue.drainAvailable();

    // session:start must not be emitted — abort was detected after routing completed
    const sessionStartEvents = events.filter((e) => e.type === 'session:start');
    expect(sessionStartEvents).toHaveLength(0);

    // spawnPrdChild must not have been called
    expect(spawnPrdChild).not.toHaveBeenCalled();
  }, 15_000);

  it('abort before routing exits cleanly without session:start', async () => {
    mkdirSync(resolve(cwd, 'eforge', 'queue'), { recursive: true });

    const prdFilePath = resolve(cwd, 'eforge', 'queue', 'abort-prd.md');
    writeFileSync(prdFilePath, '---\ntitle: Abort Test\n---\n\nContent.', 'utf-8');

    const { getConfigDir, getConventionalConfigDir } = await import('@eforge-build/engine/config');
    const configDir = (await getConfigDir(cwd)) ?? getConventionalConfigDir(cwd);

    const bus = new EventEmitter();
    const eventQueue = new AsyncEventQueue<EforgeEvent>();
    const spawnPrdChild = vi.fn(async () => 'completed' as const);
    const abortController = new AbortController();

    // Abort immediately before scheduler processes
    abortController.abort();

    const scheduler = new QueueScheduler({
      bus,
      cwd,
      queueDir: 'eforge/queue',
      config: makeConfig(cwd),
      configProfile: { name: null, source: 'none', scope: null, config: null },
      parallelism: 1,
      abortController,
      eventQueue,
      spawnPrdChild,
      options: { auto: true },
      initialPrds: [makePrd('abort-prd', prdFilePath)],
      configDir,
    });

    eventQueue.addProducer();
    await scheduler.start();

    // Remove producer immediately — when abort was pre-set, the scheduler emits
    // nothing synchronously, so the queue will be done and drainable.
    eventQueue.removeProducer();

    // Drain any buffered events without blocking
    const events = eventQueue.drainAvailable();

    // session:start should not be present
    const sessionStartEvents = events.filter((e) => e.type === 'session:start');
    expect(sessionStartEvents).toHaveLength(0);
  }, 10_000);
});
