import { memo, useMemo, useState } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AgentThread, StoredEvent } from '@/lib/reducer';
import type { AgentRole, PipelineStage, ReviewIssue, OrchestrationConfig, BuildStageSpec } from '@/lib/types';
import { EMPTY_THREADS } from './pipeline-colors';
import { AGENT_TO_STAGE, MIN_TIMELINE_WINDOW_MS } from './agent-stage-map';
import { ACTIVITY_STREAMING_TYPES } from './activity-overlay';
import { computeDepthMap } from './compute-depth-map';
import { PlanRow } from './plan-row';

interface ThreadPipelineProps {
  agentThreads: AgentThread[];
  startTime: number | null;
  endTime: number | null;
  planStatuses: Record<string, PipelineStage>;
  reviewIssues?: Record<string, ReviewIssue[]>;
  events: StoredEvent[];
  orchestration?: OrchestrationConfig | null;
  prdSource?: { label: string; content: string } | null;
  planArtifacts?: Array<{ id: string; name: string; body: string }>;
}

function ThreadPipelineImpl({ agentThreads, startTime, endTime, planStatuses, reviewIssues, events, orchestration, prdSource, planArtifacts }: ThreadPipelineProps) {
  const [hoveredStage, setHoveredStage] = useState<string | null>(null);
  const entries = Object.entries(planStatuses);

  const planArtifactMap = useMemo(() => {
    const map = new Map<string, { name: string; body: string }>();
    if (planArtifacts) {
      for (const p of planArtifacts) {
        map.set(p.id, { name: p.name, body: p.body });
      }
    }
    return map;
  }, [planArtifacts]);

  const dependsByPlan = useMemo(() => {
    const map = new Map<string, string[]>();
    if (orchestration) {
      for (const plan of orchestration.plans) {
        if (plan.dependsOn.length > 0) {
          map.set(plan.id, plan.dependsOn);
        }
      }
    }
    return map;
  }, [orchestration]);

  const depthMap = useMemo(() => {
    if (!orchestration || orchestration.plans.length === 0) {
      return new Map<string, number>();
    }
    return computeDepthMap(orchestration.plans);
  }, [orchestration]);

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
    return { sessionStart: start, totalSpan: Math.max(maxEnd - start, MIN_TIMELINE_WINDOW_MS) };
  }, [agentThreads, startTime, endTime]);

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

  const buildStagesByPlan = useMemo(() => {
    const map = new Map<string, BuildStageSpec[]>();
    if (orchestration) {
      for (const plan of orchestration.plans) {
        if (plan.build && plan.build.length > 0) {
          map.set(plan.id, plan.build);
        }
      }
    }
    return map;
  }, [orchestration]);

  const globalThreads = threadsByPlan.get('__global__') ?? EMPTY_THREADS;
  const hasGlobalThreads = globalThreads.length > 0;
  const hasThreadContent = entries.length > 0 || hasGlobalThreads;

  const { activeStages, completedStages } = useMemo(() => {
    const active = new Set<string>();
    const seen = new Set<string>();
    const running = new Set<string>();

    for (const thread of agentThreads) {
      const stage = AGENT_TO_STAGE[thread.agent as AgentRole];
      if (!stage) continue;
      seen.add(stage);
      if (thread.endedAt === null) {
        running.add(stage);
      }
    }

    const completed = new Set<string>();
    for (const stage of seen) {
      if (running.has(stage)) {
        active.add(stage);
      } else {
        completed.add(stage);
      }
    }

    return { activeStages: active, completedStages: completed };
  }, [agentThreads]);

  const eventsByAgent = useMemo(() => {
    const map = new Map<string, StoredEvent[]>();
    for (const stored of events) {
      const { event } = stored;
      if (!ACTIVITY_STREAMING_TYPES.has(event.type)) continue;
      if (!('agentId' in event)) continue;
      const aid = (event as { agentId: string }).agentId;
      let arr = map.get(aid);
      if (!arr) {
        arr = [];
        map.set(aid, arr);
      }
      arr.push(stored);
    }
    return map;
  }, [events]);

  if (!hasThreadContent) return null;

  return (
    <TooltipProvider delayDuration={0}>
      <div>
        <h3 className="text-[11px] uppercase tracking-wider text-text-dim mb-2 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-blue" />
          Pipeline
        </h3>

        {hasThreadContent && (
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
                eventsByAgent={eventsByAgent}
                prdSource={prdSource}
                compileActiveStages={activeStages}
                compileCompletedStages={completedStages}
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
                eventsByAgent={eventsByAgent}
                buildStages={buildStagesByPlan.get(planId)}
                currentStage={planStatuses[planId]}
                planArtifact={planArtifactMap.get(planId)}
                dependsOn={dependsByPlan.get(planId)}
                depth={depthMap.get(planId) ?? 0}
              />
            ))}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}

export const ThreadPipeline = memo(ThreadPipelineImpl);
