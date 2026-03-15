import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { RunInfo } from '@/lib/types';
import { useApi } from '@/hooks/use-api';
import { RunItem } from './run-item';

interface SidebarProps {
  currentRunId: string | null;
  onSelectRun: (runId: string) => void;
  refreshTrigger: number;
}

interface PlanSetGroup {
  planSet: string;
  runs: RunInfo[];
}

function groupByPlanSet(runs: RunInfo[]): PlanSetGroup[] {
  const groups = new Map<string, RunInfo[]>();
  for (const run of runs) {
    const key = run.planSet || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(run);
  }
  // Sort runs within each group: plan before build, then chronological (newest first)
  const commandOrder: Record<string, number> = { plan: 0, run: 1, build: 2 };
  for (const groupRuns of groups.values()) {
    groupRuns.sort((a, b) => {
      const ta = new Date(a.startedAt).getTime();
      const tb = new Date(b.startedAt).getTime();
      // Same timestamp bucket (within 1s) — sort plan before build
      if (Math.abs(ta - tb) < 1000) {
        return (commandOrder[a.command] ?? 9) - (commandOrder[b.command] ?? 9);
      }
      return tb - ta; // newest first
    });
  }
  // Sort groups by most recent run (newest group first)
  const sorted = [...groups.entries()].sort((a, b) => {
    const latestA = new Date(a[1][0].startedAt).getTime();
    const latestB = new Date(b[1][0].startedAt).getTime();
    return latestB - latestA;
  });
  return sorted.map(([planSet, runs]) => ({ planSet, runs }));
}

function GroupHeader({ planSet, count, isExpanded, onToggle }: {
  planSet: string;
  count: number;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className="w-full text-left flex items-center gap-1 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-dim/70 hover:text-text-dim cursor-pointer bg-transparent border-none"
      onClick={onToggle}
    >
      {isExpanded
        ? <ChevronDown className="w-3 h-3 flex-shrink-0" />
        : <ChevronRight className="w-3 h-3 flex-shrink-0" />
      }
      <span className="truncate">{planSet}</span>
      <span className="text-text-dim/50 ml-auto">{count}</span>
    </button>
  );
}

export function Sidebar({ currentRunId, onSelectRun, refreshTrigger }: SidebarProps) {
  const { data: runs, refetch } = useApi<RunInfo[]>('/api/runs');

  // Refetch when trigger changes
  useEffect(() => {
    if (refreshTrigger > 0) {
      refetch();
    }
  }, [refreshTrigger, refetch]);

  const groups = useMemo(() => groupByPlanSet(runs ?? []), [runs]);

  // Track which groups are expanded — default: first group expanded
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (groups.length > 0 && expandedGroups.size === 0) {
      setExpandedGroups(new Set([groups[0].planSet]));
    }
  }, [groups]);

  // Also expand the group containing the current run
  useEffect(() => {
    if (currentRunId && groups.length > 0) {
      const group = groups.find((g) => g.runs.some((r) => r.id === currentRunId));
      if (group && !expandedGroups.has(group.planSet)) {
        setExpandedGroups((prev) => new Set([...prev, group.planSet]));
      }
    }
  }, [currentRunId, groups]);

  const toggleGroup = (planSet: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(planSet)) {
        next.delete(planSet);
      } else {
        next.add(planSet);
      }
      return next;
    });
  };

  return (
    <aside className="bg-card border-r border-border overflow-y-auto px-3 py-3">
      <h2 className="text-[11px] uppercase tracking-wider text-text-dim px-2 py-1.5 mb-1">
        Runs
      </h2>
      {groups.map((group) => (
        <div key={group.planSet} className="mb-1">
          <GroupHeader
            planSet={group.planSet}
            count={group.runs.length}
            isExpanded={expandedGroups.has(group.planSet)}
            onToggle={() => toggleGroup(group.planSet)}
          />
          {expandedGroups.has(group.planSet) && (
            <div className="ml-1">
              {group.runs.map((run) => (
                <RunItem
                  key={run.id}
                  run={run}
                  isActive={run.id === currentRunId}
                  onSelect={onSelectRun}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </aside>
  );
}
