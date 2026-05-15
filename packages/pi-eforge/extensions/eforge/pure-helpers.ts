/**
 * Pure, Pi-framework-free helpers for multi-build status formatting.
 *
 * Kept in a separate module so they can be unit-tested without loading the
 * Pi extension runtime (which has peer-dep imports that are not available in
 * the test environment).
 */

import type { RunSummary, RunInfo, QueueItem } from '@eforge-build/client';

export function truncateStatusPart(value: string, max = 36): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

/**
 * Format the Pi footer status line for a single running build.
 * The plan denominator is `summary.plans.length` — all plans (pending,
 * running, completed, failed) count toward the total so users can see
 * overall build scope, not just work in progress.
 */
export function formatSingleBuildFooter(summary: RunSummary): string {
  const parts: string[] = ['eforge build: running'];

  const activityParts = [summary.currentPhase, summary.currentAgent]
    .filter((part): part is string => Boolean(part));
  let activity = activityParts.join(' › ');
  if (!activity) {
    const runningPlan = summary.plans.find((plan) => plan.status === 'running');
    const runningRun = summary.runs.find((run) => run.status === 'running');
    activity = runningPlan?.id ?? runningRun?.command ?? '';
  }
  if (activity) parts.push(truncateStatusPart(activity));

  if (summary.plans.length > 0) {
    const complete = summary.plans.filter((plan) => plan.status === 'completed').length;
    parts.push(`${complete}/${summary.plans.length} plans`);
  }

  if (summary.eventCounts.errors > 0) {
    parts.push(`${summary.eventCounts.errors} errors`);
  }

  if (summary.duration.seconds != null) {
    parts.push(formatDuration(summary.duration.seconds));
  }

  return parts.join(' - ');
}

export function formatQueueFooter(queueItems: QueueItem[], hasRunningBuild: boolean): string | undefined {
  const visibleItems = hasRunningBuild
    ? queueItems.filter((item) => item.status !== 'running')
    : queueItems;
  if (visibleItems.length === 0) return undefined;

  const counts = new Map<string, number>();
  for (const item of visibleItems) {
    counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  }

  const preferredOrder = ['running', 'pending', 'waiting', 'failed', 'skipped'];
  const parts: string[] = [];
  for (const status of preferredOrder) {
    const count = counts.get(status);
    if (count) parts.push(`${count} ${status}`);
  }
  for (const [status, count] of counts) {
    if (!preferredOrder.includes(status)) parts.push(`${count} ${status}`);
  }

  return `eforge queue: ${parts.join(', ')}`;
}

export interface RunningSummariesAggregate {
  runningCount: number;
  totalPlans: number;
  completedPlans: number;
  activePlans: number;
  /** ISO timestamp of the oldest still-running build's startedAt, or null if none. */
  oldestStartedAt: string | null;
  totalErrors: number;
}

/**
 * Aggregate multiple concurrent running session summaries into a single
 * statistics object for display in the Pi footer.
 */
export function aggregateRunningSummaries(
  summaries: Array<{ run: RunInfo; summary: RunSummary }>,
): RunningSummariesAggregate {
  if (summaries.length === 0) {
    return {
      runningCount: 0,
      totalPlans: 0,
      completedPlans: 0,
      activePlans: 0,
      oldestStartedAt: null,
      totalErrors: 0,
    };
  }

  let totalPlans = 0;
  let completedPlans = 0;
  let activePlans = 0;
  let oldestStartedAt: string | null = null;
  let totalErrors = 0;

  for (const { summary } of summaries) {
    totalPlans += summary.plans.length;
    completedPlans += summary.plans.filter((p) => p.status === 'completed').length;
    activePlans += summary.plans.filter((p) => p.status === 'running').length;
    totalErrors += summary.eventCounts.errors;

    const startedAt = summary.duration.startedAt;
    if (startedAt !== null) {
      if (oldestStartedAt === null || startedAt < oldestStartedAt) {
        oldestStartedAt = startedAt;
      }
    }
  }

  return {
    runningCount: summaries.length,
    totalPlans,
    completedPlans,
    activePlans,
    oldestStartedAt,
    totalErrors,
  };
}

/**
 * Format the Pi footer status line for multiple concurrently running builds.
 * Duration anchors on the *oldest* still-running build so the displayed
 * elapsed time increases monotonically even as new builds start.
 */
export function formatAggregateFooter(summaries: Array<{ run: RunInfo; summary: RunSummary }>): string {
  const agg = aggregateRunningSummaries(summaries);

  let durationPart = '';
  if (agg.oldestStartedAt) {
    const elapsedMs = Date.now() - new Date(agg.oldestStartedAt).getTime();
    const elapsedSeconds = Math.round(elapsedMs / 1000);
    durationPart = ` - ${formatDuration(elapsedSeconds)}`;
  }

  return `eforge builds: ${agg.runningCount} running - ${agg.completedPlans}/${agg.totalPlans} plans - ${agg.activePlans} active${durationPart}`;
}

/**
 * Returns a user-facing message when active builds block a daemon stop,
 * or null when no builds are running.
 * Canonical version — the MCP proxy mirrors this logic inline.
 */
export function checkActiveBuildsMessage(runs: RunInfo[]): string | null {
  if (runs.length === 0) return null;
  if (runs.length === 1) {
    return 'An eforge build is currently active. Use force: true to stop anyway.';
  }
  return `${runs.length} eforge builds are currently active. Use force: true to stop anyway.`;
}
