import { useMemo } from 'react';
import { usePlanPreview } from '@/components/preview';
import { formatDuration } from '@/lib/format';
import { ReviewGauge } from './review-gauge';
import type { AgentThread } from '@/lib/reducer';
import type { PipelineStage, ReviewIssue } from '@/lib/types';

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

function getAgentColor(agent: string) {
  return AGENT_COLORS[agent] ?? FALLBACK_COLOR;
}

interface ThreadPipelineProps {
  agentThreads: AgentThread[];
  startTime: number | null;
  planStatuses: Record<string, PipelineStage>;
  reviewIssues?: Record<string, ReviewIssue[]>;
}

export function ThreadPipeline({ agentThreads, startTime, planStatuses, reviewIssues }: ThreadPipelineProps) {
  const entries = Object.entries(planStatuses);

  // Compute the time span across all threads
  const { sessionStart, totalSpan } = useMemo(() => {
    const start = startTime ?? Date.now();
    let maxEnd = Date.now();
    for (const thread of agentThreads) {
      if (thread.endedAt) {
        const end = new Date(thread.endedAt).getTime();
        if (end > maxEnd) maxEnd = end;
      }
    }
    return { sessionStart: start, totalSpan: Math.max(maxEnd - start, 1) };
  }, [agentThreads, startTime]);

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

  if (entries.length === 0) return null;

  return (
    <div className="bg-card border border-border rounded-lg px-4 py-3 shadow-sm shadow-black/20">
      <h3 className="text-[11px] uppercase tracking-wider text-text-dim mb-2 flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-blue" />
        Pipeline
      </h3>
      <div className="flex flex-col gap-1.5">
        {entries.map(([planId]) => (
          <PlanRow
            key={planId}
            planId={planId}
            threads={threadsByPlan.get(planId) ?? threadsByPlan.get('__global__') ?? []}
            sessionStart={sessionStart}
            totalSpan={totalSpan}
            reviewIssues={reviewIssues?.[planId]}
          />
        ))}
      </div>
    </div>
  );
}

interface PlanRowProps {
  planId: string;
  threads: AgentThread[];
  sessionStart: number;
  totalSpan: number;
  reviewIssues?: ReviewIssue[];
}

function PlanRow({ planId, threads, sessionStart, totalSpan, reviewIssues }: PlanRowProps) {
  const { openPreview } = usePlanPreview();

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs">
        <span
          className="w-[140px] text-text-dim overflow-hidden text-ellipsis whitespace-nowrap cursor-pointer hover:text-foreground hover:underline font-mono text-[11px]"
          title={planId}
          onClick={() => openPreview(planId)}
        >
          {planId}
        </span>
        <div className="relative flex-1 h-5 bg-bg-tertiary rounded-sm overflow-hidden">
          {threads.map((thread) => {
            const threadStart = new Date(thread.startedAt).getTime();
            const threadEnd = thread.endedAt
              ? new Date(thread.endedAt).getTime()
              : Date.now();
            const leftPercent = ((threadStart - sessionStart) / totalSpan) * 100;
            const widthPercent = ((threadEnd - threadStart) / totalSpan) * 100;
            const isRunning = thread.endedAt === null;
            const color = getAgentColor(thread.agent);
            const duration = thread.durationMs != null
              ? formatDuration(thread.durationMs)
              : isRunning
                ? 'running...'
                : formatDuration(threadEnd - threadStart);

            return (
              <div
                key={thread.agentId}
                className={`absolute top-0.5 bottom-0.5 rounded-sm border ${color.bg} ${color.border}`}
                style={{
                  left: `${Math.max(0, leftPercent)}%`,
                  width: `max(2px, ${widthPercent}%)`,
                  animation: isRunning ? 'pulse-opacity 2s ease-in-out infinite' : undefined,
                }}
                title={`${thread.agent} - ${duration}`}
              />
            );
          })}
        </div>
      </div>
      {reviewIssues && reviewIssues.length > 0 && (
        <div className="ml-[148px]">
          <ReviewGauge issues={reviewIssues} />
        </div>
      )}
    </div>
  );
}
