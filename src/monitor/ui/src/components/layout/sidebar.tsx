import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Link2 } from 'lucide-react';
import type { RunInfo } from '@/lib/types';
import { useApi } from '@/hooks/use-api';
import { groupRunsBySessions, type SessionGroup } from '@/lib/session-utils';
import { RunItem } from './run-item';

interface SidebarProps {
  currentRunId: string | null;
  onSelectRun: (runId: string) => void;
  refreshTrigger: number;
}

function StatusDot({ status }: { status: SessionGroup['status'] }) {
  const color =
    status === 'running' ? 'bg-blue' :
    status === 'failed' ? 'bg-red' :
    'bg-green';
  return (
    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${color}`} />
  );
}

function GroupHeader({ group, isExpanded, onToggle }: {
  group: SessionGroup;
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
      {group.isSession && (
        <Link2 className="w-3 h-3 flex-shrink-0 text-cyan/70" />
      )}
      <span className="truncate">{group.label}</span>
      <StatusDot status={group.status} />
      <span className="text-text-dim/50 ml-auto">{group.runs.length}</span>
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

  const groups = useMemo(() => groupRunsBySessions(runs ?? []), [runs]);

  // Track which groups are expanded — default: first group expanded
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (groups.length > 0 && expandedGroups.size === 0) {
      setExpandedGroups(new Set([groups[0].key]));
    }
  }, [groups]);

  // Also expand the group containing the current run
  useEffect(() => {
    if (currentRunId && groups.length > 0) {
      const group = groups.find((g) => g.runs.some((r) => r.id === currentRunId));
      if (group && !expandedGroups.has(group.key)) {
        setExpandedGroups((prev) => new Set([...prev, group.key]));
      }
    }
  }, [currentRunId, groups]);

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
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
        <div key={group.key} className="mb-1">
          <GroupHeader
            group={group}
            isExpanded={expandedGroups.has(group.key)}
            onToggle={() => toggleGroup(group.key)}
          />
          {expandedGroups.has(group.key) && (
            <div className="ml-1">
              {group.runs.map((run) => (
                <RunItem
                  key={run.id}
                  run={run}
                  isActive={run.id === currentRunId}
                  onSelect={onSelectRun}
                  compact={group.isSession}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </aside>
  );
}
