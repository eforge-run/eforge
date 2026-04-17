import { useMemo, useState } from 'react';
import { usePlanPreview } from '@/components/preview';
import { formatDuration, formatNumber } from '@/lib/format';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { AgentThread, StoredEvent } from '@/lib/reducer';
import type { AgentRole, PipelineStage, ReviewIssue, ProfileInfo, OrchestrationConfig, BuildStageSpec } from '@/lib/types';

const REVIEW_AGENTS = new Set([
  'reviewer', 'review-fixer', 'plan-reviewer', 'architecture-reviewer', 'cohesion-reviewer',
  'evaluator', 'plan-evaluator', 'architecture-evaluator', 'cohesion-evaluator',
]);

/** Map agent roles to pipeline-stage color classes */
const AGENT_COLORS: Record<AgentRole, { bg: string; border: string }> = {
  'planner':                { bg: 'bg-yellow/30',  border: 'border-yellow/50' },
  'module-planner':         { bg: 'bg-yellow/30',  border: 'border-yellow/50' },
  'builder':                { bg: 'bg-blue/30',    border: 'border-blue/50' },
  'reviewer':               { bg: 'bg-green/30',   border: 'border-green/50' },
  'review-fixer':           { bg: 'bg-green/30',   border: 'border-green/50' },
  'plan-reviewer':          { bg: 'bg-green/30',   border: 'border-green/50' },
  'cohesion-reviewer':      { bg: 'bg-green/30',   border: 'border-green/50' },
  'architecture-reviewer':  { bg: 'bg-green/30',   border: 'border-green/50' },
  'evaluator':              { bg: 'bg-purple/30',  border: 'border-purple/50' },
  'plan-evaluator':         { bg: 'bg-purple/30',  border: 'border-purple/50' },
  'architecture-evaluator': { bg: 'bg-purple/30',  border: 'border-purple/50' },
  'cohesion-evaluator':     { bg: 'bg-purple/30',  border: 'border-purple/50' },
  'doc-updater':            { bg: 'bg-cyan/30',    border: 'border-cyan/50' },
  'validation-fixer':       { bg: 'bg-red/30',     border: 'border-red/50' },
  'formatter':              { bg: 'bg-cyan/30',    border: 'border-cyan/50' },
  'tester':                 { bg: 'bg-orange/30',  border: 'border-orange/50' },
  'test-writer':            { bg: 'bg-orange/30',  border: 'border-orange/50' },
  'merge-conflict-resolver': { bg: 'bg-red/30',    border: 'border-red/50' },
  'staleness-assessor':     { bg: 'bg-cyan/30',    border: 'border-cyan/50' },
  'prd-validator':          { bg: 'bg-orange/30',  border: 'border-orange/50' },
  'gap-closer':            { bg: 'bg-pink/30',    border: 'border-pink/50' },
  'dependency-detector':   { bg: 'bg-cyan/30',    border: 'border-cyan/50' },
  'pipeline-composer':     { bg: 'bg-cyan/30',    border: 'border-cyan/50' },
};

const FALLBACK_COLOR = { bg: 'bg-cyan/30', border: 'border-cyan/50' };
const EMPTY_THREADS: AgentThread[] = [];
const EMPTY_EVENTS: StoredEvent[] = [];
const EMPTY_SET = new Set<string>();

// --- Pill constants for artifact labels ---

const pillClass =
  'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium cursor-pointer transition-colors border-none';
const prdPillClass = `${pillClass} bg-yellow/15 text-yellow/70 hover:bg-yellow/25`;
const planPillClass = `${pillClass} bg-cyan/15 text-cyan/70 hover:bg-cyan/25`;

function abbreviatePlanId(id: string): string {
  if (id === 'gap-close') return 'Gap Close';
  const match = id.match(/^plan-(\d+)/);
  if (match) return `Plan ${match[1]}`;
  return id;
}

function getAgentColor(agent: string) {
  return AGENT_COLORS[agent as AgentRole] ?? FALLBACK_COLOR;
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

const AGENT_TO_STAGE: Record<AgentRole, string> = {
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
  'review-fixer': 'review-fix',
  'evaluator': 'evaluate',
  'validation-fixer': 'validate',
  'formatter': 'formatter',
  'tester': 'test',
  'test-writer': 'test-write',
  'merge-conflict-resolver': 'merge',
  'staleness-assessor': 'staleness',
  'prd-validator': 'prd-validation',
  'gap-closer': 'gap-close',
  'dependency-detector': 'dependency-detection',
  'pipeline-composer': 'pipeline-composition',
};

type StageStatus = 'pending' | 'active' | 'completed' | 'failed';

const STAGE_STATUS_STYLES: Record<StageStatus, string> = {
  pending: 'bg-bg-tertiary text-text-dim/80',
  active: 'bg-primary/20 text-primary',
  completed: 'bg-green/15 text-green/70',
  failed: 'bg-red/15 text-red/70',
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

function ProfileHeader({ profileInfo }: {
  profileInfo: ProfileInfo;
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
            <div>{profileInfo.rationale}</div>
            {!profileInfo.config.extends && profileInfo.config.description && (
              <div className="mt-1 opacity-70">{profileInfo.config.description}</div>
            )}
          </TooltipContent>
        </Tooltip>
        {profileInfo.config.extends && profileInfo.config.description && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={`text-[11px] cursor-default ${getTierColor(profileInfo.config.extends).text}`}>
                extends <span className="font-medium">{profileInfo.config.extends}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              {profileInfo.config.description}
            </TooltipContent>
          </Tooltip>
        )}
        {profileInfo.config.extends && !profileInfo.config.description && (
          <span className={`text-[11px] cursor-default ${getTierColor(profileInfo.config.extends).text}`}>
            extends <span className="font-medium">{profileInfo.config.extends}</span>
          </span>
        )}
      </div>
    </div>
  );
}

// --- Build stage breadcrumb ---

/** Map composite stage names to their child pipeline stages */
const COMPOSITE_STAGES: Record<string, string[]> = {
  'review-cycle': ['review', 'evaluate'],
  'test-cycle': ['test', 'evaluate'],
};

/** Resolve a raw pipeline stage to its build stage name using the plan's actual build stages.
 *  For stages that appear in a composite (e.g. 'review' in 'review-cycle'), returns the composite
 *  name if that composite is present in the plan's buildStages. Falls back to the raw stage name. */
function resolveBuildStage(pipelineStage: string, buildStages?: BuildStageSpec[]): string {
  if (!buildStages || buildStages.length === 0) return pipelineStage;

  // Direct match - check if the stage itself is a build stage
  const directMatch = buildStages.some((spec) => {
    const name = buildStageName(spec);
    return name === pipelineStage || (Array.isArray(spec) && spec.includes(pipelineStage));
  });
  if (directMatch) return pipelineStage;

  // Check composites - find the last composite that contains this pipeline stage and is in buildStages
  let resolved = pipelineStage;
  for (const [composite, children] of Object.entries(COMPOSITE_STAGES)) {
    if (!children.includes(pipelineStage)) continue;
    const inBuild = buildStages.some((spec) => {
      const name = buildStageName(spec);
      return name === composite || (Array.isArray(spec) && spec.includes(composite));
    });
    if (inBuild) resolved = composite;
  }

  return resolved;
}

/** Normalize a BuildStageSpec to its string name (for parallel groups, join with '+') */
function buildStageName(spec: BuildStageSpec): string {
  return Array.isArray(spec) ? spec.join('+') : spec;
}

/** Compute status for each build stage given the current PipelineStage */
function getBuildStageStatuses(
  buildStages: BuildStageSpec[],
  currentStage: PipelineStage | undefined,
  threads?: AgentThread[],
): StageStatus[] {
  if (!currentStage || buildStages.length === 0) return buildStages.map(() => 'pending');

  // All completed
  if (currentStage === 'complete') return buildStages.map(() => 'completed');

  // Failed - find the furthest-reached build stage from thread data and mark it as failed
  if (currentStage === 'failed') {
    // Use thread data to find the furthest-reached build stage index
    let furthestIdx = -1;
    if (threads && threads.length > 0) {
      for (const thread of threads) {
        const agentStage = AGENT_TO_STAGE[thread.agent as AgentRole];
        if (!agentStage) continue;
        const mappedName = resolveBuildStage(agentStage, buildStages);
        if (!mappedName) continue;
        const idx = buildStages.findIndex((spec) => {
          const name = buildStageName(spec);
          return name === mappedName || (Array.isArray(spec) && spec.includes(mappedName));
        });
        if (idx > furthestIdx) furthestIdx = idx;
      }
    }
    // Fall back to the last stage if no thread data available
    if (furthestIdx === -1) furthestIdx = buildStages.length - 1;

    return buildStages.map((_, i) => {
      if (i < furthestIdx) return 'completed';
      if (i === furthestIdx) return 'failed';
      return 'pending';
    });
  }

  // Map current PipelineStage to build stage name
  const mappedName = resolveBuildStage(currentStage, buildStages);
  if (!mappedName) return buildStages.map(() => 'pending');

  // Find the index of the current stage in the build stages
  const currentIdx = buildStages.findIndex((spec) => {
    const name = buildStageName(spec);
    return name === mappedName || (Array.isArray(spec) && spec.includes(mappedName));
  });

  if (currentIdx === -1) return buildStages.map(() => 'pending');

  return buildStages.map((_, i) => {
    if (i < currentIdx) return 'completed';
    if (i === currentIdx) return 'active';
    return 'pending';
  });
}

function BuildStageProgress({ buildStages, currentStage, hoveredStage, onStageHover, threads }: {
  buildStages?: BuildStageSpec[];
  currentStage?: PipelineStage;
  hoveredStage: string | null;
  onStageHover: (stage: string | null) => void;
  threads?: AgentThread[];
}) {
  if (!buildStages || buildStages.length === 0) return null;

  const statuses = getBuildStageStatuses(buildStages, currentStage, threads);

  return (
    <div className="flex items-center gap-1 flex-wrap mb-0.5">
      {buildStages.map((spec, i) => {
        const status = statuses[i];
        if (Array.isArray(spec)) {
          // Parallel group: render in a bordered container
          return (
            <div key={`b-${i}`} className="flex items-center gap-1">
              {i > 0 && <Chevron />}
              <div className={`flex items-center gap-0.5 border rounded px-1 py-0.5 ${STAGE_STATUS_STYLES[status].replace(/bg-\S+/, '')} border-current/20`}>
                {spec.map((s, j) => (
                  <StagePill key={s} stage={s} status={status} hoveredStage={hoveredStage} onStageHover={onStageHover} />
                ))}
              </div>
            </div>
          );
        }
        return (
          <div key={`b-${i}`} className="flex items-center gap-1">
            {i > 0 && <Chevron />}
            <StagePill stage={spec} status={status} hoveredStage={hoveredStage} onStageHover={onStageHover} />
          </div>
        );
      })}
    </div>
  );
}

/** Minimum timeline window (ms) so short-elapsed bars don't fill 100% width */
const MIN_TIMELINE_WINDOW_MS = 300_000;

// --- Activity overlay constants ---

const ACTIVITY_BUCKET_MS = 5_000; // 5 seconds per bucket

const ACTIVITY_STREAMING_TYPES = new Set(['agent:message', 'agent:tool_use', 'agent:tool_result']);

function getActivityOpacity(ratio: number): string {
  if (ratio < 0.25) return 'rgba(255, 255, 255, 0.05)';
  if (ratio < 0.50) return 'rgba(255, 255, 255, 0.12)';
  if (ratio < 0.75) return 'rgba(255, 255, 255, 0.20)';
  return 'rgba(255, 255, 255, 0.30)';
}

function ActivityOverlay({ agentEvents, threadStart, threadEnd }: {
  agentEvents: StoredEvent[];
  threadStart: number;
  threadEnd: number;
}) {
  const buckets = useMemo(() => {
    const span = threadEnd - threadStart;
    if (span <= 0) return [];

    const totalBuckets = Math.max(1, Math.ceil(span / ACTIVITY_BUCKET_MS));
    const counts = new Array(totalBuckets).fill(0);

    for (const { event } of agentEvents) {
      if ('timestamp' in event) {
        const t = new Date((event as { timestamp: string }).timestamp).getTime();
        const idx = Math.floor((t - threadStart) / ACTIVITY_BUCKET_MS);
        if (idx >= 0 && idx < totalBuckets) {
          counts[idx]++;
        }
      }
    }

    const maxCount = Math.max(...counts, 1);
    return counts
      .map((count, i) => ({ count, index: i }))
      .filter(({ count }) => count > 0)
      .map(({ count, index }) => ({
        count,
        leftPercent: ((index * ACTIVITY_BUCKET_MS) / span) * 100,
        widthPercent: (ACTIVITY_BUCKET_MS / span) * 100,
        color: getActivityOpacity(count / maxCount),
      }));
  }, [agentEvents, threadStart, threadEnd]);

  if (buckets.length === 0) return null;

  return (
    <>
      {buckets.map((bucket, i) => (
        <Tooltip key={i}>
          <TooltipTrigger asChild>
            <div
              className="absolute inset-y-0 z-0"
              style={{
                left: `${bucket.leftPercent}%`,
                width: `${bucket.widthPercent}%`,
                backgroundColor: bucket.color,
              }}
            />
          </TooltipTrigger>
          <TooltipContent side="top">
            {bucket.count} events
          </TooltipContent>
        </Tooltip>
      ))}
    </>
  );
}

// --- Depth computation for thread-line gutter ---

/** Compute a depth map from the orchestration config's dependency graph.
 *  Depth = longest path from any root (no dependencies) to this node. */
function computeDepthMap(plans: OrchestrationConfig['plans']): Map<string, number> {
  const depthMap = new Map<string, number>();
  const depsById = new Map<string, string[]>();
  for (const plan of plans) {
    depsById.set(plan.id, plan.dependsOn);
  }

  function getDepth(id: string, visited: Set<string>): number {
    if (depthMap.has(id)) return depthMap.get(id)!;
    if (visited.has(id)) return 0; // cycle guard
    visited.add(id);
    const deps = depsById.get(id);
    if (!deps || deps.length === 0) {
      depthMap.set(id, 0);
      return 0;
    }
    let maxParentDepth = 0;
    for (const dep of deps) {
      const d = getDepth(dep, visited);
      if (d + 1 > maxParentDepth) maxParentDepth = d + 1;
    }
    depthMap.set(id, maxParentDepth);
    return maxParentDepth;
  }

  for (const plan of plans) {
    getDepth(plan.id, new Set());
  }

  return depthMap;
}

/** Width in pixels per depth level for indentation */
const DEPTH_LEVEL_WIDTH = 20;

// --- Main component ---

interface ThreadPipelineProps {
  agentThreads: AgentThread[];
  startTime: number | null;
  endTime: number | null;
  planStatuses: Record<string, PipelineStage>;
  reviewIssues?: Record<string, ReviewIssue[]>;
  profileInfo?: ProfileInfo | null;
  events: StoredEvent[];
  orchestration?: OrchestrationConfig | null;
  prdSource?: { label: string; content: string } | null;
  planArtifacts?: Array<{ id: string; name: string; body: string }>;
}

export function ThreadPipeline({ agentThreads, startTime, endTime, planStatuses, reviewIssues, profileInfo, events, orchestration, prdSource, planArtifacts }: ThreadPipelineProps) {
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
    return { sessionStart: start, totalSpan: Math.max(maxEnd - start, MIN_TIMELINE_WINDOW_MS) };
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

  // Build a lookup from plan ID to build stages from orchestration
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

  // Derive active/completed stage sets from agent threads
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

    return { activeStages: active, completedStages: completed };
  }, [agentThreads, profileInfo]);

  // Show nothing if there are no threads and no profile info
  if (!hasThreadContent && !profileInfo) return null;

  return (
    <TooltipProvider delayDuration={0}>
      <div>
        {/* Header: profile badge + description, or fallback "Pipeline" label */}
        {profileInfo ? (
          <ProfileHeader profileInfo={profileInfo} />
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
                  events={events}
                  prdSource={prdSource}
                  compileStages={profileInfo?.config.compile}
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
                  events={events}
                  buildStages={buildStagesByPlan.get(planId)}
                  currentStage={planStatuses[planId]}
                  planArtifact={planArtifactMap.get(planId)}
                  dependsOn={dependsByPlan.get(planId)}
                  depth={depthMap.get(planId) ?? 0}
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
  events: StoredEvent[];
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

function PlanRow({ planId, threads, sessionStart, totalSpan, endTime, issues, disablePreview, hoveredStage, onStageHover, events, buildStages, currentStage, prdSource, planArtifact, dependsOn, depth, compileStages, compileActiveStages, compileCompletedStages }: PlanRowProps) {
  const { openPreview, openContentPreview } = usePlanPreview();

  const sortedThreads = useMemo(
    () => [...threads].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()),
    [threads],
  );

  // Pre-group activity events by agentId to avoid N full scans in ActivityOverlay
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
        <div className={`w-[100px] shrink-0 mt-0.5`} style={{ paddingLeft: (depth ?? 0) * DEPTH_LEVEL_WIDTH }}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={prdPillClass}
                onClick={() => openContentPreview(prdSource.label, prdSource.content)}
              >
                PRD
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">{prdSource.label}</TooltipContent>
          </Tooltip>
        </div>
      );
    }
    if (planArtifact) {
      return (
        <div className="w-[100px] shrink-0 mt-0.5" style={{ paddingLeft: (depth ?? 0) * DEPTH_LEVEL_WIDTH }}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={planPillClass}
                onClick={() => openContentPreview(planArtifact.name || planId, planArtifact.body)}
              >
                {abbreviatePlanId(planId)}
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">
              {planTooltipText.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </TooltipContent>
          </Tooltip>
        </div>
      );
    }
    // Fallback: pill label (e.g. gap-close or plans without artifacts)
    return (
      <div className="w-[100px] shrink-0 mt-0.5" style={{ paddingLeft: (depth ?? 0) * DEPTH_LEVEL_WIDTH }}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className={planPillClass}
              onClick={disablePreview ? undefined : () => openPreview(planId)}
            >
              {abbreviatePlanId(planId)}
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">{planId}</TooltipContent>
        </Tooltip>
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
                    {thread.model && <div className="opacity-50 text-[10px]">{thread.model}</div>}
                    {thread.effort && (
                      <div className="opacity-50 text-[10px]">
                        {thread.effortClamped && thread.effortOriginal
                          ? `${thread.effort} (clamped from ${thread.effortOriginal})`
                          : thread.effort}
                        {thread.effortSource && (
                          <span>
                            {' '}({thread.effortSource === 'planner'
                              ? 'planner'
                              : thread.effortSource === 'role-config' || thread.effortSource === 'global-config'
                                ? 'config'
                                : thread.effortSource === 'default'
                                  ? 'default'
                                  : thread.effortSource})
                          </span>
                        )}
                      </div>
                    )}
                    {thread.thinking && <div className="opacity-50 text-[10px]">{thread.thinking}</div>}
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
