// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { AgentDetailSheet } from '../agent-detail-sheet';

afterEach(cleanup);
import type { AgentThread, AgentActivityFacts, StoredEvent } from '@/lib/reducer';

function makeThread(overrides: Partial<AgentThread> = {}): AgentThread {
  return {
    agentId: 'agent-abc-123',
    agent: 'builder',
    planId: 'plan-01',
    startedAt: '2024-01-15T10:00:00.000Z',
    endedAt: '2024-01-15T10:05:00.000Z',
    durationMs: 300000,
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1500,
    cacheRead: 200,
    costUsd: 0.015,
    numTurns: 3,
    model: 'claude-sonnet-4-5',
    ...overrides,
  };
}

function makeActivity(overrides: Partial<AgentActivityFacts> = {}): AgentActivityFacts {
  return {
    attribution: 'exact',
    files: [
      { path: 'src/index.ts', additions: 10, deletions: 2 },
      { path: 'src/utils.ts', additions: 5, deletions: 0 },
    ],
    totals: { filesChanged: 2, additions: 15, deletions: 2 },
    ...overrides,
  };
}

describe('AgentDetailSheet', () => {
  it('drawer renders title containing agent role and plan id', () => {
    const thread = makeThread({ agent: 'builder', planId: 'plan-01' });
    render(
      <AgentDetailSheet thread={thread} events={[]} open={true} onClose={() => {}} />,
    );
    // The SheetContent title is "role · planId"
    expect(screen.getByText('builder · plan-01')).toBeTruthy();
  });

  it('result text longer than 600 chars renders a button labeled "Show more"', () => {
    const longText = 'a'.repeat(601);
    const thread = makeThread({ resultText: longText });
    render(
      <AgentDetailSheet thread={thread} events={[]} open={true} onClose={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy();
    // Only first 600 chars should be visible (plus ellipsis)
    expect(screen.queryByText(longText)).toBeFalsy();
  });

  it('attribution badge for "exact" contains the text "exact"', () => {
    const thread = makeThread({ activity: makeActivity({ attribution: 'exact' }) });
    render(
      <AgentDetailSheet thread={thread} events={[]} open={true} onClose={() => {}} />,
    );
    expect(screen.getByText('exact')).toBeTruthy();
  });

  it('attribution badge for "best_effort" contains the text "best_effort"', () => {
    const thread = makeThread({ activity: makeActivity({ attribution: 'best_effort' }) });
    render(
      <AgentDetailSheet thread={thread} events={[]} open={true} onClose={() => {}} />,
    );
    expect(screen.getByText('best_effort')).toBeTruthy();
  });

  it('activity totals render when activity is present', () => {
    const thread = makeThread({
      activity: makeActivity({
        attribution: 'exact',
        totals: { filesChanged: 3, additions: 20, deletions: 5 },
      }),
    });
    render(
      <AgentDetailSheet thread={thread} events={[]} open={true} onClose={() => {}} />,
    );
    // totals section should render filesChanged, +additions, -deletions
    const container = document.body;
    expect(container.textContent).toContain('3 files');
    expect(container.textContent).toContain('+20');
    expect(container.textContent).toContain('-5');
  });

  it('activity totals are omitted when activity is undefined', () => {
    const thread = makeThread({ activity: undefined });
    const { container } = render(
      <AgentDetailSheet thread={thread} events={[]} open={true} onClose={() => {}} />,
    );
    // "Files changed (deterministic)" section should not be rendered
    expect(within(container).queryByText('Files changed (deterministic)')).toBeFalsy();
  });

  it('does not render when thread is null', () => {
    const { container } = render(
      <AgentDetailSheet thread={null} events={[]} open={true} onClose={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('does not render sheet content when open is false', () => {
    const thread = makeThread();
    const { container } = render(
      <AgentDetailSheet thread={thread} events={[]} open={false} onClose={() => {}} />,
    );
    expect(within(container).queryByText('builder · plan-01')).toBeFalsy();
  });

  it('renders warning events for the matching agentId', () => {
    const thread = makeThread({ agentId: 'agent-abc-123' });
    const events: StoredEvent[] = [
      {
        eventId: 'ev1',
        event: {
          type: 'agent:warning',
          timestamp: '2024-01-15T10:01:00.000Z',
          sessionId: 's1',
          agentId: 'agent-abc-123',
          agent: 'builder',
          code: 'CONTEXT_LIMIT',
          message: 'Context approaching limit.',
        },
      },
    ];
    render(
      <AgentDetailSheet thread={thread} events={events} open={true} onClose={() => {}} />,
    );
    expect(screen.getByText(/CONTEXT_LIMIT/)).toBeTruthy();
    expect(screen.getByText(/Context approaching limit\./)).toBeTruthy();
  });
});
