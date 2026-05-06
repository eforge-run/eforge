/**
 * Wire roundtrip tests for the 18 new daemon EforgeEvent variants added in the
 * plan-01-types-and-daemon-emission region of events.ts.
 *
 * Each fixture is statically typed as `EforgeEvent`, so field-name or type
 * drift surfaces as a TypeScript compile error rather than a runtime surprise.
 *
 * "Roundtrip" = JSON.stringify → JSON.parse → deep equality, which verifies:
 *   1. No non-JSON-safe values (Functions, Maps, Dates, undefined, etc.)
 *   2. No field silently dropped during serialisation.
 */

import { describe, it, expect } from 'vitest';
import type { EforgeEvent } from '../events.js';

// ---------------------------------------------------------------------------
// Fixtures — one per new daemon variant (all statically typed as EforgeEvent)
// ---------------------------------------------------------------------------

const variants: EforgeEvent[] = [
  // Daemon lifecycle
  {
    type: 'daemon:lifecycle:starting',
    timestamp: '2025-01-01T00:00:00.000Z',
    pid: 12345,
    port: 9000,
    version: '1.2.3',
    mode: 'auto',
  },
  {
    type: 'daemon:lifecycle:ready',
    timestamp: '2025-01-01T00:00:00.100Z',
    pid: 12345,
    port: 9000,
    version: '1.2.3',
    mode: 'auto',
    recoveryDurationMs: 42,
  },
  {
    type: 'daemon:lifecycle:shutdown:start',
    timestamp: '2025-01-01T01:00:00.000Z',
    signal: 'SIGTERM',
    reason: 'user requested shutdown',
  },
  {
    type: 'daemon:lifecycle:shutdown:complete',
    timestamp: '2025-01-01T01:00:00.250Z',
    durationMs: 250,
  },

  // Daemon heartbeat
  {
    type: 'daemon:heartbeat',
    timestamp: '2025-01-01T00:00:10.000Z',
    uptime: 10000,
    queueDepth: 2,
    runningBuilds: 1,
    autoBuild: { enabled: true, paused: false },
    subscribers: 3,
  },

  // Daemon scheduler
  {
    type: 'daemon:scheduler:dequeued',
    timestamp: '2025-01-01T00:01:00.000Z',
    prdId: 'my-prd-001',
    queueDepth: 1,
    capacityRemaining: 1,
  },
  {
    type: 'daemon:scheduler:capacity-blocked',
    timestamp: '2025-01-01T00:01:01.000Z',
    queueDepth: 3,
    runningCount: 2,
    limit: 2,
  },
  {
    type: 'daemon:scheduler:dependency-blocked',
    timestamp: '2025-01-01T00:01:02.000Z',
    prdId: 'dependent-prd',
    blockedBy: ['prd-a', 'prd-b'],
  },

  // Daemon auto-build extensions
  {
    type: 'daemon:auto-build:enabled',
    timestamp: '2025-01-01T00:02:00.000Z',
  },
  {
    type: 'daemon:auto-build:resumed',
    timestamp: '2025-01-01T00:02:01.000Z',
  },
  {
    type: 'daemon:auto-build:triggered',
    timestamp: '2025-01-01T00:02:02.000Z',
    trigger: 'file',
    prdsEnqueued: 2,
  },

  // Daemon recovery
  {
    type: 'daemon:recovery:start',
    timestamp: '2025-01-01T00:00:00.050Z',
  },
  {
    type: 'daemon:recovery:run-marked-failed',
    timestamp: '2025-01-01T00:00:00.060Z',
    runId: 'run-abc123',
    planSet: 'my-plan-set',
    reason: 'lock file found without live process',
  },
  {
    type: 'daemon:recovery:lock-removed',
    timestamp: '2025-01-01T00:00:00.070Z',
    path: '/project/.eforge/sessions/run-abc123.lock',
    pid: 99999,
  },
  {
    type: 'daemon:recovery:complete',
    timestamp: '2025-01-01T00:00:00.090Z',
    runsFailed: 1,
    locksRemoved: 1,
    durationMs: 40,
  },

  // Daemon orphan reaping
  {
    type: 'daemon:orphan:reaped',
    timestamp: '2025-01-01T00:10:00.000Z',
    runId: 'run-orphan-xyz',
    sessionId: 'sess-dead-789',
    planSet: 'orphaned-plan-set',
    pid: 77777,
  },

  // Daemon warning (with optional details)
  {
    type: 'daemon:warning',
    timestamp: '2025-01-01T00:05:00.000Z',
    source: 'scheduler',
    message: 'queue depth exceeded threshold',
    details: 'depth=10, threshold=5',
  },

  // Daemon error (with optional stack)
  {
    type: 'daemon:error',
    timestamp: '2025-01-01T00:06:00.000Z',
    source: 'session-runner',
    message: 'unhandled exception in build loop',
    stack: 'Error: unhandled exception\n    at buildLoop (runner.js:42:11)',
  },
];

// ---------------------------------------------------------------------------
// Expected type literals (hard-coded to the 18 new daemon variants)
// ---------------------------------------------------------------------------

const EXPECTED_LITERALS = new Set([
  'daemon:lifecycle:starting',
  'daemon:lifecycle:ready',
  'daemon:lifecycle:shutdown:start',
  'daemon:lifecycle:shutdown:complete',
  'daemon:heartbeat',
  'daemon:scheduler:dequeued',
  'daemon:scheduler:capacity-blocked',
  'daemon:scheduler:dependency-blocked',
  'daemon:auto-build:enabled',
  'daemon:auto-build:resumed',
  'daemon:auto-build:triggered',
  'daemon:recovery:start',
  'daemon:recovery:run-marked-failed',
  'daemon:recovery:lock-removed',
  'daemon:recovery:complete',
  'daemon:orphan:reaped',
  'daemon:warning',
  'daemon:error',
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EforgeEvent wire roundtrip', () => {
  it('roundtrips all 18 new daemon variants through JSON', () => {
    for (const event of variants) {
      const parsed = JSON.parse(JSON.stringify(event));
      expect(parsed).toEqual(event);
      expect(parsed.type).toBe(event.type);
    }
  });

  it('covers all 18 new daemon variant type literals', () => {
    const types = new Set(variants.map((e) => e.type));
    expect(types.size).toBe(18);
    expect(types).toEqual(EXPECTED_LITERALS);
  });
});
