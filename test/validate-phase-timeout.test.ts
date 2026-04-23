import { describe, it, expect, vi } from 'vitest';
import { validate } from '@eforge-build/engine/orchestrator/phases';
import type { PhaseContext } from '@eforge-build/engine/orchestrator/phases';
import type { WorktreeManager } from '@eforge-build/engine/worktree-manager';
import type { EforgeEvent, EforgeState, OrchestrationConfig } from '@eforge-build/engine/events';
import { useTempDir } from './test-tmpdir.js';

const TEST_PIPELINE = {
  planner: { enabled: true },
  reviewer: { enabled: true },
  defaultBuild: ['implement', 'review-cycle'],
  defaultReview: { strategy: 'auto' as const, perspectives: ['code'], maxRounds: 1, evaluatorStrictness: 'standard' as const },
  rationale: 'test pipeline',
};

function makeState(): EforgeState {
  return {
    setName: 'test-set',
    status: 'running',
    startedAt: '2026-01-01T00:00:00Z',
    baseBranch: 'main',
    featureBranch: 'eforge/test-set',
    worktreeBase: '/tmp/worktrees',
    // No plans — every() on empty collection returns true → allMerged = true
    plans: {},
    completedPlans: [],
  };
}

function makeConfig(): OrchestrationConfig {
  return {
    name: 'test-set',
    description: 'test',
    created: '2026-01-01T00:00:00Z',
    mode: 'excursion',
    baseBranch: 'main',
    pipeline: TEST_PIPELINE,
    plans: [],
  };
}

function makeCtx(
  stateDir: string,
  mergeWorktreePath: string,
  overrides: Partial<PhaseContext>,
): PhaseContext {
  const stubWorktreeManager = {
    acquireForPlan: async () => '/tmp/fake-worktree',
    releaseForPlan: async () => {},
    mergePlan: async () => 'abc123',
    reconcile: async () => ({ valid: [], recovered: [], orphaned: [] }),
  } as unknown as WorktreeManager;

  const state = makeState();
  return {
    state,
    config: makeConfig(),
    stateDir,
    repoRoot: '/tmp/repo',
    planRunner: async function* () {},
    parallelism: 1,
    postMergeCommands: [],
    validateCommands: [],
    maxValidationRetries: 0,
    minCompletionPercent: 0,
    gapClosePerformed: false,
    mergeWorktreePath,
    featureBranch: state.featureBranch,
    worktreeManager: stubWorktreeManager,
    failedMerges: new Set(),
    recentlyMergedIds: [],
    featureBranchMerged: false,
    resumed: false,
    ...overrides,
  };
}

// Skip on Windows — process-group kill semantics are POSIX-only.
const isWindows = process.platform === 'win32';
const describePosix = isWindows ? describe.skip : describe;

describePosix('validate phase — timeout behavior', () => {
  const makeTempDir = useTempDir();

  it('emits validation:command:timeout then validation:command:complete with exitCode 124 and invokes fixer', async () => {
    const stateDir = makeTempDir();
    const mergeWorktreePath = makeTempDir();

    const fixerEvents: EforgeEvent[] = [];
    const fixerInvocations: Array<{ attempt: number }> = [];

    const validationFixer: PhaseContext['validationFixer'] = async function* (
      _cwd,
      _failures,
      attempt,
    ) {
      fixerInvocations.push({ attempt });
      yield {
        timestamp: new Date().toISOString(),
        type: 'validation:fix:start',
        attempt,
        maxAttempts: 1,
      } as EforgeEvent;
      fixerEvents.push({
        timestamp: new Date().toISOString(),
        type: 'validation:fix:complete',
        attempt,
      } as EforgeEvent);
      yield fixerEvents[fixerEvents.length - 1];
    };

    const ctx = makeCtx(stateDir, mergeWorktreePath, {
      validateCommands: ["sh -c 'sleep 60'"],
      postMergeCommandTimeoutMs: 250,
      maxValidationRetries: 1,
      validationFixer,
    });

    const events: EforgeEvent[] = [];
    for await (const event of validate(ctx)) {
      events.push(event);
    }

    const types = events.map((e) => e.type);

    // Must include the timeout event
    expect(types).toContain('validation:command:timeout');

    // validation:command:timeout should come before validation:command:complete
    const timeoutIdx = types.indexOf('validation:command:timeout');
    const completeIdx = types.indexOf('validation:command:complete');
    expect(timeoutIdx).toBeLessThan(completeIdx);

    // The complete event should have exitCode 124 (coreutils timeout convention)
    const completeEvent = events.find(
      (e) => e.type === 'validation:command:complete',
    ) as Extract<EforgeEvent, { type: 'validation:command:complete' }>;
    expect(completeEvent).toBeDefined();
    expect(completeEvent.exitCode).toBe(124);
    expect(completeEvent.output).toContain('timed out');

    // The timeout event should carry the right payload
    const timeoutEvent = events.find(
      (e) => e.type === 'validation:command:timeout',
    ) as Extract<EforgeEvent, { type: 'validation:command:timeout' }>;
    expect(timeoutEvent).toBeDefined();
    expect(timeoutEvent.timeoutMs).toBe(250);
    expect(timeoutEvent.pid).toBeGreaterThan(0);
    expect(timeoutEvent.command).toBe("sh -c 'sleep 60'");

    // validation:complete should be emitted with passed: false
    const validationComplete = events.find((e) => e.type === 'validation:complete') as
      | Extract<EforgeEvent, { type: 'validation:complete' }>
      | undefined;
    expect(validationComplete).toBeDefined();
    expect(validationComplete!.passed).toBe(false);

    // The fixer should have been invoked (maxValidationRetries: 1)
    expect(fixerInvocations).toHaveLength(1);
  }, 10_000);

  it('emits config:warning before commands when postMergeCommandTimeoutMs is below the floor', async () => {
    const stateDir = makeTempDir();
    const mergeWorktreePath = makeTempDir();

    const ctx = makeCtx(stateDir, mergeWorktreePath, {
      validateCommands: ['exit 0'],
      postMergeCommandTimeoutMs: 50, // below 10_000 floor
      maxValidationRetries: 0,
    });

    const events: EforgeEvent[] = [];
    for await (const event of validate(ctx)) {
      events.push(event);
    }

    const types = events.map((e) => e.type);

    // config:warning should appear before validation:start
    expect(types).toContain('config:warning');
    const warningIdx = types.indexOf('config:warning');
    const startIdx = types.indexOf('validation:start');
    expect(warningIdx).toBeLessThan(startIdx);

    // The warning message should mention the clamp
    const warningEvent = events.find((e) => e.type === 'config:warning') as
      | Extract<EforgeEvent, { type: 'config:warning' }>
      | undefined;
    expect(warningEvent).toBeDefined();
    expect(warningEvent!.source).toBe('validate');
    expect(warningEvent!.message).toContain('10000');
  }, 10_000);

  it('does not emit config:warning when timeout is at or above the floor', async () => {
    const stateDir = makeTempDir();
    const mergeWorktreePath = makeTempDir();

    const ctx = makeCtx(stateDir, mergeWorktreePath, {
      validateCommands: ['exit 0'],
      postMergeCommandTimeoutMs: 10_000, // exactly at floor
      maxValidationRetries: 0,
    });

    const events: EforgeEvent[] = [];
    for await (const event of validate(ctx)) {
      events.push(event);
    }

    expect(events.find((e) => e.type === 'config:warning')).toBeUndefined();
  }, 10_000);

  it('uses default timeout of 300_000ms when postMergeCommandTimeoutMs is not set', async () => {
    const stateDir = makeTempDir();
    const mergeWorktreePath = makeTempDir();

    const ctx = makeCtx(stateDir, mergeWorktreePath, {
      validateCommands: ['exit 0'],
      // postMergeCommandTimeoutMs not set → default 300_000
      maxValidationRetries: 0,
    });

    const events: EforgeEvent[] = [];
    for await (const event of validate(ctx)) {
      events.push(event);
    }

    // Should complete successfully with no timeout or warning events
    expect(events.find((e) => e.type === 'config:warning')).toBeUndefined();
    expect(events.find((e) => e.type === 'validation:command:timeout')).toBeUndefined();

    const completeEvent = events.find((e) => e.type === 'validation:complete') as
      | Extract<EforgeEvent, { type: 'validation:complete' }>
      | undefined;
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.passed).toBe(true);
  }, 10_000);
});
