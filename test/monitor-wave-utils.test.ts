import { describe, it, expect } from 'vitest';
import {
  partitionEventsByWave,
  computeWaveStatus,
  isMultiPlanRun,
  type WaveInfo,
} from '../src/monitor/ui/src/lib/wave-utils';
import type { StoredEvent } from '../src/monitor/ui/src/lib/reducer';
import type { EforgeEvent } from '../src/engine/events';

function makeStoredEvent(event: EforgeEvent, eventId: string): StoredEvent {
  return { event, eventId };
}

describe('partitionEventsByWave', () => {
  it('puts all events in preWave when no waves exist', () => {
    const events: StoredEvent[] = [
      makeStoredEvent({ type: 'eforge:start', runId: 'r1', planSet: 'test', command: 'build', timestamp: '2024-01-01T00:00:00Z' }, '1'),
      makeStoredEvent({ type: 'plan:start', source: 'test.md' }, '2'),
      makeStoredEvent({ type: 'plan:complete', plans: [] }, '3'),
    ];

    const result = partitionEventsByWave(events, []);
    expect(result.preWave).toHaveLength(3);
    expect(result.waveEvents.size).toBe(0);
    expect(result.postWave).toHaveLength(0);
  });

  it('partitions events with a single wave', () => {
    const waves: WaveInfo[] = [{ wave: 1, planIds: ['plan-01', 'plan-02'] }];

    const events: StoredEvent[] = [
      makeStoredEvent({ type: 'eforge:start', runId: 'r1', planSet: 'test', command: 'build', timestamp: '2024-01-01T00:00:00Z' }, '1'),
      makeStoredEvent({ type: 'plan:complete', plans: [] }, '2'),
      makeStoredEvent({ type: 'wave:start', wave: 1, planIds: ['plan-01', 'plan-02'] }, '3'),
      makeStoredEvent({ type: 'build:start', planId: 'plan-01' }, '4'),
      makeStoredEvent({ type: 'build:start', planId: 'plan-02' }, '5'),
      makeStoredEvent({ type: 'build:complete', planId: 'plan-01' }, '6'),
      makeStoredEvent({ type: 'build:complete', planId: 'plan-02' }, '7'),
      makeStoredEvent({ type: 'wave:complete', wave: 1 }, '8'),
      makeStoredEvent({ type: 'merge:start', planId: 'plan-01' }, '9'),
      makeStoredEvent({ type: 'merge:complete', planId: 'plan-01' }, '10'),
    ];

    const result = partitionEventsByWave(events, waves);

    // Pre-wave: eforge:start, plan:complete
    expect(result.preWave).toHaveLength(2);
    expect(result.preWave[0].event.type).toBe('eforge:start');
    expect(result.preWave[1].event.type).toBe('plan:complete');

    // Wave 1: wave:start, 2x build:start, 2x build:complete, wave:complete + 2 merge events
    // Merge events have planId matching wave plans, so they get assigned to the wave bucket
    const wave1Events = result.waveEvents.get(1)!;
    expect(wave1Events).toHaveLength(8);

    // Post-wave: empty (merge events have planId so they go to wave bucket)
    expect(result.postWave).toHaveLength(0);
  });

  it('partitions events with multiple waves', () => {
    const waves: WaveInfo[] = [
      { wave: 1, planIds: ['plan-01'] },
      { wave: 2, planIds: ['plan-02', 'plan-03'] },
    ];

    const events: StoredEvent[] = [
      makeStoredEvent({ type: 'plan:start', source: 'test.md' }, '1'),
      makeStoredEvent({ type: 'wave:start', wave: 1, planIds: ['plan-01'] }, '2'),
      makeStoredEvent({ type: 'build:start', planId: 'plan-01' }, '3'),
      makeStoredEvent({ type: 'build:complete', planId: 'plan-01' }, '4'),
      makeStoredEvent({ type: 'wave:complete', wave: 1 }, '5'),
      makeStoredEvent({ type: 'wave:start', wave: 2, planIds: ['plan-02', 'plan-03'] }, '6'),
      makeStoredEvent({ type: 'build:start', planId: 'plan-02' }, '7'),
      makeStoredEvent({ type: 'build:start', planId: 'plan-03' }, '8'),
      makeStoredEvent({ type: 'build:complete', planId: 'plan-02' }, '9'),
      makeStoredEvent({ type: 'build:complete', planId: 'plan-03' }, '10'),
      makeStoredEvent({ type: 'wave:complete', wave: 2 }, '11'),
      makeStoredEvent({ type: 'validation:start', commands: ['pnpm test'] }, '12'),
      makeStoredEvent({ type: 'eforge:end', runId: 'r1', result: { status: 'completed', summary: 'done' }, timestamp: '2024-01-01T00:01:00Z' }, '13'),
    ];

    const result = partitionEventsByWave(events, waves);

    // Pre-wave
    expect(result.preWave).toHaveLength(1);
    expect(result.preWave[0].event.type).toBe('plan:start');

    // Wave 1: wave:start + build:start + build:complete + wave:complete
    const wave1 = result.waveEvents.get(1)!;
    expect(wave1).toHaveLength(4);

    // Wave 2: wave:start + 2x build:start + 2x build:complete + wave:complete
    const wave2 = result.waveEvents.get(2)!;
    expect(wave2).toHaveLength(6);

    // Post-wave: validation:start + eforge:end
    expect(result.postWave).toHaveLength(2);
    expect(result.postWave[0].event.type).toBe('validation:start');
    expect(result.postWave[1].event.type).toBe('eforge:end');
  });

  it('assigns events without planId to pre-wave when before first wave', () => {
    const waves: WaveInfo[] = [{ wave: 1, planIds: ['plan-01'] }];

    const events: StoredEvent[] = [
      makeStoredEvent({ type: 'plan:scope', assessment: 'expedition', justification: 'big' }, '1'),
      makeStoredEvent({ type: 'expedition:architecture:complete', modules: [] }, '2'),
      makeStoredEvent({ type: 'wave:start', wave: 1, planIds: ['plan-01'] }, '3'),
      makeStoredEvent({ type: 'build:start', planId: 'plan-01' }, '4'),
      makeStoredEvent({ type: 'build:complete', planId: 'plan-01' }, '5'),
      makeStoredEvent({ type: 'wave:complete', wave: 1 }, '6'),
    ];

    const result = partitionEventsByWave(events, waves);
    expect(result.preWave).toHaveLength(2);
    expect(result.preWave[0].event.type).toBe('plan:scope');
    expect(result.preWave[1].event.type).toBe('expedition:architecture:complete');
  });

  it('handles merge/validation events in post-wave zone', () => {
    const waves: WaveInfo[] = [{ wave: 1, planIds: ['plan-01'] }];

    const events: StoredEvent[] = [
      makeStoredEvent({ type: 'wave:start', wave: 1, planIds: ['plan-01'] }, '1'),
      makeStoredEvent({ type: 'build:start', planId: 'plan-01' }, '2'),
      makeStoredEvent({ type: 'build:complete', planId: 'plan-01' }, '3'),
      makeStoredEvent({ type: 'wave:complete', wave: 1 }, '4'),
      makeStoredEvent({ type: 'validation:start', commands: ['pnpm test'] }, '5'),
      makeStoredEvent({ type: 'validation:complete', passed: true }, '6'),
    ];

    const result = partitionEventsByWave(events, waves);
    expect(result.postWave).toHaveLength(2);
    expect(result.postWave[0].event.type).toBe('validation:start');
    expect(result.postWave[1].event.type).toBe('validation:complete');
  });
});

describe('computeWaveStatus', () => {
  it('returns pending when no plan statuses exist', () => {
    const wave: WaveInfo = { wave: 1, planIds: ['plan-01', 'plan-02'] };
    expect(computeWaveStatus(wave, {})).toBe('pending');
  });

  it('returns running when any plan is in progress', () => {
    const wave: WaveInfo = { wave: 1, planIds: ['plan-01', 'plan-02'] };
    const statuses = { 'plan-01': 'implement' as const, 'plan-02': 'complete' as const };
    expect(computeWaveStatus(wave, statuses)).toBe('running');
  });

  it('returns complete when all plans are complete', () => {
    const wave: WaveInfo = { wave: 1, planIds: ['plan-01', 'plan-02'] };
    const statuses = { 'plan-01': 'complete' as const, 'plan-02': 'complete' as const };
    expect(computeWaveStatus(wave, statuses)).toBe('complete');
  });

  it('returns failed when any plan has failed', () => {
    const wave: WaveInfo = { wave: 1, planIds: ['plan-01', 'plan-02'] };
    const statuses = { 'plan-01': 'complete' as const, 'plan-02': 'failed' as const };
    expect(computeWaveStatus(wave, statuses)).toBe('failed');
  });

  it('returns failed even if some plans are still running', () => {
    const wave: WaveInfo = { wave: 1, planIds: ['plan-01', 'plan-02', 'plan-03'] };
    const statuses = {
      'plan-01': 'implement' as const,
      'plan-02': 'failed' as const,
      'plan-03': 'complete' as const,
    };
    expect(computeWaveStatus(wave, statuses)).toBe('failed');
  });

  it('returns running with review stage', () => {
    const wave: WaveInfo = { wave: 1, planIds: ['plan-01'] };
    const statuses = { 'plan-01': 'review' as const };
    expect(computeWaveStatus(wave, statuses)).toBe('running');
  });

  it('returns running with evaluate stage', () => {
    const wave: WaveInfo = { wave: 1, planIds: ['plan-01'] };
    const statuses = { 'plan-01': 'evaluate' as const };
    expect(computeWaveStatus(wave, statuses)).toBe('running');
  });
});

describe('isMultiPlanRun', () => {
  it('returns false for empty waves', () => {
    expect(isMultiPlanRun([])).toBe(false);
  });

  it('returns true when waves are present', () => {
    expect(isMultiPlanRun([{ wave: 1, planIds: ['plan-01'] }])).toBe(true);
  });
});
