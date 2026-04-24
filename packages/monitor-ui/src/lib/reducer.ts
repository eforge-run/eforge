/**
 * Reducer for eforge session run state.
 *
 * ## Action types
 *
 * ### `ADD_EVENT`
 * Appends a single `EforgeEvent` to the event log and updates all derived
 * aggregates (token counts, cost, plan statuses, agent threads, file changes,
 * review issues, etc.) incrementally. Use for live SSE events received after
 * the initial batch load.
 *
 * ### `BATCH_LOAD`
 * Rebuilds the entire state from scratch by replaying a full array of stored
 * events. Accepts an optional `serverStatus` that acts as an authoritative
 * override for `isComplete`/`resultStatus` when the event array alone would
 * leave those fields unset (e.g. the terminal `session:end` event was missed).
 * Use for the initial HTTP snapshot or when loading a cached completed session.
 *
 * ### `RESET`
 * Returns the initial empty state with freshly allocated mutable containers
 * (`fileChanges: new Map()`, etc.). Use when the session changes to `null` or
 * when the hook is cleaning up.
 */
import type { EforgeEvent, ExpeditionModule, OrchestrationConfig, ProfileInfo, ReviewIssue } from './types';
import type { PipelineStage } from './types';
import { formatDuration, formatThinking } from './format';

export type ModuleStatus = 'pending' | 'planning' | 'complete';

export interface StoredEvent {
  event: EforgeEvent;
  eventId: string;
}

export interface AgentThread {
  agentId: string;
  agent: string;  // AgentRole
  planId?: string;
  startedAt: string;      // ISO from agent:start timestamp
  endedAt: string | null;  // ISO from agent:stop timestamp
  durationMs: number | null; // from agent:result
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheRead: number | null;
  costUsd: number | null;
  numTurns: number | null;
  model: string;
  effort?: string;
  thinking?: string;
  effortClamped?: boolean;
  effortOriginal?: string;
  effortSource?: string;
  thinkingSource?: string;
}

export interface RunState {
  events: StoredEvent[];
  startTime: number | null;
  planStatuses: Record<string, PipelineStage>;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreation: number;
  totalCost: number;
  isComplete: boolean;
  resultStatus: 'completed' | 'failed' | null;
  fileChanges: Map<string, string[]>;
  reviewIssues: Record<string, ReviewIssue[]>;
  agentThreads: AgentThread[];
  expeditionModules: ExpeditionModule[];
  moduleStatuses: Record<string, ModuleStatus>;
  earlyOrchestration: OrchestrationConfig | null;
  profileInfo: ProfileInfo | null;
  endTime: number | null;
  mergeCommits: Record<string, string>;
  backend: string | null;
  liveAgentUsage: Record<string, { input: number; output: number; cacheRead: number; cacheCreation: number; cost: number; turns: number }>;
  enqueueStatus: 'running' | 'complete' | 'failed' | null;
  enqueueTitle: string | null;
  enqueueSource: string | null;
}

export const initialRunState: RunState = {
  events: [],
  startTime: null,
  planStatuses: {},
  tokensIn: 0,
  tokensOut: 0,
  cacheRead: 0,
  cacheCreation: 0,
  totalCost: 0,
  isComplete: false,
  resultStatus: null,
  fileChanges: new Map(),
  reviewIssues: {},
  agentThreads: [],
  expeditionModules: [],
  moduleStatuses: {},
  earlyOrchestration: null,
  profileInfo: null,
  endTime: null,
  mergeCommits: {},
  backend: null,
  liveAgentUsage: {},
  enqueueStatus: null,
  enqueueTitle: null,
  enqueueSource: null,
};

export type RunAction =
  | { type: 'ADD_EVENT'; event: EforgeEvent; eventId: string }
  | { type: 'BATCH_LOAD'; events: Array<{ event: EforgeEvent; eventId: string }>; serverStatus?: string }
  | { type: 'RESET' };

/** Process a single event into mutable state accumulators */
function processEvent(
  event: EforgeEvent,
  state: {
    startTime: number | null;
    endTime: number | null;
    isComplete: boolean;
    resultStatus: 'completed' | 'failed' | null;
    tokensIn: number;
    tokensOut: number;
    cacheRead: number;
    cacheCreation: number;
    totalCost: number;
    planStatuses: Record<string, PipelineStage>;
    fileChanges: Map<string, string[]>;
    reviewIssues: Record<string, ReviewIssue[]>;
    agentThreads: AgentThread[];
    expeditionModules: ExpeditionModule[];
    moduleStatuses: Record<string, ModuleStatus>;
    earlyOrchestration: OrchestrationConfig | null;
    profileInfo: ProfileInfo | null;
    mergeCommits: Record<string, string>;
    backend: string | null;
    liveAgentUsage: Record<string, { input: number; output: number; cacheRead: number; cacheCreation: number; cost: number; turns: number }>;
    enqueueStatus: 'running' | 'complete' | 'failed' | null;
    enqueueTitle: string | null;
    enqueueSource: string | null;
  },
): void {
  if (event.type === 'session:start' && 'timestamp' in event && state.startTime === null) {
    state.startTime = new Date(event.timestamp as string).getTime();
  }

  if (event.type === 'phase:start' && 'timestamp' in event && state.startTime === null) {
    state.startTime = new Date(event.timestamp).getTime();
  }

  if (event.type === 'enqueue:start') {
    state.enqueueStatus = 'running';
    state.enqueueSource = (event as { source: string }).source;
  }

  if (event.type === 'enqueue:complete') {
    state.enqueueStatus = 'complete';
    state.enqueueTitle = (event as { title: string }).title;
  }

  if (event.type === 'enqueue:failed') {
    state.enqueueStatus = 'failed';
  }

  if (event.type === 'session:end') {
    state.isComplete = true;
    if ('timestamp' in event && event.timestamp) {
      state.endTime = new Date(event.timestamp as string).getTime();
    }
    if ('result' in event && event.result) {
      state.resultStatus = (event.result as { status: 'completed' | 'failed' }).status;
    }
  }

  if (event.type === 'agent:result' && event.result) {
    state.tokensIn += event.result.usage?.input || 0;
    state.tokensOut += event.result.usage?.output || 0;
    state.cacheRead += event.result.usage?.cacheRead || 0;
    state.cacheCreation += event.result.usage?.cacheCreation || 0;
    state.totalCost += event.result.totalCostUsd || 0;
  }

  if (event.type === 'planning:complete' && 'plans' in event) {
    const plans = (event as { plans: Array<{ id: string }> }).plans;
    for (const plan of plans) {
      state.planStatuses[plan.id] = 'plan';
    }
  }

  const planId = 'planId' in event ? (event as { planId?: string }).planId : undefined;
  if (planId) {
    switch (event.type) {
      case 'plan:build:start':
      case 'plan:build:implement:start':
        state.planStatuses[planId] = 'implement';
        break;
      case 'plan:build:doc-update:start':
      case 'plan:build:doc-update:complete':
        // Doc-update runs in parallel with implement — don't advance stage
        break;
      case 'plan:build:implement:complete':
        // Don't advance — next stage (test or review) will set the status
        break;
      case 'plan:build:test:write:start':
      case 'plan:build:test:start':
        state.planStatuses[planId] = 'test';
        break;
      case 'plan:build:test:write:complete':
      case 'plan:build:test:complete':
        // Don't advance stage — next stage (review/evaluate) will set it
        break;
      case 'plan:build:review:start':
        state.planStatuses[planId] = 'review';
        break;
      case 'plan:build:review:complete':
      case 'plan:build:evaluate:start':
        state.planStatuses[planId] = 'evaluate';
        break;
      case 'plan:build:complete':
        state.planStatuses[planId] = 'complete';
        break;
      case 'plan:build:failed':
        state.planStatuses[planId] = 'failed';
        break;
    }
  }

  if (event.type === 'plan:build:review:complete' && 'planId' in event && 'issues' in event) {
    state.reviewIssues[(event as { planId: string }).planId] = (event as { issues: ReviewIssue[] }).issues;
  }

  if (event.type === 'plan:build:test:complete' && 'planId' in event && 'productionIssues' in event) {
    const issues = (event as { productionIssues: { severity: string; category: string; file: string; description: string }[] }).productionIssues;
    if (issues.length > 0) {
      state.reviewIssues[(event as { planId: string }).planId] = issues.map((i) => ({
        severity: i.severity as 'critical' | 'warning' | 'suggestion',
        category: i.category,
        file: i.file,
        description: i.description,
      }));
    }
  }

  if (event.type === 'plan:build:files_changed' && 'files' in event) {
    state.fileChanges.set(event.planId, event.files);
  }

  if (event.type === 'plan:merge:complete' && planId) {
    state.planStatuses[planId] = 'complete';
    const commitSha = 'commitSha' in event ? (event as { commitSha?: string }).commitSha : undefined;
    if (commitSha) {
      state.mergeCommits[planId] = commitSha;
    }
  }

  // Expedition module tracking — synthesize early orchestration from architecture
  if (event.type === 'expedition:architecture:complete') {
    state.expeditionModules = event.modules;
    state.moduleStatuses = {};
    for (const mod of event.modules) {
      state.moduleStatuses[mod.id] = 'pending';
    }
    state.earlyOrchestration = {
      name: '',
      description: '',
      created: '',
      mode: 'expedition',
      baseBranch: '',
      pipeline: { scope: 'expedition', compile: [], defaultBuild: [], defaultReview: { strategy: 'auto' as const, perspectives: [], maxRounds: 1, evaluatorStrictness: 'standard' as const }, rationale: '' },
      plans: event.modules.map((mod) => ({
        id: mod.id,
        name: mod.description,
        dependsOn: mod.dependsOn,
        branch: '',
        build: [] as import('./types').BuildStageSpec[],
        review: { strategy: 'auto' as const, perspectives: [], maxRounds: 1, evaluatorStrictness: 'standard' as const },
      })),
    };
  }

  if (event.type === 'expedition:module:start') {
    state.moduleStatuses[event.moduleId] = 'planning';
  }

  if (event.type === 'expedition:module:complete') {
    state.moduleStatuses[event.moduleId] = 'complete';
  }

  // Agent thread tracking
  if (event.type === 'agent:start' && 'timestamp' in event && event.timestamp) {
    // Set session-level backend from first agent:start (remove fallback after 2026-04-29)
    if (state.backend === null) {
      state.backend = ('backend' in event ? (event as { backend?: string }).backend : undefined) ?? 'unknown';
    }
    state.agentThreads.push({
      agentId: event.agentId,
      agent: event.agent,
      planId: 'planId' in event ? (event as { planId?: string }).planId : undefined,
      startedAt: event.timestamp,
      endedAt: null,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cacheRead: null,
      costUsd: null,
      numTurns: null,
      // Capture model from agent:start (remove fallback after 2026-04-29)
      model: ('model' in event ? (event as { model?: string }).model : undefined) ?? 'unknown',
      effort: 'effort' in event ? (event as { effort?: string }).effort : undefined,
      thinking: 'thinking' in event ? formatThinking((event as { thinking?: unknown }).thinking) : undefined,
      effortClamped: 'effortClamped' in event ? (event as { effortClamped?: boolean }).effortClamped : undefined,
      effortOriginal: 'effortOriginal' in event ? (event as { effortOriginal?: string }).effortOriginal : undefined,
      effortSource: 'effortSource' in event ? (event as { effortSource?: string }).effortSource : undefined,
      thinkingSource: 'thinkingSource' in event ? (event as { thinkingSource?: string }).thinkingSource : undefined,
    });
  }

  if (event.type === 'agent:usage') {
    const isFinal = (event as { final?: boolean }).final === true;
    if (isFinal) {
      // Authoritative cumulative total — last-wins replacement.
      state.liveAgentUsage[event.agentId] = {
        input: event.usage.input,
        output: event.usage.output,
        cacheRead: event.usage.cacheRead,
        cacheCreation: event.usage.cacheCreation,
        cost: event.costUsd,
        turns: event.numTurns,
      };
      const thread = state.agentThreads.find((t) => t.agentId === event.agentId);
      if (thread) {
        thread.inputTokens = event.usage.input;
        thread.outputTokens = event.usage.output;
        thread.totalTokens = event.usage.total;
        thread.cacheRead = event.usage.cacheRead;
        thread.costUsd = event.costUsd;
        thread.numTurns = event.numTurns;
      }
    } else {
      // Per-turn delta — additive into running totals. Seed from zero when
      // this is the first usage event for the agent.
      const base = state.liveAgentUsage[event.agentId] ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0, turns: 0 };
      state.liveAgentUsage[event.agentId] = {
        input: base.input + event.usage.input,
        output: base.output + event.usage.output,
        cacheRead: base.cacheRead + event.usage.cacheRead,
        cacheCreation: base.cacheCreation + event.usage.cacheCreation,
        cost: base.cost + event.costUsd,
        turns: base.turns + event.numTurns,
      };
      const thread = state.agentThreads.find((t) => t.agentId === event.agentId);
      if (thread) {
        const nextInput = (thread.inputTokens ?? 0) + event.usage.input;
        const nextOutput = (thread.outputTokens ?? 0) + event.usage.output;
        thread.inputTokens = nextInput;
        thread.outputTokens = nextOutput;
        // Derive total from the running sums; don't trust the delta's `total` field.
        thread.totalTokens = nextInput + nextOutput;
        thread.cacheRead = (thread.cacheRead ?? 0) + event.usage.cacheRead;
        thread.costUsd = (thread.costUsd ?? 0) + event.costUsd;
        thread.numTurns = (thread.numTurns ?? 0) + event.numTurns;
      }
    }
  }

  if (event.type === 'config:warning' || event.type === 'planning:warning') {
    // Warnings flow through the event stream; visual surfacing is optional
    console.log('[eforge] warning:', (event as { message: string }).message);
  }

  if (event.type === 'agent:stop' && 'timestamp' in event && event.timestamp) {
    const thread = state.agentThreads.find((t) => t.agentId === event.agentId);
    if (thread) {
      thread.endedAt = event.timestamp;
    }
    delete state.liveAgentUsage[event.agentId];
  }

  if (event.type === 'agent:result' && event.result) {
    const agentRole = event.agent;
    const eventPlanId = 'planId' in event ? (event as { planId?: string }).planId : undefined;
    // Find most recent thread matching (agent, planId) where durationMs is null
    for (let i = state.agentThreads.length - 1; i >= 0; i--) {
      const thread = state.agentThreads[i];
      if (thread.agent === agentRole && thread.planId === eventPlanId && thread.durationMs === null) {
        thread.durationMs = event.result.durationMs;
        thread.inputTokens = event.result.usage?.input ?? null;
        thread.outputTokens = event.result.usage?.output ?? null;
        thread.totalTokens = event.result.usage?.total ?? null;
        thread.cacheRead = event.result.usage?.cacheRead ?? null;
        thread.costUsd = event.result.totalCostUsd ?? null;
        thread.numTurns = event.result.numTurns ?? null;
        // Clear live usage overlay — finalized totals are now in agent:result
        delete state.liveAgentUsage[thread.agentId];
        break;
      }
    }
  }
}

export function eforgeReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case 'RESET':
      return { ...initialRunState, fileChanges: new Map(), reviewIssues: {}, agentThreads: [], expeditionModules: [], moduleStatuses: {}, earlyOrchestration: null, profileInfo: null, mergeCommits: {}, backend: null, liveAgentUsage: {}, enqueueStatus: null as 'running' | 'complete' | 'failed' | null, enqueueTitle: null, enqueueSource: null };

    case 'BATCH_LOAD': {
      const acc = {
        startTime: null as number | null,
        endTime: null as number | null,
        isComplete: false,
        resultStatus: null as 'completed' | 'failed' | null,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheCreation: 0,
        totalCost: 0,
        planStatuses: {} as Record<string, PipelineStage>,
        fileChanges: new Map<string, string[]>(),
        reviewIssues: {} as Record<string, ReviewIssue[]>,
        agentThreads: [] as AgentThread[],
        expeditionModules: [] as ExpeditionModule[],
        moduleStatuses: {} as Record<string, ModuleStatus>,
        earlyOrchestration: null as OrchestrationConfig | null,
        profileInfo: null as ProfileInfo | null,
        mergeCommits: {} as Record<string, string>,
        backend: null as string | null,
        liveAgentUsage: {} as Record<string, { input: number; output: number; cacheRead: number; cacheCreation: number; cost: number; turns: number }>,
        enqueueStatus: null as 'running' | 'complete' | 'failed' | null,
        enqueueTitle: null as string | null,
        enqueueSource: null as string | null,
      };

      for (const { event } of action.events) {
        processEvent(event, acc);
      }

      // Apply server status as authoritative override when events are incomplete
      if (action.serverStatus && !acc.isComplete) {
        if (action.serverStatus === 'completed' || action.serverStatus === 'failed') {
          acc.isComplete = true;
          acc.resultStatus = action.serverStatus;
        }
      }

      return {
        events: action.events,
        ...acc,
      };
    }

    case 'ADD_EVENT': {
      const { event, eventId } = action;
      const newState: RunState = {
        ...state,
        events: [...state.events, { event, eventId }],
        resultStatus: state.resultStatus,
        planStatuses: { ...state.planStatuses },
        fileChanges: new Map(state.fileChanges),
        reviewIssues: { ...state.reviewIssues },
        agentThreads: [...state.agentThreads],
        expeditionModules: state.expeditionModules,
        moduleStatuses: { ...state.moduleStatuses },
        earlyOrchestration: state.earlyOrchestration,
        profileInfo: state.profileInfo,
        mergeCommits: { ...state.mergeCommits },
        liveAgentUsage: { ...state.liveAgentUsage },
      };

      processEvent(event, newState);

      return newState;
    }

    default:
      return state;
  }
}

export function getSummaryStats(state: RunState): {
  duration: string;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreation: number;
  totalCost: number;
  plansCompleted: number;
  plansFailed: number;
  plansTotal: number;
  totalTurns: number;
  filesChanged: number;
  reviewCritical: number;
  reviewWarning: number;
} {
  const end = state.endTime ?? Date.now();
  const duration = state.startTime
    ? formatDuration(end - state.startTime)
    : '--';

  const statuses = Object.values(state.planStatuses);

  // Sum turns across finalized agent threads only (live agents tracked via liveAgentUsage overlay)
  const liveAgentIds = new Set(Object.keys(state.liveAgentUsage));
  const totalTurns = state.agentThreads.reduce((sum, t) => liveAgentIds.has(t.agentId) ? sum : sum + (t.numTurns ?? 0), 0);

  // Deduplicate file paths across plans using a Set
  const uniqueFiles = new Set<string>();
  for (const files of state.fileChanges.values()) {
    for (const f of files) {
      uniqueFiles.add(f);
    }
  }
  const filesChanged = uniqueFiles.size;

  // Count review issues by severity across all plans
  let reviewCritical = 0;
  let reviewWarning = 0;
  for (const issues of Object.values(state.reviewIssues)) {
    for (const issue of issues) {
      if (issue.severity === 'critical') reviewCritical++;
      else if (issue.severity === 'warning') reviewWarning++;
    }
  }

  // Overlay live agent usage (in-flight agents not yet finalized via agent:result)
  const liveValues = Object.values(state.liveAgentUsage);
  const liveExtra = liveValues.reduce(
    (acc, v) => {
      acc.input += v.input;
      acc.output += v.output;
      acc.cacheRead += v.cacheRead;
      acc.cacheCreation += v.cacheCreation;
      acc.cost += v.cost;
      acc.turns += v.turns;
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0, turns: 0 },
  );

  return {
    duration,
    tokensIn: state.tokensIn + liveExtra.input,
    tokensOut: state.tokensOut + liveExtra.output,
    cacheRead: state.cacheRead + liveExtra.cacheRead,
    cacheCreation: state.cacheCreation + liveExtra.cacheCreation,
    totalCost: state.totalCost + liveExtra.cost,
    plansCompleted: statuses.filter((s) => s === 'complete').length,
    plansFailed: statuses.filter((s) => s === 'failed').length,
    plansTotal: statuses.length,
    totalTurns: totalTurns + liveExtra.turns,
    filesChanged,
    reviewCritical,
    reviewWarning,
  };
}
