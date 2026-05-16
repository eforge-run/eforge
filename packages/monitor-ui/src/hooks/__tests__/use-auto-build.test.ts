// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoBuild } from '../use-auto-build';
import { setAutoBuild, type AutoBuildState } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    setAutoBuild: vi.fn(),
  };
});

const mockedSetAutoBuild = vi.mocked(setAutoBuild);

function makeAutoBuild(overrides: Partial<AutoBuildState> = {}): AutoBuildState {
  return {
    enabled: true,
    watcher: { running: true, pid: 1234, sessionId: 'watcher-session-1' },
    desired: 'enabled',
    mode: 'running',
    scheduler: { alive: true, paused: false, lastMutationReason: 'enqueue' },
    lastTransition: {
      at: '2024-01-15T09:59:00.000Z',
      previousMode: 'starting',
      nextMode: 'running',
      desired: 'enabled',
      reason: 'startup complete',
      source: 'test',
    },
    reason: 'startup complete',
    ...overrides,
  };
}

describe('useAutoBuild', () => {
  beforeEach(() => {
    mockedSetAutoBuild.mockReset();
  });

  it('passes the enriched POST response to onUpdate so daemon state can be updated', async () => {
    const currentState = makeAutoBuild({ enabled: true });
    const responseState = makeAutoBuild({
      enabled: false,
      watcher: { running: false, pid: null, sessionId: null },
      desired: 'disabled',
      mode: 'disabled',
      scheduler: { alive: false, paused: false, lastMutationReason: 'manual toggle' },
      lastTransition: {
        at: '2024-01-15T10:05:00.000Z',
        previousMode: 'running',
        nextMode: 'disabled',
        desired: 'disabled',
        reason: 'manual toggle',
        source: 'http',
      },
      reason: 'manual toggle',
    });
    mockedSetAutoBuild.mockResolvedValue(responseState);
    const onUpdate = vi.fn();

    const { result } = renderHook(() => useAutoBuild(currentState, onUpdate));

    act(() => {
      result.current.toggle();
    });

    await waitFor(() => expect(result.current.toggling).toBe(false));

    expect(mockedSetAutoBuild).toHaveBeenCalledWith(false);
    expect(onUpdate).toHaveBeenCalledWith(responseState);
    expect(onUpdate.mock.calls[0][0].mode).toBe('disabled');
    expect(onUpdate.mock.calls[0][0].scheduler?.lastMutationReason).toBe('manual toggle');
    expect(onUpdate.mock.calls[0][0].lastTransition?.reason).toBe('manual toggle');
  });
});
