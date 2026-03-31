import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EforgeEvent } from '../src/engine/events.js';
import type { BuildStageContext } from '../src/engine/pipeline.js';
import { withPeriodicFileCheck } from '../src/engine/pipeline.js';

// Create mock inside vi.hoisted so it's available when vi.mock factory runs (hoisted above imports).
const { execFileMock, mockedExecFilePromisified } = vi.hoisted(() => {
  const customSym = Symbol.for('nodejs.util.promisify.custom');
  const mock: any = vi.fn();
  mock[customSym] = vi.fn();
  return { execFileMock: mock, mockedExecFilePromisified: mock[customSym] as ReturnType<typeof vi.fn> };
});

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

// Short interval for tests (real timers)
const TEST_INTERVAL_MS = 50;

/** Create a minimal BuildStageContext for testing. */
function makeCtx(overrides: Partial<BuildStageContext> = {}): BuildStageContext {
  return {
    planId: 'test-plan',
    worktreePath: '/tmp/test-worktree',
    orchConfig: { baseBranch: 'main', plans: [], validate: [] },
    ...overrides,
  } as unknown as BuildStageContext;
}

/** Create an async generator that yields the given events with optional delays. */
async function* asyncIterableFrom(events: EforgeEvent[], delayMs = 0): AsyncGenerator<EforgeEvent> {
  for (const event of events) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    yield event;
  }
}

/** Helper to sleep for a given duration. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Set up the promisified execFile mock to resolve with the given stdout. */
function mockGitDiff(stdout: string): void {
  mockedExecFilePromisified.mockResolvedValue({ stdout, stderr: '' });
}

/**
 * Set up the promisified execFile mock to handle both --name-only and full diff calls.
 * The first call pattern (with --name-only) returns file names.
 * The second call pattern (without --name-only) returns full diff output.
 */
function mockGitDiffWithContent(nameOnlyStdout: string, fullDiffStdout: string): void {
  mockedExecFilePromisified.mockImplementation((...args: any[]) => {
    const gitArgs = args[1] as string[];
    if (gitArgs.includes('--name-only')) {
      return Promise.resolve({ stdout: nameOnlyStdout, stderr: '' });
    }
    return Promise.resolve({ stdout: fullDiffStdout, stderr: '' });
  });
}

/** Set up the promisified execFile mock to reject with an error. */
function mockGitDiffError(): void {
  mockedExecFilePromisified.mockRejectedValue(new Error('git failed'));
}

describe('withPeriodicFileCheck', () => {
  beforeEach(() => {
    mockedExecFilePromisified.mockReset();
  });

  it('passes through inner events unchanged', async () => {
    const innerEvents: EforgeEvent[] = [
      { type: 'build:implement:start', planId: 'test-plan' } as EforgeEvent,
      { type: 'build:implement:progress', planId: 'test-plan', message: 'working' } as EforgeEvent,
      { type: 'build:implement:complete', planId: 'test-plan' } as EforgeEvent,
    ];

    const ctx = makeCtx();
    // Events yield immediately so no timer fires
    const wrapped = withPeriodicFileCheck(asyncIterableFrom(innerEvents), ctx, TEST_INTERVAL_MS);

    const collected: EforgeEvent[] = [];
    for await (const event of wrapped) {
      collected.push(event);
    }

    // All inner events should pass through
    expect(collected.map((e) => e.type)).toEqual([
      'build:implement:start',
      'build:implement:progress',
      'build:implement:complete',
    ]);
  });

  it('emits file change events when timer fires and file list differs', async () => {
    mockGitDiff('src/foo.ts\nsrc/bar.ts\n');

    const ctx = makeCtx();

    // Create a generator that yields one event, then waits long enough for a timer tick
    async function* slowInner(): AsyncGenerator<EforgeEvent> {
      yield { type: 'build:implement:start', planId: 'test-plan' } as EforgeEvent;
      // Wait longer than the test interval so the periodic timer fires
      await sleep(TEST_INTERVAL_MS * 3);
      yield { type: 'build:implement:complete', planId: 'test-plan' } as EforgeEvent;
    }

    const wrapped = withPeriodicFileCheck(slowInner(), ctx, TEST_INTERVAL_MS);

    const collected: EforgeEvent[] = [];
    for await (const event of wrapped) {
      collected.push(event);
    }

    const types = collected.map((e) => e.type);
    expect(types).toContain('build:files_changed');

    const fileEvent = collected.find((e) => e.type === 'build:files_changed');
    expect(fileEvent).toBeDefined();
    if (fileEvent && fileEvent.type === 'build:files_changed') {
      expect(fileEvent.files).toEqual(['src/bar.ts', 'src/foo.ts']); // sorted
      expect(fileEvent.planId).toBe('test-plan');
    }
  });

  it('includes diffs and baseBranch in emitted file change events', async () => {
    const fullDiff = [
      'diff --git a/src/bar.ts b/src/bar.ts\n--- a/src/bar.ts\n+++ b/src/bar.ts\n+new line in bar',
      'diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n+new line in foo',
    ].join('\n');

    mockGitDiffWithContent('src/foo.ts\nsrc/bar.ts\n', fullDiff);

    const ctx = makeCtx();

    async function* slowInner(): AsyncGenerator<EforgeEvent> {
      yield { type: 'build:implement:start', planId: 'test-plan' } as EforgeEvent;
      await sleep(TEST_INTERVAL_MS * 3);
      yield { type: 'build:implement:complete', planId: 'test-plan' } as EforgeEvent;
    }

    const wrapped = withPeriodicFileCheck(slowInner(), ctx, TEST_INTERVAL_MS);

    const collected: EforgeEvent[] = [];
    for await (const event of wrapped) {
      collected.push(event);
    }

    const fileEvent = collected.find((e) => e.type === 'build:files_changed');
    expect(fileEvent).toBeDefined();
    if (fileEvent && fileEvent.type === 'build:files_changed') {
      expect(fileEvent.baseBranch).toBe('main');
      expect(fileEvent.diffs).toBeDefined();
      expect(fileEvent.diffs!.length).toBeGreaterThan(0);
      // Each diff entry should have path and diff content
      for (const d of fileEvent.diffs!) {
        expect(d.path).toBeTruthy();
        expect(d.diff).toContain('diff --git');
      }
    }
  });

  it('does not re-emit when file list is unchanged (deduplication)', async () => {
    // Return the same file list every time
    mockGitDiff('src/foo.ts\n');

    const ctx = makeCtx();

    async function* slowInner(): AsyncGenerator<EforgeEvent> {
      yield { type: 'build:implement:start', planId: 'test-plan' } as EforgeEvent;
      // Wait long enough for multiple timer ticks
      await sleep(TEST_INTERVAL_MS * 5);
      yield { type: 'build:implement:complete', planId: 'test-plan' } as EforgeEvent;
    }

    const wrapped = withPeriodicFileCheck(slowInner(), ctx, TEST_INTERVAL_MS);

    const collected: EforgeEvent[] = [];
    for await (const event of wrapped) {
      collected.push(event);
    }

    // Should only emit files_changed once since the list didn't change
    const fileEvents = collected.filter((e) => e.type === 'build:files_changed');
    expect(fileEvents.length).toBe(1);
  });

  it('is silent on git failure', async () => {
    mockGitDiffError();

    const ctx = makeCtx();

    async function* slowInner(): AsyncGenerator<EforgeEvent> {
      yield { type: 'build:implement:start', planId: 'test-plan' } as EforgeEvent;
      await sleep(TEST_INTERVAL_MS * 3);
      yield { type: 'build:implement:complete', planId: 'test-plan' } as EforgeEvent;
    }

    const wrapped = withPeriodicFileCheck(slowInner(), ctx, TEST_INTERVAL_MS);

    const collected: EforgeEvent[] = [];
    for await (const event of wrapped) {
      collected.push(event);
    }

    // Should only have inner events, no files_changed and no errors
    const types = collected.map((e) => e.type);
    expect(types).toEqual(['build:implement:start', 'build:implement:complete']);
  });

  it('calls iterator.return() on early termination via break', async () => {
    const returnSpy = vi.fn().mockResolvedValue({ done: true, value: undefined });

    async function* neverEnding(): AsyncGenerator<EforgeEvent> {
      let i = 0;
      while (true) {
        yield { type: 'build:implement:progress', planId: 'test-plan', message: `step ${i++}` } as EforgeEvent;
      }
    }

    const inner = neverEnding();
    // Patch the return method
    const origReturn = inner.return.bind(inner);
    inner.return = async (value: any) => {
      returnSpy(value);
      return origReturn(value);
    };

    const ctx = makeCtx();
    const wrapped = withPeriodicFileCheck(inner, ctx, TEST_INTERVAL_MS);

    // Consume only the first event then break
    for await (const _event of wrapped) {
      break;
    }

    expect(returnSpy).toHaveBeenCalled();
  });
});
