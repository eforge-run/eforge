import type { RunInfo } from './types';

export interface SessionGroup {
  key: string;
  label: string;
  isSession: boolean;
  runs: RunInfo[];
  status: 'running' | 'failed' | 'completed';
  startedAt: string;
  completedAt?: string;
}

const commandOrder: Record<string, number> = { compile: 0, adopt: 0, run: 1, build: 2 };

function sortRuns(runs: RunInfo[]): RunInfo[] {
  return [...runs].sort((a, b) => {
    const ta = new Date(a.startedAt).getTime();
    const tb = new Date(b.startedAt).getTime();
    // Same timestamp bucket (within 1s) - sort compile before build
    if (Math.abs(ta - tb) < 1000) {
      return (commandOrder[a.command] ?? 9) - (commandOrder[b.command] ?? 9);
    }
    return ta - tb; // chronological within group
  });
}

function rollupStatus(runs: RunInfo[]): 'running' | 'failed' | 'completed' {
  if (runs.some((r) => r.status === 'running')) return 'running';
  if (runs.some((r) => r.status === 'failed')) return 'failed';
  return 'completed';
}

export function groupRunsBySessions(runs: RunInfo[]): SessionGroup[] {
  const sessionMap = new Map<string, RunInfo[]>();
  const planSetMap = new Map<string, RunInfo[]>();

  for (const run of runs) {
    if (run.sessionId) {
      if (!sessionMap.has(run.sessionId)) sessionMap.set(run.sessionId, []);
      sessionMap.get(run.sessionId)!.push(run);
    } else {
      const key = run.planSet || 'unknown';
      if (!planSetMap.has(key)) planSetMap.set(key, []);
      planSetMap.get(key)!.push(run);
    }
  }

  const groups: SessionGroup[] = [];

  for (const [sessionId, sessionRuns] of sessionMap) {
    const sorted = sortRuns(sessionRuns);
    const startedAt = sorted[0].startedAt;
    const completedRuns = sorted.filter((r) => r.completedAt);
    const completedAt = completedRuns.length === sorted.length
      ? completedRuns.reduce((latest, r) => {
          const t = new Date(r.completedAt!).getTime();
          return t > new Date(latest).getTime() ? r.completedAt! : latest;
        }, completedRuns[0].completedAt!)
      : undefined;

    groups.push({
      key: sessionId,
      label: sorted[0].planSet || 'unknown',
      isSession: true,
      runs: sorted,
      status: rollupStatus(sorted),
      startedAt,
      completedAt,
    });
  }

  for (const [planSet, planSetRuns] of planSetMap) {
    const sorted = sortRuns(planSetRuns);
    const startedAt = sorted[0].startedAt;
    const completedRuns = sorted.filter((r) => r.completedAt);
    const completedAt = completedRuns.length === sorted.length && completedRuns.length > 0
      ? completedRuns.reduce((latest, r) => {
          const t = new Date(r.completedAt!).getTime();
          return t > new Date(latest).getTime() ? r.completedAt! : latest;
        }, completedRuns[0].completedAt!)
      : undefined;

    groups.push({
      key: planSet,
      label: planSet,
      isSession: false,
      runs: sorted,
      status: rollupStatus(sorted),
      startedAt,
      completedAt,
    });
  }

  // Sort groups newest-first
  groups.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  return groups;
}
