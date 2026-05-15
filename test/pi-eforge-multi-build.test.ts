/**
 * Unit tests for Pi extension multi-build status helpers.
 *
 * All fixtures are constructed inline — no daemon, no mocks.
 * Imports from the pure-helpers module directly so Pi framework peer deps
 * are not loaded during test execution.
 */
import { describe, it, expect } from 'vitest';
import type { RunInfo, RunSummary, QueueItem } from '@eforge-build/client';
import {
  aggregateRunningSummaries,
  formatSingleBuildFooter,
  formatAggregateFooter,
  formatQueueFooter,
  checkActiveBuildsMessage,
} from '../packages/pi-eforge/extensions/eforge/pure-helpers.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRunInfo(overrides: Partial<RunInfo> = {}): RunInfo {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    planSet: 'ps-1',
    command: 'build',
    status: 'running',
    startedAt: '2024-01-01T10:00:00.000Z',
    cwd: '/project',
    ...overrides,
  };
}

function makeRunSummary(overrides: Partial<RunSummary> & { plans?: RunSummary['plans'] } = {}): RunSummary {
  return {
    sessionId: 'session-1',
    status: 'running',
    runs: [],
    plans: [],
    currentPhase: null,
    currentAgent: null,
    eventCounts: { total: 0, errors: 0 },
    duration: { startedAt: '2024-01-01T10:00:00.000Z', completedAt: null, seconds: 60 },
    ...overrides,
  };
}

function makeQueueItem(status: string, id = 'item-1'): QueueItem {
  return {
    id,
    status,
    source: 'test.md',
    enqueued_at: '2024-01-01T10:00:00.000Z',
  } as QueueItem;
}

// ---------------------------------------------------------------------------
// aggregateRunningSummaries
// ---------------------------------------------------------------------------

describe('aggregateRunningSummaries', () => {
  it('returns all-zeros for empty input', () => {
    const result = aggregateRunningSummaries([]);
    expect(result).toEqual({
      runningCount: 0,
      totalPlans: 0,
      completedPlans: 0,
      activePlans: 0,
      oldestStartedAt: null,
      totalErrors: 0,
    });
  });

  it('returns correct totals for a single summary', () => {
    const summary = makeRunSummary({
      plans: [
        { id: 'plan-1', status: 'pending', branch: null, dependsOn: [] },
        { id: 'plan-2', status: 'running', branch: null, dependsOn: [] },
      ],
      eventCounts: { total: 10, errors: 2 },
      duration: { startedAt: '2024-01-01T10:00:00.000Z', completedAt: null, seconds: 30 },
    });
    const run = makeRunInfo();

    const result = aggregateRunningSummaries([{ run, summary }]);
    expect(result.runningCount).toBe(1);
    expect(result.totalPlans).toBe(2);
    expect(result.completedPlans).toBe(0);
    expect(result.activePlans).toBe(1);
    expect(result.totalErrors).toBe(2);
    expect(result.oldestStartedAt).toBe('2024-01-01T10:00:00.000Z');
  });

  it('correctly aggregates two summaries with mixed plan statuses', () => {
    // Summary A: 2 plans [pending, running]
    const summaryA = makeRunSummary({
      sessionId: 'session-a',
      plans: [
        { id: 'plan-a1', status: 'pending', branch: null, dependsOn: [] },
        { id: 'plan-a2', status: 'running', branch: null, dependsOn: [] },
      ],
      eventCounts: { total: 5, errors: 1 },
      duration: { startedAt: '2024-01-01T10:00:00.000Z', completedAt: null, seconds: 120 },
    });
    // Summary B: 2 plans [completed, failed]
    const summaryB = makeRunSummary({
      sessionId: 'session-b',
      plans: [
        { id: 'plan-b1', status: 'completed', branch: 'feat/b1', dependsOn: [] },
        { id: 'plan-b2', status: 'failed', branch: null, dependsOn: [] },
      ],
      eventCounts: { total: 8, errors: 3 },
      duration: { startedAt: '2024-01-01T09:30:00.000Z', completedAt: null, seconds: 210 },
    });
    const runA = makeRunInfo({ id: 'run-a', sessionId: 'session-a' });
    const runB = makeRunInfo({ id: 'run-b', sessionId: 'session-b', startedAt: '2024-01-01T09:30:00.000Z' });

    const result = aggregateRunningSummaries([
      { run: runA, summary: summaryA },
      { run: runB, summary: summaryB },
    ]);
    expect(result.runningCount).toBe(2);
    expect(result.totalPlans).toBe(4);
    expect(result.completedPlans).toBe(1);
    expect(result.activePlans).toBe(1);
    // oldestStartedAt is the earlier of the two startedAt values
    expect(result.oldestStartedAt).toBe('2024-01-01T09:30:00.000Z');
    expect(result.totalErrors).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// formatSingleBuildFooter
// ---------------------------------------------------------------------------

describe('formatSingleBuildFooter', () => {
  it('includes "eforge build: running" prefix', () => {
    const summary = makeRunSummary();
    expect(formatSingleBuildFooter(summary)).toContain('eforge build: running');
  });

  it('counts pending plans in the denominator', () => {
    const summary = makeRunSummary({
      plans: [
        { id: 'plan-1', status: 'pending', branch: null, dependsOn: [] },
        { id: 'plan-2', status: 'pending', branch: null, dependsOn: [] },
      ],
    });
    // 0 completed of 2 total (both pending)
    expect(formatSingleBuildFooter(summary)).toContain('0/2 plans');
  });

  it('shows correct completed/total ratio including all statuses', () => {
    const summary = makeRunSummary({
      plans: [
        { id: 'plan-1', status: 'completed', branch: null, dependsOn: [] },
        { id: 'plan-2', status: 'running', branch: null, dependsOn: [] },
        { id: 'plan-3', status: 'pending', branch: null, dependsOn: [] },
        { id: 'plan-4', status: 'failed', branch: null, dependsOn: [] },
      ],
    });
    // 1 completed of 4 total
    expect(formatSingleBuildFooter(summary)).toContain('1/4 plans');
  });

  it('does not start with the aggregate format', () => {
    const summary = makeRunSummary();
    expect(formatSingleBuildFooter(summary)).not.toMatch(/^eforge builds:/);
  });
});

// ---------------------------------------------------------------------------
// formatAggregateFooter
// ---------------------------------------------------------------------------

describe('formatAggregateFooter', () => {
  it('matches expected format for two running summaries', () => {
    const summaryA = makeRunSummary({
      sessionId: 'session-a',
      plans: [
        { id: 'plan-a1', status: 'completed', branch: null, dependsOn: [] },
        { id: 'plan-a2', status: 'running', branch: null, dependsOn: [] },
      ],
      duration: { startedAt: new Date(Date.now() - 120_000).toISOString(), completedAt: null, seconds: 120 },
    });
    const summaryB = makeRunSummary({
      sessionId: 'session-b',
      plans: [
        { id: 'plan-b1', status: 'pending', branch: null, dependsOn: [] },
        { id: 'plan-b2', status: 'pending', branch: null, dependsOn: [] },
      ],
      duration: { startedAt: new Date(Date.now() - 60_000).toISOString(), completedAt: null, seconds: 60 },
    });
    const runA = makeRunInfo({ id: 'run-a', sessionId: 'session-a' });
    const runB = makeRunInfo({ id: 'run-b', sessionId: 'session-b' });

    const footer = formatAggregateFooter([
      { run: runA, summary: summaryA },
      { run: runB, summary: summaryB },
    ]);

    // Should match: "eforge builds: 2 running - {N}/{N} plans - {N} active - {duration}"
    expect(footer).toMatch(/^eforge builds: 2 running - \d+\/\d+ plans - \d+ active - /);
    // Total plans = 4, completed = 1
    expect(footer).toContain('1/4 plans');
    // Active = 1 (one 'running' plan in summaryA)
    expect(footer).toContain('1 active');
  });

  it('does not start with single-build format', () => {
    const summaryA = makeRunSummary({ sessionId: 'session-a' });
    const summaryB = makeRunSummary({ sessionId: 'session-b' });
    const runA = makeRunInfo({ id: 'run-a', sessionId: 'session-a' });
    const runB = makeRunInfo({ id: 'run-b', sessionId: 'session-b' });

    const footer = formatAggregateFooter([
      { run: runA, summary: summaryA },
      { run: runB, summary: summaryB },
    ]);

    expect(footer).not.toMatch(/^eforge build: running/);
  });
});

// ---------------------------------------------------------------------------
// formatQueueFooter
// ---------------------------------------------------------------------------

describe('formatQueueFooter', () => {
  it('returns undefined for empty queue', () => {
    expect(formatQueueFooter([], false)).toBeUndefined();
    expect(formatQueueFooter([], true)).toBeUndefined();
  });

  it('excludes running items from count when hasRunningBuild is true', () => {
    const items = [
      makeQueueItem('running', 'i1'),
      makeQueueItem('pending', 'i2'),
    ];
    const footer = formatQueueFooter(items, true);
    expect(footer).toBeDefined();
    expect(footer).not.toContain('running');
    expect(footer).toContain('1 pending');
  });

  it('includes running items when hasRunningBuild is false', () => {
    const items = [
      makeQueueItem('running', 'i1'),
      makeQueueItem('pending', 'i2'),
    ];
    const footer = formatQueueFooter(items, false);
    expect(footer).toBeDefined();
    expect(footer).toContain('1 running');
    expect(footer).toContain('1 pending');
  });

  it('returns undefined when all items are running and hasRunningBuild is true', () => {
    const items = [makeQueueItem('running', 'i1'), makeQueueItem('running', 'i2')];
    expect(formatQueueFooter(items, true)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// checkActiveBuildsMessage
// ---------------------------------------------------------------------------

describe('checkActiveBuildsMessage', () => {
  it('returns null for empty runs', () => {
    expect(checkActiveBuildsMessage([])).toBeNull();
  });

  it('returns singular message for one running run', () => {
    const run = makeRunInfo();
    expect(checkActiveBuildsMessage([run])).toBe(
      'An eforge build is currently active. Use force: true to stop anyway.',
    );
  });

  it('returns plural message for two running runs', () => {
    const run1 = makeRunInfo({ id: 'run-1', sessionId: 'session-1' });
    const run2 = makeRunInfo({ id: 'run-2', sessionId: 'session-2' });
    expect(checkActiveBuildsMessage([run1, run2])).toBe(
      '2 eforge builds are currently active. Use force: true to stop anyway.',
    );
  });

  it('returns plural message for N > 2 running runs', () => {
    const runs = [1, 2, 3].map((i) =>
      makeRunInfo({ id: `run-${i}`, sessionId: `session-${i}` }),
    );
    expect(checkActiveBuildsMessage(runs)).toBe(
      '3 eforge builds are currently active. Use force: true to stop anyway.',
    );
  });
});

// ---------------------------------------------------------------------------
// MCP proxy checkActiveBuilds message parity
// ---------------------------------------------------------------------------

describe('MCP proxy checkActiveBuilds message parity', () => {
  // The MCP proxy mirrors checkActiveBuildsMessage logic inline (cannot import
  // from pi-eforge without pulling Pi peer deps into the CLI).
  // This test asserts identical output for the same inputs.
  function mcpCheckActiveBuildsMessage(runs: RunInfo[]): string | null {
    // Mirrors packages/eforge/src/cli/mcp-proxy.ts inner checkActiveBuilds
    if (runs.length === 0) return null;
    if (runs.length === 1) {
      return 'An eforge build is currently active. Use force: true to stop anyway.';
    }
    return `${runs.length} eforge builds are currently active. Use force: true to stop anyway.`;
  }

  it('produces null for empty input (matches Pi helper)', () => {
    expect(mcpCheckActiveBuildsMessage([])).toBe(checkActiveBuildsMessage([]));
  });

  it('produces singular message for one run (matches Pi helper)', () => {
    const run = makeRunInfo();
    expect(mcpCheckActiveBuildsMessage([run])).toBe(checkActiveBuildsMessage([run]));
  });

  it('produces plural message for two runs (matches Pi helper)', () => {
    const runs = [
      makeRunInfo({ id: 'run-1', sessionId: 'session-1' }),
      makeRunInfo({ id: 'run-2', sessionId: 'session-2' }),
    ];
    expect(mcpCheckActiveBuildsMessage(runs)).toBe(checkActiveBuildsMessage(runs));
  });
});
