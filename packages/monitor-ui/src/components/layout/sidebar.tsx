import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, XCircle, Loader2, CircleStop, X } from 'lucide-react';
import type { RunInfo, SessionMetadata } from '@/lib/types';
import { useApi } from '@/hooks/use-api';
import { cancelSession } from '@/lib/api';
import { API_ROUTES } from '@eforge-build/client/browser';
import { groupRunsBySessions, partitionEnqueueSessions, type SessionGroup } from '@/lib/session-utils';
import { formatRelativeTime, formatRunDuration } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { QueueSection } from './queue-section';
import { EnqueueSection } from './enqueue-section';

interface SidebarProps {
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  refreshTrigger: number;
  daemonActive: boolean;
}

function StatusIcon({ status }: { status: SessionGroup['status'] }) {
  switch (status) {
    case 'running':
      return <Loader2 className="w-3.5 h-3.5 text-blue flex-shrink-0 animate-spin" />;
    case 'failed':
      return <XCircle className="w-3.5 h-3.5 text-red flex-shrink-0" />;
    case 'completed':
      return <CheckCircle2 className="w-3.5 h-3.5 text-green flex-shrink-0" />;
  }
}

export const profileBadgeClasses: Record<string, string> = {
  errand: 'bg-green/20 text-green border-green/30',
  excursion: 'bg-yellow/20 text-yellow border-yellow/30',
  expedition: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
};

function SessionItem({ group, isActive, onSelect, daemonActive, metadata }: {
  group: SessionGroup;
  isActive: boolean;
  onSelect: () => void;
  daemonActive: boolean;
  metadata?: SessionMetadata;
}) {
  const relative = formatRelativeTime(group.startedAt);
  const duration = formatRunDuration(group.startedAt, group.completedAt);
  const showCancel = group.status === 'running' && group.isSession && daemonActive;
  const isEnqueueOnly = group.runs.length > 0 && group.runs.every((r) => r.command === 'enqueue');

  return (
    <div
      className={cn(
        'px-2.5 py-2 rounded-md cursor-pointer mb-0.5 transition-colors',
        'hover:bg-bg-tertiary',
        isActive && 'bg-bg-tertiary ring-1 ring-cyan/40',
      )}
      onClick={onSelect}
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5">
          <StatusIcon status={group.status} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-foreground truncate">
              {group.label}
            </span>
            <div className="flex items-center gap-1.5">
              {showCancel && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      title="Cancel this session"
                      className="h-auto w-auto p-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <CircleStop size={14} />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent onClick={(e) => e.stopPropagation()}>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Cancel this build?</AlertDialogTitle>
                      <AlertDialogDescription>
                        The running worker will be terminated and any in-progress work will be lost.
                        Files staged in the worktree may remain.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep running</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        onClick={() => cancelSession(group.key)}
                      >
                        Cancel build
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
              <span className="text-[11px] text-text-dim">{relative}</span>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 mt-1">
            <span className="text-[11px] text-text-dim whitespace-nowrap">{duration}</span>
            <div className="flex items-center gap-1.5">
              {isEnqueueOnly && (
                <Badge
                  variant="outline"
                  className="text-[9px] px-1.5 py-0 rounded-sm font-medium bg-red/20 text-red border-red/30"
                >
                  enqueue
                </Badge>
              )}
              {metadata?.baseProfile && (
                <Badge
                  variant="outline"
                  className={cn(
                    'text-[9px] px-1.5 py-0 rounded-sm font-medium',
                    profileBadgeClasses[metadata.baseProfile] ?? 'bg-bg-tertiary text-text-dim border-border',
                  )}
                >
                  {metadata.baseProfile}
                </Badge>
              )}
              {metadata?.planCount != null && metadata.planCount > 0 && (
                <span className="text-[10px] text-text-dim/70 bg-bg-tertiary px-1.5 py-0.5 rounded-sm">
                  {metadata.planCount} {metadata.planCount === 1 ? 'plan' : 'plans'}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const PAGE_SIZE = 25;

export function Sidebar({ currentSessionId, onSelectSession, refreshTrigger, daemonActive }: SidebarProps) {
  const { data: runs, refetch } = useApi<RunInfo[]>(API_ROUTES.runs);
  const { data: metadataMap, refetch: refetchMetadata } = useApi<Record<string, SessionMetadata>>(API_ROUTES.sessionMetadata);
  const [searchQuery, setSearchQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Refetch when trigger changes
  useEffect(() => {
    if (refreshTrigger > 0) {
      refetch();
      refetchMetadata();
    }
  }, [refreshTrigger, refetch, refetchMetadata]);

  const allGroups = useMemo(() => groupRunsBySessions(runs ?? []), [runs]);
  const { enqueue: enqueueGroups, sessions: sessionGroups } = useMemo(
    () => partitionEnqueueSessions(allGroups),
    [allGroups],
  );

  const visibleGroups = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    // When searching, show all matches (no pagination)
    if (query) {
      return sessionGroups.filter((group) =>
        group.label.toLowerCase().includes(query),
      );
    }

    // Paginated view
    const sliced = sessionGroups.slice(0, visibleCount);

    // Ensure the currently selected session is always visible
    if (currentSessionId) {
      const isVisible = sliced.some((g) => g.key === currentSessionId);
      if (!isVisible) {
        const selected = sessionGroups.find((g) => g.key === currentSessionId);
        if (selected) {
          sliced.push(selected);
        }
      }
    }

    return sliced;
  }, [sessionGroups, searchQuery, visibleCount, currentSessionId]);

  const isSearching = searchQuery.trim().length > 0;
  const remainingCount = sessionGroups.length - visibleCount;
  const showMoreButton = !isSearching && remainingCount > 0;

  return (
    <aside className="bg-card border-r border-border overflow-y-auto px-3 py-3">
      <EnqueueSection
        groups={enqueueGroups}
        currentSessionId={currentSessionId}
        onSelectSession={onSelectSession}
      />
      <QueueSection refreshTrigger={refreshTrigger} />
      <div className="relative mb-2">
        <Input
          type="text"
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            if (!e.target.value.trim()) {
              setVisibleCount(PAGE_SIZE);
            }
          }}
          placeholder="Search builds..."
          className="h-8 text-xs pr-7"
        />
        {searchQuery && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => {
              setSearchQuery('');
              setVisibleCount(PAGE_SIZE);
            }}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 h-auto w-auto p-0"
          >
            <X size={12} />
          </Button>
        )}
      </div>
      {visibleGroups.map((group, index) => (
        <div key={group.key}>
          {index > 0 && <div className="border-t border-border/40 my-0.5" />}
          <SessionItem
            group={group}
            isActive={group.key === currentSessionId}
            onSelect={() => onSelectSession(group.key)}
            daemonActive={daemonActive}
            metadata={metadataMap?.[group.key]}
          />
        </div>
      ))}
      {showMoreButton && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}
          className="w-full mt-1"
        >
          Show {Math.min(PAGE_SIZE, remainingCount)} more ({remainingCount} remaining)
        </Button>
      )}
    </aside>
  );
}
