/**
 * Unit tests for `eventToProgress()` - the event-to-progress mapping the
 * `eforge_follow` MCP tool uses to convert daemon stream events into MCP
 * progress notifications.
 *
 * The mapping is intentionally narrow: only high-signal events
 * (`phase:start`, `phase:end`, `build:files_changed`, high/critical
 * `review:issue`, `build:failed`, `phase:error`) produce updates. Everything
 * else - especially the noisy `agent:*` event family - is filtered.
 */
import { describe, it, expect } from 'vitest';
import type { DaemonStreamEvent } from '@eforge-build/client';
import { eventToProgress, type FollowCounters } from '../packages/eforge/src/cli/mcp-proxy.js';

const emptyCounters: FollowCounters = { filesChanged: 0 };

describe('eventToProgress', () => {
  describe('phase events', () => {
    it('maps phase:start to a "Phase: ... starting" message', () => {
      const event: DaemonStreamEvent = { type: 'phase:start', phase: 'plan' };
      const result = eventToProgress(event, emptyCounters);
      expect(result).not.toBeNull();
      expect(result!.message).toMatch(/^Phase:/);
      expect(result!.message).toContain('plan');
      expect(result!.message).toContain('starting');
      expect(result!.counters).toEqual(emptyCounters);
    });

    it('maps phase:end to a "Phase: ... complete" message', () => {
      const event: DaemonStreamEvent = { type: 'phase:end', phase: 'build' };
      const result = eventToProgress(event, emptyCounters);
      expect(result).not.toBeNull();
      expect(result!.message).toMatch(/^Phase:/);
      expect(result!.message).toContain('build');
      expect(result!.message).toContain('complete');
    });

    it('falls back to "unknown" when no phase label is present', () => {
      const event: DaemonStreamEvent = { type: 'phase:start' };
      const result = eventToProgress(event, emptyCounters);
      expect(result).not.toBeNull();
      expect(result!.message).toContain('unknown');
    });
  });

  describe('plan:build:files_changed', () => {
    it('maps build:files_changed to a "Files changed: N" message', () => {
      const event: DaemonStreamEvent = {
        type: 'plan:build:files_changed',
        planId: 'plan-01',
        files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      };
      const result = eventToProgress(event, emptyCounters);
      expect(result).not.toBeNull();
      expect(result!.message).toContain('Files changed:');
      expect(result!.message).toContain('3');
      expect(result!.counters.filesChanged).toBe(3);
    });

    it('accumulates filesChanged across multiple events', () => {
      const first: DaemonStreamEvent = {
        type: 'plan:build:files_changed',
        files: ['a.ts', 'b.ts'],
      };
      const second: DaemonStreamEvent = {
        type: 'plan:build:files_changed',
        files: ['c.ts'],
      };
      const r1 = eventToProgress(first, emptyCounters)!;
      const r2 = eventToProgress(second, r1.counters)!;
      expect(r1.counters.filesChanged).toBe(2);
      expect(r2.counters.filesChanged).toBe(3);
    });
  });

  describe('review:issue severity filtering', () => {
    it('emits a message for high severity issues', () => {
      const event: DaemonStreamEvent = {
        type: 'review:issue',
        severity: 'high',
        summary: 'Missing error handling',
      };
      const result = eventToProgress(event, emptyCounters);
      expect(result).not.toBeNull();
      expect(result!.message).toContain('(high)');
      expect(result!.message).toContain('Missing error handling');
    });

    it('emits a message for critical severity issues', () => {
      const event: DaemonStreamEvent = {
        type: 'review:issue',
        severity: 'critical',
        summary: 'Secret leaked',
      };
      const result = eventToProgress(event, emptyCounters);
      expect(result).not.toBeNull();
      expect(result!.message).toContain('(critical)');
    });

    it('filters low severity issues (returns null)', () => {
      const event: DaemonStreamEvent = {
        type: 'review:issue',
        severity: 'low',
        summary: 'Minor nit',
      };
      expect(eventToProgress(event, emptyCounters)).toBeNull();
    });

    it('filters medium severity issues (returns null)', () => {
      const event: DaemonStreamEvent = {
        type: 'review:issue',
        severity: 'medium',
        summary: 'Nit',
      };
      expect(eventToProgress(event, emptyCounters)).toBeNull();
    });

    it('filters issues without a severity field', () => {
      const event: DaemonStreamEvent = { type: 'review:issue', summary: 'X' };
      expect(eventToProgress(event, emptyCounters)).toBeNull();
    });
  });

  describe('failure events', () => {
    it('maps build:failed to a "Build failed:" message', () => {
      const event: DaemonStreamEvent = {
        type: 'plan:build:failed',
        planId: 'plan-03',
        error: 'compilation error',
      };
      const result = eventToProgress(event, emptyCounters);
      expect(result).not.toBeNull();
      expect(result!.message).toMatch(/^Build failed:/);
      expect(result!.message).toContain('plan-03');
      expect(result!.message).toContain('compilation error');
    });

    it('maps phase:error to a "Phase error:" message', () => {
      const event: DaemonStreamEvent = {
        type: 'phase:error',
        error: 'unexpected exit',
      };
      const result = eventToProgress(event, emptyCounters);
      expect(result).not.toBeNull();
      expect(result!.message).toMatch(/^Phase error:/);
      expect(result!.message).toContain('unexpected exit');
    });
  });

  describe('filtered event families', () => {
    it('filters agent:* events (returns null)', () => {
      const types = [
        'agent:start',
        'agent:end',
        'agent:tool_call',
        'agent:message',
        'agent:thinking',
      ];
      for (const type of types) {
        const event: DaemonStreamEvent = { type, agent: 'builder' };
        expect(eventToProgress(event, emptyCounters)).toBeNull();
      }
    });

    it('filters unrecognized event types', () => {
      const event: DaemonStreamEvent = { type: 'session:heartbeat' };
      expect(eventToProgress(event, emptyCounters)).toBeNull();
    });

    it('filters events without a string type', () => {
      const event = { type: 123 } as unknown as DaemonStreamEvent;
      expect(eventToProgress(event, emptyCounters)).toBeNull();
    });
  });
});
