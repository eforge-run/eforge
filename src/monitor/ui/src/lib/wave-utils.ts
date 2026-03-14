import type { EforgeEvent } from './types';
import type { StoredEvent } from './reducer';
import type { PipelineStage } from './types';

export interface WaveInfo {
  wave: number;
  planIds: string[];
}

export type WaveStatus = 'pending' | 'running' | 'complete' | 'failed';

export interface PartitionedEvents {
  preWave: StoredEvent[];
  waveEvents: Map<number, StoredEvent[]>;
  postWave: StoredEvent[];
}

/**
 * Partitions events into pre-wave, per-wave buckets, and post-wave sections.
 * Events with a planId are assigned to the wave containing that plan.
 * Events without a planId are assigned based on their position relative to wave boundaries.
 */
export function partitionEventsByWave(
  events: StoredEvent[],
  waves: WaveInfo[],
): PartitionedEvents {
  if (waves.length === 0) {
    return { preWave: [...events], waveEvents: new Map(), postWave: [] };
  }

  // Build planId → wave number lookup
  const planToWave = new Map<string, number>();
  for (const wave of waves) {
    for (const planId of wave.planIds) {
      planToWave.set(planId, wave.wave);
    }
  }

  // Initialize wave buckets
  const waveEvents = new Map<number, StoredEvent[]>();
  for (const wave of waves) {
    waveEvents.set(wave.wave, []);
  }

  const preWave: StoredEvent[] = [];
  const postWave: StoredEvent[] = [];

  // Track which zone we're in
  let firstWaveStartSeen = false;
  let lastWaveCompleteSeen = false;

  // Track completed waves incrementally (no look-ahead)
  const completedWaves = new Set<number>();

  for (const storedEvent of events) {
    const event = storedEvent.event;

    // Track zone transitions
    if (event.type === 'wave:start' && !firstWaveStartSeen) {
      firstWaveStartSeen = true;
    }

    // Check for last wave completion (incrementally, no look-ahead)
    if (event.type === 'wave:complete') {
      completedWaves.add(event.wave);
      if (completedWaves.size === waves.length) {
        lastWaveCompleteSeen = true;
      }
    }

    // Try to assign by planId first
    const planId = 'planId' in event ? (event as { planId?: string }).planId : undefined;
    if (planId && planToWave.has(planId)) {
      const waveNum = planToWave.get(planId)!;
      waveEvents.get(waveNum)!.push(storedEvent);
      continue;
    }

    // wave:start and wave:complete go into their wave bucket
    if (event.type === 'wave:start') {
      waveEvents.get(event.wave)!.push(storedEvent);
      continue;
    }
    if (event.type === 'wave:complete') {
      waveEvents.get(event.wave)!.push(storedEvent);
      continue;
    }

    // Post-wave events: merge, validation, eforge:end after all waves complete
    if (lastWaveCompleteSeen) {
      postWave.push(storedEvent);
      continue;
    }

    // Pre-wave events: before first wave:start
    if (!firstWaveStartSeen) {
      preWave.push(storedEvent);
      continue;
    }

    // Events during wave execution with no planId — assign to pre-wave zone as fallback
    // (e.g., agent events without a planId during wave execution)
    preWave.push(storedEvent);
  }

  return { preWave, waveEvents, postWave };
}

/**
 * Derives aggregate wave status from constituent plan statuses.
 * all complete → "complete", any failed → "failed", any running → "running", otherwise "pending"
 */
export function computeWaveStatus(
  wave: WaveInfo,
  planStatuses: Record<string, PipelineStage>,
): WaveStatus {
  const statuses = wave.planIds.map((id) => planStatuses[id]);

  if (statuses.some((s) => s === 'failed')) return 'failed';
  if (statuses.every((s) => s === 'complete')) return 'complete';
  if (statuses.some((s) => s === 'implement' || s === 'review' || s === 'evaluate')) return 'running';
  return 'pending';
}

/**
 * Returns true if wave data is present (convenience for conditional rendering).
 */
export function isMultiPlanRun(waves: WaveInfo[]): boolean {
  return waves.length > 0;
}
