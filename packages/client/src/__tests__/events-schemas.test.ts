/**
 * Tests for the Zod-based wire event schemas introduced in plan-01-foundation.
 *
 * Validates:
 *   - EforgeEventSchema is exported from @eforge-build/client (AC #13)
 *   - EforgeEvent is z.infer-derived: Zod validates what TypeScript accepts (AC #3)
 *   - The 5 new event variants round-trip through JSON (AC #3)
 *   - Zod runtime validation accepts valid payloads and rejects invalid ones
 *   - agent:start thinkingCoerced/thinkingOriginal optional fields parse correctly (AC #8 precursor)
 *   - Unknown event types are rejected, not silently accepted
 *
 * All fixtures are statically typed as EforgeEvent so field drift surfaces as
 * a TypeScript compile error rather than a runtime surprise.
 */

import { describe, it, expect } from 'vitest';
import { EforgeEventSchema } from '../events.schemas.js';
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
// Zod schema validation — valid payloads
// ---------------------------------------------------------------------------

describe('EforgeEventSchema.safeParse — new variants', () => {
  it('accepts plan:status:change with every valid status value', () => {
    const statuses = ['pending', 'running', 'completed', 'failed', 'blocked', 'merged'] as const;
    for (const status of statuses) {
      const result = EforgeEventSchema.safeParse({
        type: 'plan:status:change',
        timestamp: '2025-01-01T00:00:00.000Z',
        planId: 'plan-01',
        status,
      });
      expect(result.success, `status '${status}' should be accepted`).toBe(true);
    }
  });

  it('accepts plan:error:set with required fields', () => {
    const result = EforgeEventSchema.safeParse({
      type: 'plan:error:set',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      error: 'Build timed out',
    });
    expect(result.success).toBe(true);
  });

  it('accepts plan:error:clear with only planId + timestamp', () => {
    const result = EforgeEventSchema.safeParse({
      type: 'plan:error:clear',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
    });
    expect(result.success).toBe(true);
  });

  it('accepts merge:worktree:set with path', () => {
    const result = EforgeEventSchema.safeParse({
      type: 'merge:worktree:set',
      timestamp: '2025-01-01T00:00:00.000Z',
      path: '/tmp/merge-worktree',
    });
    expect(result.success).toBe(true);
  });

  it('accepts merge:worktree:clear with only timestamp', () => {
    const result = EforgeEventSchema.safeParse({
      type: 'merge:worktree:clear',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional envelope fields (sessionId, runId)', () => {
    const result = EforgeEventSchema.safeParse({
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
});

// ---------------------------------------------------------------------------
// Zod schema validation — invalid payloads rejected
// ---------------------------------------------------------------------------

describe('EforgeEventSchema.safeParse — rejection of invalid payloads', () => {
  it('rejects plan:status:change with an invalid status value', () => {
    const result = EforgeEventSchema.safeParse({
      type: 'plan:status:change',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      status: 'not-a-real-status',
    });
    expect(result.success).toBe(false);
  });

  it('rejects plan:status:change missing planId', () => {
    const result = EforgeEventSchema.safeParse({
      type: 'plan:status:change',
      timestamp: '2025-01-01T00:00:00.000Z',
      status: 'running',
    });
    expect(result.success).toBe(false);
  });

  it('rejects plan:error:set missing error field', () => {
    const result = EforgeEventSchema.safeParse({
      type: 'plan:error:set',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
    });
    expect(result.success).toBe(false);
  });

  it('rejects merge:worktree:set missing path field', () => {
    const result = EforgeEventSchema.safeParse({
      type: 'merge:worktree:set',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an entirely unknown event type', () => {
    const result = EforgeEventSchema.safeParse({
      type: 'completely:unknown:event',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an event missing timestamp (required envelope field)', () => {
    const result = EforgeEventSchema.safeParse({
      type: 'plan:status:change',
      planId: 'plan-01',
      status: 'running',
    });
    expect(result.success).toBe(false);
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
    const result = EforgeEventSchema.safeParse(event);
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
    const result = EforgeEventSchema.safeParse({
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
// Schema-as-source-of-truth: Zod validation of pre-existing variants
// ---------------------------------------------------------------------------

describe('EforgeEventSchema.safeParse — pre-existing variant spot-checks', () => {
  it('accepts a well-formed session:start event', () => {
    const result = EforgeEventSchema.safeParse({
      type: 'session:start',
      timestamp: '2025-01-01T00:00:00.000Z',
      sessionId: 'sess-123',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a well-formed plan:build:failed event', () => {
    const result = EforgeEventSchema.safeParse({
      type: 'plan:build:failed',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      error: 'build failed',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a well-formed daemon:heartbeat event', () => {
    const result = EforgeEventSchema.safeParse({
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
});
