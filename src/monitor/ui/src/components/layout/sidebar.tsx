import { useEffect, useCallback } from 'react';
import type { RunInfo } from '@/lib/types';
import { useApi } from '@/hooks/use-api';
import { RunItem } from './run-item';

interface SidebarProps {
  currentRunId: string | null;
  onSelectRun: (runId: string) => void;
  refreshTrigger: number;
}

export function Sidebar({ currentRunId, onSelectRun, refreshTrigger }: SidebarProps) {
  const { data: runs, refetch } = useApi<RunInfo[]>('/api/runs');

  // Refetch when trigger changes
  useEffect(() => {
    if (refreshTrigger > 0) {
      refetch();
    }
  }, [refreshTrigger, refetch]);

  return (
    <aside className="bg-card border-r border-border overflow-y-auto p-2">
      <h2 className="text-[11px] uppercase tracking-wide text-text-dim px-2 py-2 pb-1">
        Runs
      </h2>
      {runs?.map((run) => (
        <RunItem
          key={run.id}
          run={run}
          isActive={run.id === currentRunId}
          onSelect={onSelectRun}
        />
      ))}
    </aside>
  );
}
