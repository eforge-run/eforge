import { useMemo, useState } from 'react';
import { usePlanPreview } from '@/components/preview';
import { formatDuration, formatNumber } from '@/lib/format';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { AgentThread } from '@/lib/reducer';
import type { PipelineStage, ReviewIssue, ProfileInfo } from '@/lib/types';

const REVIEW_AGENTS = new Set([
  'reviewer', 'plan-reviewer', 'architecture-reviewer', 'cohesion-reviewer',
  'evaluator', 'plan-evaluator', 'architecture-evaluator', 'cohesion-evaluator',
]);

/** Map agent roles to pipeline-stage color classes */
const AGENT_COLORS: Record<string, { bg: string; border: string }> = {
  planner:             { bg: 'bg-yellow/30',  border: 'border-yellow/50' },
  'module-planner':    { bg: 'bg-yellow/30',  border: 'border-yellow/50' },
  builder:             { bg: 'bg-blue/30',    border: 'border-blue/50' },
  reviewer:            { bg: 'bg-green/30',   border: 'border-green/50' },
  'plan-reviewer':     { bg: 'bg-green/30',   border: 'border-green/50' },
  'cohesion-reviewer': { bg: 'bg-green/30',   border: 'border-green/50' },
  'architecture-reviewer': { bg: 'bg-green/30', border: 'border-green/50' },
  evaluator:           { bg: 'bg-purple/30',  border: 'border-purple/50' },
  'plan-evaluator':    { bg: 'bg-purple/30',  border: 'border-purple/50' },
  'architecture-evaluator': { bg: 'bg-purple/30', border: 'border-purple/50' },
  'cohesion-evaluator':{ bg: 'bg-purple/30',  border: 'border-purple/50' },
  'review-fixer':      { bg: 'bg-purple/30',  border: 'border-purple/50' },
  'parallel-reviewer': { bg: 'bg-green/30',   border: 'border-green/50' },
  'doc-updater':       { bg: 'bg-cyan/30',    border: 'border-cyan/50' },
  'validation-fixer':  { bg: 'bg-red/30',     border: 'border-red/50' },
  formatter:           { bg: 'bg-cyan/30',    border: 'border-cyan/50' },
};

const FALLBACK_COLOR = { bg: 'bg-cyan/30', border: 'border-cyan/50' };
const EMPTY_THREADS: AgentThread[] = [];

function getAgentColor(agent: string) {
  return AGENT_COLORS[agent] ?? FALLBACK_COLOR;
}

// --- Profile tier colors ---

const TIER_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  errand: { bg: 'bg-[#3fb950]/15', text: 'text-[#3fb950]', border: 'border-[#3fb950]/30' },
  excursion: { bg: 'bg-[#58a6ff]/15', text: 'text-[#58a6ff]', border: 'border-[#58a6ff]/30' },
  expedition: { bg: 'bg-[#f0883e]/15', text: 'text-[#f0883e]', border: 'border-[#f0883e]/30' },
};

const DEFAULT_TIER = { bg: 'bg-[#bc8cff]/15', text: 'text-[#bc8cff]', border: 'border-[#bc8cff]/30' };

function getTierColor(name: string) {
  return TIER_COLORS[name] ?? DEFAULT_TIER;
}

// --- Agent role → profile stage mapping ---

const AGENT_TO_STAGE: Record<string, string> = {
  'planner': 'planner',
  'plan-reviewer': 'plan-review-cycle',
  'plan-evaluator': 'plan-review-cycle',
  'module-planner': 'module-planning',
  'architecture-reviewer': 'architecture-review-cycle',
  'architecture-evaluator': 'architecture-review-cycle',
  'cohesion-reviewer': 'cohesion-review-cycle',
  'cohesion-evaluator': 'cohesion-review-cycle',
  'builder': 'implement',
  'doc-updater': 'doc-update',
  'reviewer': 'review',
  'parallel-reviewer': 'review',
  'review-fixer': 'review-fix',
  'evaluator': 'evaluate',
  'validation-fixer': 'validate',
};

type StageStatus = 'pending' | 'active' | 'completed';

const STAGE_STATUS_STYLES: Record<StageStatus, string> = {
  pending: 'bg-bg-tertiary text-text-dim/80',
  active: 'bg-primary/20 text-primary',
  completed: 'bg-green/15 text-green/70',
};

// --- Stage overview sub-components ---

function StagePill({ stage, status = 'pending', hoveredStage, onStageHover }: {
  stage: string;
  status?: StageStatus;
  hoveredStage: string | null;
  onStageHover: (stage: string | null) => void;
}) {
  const isHighlighted = hoveredStage === stage;
  const isDimmed = hoveredStage !== null && hoveredStage !== stage;
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-[10px] font-medium whitespace-nowrap transition-all duration-150 ${STAGE_STATUS_STYLES[status]}${isHighlighted ? ' ring-1 ring-foreground/40 brightness-125' : ''}${isDimmed ? ' opacity-40' : ''}`}
      style={status === 'active' ? { animation: 'pulse-opacity 2s ease-in-out infinite' } : undefined}
      onMouseEnter={() => onStageHover(stage)}
      onMouseLeave={() => onStageHover(null)}
    >
      {stage}
    </span>
  );
}

function Chevron() {
  return (
    <svg className="w-3 h-3 text-text-dim/30 shrink-0" viewBox="0 0 12 12" fill="none">
      <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function getStageStatus(stage: string, activeStages: Set<string>, completedStages: Set<string>): StageStatus {
  if (activeStages.has(stage)) return 'active';
  if (completedStages.has(stage)) return 'completed';
  return 'pending';
}

function StageOverview({ compile, activeStages, completedStages, hoveredStage, onStageHover }: {
  compile: string[];
  activeStages: Set<string>;
  completedStages: Set<string>;
  hoveredStage: string | null;
  onStageHover: (stage: string | null) => void;
}) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {compile.map((stage, i) => (
        <div key={`c-${i}`} className="flex items-center gap-1">
          {i > 0 && <Chevron />}
          <StagePill stage={stage} status={getStageStatus(stage, activeStages, completedStages)} hoveredStage={hoveredStage} onStageHover={onStageHover} />
        </div>
      ))}
    </div>
  );
}

function ProfileHeader({ profileInfo, activeStages, completedStages, hoveredStage, onStageHover }: {
  profileInfo: ProfileInfo;
  activeStages: Set<string>;
  completedStages: Set<string>;
  hoveredStage: string | null;
  onStageHover: (stage: string | null) => void;
}) {
  const tier = getTierColor(profileInfo.profileName);
  return (
    <div className="flex flex-col gap-2 mb-3">
      <div className="flex items-center gap-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={`px-2.5 py-1 rounded-md text-xs font-semibold border cursor-default ${tier.bg} ${tier.text} ${tier.border}`}>
              {profileInfo.profileName}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            {profileInfo.rationale}
          </TooltipContent>
        </Tooltip>
        {profileInfo.config.extends && (
          <span className={`text-[11px] ${getTierColor(profileInfo.config.extends).text}`}>
            extends <span className="font-medium">{profileInfo.config.extends}</span>
          </span>
        )}
        <span className="text-[11px] text-text-dim">{profileInfo.config.description}</span>
      </div>
      <StageOverview compile={profileInfo.config.compile} activeStages={activeStages} completedStages={completedStages} hoveredStage={hoveredStage} onStageHover={onStageHover} />
    </div>
  );
}

// --- Main component ---

interface ThreadPipelineProps {
  agentThreads: AgentThread[];
  startTime: number | null;
  endTime: number | null;
  planStatuses: Record<string, PipelineStage>;
  reviewIssues?: Record<string, ReviewIssue[]>;
  profileInfo?: ProfileInfo | null;
}

export function ThreadPipeline({ agentThreads, startTime, endTime, planStatuses, reviewIssues, profileInfo }: ThreadPipelineProps) {
  const [hoveredStage, setHoveredStage] = useState<string | null>(null);
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
  const hasThreadContent = entries.length > 0 || hasGlobalThreads;

  // Derive active/completed stage sets from agent threads
  const { activeStages, completedStages } = useMemo(() => {
    const active = new Set<string>();
    const seen = new Set<string>();
    const running = new Set<string>();

    for (const thread of agentThreads) {
      const stage = AGENT_TO_STAGE[thread.agent];
      if (!stage) continue;
      seen.add(stage);
      if (thread.endedAt === null) {
        running.add(stage);
      }
    }

    // A stage is active if any mapped thread is running
    // A stage is completed if at least one thread mapped to it has been seen and none are running
    const completed = new Set<string>();
    for (const stage of seen) {
      if (running.has(stage)) {
        active.add(stage);
      } else {
        completed.add(stage);
      }
    }

    // prd-passthrough has no agent — mark completed once any other stage is active/completed
    if (profileInfo && profileInfo.config.compile[0] === 'prd-passthrough' && (active.size > 0 || completed.size > 0)) {
      completed.add('prd-passthrough');
    }

    return { activeStages: active, completedStages: completed };
  }, [agentThreads, profileInfo]);

  // Show nothing if there are no threads and no profile info
  if (!hasThreadContent && !profileInfo) return null;

  return (
    <TooltipProvider delayDuration={0}>
      <div>
        {/* Header: profile badge + description, or fallback "Pipeline" label */}
        {profileInfo ? (
          <ProfileHeader profileInfo={profileInfo} activeStages={activeStages} completedStages={completedStages} hoveredStage={hoveredStage} onStageHover={setHoveredStage} />
        ) : (
          <h3 className="text-[11px] uppercase tracking-wider text-text-dim mb-2 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-blue" />
            Pipeline
          </h3>
        )}

        {/* Thread timeline rows */}
        {hasThreadContent && (
          <>

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
                  hoveredStage={hoveredStage}
                  onStageHover={setHoveredStage}
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
                  hoveredStage={hoveredStage}
                  onStageHover={setHoveredStage}
                />
              ))}
            </div>
          </>
        )}
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
  hoveredStage: string | null;
  onStageHover: (stage: string | null) => void;
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

function PlanRow({ planId, threads, sessionStart, totalSpan, endTime, issues, disablePreview, hoveredStage, onStageHover }: PlanRowProps) {
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
            const stripStage = AGENT_TO_STAGE[thread.agent];
            const isStripHighlighted = hoveredStage !== null && hoveredStage === stripStage;
            const isStripDimmed = hoveredStage !== null && hoveredStage !== stripStage;

            return (
              <div key={thread.agentId} className="relative h-4">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div
                      className={`absolute inset-y-0 rounded-sm border transition-all duration-150 ${color.bg} ${color.border} flex items-center overflow-hidden cursor-default${isStripHighlighted ? ' brightness-150 ring-1 ring-foreground/30' : ''}${isStripDimmed ? ' opacity-30' : ''}`}
                      style={{
                        left: `${leftPercent}%`,
                        width: `max(2px, ${widthPercent}%)`,
                        animation: isRunning ? 'pulse-opacity 2s ease-in-out infinite' : undefined,
                      }}
                      onMouseEnter={() => onStageHover(stripStage ?? null)}
                      onMouseLeave={() => onStageHover(null)}
                    >
                      <span className="text-[9px] truncate px-1 leading-4 text-foreground/70">
                        {thread.agent}{thread.totalTokens != null ? ` ${formatNumber(thread.totalTokens)}` : ''}
                      </span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    <div className="font-medium">{thread.agent}</div>
                    <div className="opacity-70">{duration}</div>
                    {thread.totalTokens != null && (
                      <div className="opacity-70">
                        {formatNumber(thread.totalTokens)} tokens
                        {thread.cacheRead != null && thread.inputTokens != null && thread.inputTokens > 0 && (
                          <span> ({Math.round(thread.cacheRead / thread.inputTokens * 100)}% cached)</span>
                        )}
                      </div>
                    )}
                    {thread.costUsd != null && thread.costUsd > 0 && (
                      <div className="opacity-70">${thread.costUsd.toFixed(4)}</div>
                    )}
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
