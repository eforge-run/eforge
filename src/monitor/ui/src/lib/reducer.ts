import type { EforgeEvent, ExpeditionModule, OrchestrationConfig, ReviewIssue } from './types';
import type { PipelineStage } from './types';
import { formatDuration } from './format';

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
}

export interface RunState {
  events: StoredEvent[];
  startTime: number | null;
  planStatuses: Record<string, PipelineStage>;
  tokensIn: number;
  tokensOut: number;
  totalCost: number;
  isComplete: boolean;
  resultStatus: 'completed' | 'failed' | null;
  fileChanges: Map<string, string[]>;
  reviewIssues: Record<string, ReviewIssue[]>;
  agentThreads: AgentThread[];
  expeditionModules: ExpeditionModule[];
  moduleStatuses: Record<string, ModuleStatus>;
  earlyOrchestration: OrchestrationConfig | null;
  endTime: number | null;
}

export const initialRunState: RunState = {
  events: [],
  startTime: null,
  planStatuses: {},
  tokensIn: 0,
  tokensOut: 0,
  totalCost: 0,
  isComplete: false,
  resultStatus: null,
  fileChanges: new Map(),
  reviewIssues: {},
  agentThreads: [],
  expeditionModules: [],
  moduleStatuses: {},
  earlyOrchestration: null,
  endTime: null,
};

export type RunAction =
  | { type: 'ADD_EVENT'; event: EforgeEvent; eventId: string }
  | { type: 'BATCH_LOAD'; events: Array<{ event: EforgeEvent; eventId: string }> }
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
    totalCost: number;
    planStatuses: Record<string, PipelineStage>;
    fileChanges: Map<string, string[]>;
    reviewIssues: Record<string, ReviewIssue[]>;
    agentThreads: AgentThread[];
    expeditionModules: ExpeditionModule[];
    moduleStatuses: Record<string, ModuleStatus>;
    earlyOrchestration: OrchestrationConfig | null;
  },
): void {
  if (event.type === 'phase:start' && 'timestamp' in event && state.startTime === null) {
    state.startTime = new Date(event.timestamp).getTime();
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
    state.totalCost += event.result.totalCostUsd || 0;
  }

  if (event.type === 'plan:complete' && 'plans' in event) {
    const plans = (event as { plans: Array<{ id: string }> }).plans;
    for (const plan of plans) {
      state.planStatuses[plan.id] = 'plan';
    }
  }

  const planId = 'planId' in event ? (event as { planId?: string }).planId : undefined;
  if (planId) {
    switch (event.type) {
      case 'build:start':
      case 'build:implement:start':
        state.planStatuses[planId] = 'implement';
        break;
      case 'build:doc-update:start':
      case 'build:doc-update:complete':
        // Doc-update runs in parallel with implement — don't advance stage
        break;
      case 'build:implement:complete':
      case 'build:review:start':
        state.planStatuses[planId] = 'review';
        break;
      case 'build:review:complete':
      case 'build:evaluate:start':
        state.planStatuses[planId] = 'evaluate';
        break;
      case 'build:complete':
        state.planStatuses[planId] = 'complete';
        break;
      case 'build:failed':
        state.planStatuses[planId] = 'failed';
        break;
    }
  }

  if (event.type === 'build:review:complete' && 'planId' in event && 'issues' in event) {
    state.reviewIssues[(event as { planId: string }).planId] = (event as { issues: ReviewIssue[] }).issues;
  }

  if (event.type === 'build:files_changed' && 'files' in event) {
    state.fileChanges.set(event.planId, event.files);
  }

  if (event.type === 'merge:complete' && planId) {
    state.planStatuses[planId] = 'complete';
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
      plans: event.modules.map((mod) => ({
        id: mod.id,
        name: mod.description,
        dependsOn: mod.dependsOn,
        branch: '',
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
    state.agentThreads.push({
      agentId: event.agentId,
      agent: event.agent,
      planId: 'planId' in event ? (event as { planId?: string }).planId : undefined,
      startedAt: event.timestamp,
      endedAt: null,
      durationMs: null,
    });
  }

  if (event.type === 'agent:stop' && 'timestamp' in event && event.timestamp) {
    const thread = state.agentThreads.find((t) => t.agentId === event.agentId);
    if (thread) {
      thread.endedAt = event.timestamp;
    }
  }

  if (event.type === 'agent:result' && event.result) {
    const agentRole = event.agent;
    const eventPlanId = 'planId' in event ? (event as { planId?: string }).planId : undefined;
    // Find most recent thread matching (agent, planId) where durationMs is null
    for (let i = state.agentThreads.length - 1; i >= 0; i--) {
      const thread = state.agentThreads[i];
      if (thread.agent === agentRole && thread.planId === eventPlanId && thread.durationMs === null) {
        thread.durationMs = event.result.durationMs;
        break;
      }
    }
  }
}

export function eforgeReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case 'RESET':
      return { ...initialRunState, fileChanges: new Map(), reviewIssues: {}, agentThreads: [], expeditionModules: [], moduleStatuses: {}, earlyOrchestration: null };

    case 'BATCH_LOAD': {
      const acc = {
        startTime: null as number | null,
        endTime: null as number | null,
        isComplete: false,
        resultStatus: null as 'completed' | 'failed' | null,
        tokensIn: 0,
        tokensOut: 0,
        totalCost: 0,
        planStatuses: {} as Record<string, PipelineStage>,
        fileChanges: new Map<string, string[]>(),
        reviewIssues: {} as Record<string, ReviewIssue[]>,
        agentThreads: [] as AgentThread[],
        expeditionModules: [] as ExpeditionModule[],
        moduleStatuses: {} as Record<string, ModuleStatus>,
        earlyOrchestration: null as OrchestrationConfig | null,
      };

      for (const { event } of action.events) {
        processEvent(event, acc);
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
  totalCost: number;
  plansCompleted: number;
  plansFailed: number;
  plansTotal: number;
} {
  const end = state.endTime ?? Date.now();
  const duration = state.startTime
    ? formatDuration(end - state.startTime)
    : '--';

  const statuses = Object.values(state.planStatuses);
  return {
    duration,
    tokensIn: state.tokensIn,
    tokensOut: state.tokensOut,
    totalCost: state.totalCost,
    plansCompleted: statuses.filter((s) => s === 'complete').length,
    plansFailed: statuses.filter((s) => s === 'failed').length,
    plansTotal: statuses.length,
  };
}
