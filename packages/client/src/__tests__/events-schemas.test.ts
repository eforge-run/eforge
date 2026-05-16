/**
 * Tests for the TypeBox-based wire event schemas.
 *
 * Validates:
 *   - EforgeEventSchema is exported from @eforge-build/client (AC #13)
 *   - EforgeEvent is Static<>-derived: TypeBox validates what TypeScript accepts (AC #3)
 *   - The 5 new event variants round-trip through JSON (AC #3)
 *   - Runtime validation accepts valid payloads and rejects invalid ones
 *   - agent:start thinkingCoerced/thinkingOriginal optional fields parse correctly (AC #8 precursor)
 *   - Unknown event types are rejected, not silently accepted
 *
 * All fixtures are statically typed as EforgeEvent so field drift surfaces as
 * a TypeScript compile error rather than a runtime surprise.
 */

import { describe, it, expect } from 'vitest';
import { isAlwaysYieldedAgentEvent, safeParseDaemonStreamSnapshot, safeParseEforgeEvent } from '../events.schemas.js';
import { DAEMON_EVENT_TYPES, eventRegistry, getEventSummary } from '../event-registry.js';
import type { EforgeEvent } from '../events.schemas.js';

// ---------------------------------------------------------------------------
// Fixtures — the 5 new plan lifecycle + merge worktree variants
// ---------------------------------------------------------------------------

const newVariants: EforgeEvent[] = [
  // plan:status:change — plan moves to running
  {
    type: 'plan:status:change',
    timestamp: '2025-01-01T00:00:01.000Z',
    planId: 'plan-01-foundation',
    status: 'running',
  },

  // plan:status:change — plan completes
  {
    type: 'plan:status:change',
    timestamp: '2025-01-01T00:10:00.000Z',
    planId: 'plan-01-foundation',
    status: 'completed',
  },

  // plan:error:set
  {
    type: 'plan:error:set',
    timestamp: '2025-01-01T00:05:00.000Z',
    planId: 'plan-02-mutate-state',
    error: 'Agent exceeded max turns',
  },

  // plan:error:clear
  {
    type: 'plan:error:clear',
    timestamp: '2025-01-01T00:06:00.000Z',
    planId: 'plan-02-mutate-state',
  },

  // merge:worktree:set
  {
    type: 'merge:worktree:set',
    timestamp: '2025-01-01T01:00:00.000Z',
    path: '/project/.worktrees/merge-worktree-abc123',
  },

  // merge:worktree:clear
  {
    type: 'merge:worktree:clear',
    timestamp: '2025-01-01T01:30:00.000Z',
  },
];

const NEW_VARIANT_TYPES = new Set([
  'plan:status:change',
  'plan:error:set',
  'plan:error:clear',
  'merge:worktree:set',
  'merge:worktree:clear',
]);

// --- eforge:region plan-01-native-event-runtime-foundation ---
const extensionDiagnosticVariants: EforgeEvent[] = [
  {
    type: 'extension:event-handler:failed',
    timestamp: '2025-01-01T00:00:00.000Z',
    sessionId: 'sess-1',
    runId: 'run-1',
    extensionName: 'audit-log',
    extensionPath: '/project/.eforge/extensions/audit-log.js',
    pattern: 'plan:build:*',
    triggeringEventType: 'plan:build:failed',
    message: 'boom',
    stack: 'Error: boom',
  },
  {
    type: 'extension:event-handler:failed',
    timestamp: '2025-01-01T00:00:01.000Z',
    extensionName: 'string-error-hook',
    extensionPath: '/project/.eforge/extensions/string-error-hook.js',
    pattern: 'queue:*',
    triggeringEventType: 'queue:complete',
    message: 'plain string failure',
  },
  {
    type: 'extension:event-handler:timeout',
    timestamp: '2025-01-01T00:00:02.000Z',
    extensionName: 'audit-log',
    extensionPath: '/project/.eforge/extensions/audit-log.js',
    pattern: '*',
    triggeringEventType: 'plan:build:complete',
    timeoutMs: 5000,
  },
];
// --- eforge:endregion plan-01-native-event-runtime-foundation ---

// --- eforge:region plan-01-policy-gate-foundation ---
const extensionPolicyVariants: EforgeEvent[] = [
  {
    type: 'extension:policy:decision',
    timestamp: '2025-01-01T00:00:03.000Z',
    extensionName: 'guardrails',
    extensionPath: '/project/.eforge/extensions/guardrails.js',
    gateKind: 'plan-merge',
    method: 'beforePlanMerge',
    registrationIndex: 0,
    failurePolicy: 'fail-closed',
    planId: 'plan-01',
    decision: 'block',
    reason: 'protected paths changed',
  },
  {
    type: 'extension:policy:failed',
    timestamp: '2025-01-01T00:00:04.000Z',
    extensionName: 'guardrails',
    extensionPath: '/project/.eforge/extensions/guardrails.js',
    gateKind: 'queue-dispatch',
    method: 'beforeQueueDispatch',
    registrationIndex: 1,
    failurePolicy: 'fail-open',
    prdId: 'prd-123',
    prdTitle: 'Add feature',
    message: 'boom',
    stack: 'Error: boom',
  },
  {
    type: 'extension:policy:timeout',
    timestamp: '2025-01-01T00:00:05.000Z',
    extensionName: 'guardrails',
    extensionPath: '/project/.eforge/extensions/guardrails.js',
    gateKind: 'final-merge',
    method: 'beforeFinalMerge',
    registrationIndex: 2,
    failurePolicy: 'fail-closed',
    featureBranch: 'feature/prd-123',
    baseBranch: 'main',
    planIds: ['plan-01'],
    timeoutMs: 5000,
  },
];

const extensionPolicyGateMatrixVariants: EforgeEvent[] = [
  {
    type: 'extension:policy:decision', timestamp: '2025-01-01T00:00:10.000Z', extensionName: 'guardrails', extensionPath: '/project/.eforge/extensions/guardrails.js', gateKind: 'queue-dispatch', method: 'beforeQueueDispatch', registrationIndex: 0, failurePolicy: 'fail-open', prdId: 'prd-123', prdTitle: 'Add feature', decision: 'allow',
  },
  {
    type: 'extension:policy:failed', timestamp: '2025-01-01T00:00:11.000Z', extensionName: 'guardrails', extensionPath: '/project/.eforge/extensions/guardrails.js', gateKind: 'queue-dispatch', method: 'beforeQueueDispatch', registrationIndex: 1, failurePolicy: 'fail-open', prdId: 'prd-123', prdTitle: 'Add feature', message: 'boom',
  },
  {
    type: 'extension:policy:timeout', timestamp: '2025-01-01T00:00:12.000Z', extensionName: 'guardrails', extensionPath: '/project/.eforge/extensions/guardrails.js', gateKind: 'queue-dispatch', method: 'beforeQueueDispatch', registrationIndex: 2, failurePolicy: 'fail-closed', prdId: 'prd-123', prdTitle: 'Add feature', timeoutMs: 5000,
  },
  {
    type: 'extension:policy:decision', timestamp: '2025-01-01T00:00:13.000Z', extensionName: 'guardrails', extensionPath: '/project/.eforge/extensions/guardrails.js', gateKind: 'plan-merge', method: 'beforePlanMerge', registrationIndex: 0, failurePolicy: 'fail-closed', planId: 'plan-01', decision: 'block', reason: 'protected paths changed',
  },
  {
    type: 'extension:policy:failed', timestamp: '2025-01-01T00:00:14.000Z', extensionName: 'guardrails', extensionPath: '/project/.eforge/extensions/guardrails.js', gateKind: 'plan-merge', method: 'beforePlanMerge', registrationIndex: 1, failurePolicy: 'fail-open', planId: 'plan-01', message: 'boom',
  },
  {
    type: 'extension:policy:timeout', timestamp: '2025-01-01T00:00:15.000Z', extensionName: 'guardrails', extensionPath: '/project/.eforge/extensions/guardrails.js', gateKind: 'plan-merge', method: 'beforePlanMerge', registrationIndex: 2, failurePolicy: 'fail-closed', planId: 'plan-01', timeoutMs: 5000,
  },
  {
    type: 'extension:policy:decision', timestamp: '2025-01-01T00:00:16.000Z', extensionName: 'guardrails', extensionPath: '/project/.eforge/extensions/guardrails.js', gateKind: 'final-merge', method: 'beforeFinalMerge', registrationIndex: 0, failurePolicy: 'fail-closed', featureBranch: 'feature/prd-123', baseBranch: 'main', planIds: ['plan-01'], decision: 'require-approval', reason: 'approval required',
  },
  {
    type: 'extension:policy:failed', timestamp: '2025-01-01T00:00:17.000Z', extensionName: 'guardrails', extensionPath: '/project/.eforge/extensions/guardrails.js', gateKind: 'final-merge', method: 'beforeFinalMerge', registrationIndex: 1, failurePolicy: 'fail-open', featureBranch: 'feature/prd-123', baseBranch: 'main', planIds: ['plan-01'], message: 'boom',
  },
  {
    type: 'extension:policy:timeout', timestamp: '2025-01-01T00:00:18.000Z', extensionName: 'guardrails', extensionPath: '/project/.eforge/extensions/guardrails.js', gateKind: 'final-merge', method: 'beforeFinalMerge', registrationIndex: 2, failurePolicy: 'fail-closed', featureBranch: 'feature/prd-123', baseBranch: 'main', planIds: ['plan-01'], timeoutMs: 5000,
  },
];

// --- eforge:endregion plan-01-policy-gate-foundation ---

// ---------------------------------------------------------------------------
// JSON round-trip tests
// ---------------------------------------------------------------------------

describe('new plan lifecycle + merge-worktree variants — JSON roundtrip', () => {
  it('roundtrips all 5 new variant types through JSON', () => {
    for (const event of newVariants) {
      const parsed = JSON.parse(JSON.stringify(event));
      expect(parsed).toEqual(event);
      expect(parsed.type).toBe(event.type);
    }
  });

  it('covers all 5 new variant type literals', () => {
    const types = new Set(newVariants.map((e) => e.type));
    expect(types).toEqual(NEW_VARIANT_TYPES);
  });
});

// ---------------------------------------------------------------------------
// Schema validation — valid payloads
// ---------------------------------------------------------------------------

describe('safeParseEforgeEvent — new variants', () => {
  // --- eforge:region plan-01-native-event-runtime-foundation ---
  it('accepts extension event-handler diagnostics with required fields', () => {
    for (const event of extensionDiagnosticVariants) {
      const result = safeParseEforgeEvent(event);
      expect(result.success, `${event.type} should be accepted`).toBe(true);
    }
  });

  it('round-trips extension event-handler diagnostics through JSON', () => {
    for (const event of extensionDiagnosticVariants) {
      expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    }
  });
  // --- eforge:endregion plan-01-native-event-runtime-foundation ---

  // --- eforge:region plan-01-policy-gate-foundation ---
  it('accepts extension policy decision, failure, and timeout events', () => {
    for (const event of extensionPolicyVariants) {
      const result = safeParseEforgeEvent(event);
      expect(result.success, `${event.type} should be accepted`).toBe(true);
    }
  });

  it('accepts policy decision, failed, and timeout events for every gate kind', () => {
    for (const event of extensionPolicyGateMatrixVariants) {
      const result = safeParseEforgeEvent(event);
      expect(result.success, `${event.type} should be accepted`).toBe(true);
    }
  });

  it('round-trips extension policy events through JSON', () => {
    for (const event of extensionPolicyVariants) {
      expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    }
  });
  // --- eforge:endregion plan-01-policy-gate-foundation ---

  it('accepts plan:status:change with every valid status value', () => {
    const statuses = ['pending', 'running', 'completed', 'failed', 'blocked', 'merged'] as const;
    for (const status of statuses) {
      const result = safeParseEforgeEvent({
        type: 'plan:status:change',
        timestamp: '2025-01-01T00:00:00.000Z',
        planId: 'plan-01',
        status,
      });
      expect(result.success, `status '${status}' should be accepted`).toBe(true);
    }
  });

  it('accepts plan:error:set with required fields', () => {
    const result = safeParseEforgeEvent({
      type: 'plan:error:set',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      error: 'Build timed out',
    });
    expect(result.success).toBe(true);
  });

  it('accepts plan:error:clear with only planId + timestamp', () => {
    const result = safeParseEforgeEvent({
      type: 'plan:error:clear',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
    });
    expect(result.success).toBe(true);
  });

  it('accepts merge:worktree:set with path', () => {
    const result = safeParseEforgeEvent({
      type: 'merge:worktree:set',
      timestamp: '2025-01-01T00:00:00.000Z',
      path: '/tmp/merge-worktree',
    });
    expect(result.success).toBe(true);
  });

  it('accepts merge:worktree:clear with only timestamp', () => {
    const result = safeParseEforgeEvent({
      type: 'merge:worktree:clear',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional envelope fields (sessionId, runId)', () => {
    const result = safeParseEforgeEvent({
      type: 'plan:status:change',
      timestamp: '2025-01-01T00:00:00.000Z',
      sessionId: 'sess-abc',
      runId: 'run-xyz',
      planId: 'plan-01',
      status: 'running',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessionId).toBe('sess-abc');
      expect(result.data.runId).toBe('run-xyz');
    }
  });

  it('accepts daemon:auto-build:disabled with only the common envelope', () => {
    const result = safeParseEforgeEvent({
      type: 'daemon:auto-build:disabled',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Event registry metadata
// ---------------------------------------------------------------------------

// --- eforge:region plan-01-native-event-runtime-foundation ---
describe('eventRegistry — extension diagnostics', () => {
  it('registers extension diagnostics as session-scoped, non-persistent events with summaries', () => {
    const failed = extensionDiagnosticVariants[0]!;
    const timeout = extensionDiagnosticVariants[2]!;
    expect(eventRegistry['extension:event-handler:failed']).toMatchObject({ scope: 'session', persist: false });
    expect(eventRegistry['extension:event-handler:timeout']).toMatchObject({ scope: 'session', persist: false });
    expect(getEventSummary(failed)).toBe(
      'Extension audit-log event hook failed (plan:build:* on plan:build:failed): boom',
    );
    expect(getEventSummary(timeout)).toBe(
      'Extension audit-log event hook timed out after 5000ms (* on plan:build:complete)',
    );
  });
});
// --- eforge:endregion plan-01-native-event-runtime-foundation ---

// --- eforge:region plan-01-policy-gate-foundation ---
describe('eventRegistry — extension policy gates', () => {
  it('registers policy events as session-scoped, non-persistent events with summaries', () => {
    for (const event of extensionPolicyVariants) {
      expect(eventRegistry[event.type]).toMatchObject({ scope: 'session', persist: false });
    }
    expect(getEventSummary(extensionPolicyVariants[0]!)).toBe(
      'Policy gate beforePlanMerge (guardrails) returned block: protected paths changed',
    );
    expect(getEventSummary(extensionPolicyVariants[1]!)).toBe(
      'Policy gate beforeQueueDispatch (guardrails) failed under fail-open: boom',
    );
    expect(getEventSummary(extensionPolicyVariants[2]!)).toBe(
      'Policy gate beforeFinalMerge (guardrails) timed out after 5000ms under fail-closed',
    );
  });
});
// --- eforge:endregion plan-01-policy-gate-foundation ---

// --- eforge:region plan-01-supervisor-foundation ---
describe('safeParseEforgeEvent — daemon:auto-build:transition', () => {
  it('accepts transition events with lifecycle detail', () => {
    const result = safeParseEforgeEvent({
      type: 'daemon:auto-build:transition',
      timestamp: '2025-01-01T00:00:00.000Z',
      previousMode: 'starting',
      nextMode: 'running',
      desired: 'enabled',
      reason: 'watcher started',
      source: 'watcher',
    });
    expect(result.success).toBe(true);
  });

  it('rejects transition events with invalid modes', () => {
    const result = safeParseEforgeEvent({
      type: 'daemon:auto-build:transition',
      timestamp: '2025-01-01T00:00:00.000Z',
      previousMode: 'warming-up',
      nextMode: 'running',
      desired: 'enabled',
      source: 'watcher',
    });
    expect(result.success).toBe(false);
  });

  it('rejects daemon heartbeat events with invalid autoBuild lifecycle literals', () => {
    const result = safeParseEforgeEvent({
      type: 'daemon:heartbeat',
      timestamp: '2025-01-01T00:00:00.000Z',
      uptime: 1000,
      queueDepth: 1,
      runningBuilds: 0,
      autoBuild: { enabled: true, paused: false, desired: 'enabled', mode: 'warming-up' },
      subscribers: 1,
    });
    expect(result.success).toBe(false);
  });
});

// --- eforge:endregion plan-01-supervisor-foundation ---

// --- eforge:region plan-01-supervisor-foundation ---
describe('eventRegistry — daemon:auto-build:transition', () => {
  it('registers transition events as daemon-scoped, persisted, summarized, and projected', () => {
    expect(eventRegistry['daemon:auto-build:transition']).toMatchObject({
      scope: 'daemon',
      persist: true,
    });
    expect(DAEMON_EVENT_TYPES).toContain('daemon:auto-build:transition');
    const event = {
      type: 'daemon:auto-build:transition',
      timestamp: '2025-01-01T00:00:00.000Z',
      previousMode: 'starting',
      nextMode: 'running',
      desired: 'enabled',
      reason: 'watcher started',
      source: 'watcher',
    } as const;
    expect(getEventSummary(event)).toBe('Auto-build starting → running (enabled): watcher started');

    const state = {
      runs: [],
      queue: [],
      autoBuild: { enabled: false, watcher: { running: true, pid: 1234, sessionId: 'watcher-1' } },
      latestHeartbeat: null,
    };
    expect(eventRegistry['daemon:auto-build:transition'].project?.(event, state)).toEqual({
      autoBuild: {
        enabled: true,
        watcher: { running: true, pid: 1234, sessionId: 'watcher-1' },
        desired: 'enabled',
        mode: 'running',
        lastTransition: {
          at: '2025-01-01T00:00:00.000Z',
          previousMode: 'starting',
          nextMode: 'running',
          desired: 'enabled',
          reason: 'watcher started',
          source: 'watcher',
        },
        reason: 'watcher started',
      },
    });
  });

  it('projects paused desired-enabled transitions as legacy enabled=false', () => {
    const event = {
      type: 'daemon:auto-build:transition',
      timestamp: '2025-01-01T00:00:00.000Z',
      previousMode: 'running',
      nextMode: 'paused',
      desired: 'enabled',
      reason: 'build failed',
      source: 'watcher',
    } as const;
    const state = {
      runs: [],
      queue: [],
      autoBuild: { enabled: true, watcher: { running: true, pid: 1234, sessionId: 'watcher-1' } },
      latestHeartbeat: null,
    };

    expect(eventRegistry['daemon:auto-build:transition'].project?.(event, state)).toMatchObject({
      autoBuild: {
        enabled: false,
        desired: 'enabled',
        mode: 'paused',
        reason: 'build failed',
      },
    });
  });
});
// --- eforge:endregion plan-01-supervisor-foundation ---

describe('eventRegistry — daemon:auto-build:disabled', () => {
  it('registers the disabled event as daemon-scoped, persisted, summarized, and projected', () => {
    expect(eventRegistry['daemon:auto-build:disabled']).toMatchObject({
      scope: 'daemon',
      persist: true,
      summary: 'Auto-build disabled',
    });

    const event = {
      type: 'daemon:auto-build:disabled',
      timestamp: '2025-01-01T00:00:00.000Z',
    } as const;
    expect(getEventSummary(event)).toBe('Auto-build disabled');

    const state = {
      runs: [],
      queue: [],
      autoBuild: { enabled: true, watcher: { running: true, pid: 1234, sessionId: null } },
      latestHeartbeat: null,
    };
    const project = eventRegistry['daemon:auto-build:disabled'].project;
    expect(project?.(event, state)).toEqual({
      autoBuild: { enabled: false, watcher: { running: true, pid: 1234, sessionId: null } },
    });
    expect(project?.(event, { ...state, autoBuild: { ...state.autoBuild, enabled: false } })).toBeUndefined();
    expect(project?.(event, { ...state, autoBuild: null })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Schema validation — invalid payloads rejected
// ---------------------------------------------------------------------------

// --- eforge:region plan-01-supervisor-foundation ---
describe('safeParseDaemonStreamSnapshot — enriched autoBuild state', () => {
  it('accepts autoBuild lifecycle fields in daemon stream snapshots', () => {
    const snapshot = {
      cursor: 1,
      liveness: {
        type: 'daemon:heartbeat',
        timestamp: '2025-01-01T00:00:00.000Z',
        uptime: 1000,
        queueDepth: 1,
        runningBuilds: 0,
        autoBuild: {
          enabled: true,
          paused: false,
          desired: 'enabled',
          mode: 'running',
          scheduler: { alive: true, paused: false },
          lastTransition: {
            at: '2025-01-01T00:00:00.000Z',
            previousMode: 'starting',
            nextMode: 'running',
            desired: 'enabled',
            source: 'watcher',
            reason: 'watcher started',
          },
          reason: 'watcher started',
        },
        subscribers: 1,
      },
      recentActivity: [],
      runs: [],
      queue: [],
      sessionMetadata: {},
      autoBuild: {
        enabled: true,
        watcher: { running: true, pid: 1234, sessionId: 'watcher-1' },
        desired: 'enabled',
        mode: 'running',
        scheduler: { alive: true, paused: false },
        lastTransition: {
          at: '2025-01-01T00:00:00.000Z',
          previousMode: 'starting',
          nextMode: 'running',
          desired: 'enabled',
          source: 'watcher',
          reason: 'watcher started',
        },
        reason: 'watcher started',
      },
    };

    const result = safeParseDaemonStreamSnapshot(snapshot);
    expect(result.success).toBe(true);
  });

  it('rejects invalid autoBuild lifecycle field literals in daemon stream snapshots', () => {
    const snapshot = {
      cursor: 1,
      liveness: {
        type: 'daemon:heartbeat',
        timestamp: '2025-01-01T00:00:00.000Z',
        uptime: 1000,
        queueDepth: 1,
        runningBuilds: 0,
        autoBuild: { enabled: true, paused: false, desired: 'enabled', mode: 'warming-up' },
        subscribers: 1,
      },
      recentActivity: [],
      runs: [],
      queue: [],
      sessionMetadata: {},
      autoBuild: {
        enabled: true,
        watcher: { running: true, pid: 1234, sessionId: 'watcher-1' },
        desired: 'enabled',
        mode: 'running',
      },
    };

    const result = safeParseDaemonStreamSnapshot(snapshot);
    expect(result.success).toBe(false);
  });

  it('rejects invalid top-level autoBuild lifecycle field literals in daemon stream snapshots', () => {
    const snapshot = {
      cursor: 1,
      liveness: {
        type: 'daemon:heartbeat',
        timestamp: '2025-01-01T00:00:00.000Z',
        uptime: 1000,
        queueDepth: 1,
        runningBuilds: 0,
        autoBuild: { enabled: true, paused: false, desired: 'enabled', mode: 'running' },
        subscribers: 1,
      },
      recentActivity: [],
      runs: [],
      queue: [],
      sessionMetadata: {},
      autoBuild: {
        enabled: true,
        watcher: { running: true, pid: 1234, sessionId: 'watcher-1' },
        desired: 'enabled',
        mode: 'warming-up',
      },
    };

    const result = safeParseDaemonStreamSnapshot(snapshot);
    expect(result.success).toBe(false);
  });
});
// --- eforge:endregion plan-01-supervisor-foundation ---

describe('safeParseEforgeEvent — rejection of invalid payloads', () => {
  // --- eforge:region plan-01-native-event-runtime-foundation ---
  it('rejects extension:event-handler:failed missing message', () => {
    const result = safeParseEforgeEvent({
      type: 'extension:event-handler:failed',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionName: 'audit-log',
      extensionPath: '/project/.eforge/extensions/audit-log.js',
      pattern: '*',
      triggeringEventType: 'plan:build:failed',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extension:event-handler:timeout with non-number timeoutMs', () => {
    const result = safeParseEforgeEvent({
      type: 'extension:event-handler:timeout',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionName: 'audit-log',
      extensionPath: '/project/.eforge/extensions/audit-log.js',
      pattern: '*',
      triggeringEventType: 'plan:build:failed',
      timeoutMs: '5000',
    });
    expect(result.success).toBe(false);
  });
  // --- eforge:endregion plan-01-native-event-runtime-foundation ---

  // --- eforge:region plan-01-policy-gate-foundation ---
  it('rejects extension:policy:decision with invalid decision literal', () => {
    const result = safeParseEforgeEvent({
      ...extensionPolicyVariants[0]!,
      decision: 'modify',
    });
    expect(result.success).toBe(false);
  });

  it('rejects blocking extension:policy:decision events without a reason', () => {
    const eventMissingReason = { ...extensionPolicyVariants[0]! } as Record<string, unknown>;
    delete eventMissingReason.reason;
    expect(safeParseEforgeEvent(eventMissingReason).success).toBe(false);

    const approvalMissingReason = { ...extensionPolicyGateMatrixVariants[6]! } as Record<string, unknown>;
    delete approvalMissingReason.reason;
    expect(safeParseEforgeEvent(approvalMissingReason).success).toBe(false);
  });

  it('rejects extension:policy:timeout with invalid failure policy', () => {
    const result = safeParseEforgeEvent({
      ...extensionPolicyVariants[2]!,
      failurePolicy: 'ignore',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extension policy events missing required provenance fields', () => {
    const eventMissingExtensionPath = { ...extensionPolicyVariants[0]! } as Record<string, unknown>;
    delete eventMissingExtensionPath.extensionPath;
    const result = safeParseEforgeEvent(eventMissingExtensionPath);
    expect(result.success).toBe(false);
  });

  it('rejects extension policy events with invalid registration indexes', () => {
    const result = safeParseEforgeEvent({
      ...extensionPolicyVariants[1]!,
      registrationIndex: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects policy events with missing or mismatched gate-specific target fields', () => {
    expect(safeParseEforgeEvent({
      ...extensionPolicyVariants[0]!,
      planId: undefined,
    }).success).toBe(false);

    expect(safeParseEforgeEvent({
      ...extensionPolicyVariants[1]!,
      method: 'beforePlanMerge',
    }).success).toBe(false);

    expect(safeParseEforgeEvent({
      ...extensionPolicyVariants[2]!,
      baseBranch: undefined,
    }).success).toBe(false);
  });
  // --- eforge:endregion plan-01-policy-gate-foundation ---

  it('rejects plan:status:change with an invalid status value', () => {
    const result = safeParseEforgeEvent({
      type: 'plan:status:change',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      status: 'not-a-real-status',
    });
    expect(result.success).toBe(false);
  });

  it('rejects plan:status:change missing planId', () => {
    const result = safeParseEforgeEvent({
      type: 'plan:status:change',
      timestamp: '2025-01-01T00:00:00.000Z',
      status: 'running',
    });
    expect(result.success).toBe(false);
  });

  it('rejects plan:error:set missing error field', () => {
    const result = safeParseEforgeEvent({
      type: 'plan:error:set',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
    });
    expect(result.success).toBe(false);
  });

  it('rejects merge:worktree:set missing path field', () => {
    const result = safeParseEforgeEvent({
      type: 'merge:worktree:set',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an entirely unknown event type', () => {
    const result = safeParseEforgeEvent({
      type: 'completely:unknown:event',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an event missing timestamp (required envelope field)', () => {
    const result = safeParseEforgeEvent({
      type: 'plan:status:change',
      planId: 'plan-01',
      status: 'running',
    });
    expect(result.success).toBe(false);
  });

  it('rejects enqueue:complete missing planSet (required typed field)', () => {
    const result = safeParseEforgeEvent({
      type: 'enqueue:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      id: 'x',
      filePath: 'y',
      title: 'z',
      // planSet intentionally omitted
    });
    expect(result.success).toBe(false);
  });

  it('provides a non-empty error message on failure', () => {
    const result = safeParseEforgeEvent({
      type: 'completely:unknown:event',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// agent:start — thinkingCoerced / thinkingOriginal fields (AC #8 precursor)
// ---------------------------------------------------------------------------

describe('agent:start — runtime decision fields survive schema round-trip', () => {
  it('accepts agent:start with thinkingCoerced and thinkingOriginal', () => {
    const event = {
      type: 'agent:start',
      timestamp: '2025-01-01T00:00:00.000Z',
      agentId: 'agent-xyz',
      agent: 'builder',
      model: 'claude-sonnet-4-5',
      harness: 'claude-sdk',
      harnessSource: 'tier',
      tier: 'standard',
      tierSource: 'tier',
      thinkingCoerced: true,
      thinkingOriginal: { type: 'enabled', budget_tokens: 10000 },
    };
    const result = safeParseEforgeEvent(event);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Extract<typeof result.data, { type: 'agent:start' }>).thinkingCoerced).toBe(true);
      expect((result.data as Extract<typeof result.data, { type: 'agent:start' }>).thinkingOriginal).toEqual({
        type: 'enabled',
        budget_tokens: 10000,
      });
    }
  });

  it('accepts agent:start without optional thinking fields', () => {
    const result = safeParseEforgeEvent({
      type: 'agent:start',
      timestamp: '2025-01-01T00:00:00.000Z',
      agentId: 'agent-abc',
      agent: 'reviewer',
      model: 'claude-haiku-3-5',
      harness: 'claude-sdk',
      harnessSource: 'tier',
      tier: 'fast',
      tierSource: 'role',
    });
    expect(result.success).toBe(true);
  });

  it('round-trips agent:start with thinkingCoerced/thinkingOriginal through JSON', () => {
    const event: EforgeEvent = {
      type: 'agent:start',
      timestamp: '2025-01-01T00:00:00.000Z',
      agentId: 'agent-xyz',
      agent: 'builder',
      model: 'claude-sonnet-4-5',
      harness: 'claude-sdk',
      harnessSource: 'tier',
      tier: 'standard',
      tierSource: 'tier',
      thinkingCoerced: true,
      thinkingOriginal: { type: 'enabled', budget_tokens: 10000 },
    };
    const parsed = JSON.parse(JSON.stringify(event));
    expect(parsed).toEqual(event);
  });
});

// ---------------------------------------------------------------------------
// Schema-as-source-of-truth: validation of pre-existing variants
// ---------------------------------------------------------------------------

describe('safeParseEforgeEvent — pre-existing variant spot-checks', () => {
  it('accepts a well-formed session:start event', () => {
    const result = safeParseEforgeEvent({
      type: 'session:start',
      timestamp: '2025-01-01T00:00:00.000Z',
      sessionId: 'sess-123',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a well-formed plan:build:failed event', () => {
    const result = safeParseEforgeEvent({
      type: 'plan:build:failed',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      error: 'build failed',
    });
    expect(result.success).toBe(true);
  });

  it('accepts error_transient_transport terminal subtype on build failures and retries', () => {
    const failed = safeParseEforgeEvent({
      type: 'plan:build:failed',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      error: 'Backend error: WebSocket closed 1012',
      terminalSubtype: 'error_transient_transport',
    });
    expect(failed.success).toBe(true);

    const retry = safeParseEforgeEvent({
      type: 'agent:retry',
      timestamp: '2025-01-01T00:00:01.000Z',
      agent: 'builder',
      attempt: 1,
      maxAttempts: 4,
      subtype: 'error_transient_transport',
      label: 'builder-continuation',
      planId: 'plan-01',
    });
    expect(retry.success).toBe(true);
  });

  it('rejects unknown terminal subtypes on build failures and retries', () => {
    const failed = safeParseEforgeEvent({
      type: 'plan:build:failed',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      error: 'Backend error: something else',
      terminalSubtype: 'error_not_in_schema',
    });
    expect(failed.success).toBe(false);

    const retry = safeParseEforgeEvent({
      type: 'agent:retry',
      timestamp: '2025-01-01T00:00:01.000Z',
      agent: 'builder',
      attempt: 1,
      maxAttempts: 4,
      subtype: 'error_not_in_schema',
      label: 'builder-continuation',
      planId: 'plan-01',
    });
    expect(retry.success).toBe(false);
  });

  it('accepts a well-formed daemon:heartbeat event', () => {
    const result = safeParseEforgeEvent({
      type: 'daemon:heartbeat',
      timestamp: '2025-01-01T00:00:00.000Z',
      uptime: 60000,
      queueDepth: 0,
      runningBuilds: 1,
      autoBuild: { enabled: true, paused: false },
      subscribers: 2,
    });
    expect(result.success).toBe(true);
  });

  it('accepts an agent:start event WITHOUT toolbelt observability fields', () => {
    const result = safeParseEforgeEvent({
      type: 'agent:start',
      timestamp: '2025-01-01T00:00:00.000Z',
      agentId: 'a1',
      agent: 'builder',
      model: 'claude-sonnet-4-6',
      harness: 'claude-sdk',
      harnessSource: 'tier',
      tier: 'implementation',
      tierSource: 'tier',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an agent:start event WITH toolbelt observability fields (named toolbelt)', () => {
    const result = safeParseEforgeEvent({
      type: 'agent:start',
      timestamp: '2025-01-01T00:00:00.000Z',
      agentId: 'a1',
      agent: 'builder',
      model: 'claude-sonnet-4-6',
      harness: 'claude-sdk',
      harnessSource: 'tier',
      tier: 'implementation',
      tierSource: 'tier',
      toolbelt: 'browser-ui',
      toolbeltSource: 'tier',
      projectMcpSelection: 'toolbelt',
      projectMcpServerNames: ['playwright'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts agent:start with toolbelt: null when projectMcpSelection is none', () => {
    const result = safeParseEforgeEvent({
      type: 'agent:start',
      timestamp: '2025-01-01T00:00:00.000Z',
      agentId: 'a2',
      agent: 'evaluator',
      model: 'claude-opus-4-7',
      harness: 'claude-sdk',
      harnessSource: 'tier',
      tier: 'evaluation',
      tierSource: 'tier',
      toolbelt: null,
      toolbeltSource: 'tier',
      projectMcpSelection: 'none',
      projectMcpServerNames: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects agent:start with an invalid projectMcpSelection literal', () => {
    const result = safeParseEforgeEvent({
      type: 'agent:start',
      timestamp: '2025-01-01T00:00:00.000Z',
      agentId: 'a3',
      agent: 'builder',
      model: 'claude-sonnet-4-6',
      harness: 'claude-sdk',
      harnessSource: 'tier',
      tier: 'implementation',
      tierSource: 'tier',
      projectMcpSelection: 'something-else',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// agent:activity — new discriminant variant
// ---------------------------------------------------------------------------

describe('safeParseEforgeEvent — agent:activity variant', () => {
  it('accepts agent:activity as a recognized discriminant of EforgeEventSchema', () => {
    const result = safeParseEforgeEvent({
      type: 'agent:activity',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      agentId: 'agt-abc123',
      agent: 'builder',
      files: [
        { path: 'src/foo.ts', status: 'M', additions: 10, deletions: 3, binary: false },
      ],
      totals: { filesChanged: 1, additions: 10, deletions: 3 },
      attribution: 'exact',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('agent:activity');
    }
  });

  it('accepts agent:activity with attribution: best_effort and notes', () => {
    const result = safeParseEforgeEvent({
      type: 'agent:activity',
      timestamp: '2025-01-01T00:00:00.000Z',
      agentId: 'agt-def456',
      agent: 'review-fixer',
      totals: { filesChanged: 3, additions: 20, deletions: 5 },
      attribution: 'best_effort',
      notes: ['Unclaimed files outside shard scope: lib/utils.ts'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts agent:result without agentId (backward compatibility)', () => {
    const result = safeParseEforgeEvent({
      type: 'agent:result',
      timestamp: '2025-01-01T00:00:00.000Z',
      agent: 'builder',
      result: {
        durationMs: 5000,
        durationApiMs: 4500,
        numTurns: 10,
        totalCostUsd: 0.05,
        usage: { input: 1000, output: 500, total: 1500, cacheRead: 0, cacheCreation: 0 },
        modelUsage: {},
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts agent:result with agentId', () => {
    const result = safeParseEforgeEvent({
      type: 'agent:result',
      timestamp: '2025-01-01T00:00:00.000Z',
      agentId: 'agt-xyz789',
      agent: 'builder',
      result: {
        durationMs: 5000,
        durationApiMs: 4500,
        numTurns: 10,
        totalCostUsd: 0.05,
        usage: { input: 1000, output: 500, total: 1500, cacheRead: 0, cacheCreation: 0 },
        modelUsage: {},
      },
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'agent:result') {
      expect(result.data.agentId).toBe('agt-xyz789');
    }
  });
});

// --- eforge:region plan-01-agent-context-runtime ---

// ---------------------------------------------------------------------------
// extension:agent-context:* and extension:agent-tools:* variants
// ---------------------------------------------------------------------------

describe('safeParseEforgeEvent — extension:agent-context:* variants', () => {
  it('accepts extension:agent-context:applied with required fields', () => {
    const result = safeParseEforgeEvent({
      type: 'extension:agent-context:applied',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionName: 'my-ext',
      extensionPath: '/project/.eforge/extensions/my-ext.ts',
      role: 'builder',
      profile: 'default',
      promptCharCount: 1500,
      fragmentCount: 1,
    });
    expect(result.success).toBe(true);
  });

  it('accepts extension:agent-context:applied with all optional fields', () => {
    const result = safeParseEforgeEvent({
      type: 'extension:agent-context:applied',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionName: 'my-ext',
      extensionPath: '/project/.eforge/extensions/my-ext.ts',
      role: 'builder',
      tier: 'implementation',
      phase: 'build',
      stage: 'implement',
      profile: 'default',
      planId: 'plan-01',
      harness: 'claude-sdk',
      toolbelt: 'browser-ui',
      projectMcpSelection: 'toolbelt',
      promptCharCount: 1500,
      fragmentCount: 2,
    });
    expect(result.success).toBe(true);
  });

  it('accepts extension:agent-context:applied with toolbelt: null', () => {
    const result = safeParseEforgeEvent({
      type: 'extension:agent-context:applied',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionName: 'my-ext',
      extensionPath: '/project/.eforge/extensions/my-ext.ts',
      role: 'builder',
      profile: 'default',
      toolbelt: null,
      promptCharCount: 800,
      fragmentCount: 1,
    });
    expect(result.success).toBe(true);
  });

  it('rejects extension:agent-context:applied missing promptCharCount', () => {
    const result = safeParseEforgeEvent({
      type: 'extension:agent-context:applied',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionName: 'my-ext',
      extensionPath: '/project/.eforge/extensions/my-ext.ts',
      role: 'builder',
      profile: 'default',
      fragmentCount: 1,
    });
    expect(result.success).toBe(false);
  });

  it('accepts extension:agent-context:failed with required fields', () => {
    const result = safeParseEforgeEvent({
      type: 'extension:agent-context:failed',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionName: 'my-ext',
      extensionPath: '/project/.eforge/extensions/my-ext.ts',
      role: 'reviewer',
      profile: 'default',
      message: 'Handler threw an error',
    });
    expect(result.success).toBe(true);
  });

  it('accepts extension:agent-context:failed with optional stack field', () => {
    const result = safeParseEforgeEvent({
      type: 'extension:agent-context:failed',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionName: 'my-ext',
      extensionPath: '/project/.eforge/extensions/my-ext.ts',
      role: 'builder',
      profile: 'default',
      message: 'Something went wrong',
      stack: 'Error: Something went wrong\n    at handler (/ext.ts:10:5)',
    });
    expect(result.success).toBe(true);
  });

  it('rejects extension:agent-context:failed missing message', () => {
    const result = safeParseEforgeEvent({
      type: 'extension:agent-context:failed',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionName: 'my-ext',
      extensionPath: '/project/.eforge/extensions/my-ext.ts',
      role: 'builder',
      profile: 'default',
    });
    expect(result.success).toBe(false);
  });

  it('accepts extension:agent-context:timeout with required fields', () => {
    const result = safeParseEforgeEvent({
      type: 'extension:agent-context:timeout',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionName: 'slow-ext',
      extensionPath: '/project/.eforge/extensions/slow-ext.ts',
      role: 'planner',
      profile: 'default',
      timeoutMs: 5000,
    });
    expect(result.success).toBe(true);
  });

  it('rejects extension:agent-context:timeout with non-number timeoutMs', () => {
    const result = safeParseEforgeEvent({
      type: 'extension:agent-context:timeout',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionName: 'slow-ext',
      extensionPath: '/project/.eforge/extensions/slow-ext.ts',
      role: 'planner',
      profile: 'default',
      timeoutMs: '5000',
    });
    expect(result.success).toBe(false);
  });

  it('accepts extension:agent-context:unsupported with required fields', () => {
    const result = safeParseEforgeEvent({
      type: 'extension:agent-context:unsupported',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionName: 'tool-ext',
      extensionPath: '/project/.eforge/extensions/tool-ext.ts',
      role: 'builder',
      profile: 'default',
      fields: ['tools'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts extension:agent-context:unsupported with multiple field values', () => {
    const result = safeParseEforgeEvent({
      type: 'extension:agent-context:unsupported',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionName: 'tool-ext',
      extensionPath: '/project/.eforge/extensions/tool-ext.ts',
      role: 'builder',
      profile: 'default',
      fields: ['tools', 'allowedTools', 'disallowedTools'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects extension:agent-context:unsupported with unknown field literal', () => {
    const result = safeParseEforgeEvent({
      type: 'extension:agent-context:unsupported',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionName: 'tool-ext',
      extensionPath: '/project/.eforge/extensions/tool-ext.ts',
      role: 'builder',
      profile: 'default',
      fields: ['unknownField'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts extension:agent-tools:applied with toolbelt metadata', () => {
    const result = safeParseEforgeEvent({
      type: 'extension:agent-tools:applied',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionName: 'tool-ext',
      extensionPath: '/project/.eforge/extensions/tool-ext.ts',
      role: 'builder',
      tier: 'implementation',
      phase: 'build',
      stage: 'implement',
      profile: 'default',
      planId: 'plan-01',
      harness: 'claude-sdk',
      toolbelt: 'browser-ui',
      projectMcpSelection: 'toolbelt',
      projectMcpServerNames: ['filesystem'],
      toolNames: ['inspect_context'],
      effectiveToolNames: ['mcp__eforge_engine__inspect_context'],
      registeredToolNames: [],
      inlineToolNames: ['inspect_context'],
      allowedToolsAdded: ['Read'],
      disallowedToolsAdded: ['Write'],
      excludedToolNames: ['duplicate_tool'],
      toolCount: 1,
      allowedToolCount: 1,
      disallowedToolCount: 1,
      excludedToolCount: 1,
    });
    expect(result.success).toBe(true);
  });

  it('rejects extension:agent-tools:applied missing toolNames', () => {
    const result = safeParseEforgeEvent({
      type: 'extension:agent-tools:applied',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionName: 'tool-ext',
      extensionPath: '/project/.eforge/extensions/tool-ext.ts',
      role: 'builder',
      profile: 'default',
      effectiveToolNames: [],
      registeredToolNames: [],
      inlineToolNames: [],
      allowedToolsAdded: [],
      disallowedToolsAdded: [],
      excludedToolNames: [],
      toolCount: 0,
      allowedToolCount: 0,
      disallowedToolCount: 0,
      excludedToolCount: 0,
    });
    expect(result.success).toBe(false);
  });

  it('round-trips all five agent-context/tool variants through JSON', () => {
    const variants: import('../events.schemas.js').EforgeEvent[] = [
      {
        type: 'extension:agent-context:applied',
        timestamp: '2025-01-01T00:00:00.000Z',
        extensionName: 'my-ext',
        extensionPath: '/ext.ts',
        role: 'builder',
        tier: 'implementation',
        phase: 'build',
        stage: 'implement',
        profile: 'default',
        planId: 'plan-01',
        promptCharCount: 1000,
        fragmentCount: 1,
      },
      {
        type: 'extension:agent-context:failed',
        timestamp: '2025-01-01T00:00:00.000Z',
        extensionName: 'my-ext',
        extensionPath: '/ext.ts',
        role: 'builder',
        profile: 'default',
        message: 'boom',
      },
      {
        type: 'extension:agent-context:timeout',
        timestamp: '2025-01-01T00:00:00.000Z',
        extensionName: 'slow-ext',
        extensionPath: '/slow.ts',
        role: 'planner',
        profile: 'default',
        timeoutMs: 5000,
      },
      {
        type: 'extension:agent-context:unsupported',
        timestamp: '2025-01-01T00:00:00.000Z',
        extensionName: 'tool-ext',
        extensionPath: '/tool.ts',
        role: 'builder',
        profile: 'default',
        fields: ['tools'],
      },
      {
        type: 'extension:agent-tools:applied',
        timestamp: '2025-01-01T00:00:00.000Z',
        extensionName: 'tool-ext',
        extensionPath: '/tool.ts',
        role: 'builder',
        profile: 'default',
        toolNames: ['inspect_context'],
        effectiveToolNames: ['inspect_context'],
        registeredToolNames: [],
        inlineToolNames: ['inspect_context'],
        allowedToolsAdded: [],
        disallowedToolsAdded: [],
        excludedToolNames: [],
        toolCount: 1,
        allowedToolCount: 0,
        disallowedToolCount: 0,
        excludedToolCount: 0,
      },
    ];

    for (const event of variants) {
      const parsed = JSON.parse(JSON.stringify(event));
      expect(parsed).toEqual(event);
      const result = safeParseEforgeEvent(parsed);
      expect(result.success, `${event.type} should roundtrip through safeParseEforgeEvent`).toBe(true);
    }
  });
});

describe('eventRegistry — extension:agent-context:* diagnostics', () => {
  it('registers agent-context and agent-tools variants as session-scoped, non-persistent events', () => {
    expect(eventRegistry['extension:agent-context:applied']).toMatchObject({ scope: 'session', persist: false });
    expect(eventRegistry['extension:agent-context:failed']).toMatchObject({ scope: 'session', persist: false });
    expect(eventRegistry['extension:agent-context:timeout']).toMatchObject({ scope: 'session', persist: false });
    expect(eventRegistry['extension:agent-context:unsupported']).toMatchObject({ scope: 'session', persist: false });
    expect(eventRegistry['extension:agent-tools:applied']).toMatchObject({ scope: 'session', persist: false });
  });

  it('summary function for applied event includes extension name, char count, and role', () => {
    const event: import('../events.schemas.js').EforgeEvent = {
      type: 'extension:agent-context:applied',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionName: 'my-ext',
      extensionPath: '/ext.ts',
      role: 'builder',
      tier: 'implementation',
      profile: 'default',
      promptCharCount: 1234,
      fragmentCount: 1,
    };
    const summary = getEventSummary(event);
    expect(summary).toContain('my-ext');
    expect(summary).toContain('1234');
    expect(summary).toContain('builder');
  });

  it('summary function for failed event includes extension name, role, and message', () => {
    const event: import('../events.schemas.js').EforgeEvent = {
      type: 'extension:agent-context:failed',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionName: 'err-ext',
      extensionPath: '/err.ts',
      role: 'reviewer',
      profile: 'default',
      message: 'Handler exploded',
    };
    const summary = getEventSummary(event);
    expect(summary).toContain('err-ext');
    expect(summary).toContain('reviewer');
    expect(summary).toContain('Handler exploded');
  });

  it('summary function for timeout event includes extension name, timeoutMs, and role', () => {
    const event: import('../events.schemas.js').EforgeEvent = {
      type: 'extension:agent-context:timeout',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionName: 'slow-ext',
      extensionPath: '/slow.ts',
      role: 'planner',
      profile: 'default',
      timeoutMs: 3000,
    };
    const summary = getEventSummary(event);
    expect(summary).toContain('slow-ext');
    expect(summary).toContain('3000');
    expect(summary).toContain('planner');
  });

  it('summary function for tools-applied event includes extension name, role, accepted count, and excluded count', () => {
    const event: import('../events.schemas.js').EforgeEvent = {
      type: 'extension:agent-tools:applied',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionName: 'tool-ext',
      extensionPath: '/tool.ts',
      role: 'builder',
      profile: 'default',
      toolNames: ['inspect_context'],
      effectiveToolNames: ['inspect_context'],
      registeredToolNames: [],
      inlineToolNames: ['inspect_context'],
      allowedToolsAdded: [],
      disallowedToolsAdded: [],
      excludedToolNames: ['duplicate_tool'],
      toolCount: 1,
      allowedToolCount: 0,
      disallowedToolCount: 0,
      excludedToolCount: 1,
    };
    expect(isAlwaysYieldedAgentEvent(event)).toBe(true);
    const summary = getEventSummary(event);
    expect(summary).toContain('tool-ext');
    expect(summary).toContain('builder');
    expect(summary).toContain('1 accepted');
    expect(summary).toContain('1 excluded');
  });

  it('summary function for unsupported event includes extension name, role, and fields', () => {
    const event: import('../events.schemas.js').EforgeEvent = {
      type: 'extension:agent-context:unsupported',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionName: 'tool-ext',
      extensionPath: '/tool.ts',
      role: 'builder',
      profile: 'default',
      fields: ['tools', 'allowedTools'],
    };
    const summary = getEventSummary(event);
    expect(summary).toContain('tool-ext');
    expect(summary).toContain('builder');
    expect(summary).toContain('tools');
    expect(summary).toContain('allowedTools');
  });
});

// --- eforge:endregion plan-01-agent-context-runtime ---

// --- eforge:region plan-01-profile-router-events ---

// ---------------------------------------------------------------------------
// queue:profile:* variants (EXTEND_09)
// ---------------------------------------------------------------------------

describe('safeParseEforgeEvent — queue:profile:* variants', () => {
  it('accepts queue:profile:selected with required fields', () => {
    const result = safeParseEforgeEvent({
      type: 'queue:profile:selected',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-feature-auth',
      profile: 'premium',
      baseProfile: 'standard',
      routerName: 'cost-aware-router',
      extensionName: 'my-ext',
      extensionPath: '/project/.eforge/extensions/my-ext.ts',
    });
    expect(result.success).toBe(true);
  });

  it('accepts queue:profile:selected with all optional fields', () => {
    const result = safeParseEforgeEvent({
      type: 'queue:profile:selected',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-feature-auth',
      prdTitle: 'Add OAuth support',
      profile: 'premium',
      baseProfile: 'standard',
      routerName: 'cost-aware-router',
      extensionName: 'my-ext',
      extensionPath: '/project/.eforge/extensions/my-ext.ts',
      reason: 'high-priority build',
      confidence: 'high',
    });
    expect(result.success).toBe(true);
  });

  it('accepts queue:profile:selected with baseProfile: null', () => {
    const result = safeParseEforgeEvent({
      type: 'queue:profile:selected',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-feature-auth',
      profile: 'default',
      baseProfile: null,
      routerName: 'fallback-router',
      extensionName: 'my-ext',
      extensionPath: '/project/.eforge/extensions/my-ext.ts',
    });
    expect(result.success).toBe(true);
  });

  it('rejects queue:profile:selected missing routerName', () => {
    const result = safeParseEforgeEvent({
      type: 'queue:profile:selected',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-feature-auth',
      profile: 'premium',
      baseProfile: 'standard',
      extensionName: 'my-ext',
      extensionPath: '/project/.eforge/extensions/my-ext.ts',
    });
    expect(result.success).toBe(false);
  });

  it('accepts queue:profile:router-failed with required fields', () => {
    const result = safeParseEforgeEvent({
      type: 'queue:profile:router-failed',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-feature-auth',
      routerName: 'cost-aware-router',
      extensionName: 'my-ext',
      extensionPath: '/project/.eforge/extensions/my-ext.ts',
      message: 'Router threw an unexpected error',
    });
    expect(result.success).toBe(true);
  });

  it('accepts queue:profile:router-failed with optional stack', () => {
    const result = safeParseEforgeEvent({
      type: 'queue:profile:router-failed',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-feature-auth',
      routerName: 'cost-aware-router',
      extensionName: 'my-ext',
      extensionPath: '/project/.eforge/extensions/my-ext.ts',
      message: 'Router threw an unexpected error',
      stack: 'Error: Router threw\n    at handler (/ext.ts:5:10)',
    });
    expect(result.success).toBe(true);
  });

  it('rejects queue:profile:router-failed missing message', () => {
    const result = safeParseEforgeEvent({
      type: 'queue:profile:router-failed',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-feature-auth',
      routerName: 'cost-aware-router',
      extensionName: 'my-ext',
      extensionPath: '/project/.eforge/extensions/my-ext.ts',
    });
    expect(result.success).toBe(false);
  });

  it('accepts queue:profile:router-timeout with required fields', () => {
    const result = safeParseEforgeEvent({
      type: 'queue:profile:router-timeout',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-feature-auth',
      routerName: 'slow-router',
      extensionName: 'my-ext',
      extensionPath: '/project/.eforge/extensions/my-ext.ts',
      timeoutMs: 5000,
    });
    expect(result.success).toBe(true);
  });

  it('rejects queue:profile:router-timeout with non-integer timeoutMs', () => {
    const result = safeParseEforgeEvent({
      type: 'queue:profile:router-timeout',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-feature-auth',
      routerName: 'slow-router',
      extensionName: 'my-ext',
      extensionPath: '/project/.eforge/extensions/my-ext.ts',
      timeoutMs: '5000',
    });
    expect(result.success).toBe(false);
  });

  it('accepts queue:profile:invalid-selection with required fields', () => {
    const result = safeParseEforgeEvent({
      type: 'queue:profile:invalid-selection',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-feature-auth',
      routerName: 'misconfigured-router',
      extensionName: 'my-ext',
      extensionPath: '/project/.eforge/extensions/my-ext.ts',
      requestedProfile: 'nonexistent-profile',
      reason: 'not-found',
      message: 'Profile "nonexistent-profile" was not found in the active configuration',
    });
    expect(result.success).toBe(true);
  });

  it('accepts queue:profile:invalid-selection with reason: load-error', () => {
    const result = safeParseEforgeEvent({
      type: 'queue:profile:invalid-selection',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-feature-auth',
      routerName: 'misconfigured-router',
      extensionName: 'my-ext',
      extensionPath: '/project/.eforge/extensions/my-ext.ts',
      requestedProfile: 'bad-profile',
      reason: 'load-error',
      message: 'Profile "bad-profile" failed to load',
    });
    expect(result.success).toBe(true);
  });

  it('rejects queue:profile:invalid-selection with unknown reason literal', () => {
    const result = safeParseEforgeEvent({
      type: 'queue:profile:invalid-selection',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-feature-auth',
      routerName: 'misconfigured-router',
      extensionName: 'my-ext',
      extensionPath: '/project/.eforge/extensions/my-ext.ts',
      requestedProfile: 'some-profile',
      reason: 'invalid-reason',
      message: 'something went wrong',
    });
    expect(result.success).toBe(false);
  });
});

describe('eventRegistry — queue:profile:* diagnostics', () => {
  it('registers all four profile router events as session-scoped, non-persistent events', () => {
    expect(eventRegistry['queue:profile:selected']).toMatchObject({ scope: 'session', persist: false });
    expect(eventRegistry['queue:profile:router-failed']).toMatchObject({ scope: 'session', persist: false });
    expect(eventRegistry['queue:profile:router-timeout']).toMatchObject({ scope: 'session', persist: false });
    expect(eventRegistry['queue:profile:invalid-selection']).toMatchObject({ scope: 'session', persist: false });
  });

  it('summary for queue:profile:selected includes prdId, profile, extensionName, and routerName', () => {
    const event: EforgeEvent = {
      type: 'queue:profile:selected',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-auth',
      profile: 'premium',
      baseProfile: 'standard',
      routerName: 'cost-router',
      extensionName: 'billing-ext',
      extensionPath: '/ext.ts',
    };
    const summary = getEventSummary(event);
    expect(summary).toContain('prd-auth');
    expect(summary).toContain('premium');
    expect(summary).toContain('billing-ext');
    expect(summary).toContain('cost-router');
  });

  it('summary for queue:profile:selected includes reason when present', () => {
    const event: EforgeEvent = {
      type: 'queue:profile:selected',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-auth',
      profile: 'premium',
      baseProfile: null,
      routerName: 'cost-router',
      extensionName: 'billing-ext',
      extensionPath: '/ext.ts',
      reason: 'high priority task',
    };
    const summary = getEventSummary(event);
    expect(summary).toContain('high priority task');
  });

  it('safeParseEforgeEvent accepts queue:profile:selected and rejects one missing routerName', () => {
    const valid = safeParseEforgeEvent({
      type: 'queue:profile:selected',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-1',
      profile: 'default',
      baseProfile: null,
      routerName: 'my-router',
      extensionName: 'my-ext',
      extensionPath: '/ext.ts',
    });
    expect(valid.success).toBe(true);

    const invalid = safeParseEforgeEvent({
      type: 'queue:profile:selected',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-1',
      profile: 'default',
      baseProfile: null,
      // routerName intentionally omitted
      extensionName: 'my-ext',
      extensionPath: '/ext.ts',
    });
    expect(invalid.success).toBe(false);
  });
});

// --- eforge:endregion plan-01-profile-router-events ---

// --- eforge:region plan-02-build-evaluator-enforcement ---
describe('safeParseEforgeEvent — build evaluator enriched payloads', () => {
  it('accepts plan:build:evaluate:complete verdict summaries with hunk metadata', () => {
    const event: EforgeEvent = {
      type: 'plan:build:evaluate:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      accepted: 1,
      rejected: 1,
      verdicts: [
        { file: 'src/foo.ts', hunk: 1, action: 'accept', reason: 'Correct fix' },
        { file: 'src/foo.ts', hunk: 2, action: 'reject', reason: 'Alters intent' },
      ],
    };
    const result = safeParseEforgeEvent(event);
    expect(result.success).toBe(true);
  });

  it('accepts enriched cycle-terminated build decisions', () => {
    const event: EforgeEvent = {
      type: 'plan:build:decision',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      decision: {
        kind: 'cycle-terminated',
        rationale: 'Review cycle exhausted; final evaluation ran',
        round: 1,
        reason: 'max-rounds',
        issuesRemaining: 0,
        lastReviewIssueCount: 2,
        finalEvaluationRan: true,
        finalEvaluationAccepted: 1,
        finalEvaluationRejected: 1,
      },
    };
    const result = safeParseEforgeEvent(event);
    expect(result.success).toBe(true);
  });
});
// --- eforge:endregion plan-02-build-evaluator-enforcement ---
