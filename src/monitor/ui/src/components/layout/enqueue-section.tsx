import { useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { CheckCircle2, XCircle, Loader2, ChevronRight } from 'lucide-react';
import type { SessionGroup } from '@/lib/session-utils';
import { formatRelativeTime, formatRunDuration } from '@/lib/format';
import { cn } from '@/lib/utils';

const MAX_DISPLAY = 20;

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

interface EnqueueSectionProps {
  groups: SessionGroup[];
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
}

export function EnqueueSection({ groups, currentSessionId, onSelectSession }: EnqueueSectionProps) {
  const [open, setOpen] = useState(true);

  if (groups.length === 0) return null;

  const displayed = groups.slice(0, MAX_DISPLAY);

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="mb-3">
      <Collapsible.Trigger className="flex items-center justify-between w-full px-2 py-1.5 group">
        <div className="flex items-center gap-1.5">
          <ChevronRight
            className={cn(
              'w-3 h-3 text-text-dim transition-transform',
              open && 'rotate-90',
            )}
          />
          <span className="text-[11px] uppercase tracking-wider text-text-dim">
            Enqueuing
          </span>
        </div>
        <span className="text-[10px] text-text-dim/70 bg-bg-tertiary px-1.5 py-0.5 rounded-sm">
          {groups.length}
        </span>
      </Collapsible.Trigger>
      <Collapsible.Content>
        {displayed.map((group) => {
          const isActive = group.key === currentSessionId;
          const relative = formatRelativeTime(group.startedAt);
          const duration = formatRunDuration(group.startedAt, group.completedAt);

          return (
            <div
              key={group.key}
              className={cn(
                'px-2.5 py-2 rounded-md cursor-pointer mb-0.5 transition-colors',
                'hover:bg-bg-tertiary',
                isActive && 'bg-bg-tertiary ring-1 ring-cyan/40',
              )}
              onClick={() => onSelectSession(group.key)}
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
                    <span className="text-[11px] text-text-dim">{relative}</span>
                  </div>
                  <div className="mt-1">
                    <span className="text-[11px] text-text-dim whitespace-nowrap">{duration}</span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
