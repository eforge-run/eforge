import { memo, useMemo } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { usePlanPreview } from '@/components/preview';
import { formatDuration, formatNumber } from '@/lib/format';
import type { AgentThread, StoredEvent } from '@/lib/reducer';
import type { AgentRole, PipelineStage, ReviewIssue, BuildStageSpec } from '@/lib/types';
import {
  EMPTY_EVENTS,
  EMPTY_SET,
  DEPTH_BAR_BG,
  prdPillClass,
  planPillClassFor,
  abbreviatePlanId,
  getAgentColor,
} from './pipeline-colors';
import { AGENT_TO_STAGE, REVIEW_AGENTS, resolveBuildStage } from './agent-stage-map';
import { ActivityOverlay } from './activity-overlay';
import { StageOverview, BuildStageProgress } from './stage-overview';

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
  eventsByAgent: Map<string, StoredEvent[]>;
  buildStages?: BuildStageSpec[];
  currentStage?: PipelineStage;
  prdSource?: { label: string; content: string } | null;
  planArtifact?: { name: string; body: string };
  dependsOn?: string[];
  depth?: number;
  compileStages?: string[];
  compileActiveStages?: Set<string>;
  compileCompletedStages?: Set<string>;
}

export function IssuesSummary({ issues }: { issues: ReviewIssue[] }) {
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

export function DepthBars({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return (
    <div className="flex items-stretch gap-1 self-stretch">
      {Array.from({ length: depth }).map((_, i) => (
        <div key={i} className={`w-0.5 self-stretch rounded-sm ${DEPTH_BAR_BG[i % DEPTH_BAR_BG.length]}`} />
      ))}
    </div>
  );
}

function PlanRowImpl({ planId, threads, sessionStart, totalSpan, endTime, issues, disablePreview, hoveredStage, onStageHover, eventsByAgent, buildStages, currentStage, prdSource, planArtifact, dependsOn, depth, compileStages, compileActiveStages, compileCompletedStages }: PlanRowProps) {
  const { openPreview, openContentPreview } = usePlanPreview();

  const sortedThreads = useMemo(
    () => [...threads].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()),
    [threads],
  );

  // Build tooltip text for plan pills (always returns string[] for consistent rendering)
  const planTooltipText = useMemo(() => {
    if (!planArtifact) return [planId];
    const parts = [planArtifact.name || planId];
    if (dependsOn && dependsOn.length > 0) {
      const depLabels = dependsOn.map((d) => abbreviatePlanId(d)).join(', ');
      parts.push(`Depends on: ${depLabels}`);
    }
    return parts;
  }, [planId, planArtifact, dependsOn]);

  // Render left column label
  const leftLabel = (() => {
    if (prdSource) {
      return (
        <div className="w-[100px] shrink-0 flex items-stretch gap-1.5">
          <DepthBars depth={depth ?? 0} />
          <div className="flex-1 min-w-0 mt-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={prdPillClass}
                  onClick={() => openContentPreview(prdSource.label, prdSource.content)}
                >
                  PRD
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">{prdSource.label}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      );
    }
    if (planArtifact) {
      return (
        <div className="w-[100px] shrink-0 flex items-stretch gap-1.5">
          <DepthBars depth={depth ?? 0} />
          <div className="flex-1 min-w-0 mt-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={planPillClassFor(depth ?? 0)}
                  onClick={() => openContentPreview(planArtifact.name || planId, planArtifact.body)}
                >
                  {abbreviatePlanId(planId)}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">
                {planTooltipText.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      );
    }
    // Fallback: pill label (e.g. gap-close or plans without artifacts)
    return (
      <div className="w-[100px] shrink-0 flex items-stretch gap-1.5">
        <DepthBars depth={depth ?? 0} />
        <div className="flex-1 min-w-0 mt-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={planPillClassFor(depth ?? 0)}
                onClick={disablePreview ? undefined : () => openPreview(planId)}
              >
                {abbreviatePlanId(planId)}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">{planId}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    );
  })();

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-2 text-xs">
        {leftLabel}
        <div className="flex-1 flex flex-col gap-0.5">
          {compileStages && (
            <StageOverview
              compile={compileStages}
              activeStages={compileActiveStages ?? EMPTY_SET}
              completedStages={compileCompletedStages ?? EMPTY_SET}
              hoveredStage={hoveredStage}
              onStageHover={onStageHover}
            />
          )}
          {!disablePreview && (
            <BuildStageProgress buildStages={buildStages} currentStage={currentStage} hoveredStage={hoveredStage} onStageHover={onStageHover} threads={threads} />
          )}
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
            const rawStage = AGENT_TO_STAGE[thread.agent as AgentRole];
            const stripStage = rawStage ? resolveBuildStage(rawStage, buildStages) : undefined;
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
                      <ActivityOverlay
                        agentEvents={eventsByAgent.get(thread.agentId) ?? EMPTY_EVENTS}
                        threadStart={threadStart}
                        threadEnd={threadEnd}
                      />
                      <span className="text-[9px] truncate px-1 leading-4 text-foreground/70 relative z-10">
                        {thread.agent}{thread.totalTokens != null ? ` ${formatNumber(thread.totalTokens)}` : ''}
                      </span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    <div className="font-medium">{thread.agent}</div>
                    {(thread.harness || thread.model) && (
                      <div className="opacity-50 text-[10px]">
                        {[thread.harness, thread.model].filter(Boolean).join(' · ')}
                        {thread.harnessSource && (
                          <span className={thread.harnessSource === 'plan' ? ' text-blue-400' : ''}> ({thread.harnessSource})</span>
                        )}
                      </div>
                    )}
                    <div className={thread.effortSource === 'plan' ? 'text-blue-400 font-medium text-[10px]' : 'opacity-50 text-[10px]'}>
                      effort: {thread.effort
                        ? (thread.effortClamped && thread.effortOriginal
                          ? `${thread.effort} (clamped from ${thread.effortOriginal})`
                          : thread.effort)
                        : 'unset'}
                      {thread.effortSource && (
                        <span> ({thread.effortSource})</span>
                      )}
                    </div>
                    <div className={thread.thinkingSource === 'plan' ? 'text-blue-400 font-medium text-[10px]' : 'opacity-50 text-[10px]'}>
                      thinking: {thread.thinking ?? 'unset'}
                      {thread.thinkingSource && (
                        <span> ({thread.thinkingSource})</span>
                      )}
                    </div>
                    {thread.tier && (
                      <div className={thread.tierSource === 'role' ? 'text-amber-400 font-medium text-[10px]' : 'opacity-50 text-[10px]'}>
                        tier: {thread.tier}
                        {thread.tierSource && (
                          <span> ({thread.tierSource})</span>
                        )}
                      </div>
                    )}
                    {thread.perspective && (
                      <div className="opacity-50 text-[10px]">
                        perspective: {thread.perspective}
                      </div>
                    )}
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
    </div>
  );
}

export const PlanRow = memo(PlanRowImpl);
