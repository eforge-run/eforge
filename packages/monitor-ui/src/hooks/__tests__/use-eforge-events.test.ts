/**
 * Assert that invalidateOnEvent does NOT trigger SWR revalidation for the
 * orchestration cache key (the planning:complete and expedition:compile:complete
 * arms have been removed in plan-02-orchestration-single-source).
 *
 * The function is tested directly (it is exported from use-eforge-events.ts)
 * with swr mocked to capture mutate calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EforgeEvent } from '@eforge-build/client/browser';

// Mock swr before importing the module under test so the module's import of
// `mutate` resolves to our spy. vi.mock is hoisted by Vitest.
vi.mock('swr', () => ({
  mutate: vi.fn(),
}));

// Import mutate AFTER vi.mock so we get the mocked version.
const { mutate } = await import('swr');

// Import the function under test after mocks are set up.
const { invalidateOnEvent } = await import('../use-eforge-events');

describe('invalidateOnEvent does not trigger orchestration revalidation', () => {
  const SESSION_ID = 'session-test-abc123';

  beforeEach(() => {
    vi.mocked(mutate).mockClear();
  });

  it('does not call mutate with orchestration path on planning:complete', () => {
    const event: EforgeEvent = {
      type: 'planning:complete',
      timestamp: '2024-01-15T10:01:00.000Z',
      sessionId: SESSION_ID,
      plans: [
        { id: 'plan-01', name: 'Plan One', dependsOn: [], branch: 'b1', body: '', filePath: 'p1.md' },
        { id: 'plan-02', name: 'Plan Two', dependsOn: ['plan-01'], branch: 'b2', body: '', filePath: 'p2.md' },
      ],
    };

    invalidateOnEvent(event, SESSION_ID);

    const wasCalled = vi.mocked(mutate).mock.calls.some(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('/api/orchestration'),
    );
    expect(wasCalled).toBe(false);
  });

  it('does not call mutate with orchestration path on expedition:compile:complete', () => {
    const event: EforgeEvent = {
      type: 'expedition:compile:complete',
      timestamp: '2024-01-15T10:01:00.000Z',
      sessionId: SESSION_ID,
      plans: [
        { id: 'plan-01', name: 'Plan One', dependsOn: [], branch: 'b1', body: '', filePath: 'p1.md' },
      ],
    };

    invalidateOnEvent(event, SESSION_ID);

    const wasCalled = vi.mocked(mutate).mock.calls.some(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('/api/orchestration'),
    );
    expect(wasCalled).toBe(false);
  });

  it('does not call mutate with orchestration path when sessionId is null', () => {
    const event: EforgeEvent = {
      type: 'planning:complete',
      timestamp: '2024-01-15T10:01:00.000Z',
      sessionId: 'some-session',
      plans: [
        { id: 'plan-01', name: 'Plan One', dependsOn: [], branch: 'b1', body: '', filePath: 'p1.md' },
      ],
    };

    invalidateOnEvent(event, null);

    const wasCalled = vi.mocked(mutate).mock.calls.some(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('/api/orchestration'),
    );
    expect(wasCalled).toBe(false);
  });

  it('does not call mutate with orchestration path for unrelated events', () => {
    const event: EforgeEvent = {
      type: 'phase:start',
      timestamp: '2024-01-15T10:00:00.000Z',
      sessionId: SESSION_ID,
      runId: 'run-001',
      planSet: 'my-set',
      command: 'build',
    };

    invalidateOnEvent(event, SESSION_ID);

    const wasCalledWithOrchestation = vi.mocked(mutate).mock.calls.some(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('/api/orchestration'),
    );
    expect(wasCalledWithOrchestation).toBe(false);
  });
});
