import { useMemo } from 'react';
import { usePlanPreview } from '@/components/preview';
import { formatDuration } from '@/lib/format';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { AgentThread } from '@/lib/reducer';
import type { PipelineStage, ReviewIssue } from '@/lib/types';

const REVIEW_AGENTS = new Set([
  'reviewer', 'plan-reviewer', 'cohesion-reviewer',
  'evaluator', 'plan-evaluator', 'cohesion-evaluator',
]);

/** Map agent roles to pipeline-stage color classes */
const AGENT_COLORS: Record<string, { bg: string; border: string }> = {
  planner:             { bg: 'bg-yellow/30',  border: 'border-yellow/50' },
  assessor:            { bg: 'bg-yellow/30',  border: 'border-yellow/50' },
  'module-planner':    { bg: 'bg-yellow/30',  border: 'border-yellow/50' },
  builder:             { bg: 'bg-blue/30',    border: 'border-blue/50' },
  reviewer:            { bg: 'bg-green/30',   border: 'border-green/50' },
  'plan-reviewer':     { bg: 'bg-green/30',   border: 'border-green/50' },
  'cohesion-reviewer': { bg: 'bg-green/30',   border: 'border-green/50' },
  evaluator:           { bg: 'bg-purple/30',  border: 'border-purple/50' },
  'plan-evaluator':    { bg: 'bg-purple/30',  border: 'border-purple/50' },
  'cohesion-evaluator':{ bg: 'bg-purple/30',  border: 'border-purple/50' },
  'validation-fixer':  { bg: 'bg-red/30',     border: 'border-red/50' },
};

const FALLBACK_COLOR = { bg: 'bg-cyan/30', border: 'border-cyan/50' };
const EMPTY_THREADS: AgentThread[] = [];

function getAgentColor(agent: string) {
  return AGENT_COLORS[agent] ?? FALLBACK_COLOR;
}

interface ThreadPipelineProps {
  agentThreads: AgentThread[];
  startTime: number | null;
  endTime: number | null;
  planStatuses: Record<string, PipelineStage>;
  reviewIssues?: Record<string, ReviewIssue[]>;
}

export function ThreadPipeline({ agentThreads, startTime, endTime, planStatuses, reviewIssues }: ThreadPipelineProps) {
  const entries = Object.entries(planStatuses);

  // Compute the time span across all threads
  const { sessionStart, totalSpan } = useMemo(() => {
    const fallbackNow = endTime ?? Date.now();
    const start = startTime ?? fallbackNow;
    let maxEnd = fallbackNow;
    for (const thread of agentThreads) {
      if (thread.endedAt) {
        const end = new Date(thread.endedAt).getTime();
        if (end > maxEnd) maxEnd = end;
      }
    }
    return { sessionStart: start, totalSpan: Math.max(maxEnd - start, 1) };
  }, [agentThreads, startTime, endTime]);

  // Group threads by planId (threads without planId go under a synthetic key)
  const threadsByPlan = useMemo(() => {
    const map = new Map<string, AgentThread[]>();
    for (const thread of agentThreads) {
      const key = thread.planId ?? '__global__';
      const arr = map.get(key);
      if (arr) {
        arr.push(thread);
      } else {
        map.set(key, [thread]);
      }
    }
    return map;
  }, [agentThreads]);

  const globalThreads = threadsByPlan.get('__global__') ?? EMPTY_THREADS;
  const hasGlobalThreads = globalThreads.length > 0;

  // Show nothing if there are no threads at all
  if (entries.length === 0 && !hasGlobalThreads) return null;

  return (
    <TooltipProvider delayDuration={0}>
      <div className="bg-card border border-border rounded-lg px-4 py-3 shadow-sm shadow-black/20">
        <h3 className="text-[11px] uppercase tracking-wider text-text-dim mb-2 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-blue" />
          Pipeline
        </h3>
        <div className="flex flex-col gap-1.5">
          {hasGlobalThreads && (
            <PlanRow
              key="__compile__"
              planId="Compile"
              threads={globalThreads}
              sessionStart={sessionStart}
              totalSpan={totalSpan}
              endTime={endTime}
              disablePreview
            />
          )}
          {entries.map(([planId]) => (
            <PlanRow
              key={planId}
              planId={planId}
              threads={threadsByPlan.get(planId) ?? EMPTY_THREADS}
              sessionStart={sessionStart}
              totalSpan={totalSpan}
              endTime={endTime}
              issues={reviewIssues?.[planId]}
            />
          ))}
        </div>
      </div>
    </TooltipProvider>
  );
}

interface PlanRowProps {
  planId: string;
  threads: AgentThread[];
  sessionStart: number;
  totalSpan: number;
  endTime: number | null;
  issues?: ReviewIssue[];
  disablePreview?: boolean;
}

function IssuesSummary({ issues }: { issues: ReviewIssue[] }) {
  const critical = issues.filter((i) => i.severity === 'critical').length;
  const warning = issues.filter((i) => i.severity === 'warning').length;
  const suggestion = issues.filter((i) => i.severity === 'suggestion').length;
  const parts: React.ReactNode[] = [];
  if (critical > 0) parts.push(<span key="c" className="text-red">{critical} critical</span>);
  if (warning > 0) parts.push(<span key="w" className="text-yellow">{warning} warning</span>);
  if (suggestion > 0) parts.push(<span key="s" className="text-text-dim">{suggestion} suggestion</span>);
  if (parts.length === 0) return null;
  return (
    <div className="text-[10px] mt-0.5 flex items-center gap-1">
      {parts.map((part, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <span className="opacity-30">·</span>}
          {part}
        </span>
      ))}
    </div>
  );
}

function PlanRow({ planId, threads, sessionStart, totalSpan, endTime, issues, disablePreview }: PlanRowProps) {
  const { openPreview } = usePlanPreview();

  const sortedThreads = useMemo(
    () => [...threads].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()),
    [threads],
  );

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-2 text-xs">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={`w-[140px] shrink-0 mt-0.5 text-text-dim overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] ${disablePreview ? '' : 'cursor-pointer hover:text-foreground hover:underline'}`}
              onClick={disablePreview ? undefined : () => openPreview(planId)}
            >
              {planId}
            </span>
          </TooltipTrigger>
          <TooltipContent side="left">{planId}</TooltipContent>
        </Tooltip>
        <div className="flex-1 bg-bg-tertiary rounded-sm overflow-x-clip flex flex-col gap-px py-px min-h-4">
          {sortedThreads.map((thread) => {
            const threadStart = new Date(thread.startedAt).getTime();
            const threadEnd = thread.endedAt
              ? new Date(thread.endedAt).getTime()
              : (endTime ?? Date.now());
            const leftPercent = Math.max(0, ((threadStart - sessionStart) / totalSpan) * 100);
            const widthPercent = Math.max(0, Math.min(((threadEnd - threadStart) / totalSpan) * 100, 100 - leftPercent));
            const isRunning = thread.endedAt === null;
            const color = getAgentColor(thread.agent);
            const duration = thread.durationMs != null
              ? formatDuration(thread.durationMs)
              : isRunning
                ? 'running...'
                : formatDuration(threadEnd - threadStart);

            return (
              <div key={thread.agentId} className="relative h-4">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div
                      className={`absolute inset-y-0 rounded-sm border ${color.bg} ${color.border} flex items-center overflow-hidden cursor-default`}
                      style={{
                        left: `${leftPercent}%`,
                        width: `max(2px, ${widthPercent}%)`,
                        animation: isRunning ? 'pulse-opacity 2s ease-in-out infinite' : undefined,
                      }}
                    >
                      <span className="text-[9px] truncate px-1 leading-4 text-foreground/70">
                        {thread.agent}
                      </span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    <div className="font-medium">{thread.agent}</div>
                    <div className="opacity-70">{duration}</div>
                    {REVIEW_AGENTS.has(thread.agent) && issues && issues.length > 0 && (
                      <IssuesSummary issues={issues} />
                    )}
                  </TooltipContent>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
