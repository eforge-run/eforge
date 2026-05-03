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
 * Dispatch is O(1) via the handler registry in `./reducer/index`. Each handler
 * narrows on `event.type` (discriminated union — no casts, no `'in' event`
 * guards) and returns a `Partial<RunState>` delta describing only the slices it
 * mutated. Only those slices are spread into the next state; unrelated containers
 * keep the same ref across events so downstream `React.memo` fires only when the
 * relevant container actually changed.
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
import type { EforgeEvent, ExpeditionModule, OrchestrationConfig, SessionProfile, ReviewIssue } from './types';
import type { PipelineStage } from './types';
import { formatDuration } from './format';
import { handlerRegistry } from './reducer/index';

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
  /** The harness kind for this tier entry. */
  harness?: string;
  /** Provenance source for harness — "tier", "role", or "plan". */
  harnessSource?: string;
  effort?: string;
  thinking?: string;
  effortClamped?: boolean;
  effortOriginal?: string;
  effortSource?: string;
  thinkingSource?: string;
  tier?: string;
  tierSource?: string;
  perspective?: string;
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
  profile: SessionProfile | null;
  endTime: number | null;
  mergeCommits: Record<string, string>;
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
  profile: null,
  endTime: null,
  mergeCommits: {},
  liveAgentUsage: {},
  enqueueStatus: null,
  enqueueTitle: null,
  enqueueSource: null,
};

export type RunAction =
  | { type: 'ADD_EVENT'; event: EforgeEvent; eventId: string }
  | { type: 'BATCH_LOAD'; events: Array<{ event: EforgeEvent; eventId: string }>; serverStatus?: string }
  | { type: 'RESET' };

export function eforgeReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case 'RESET':
      return { ...initialRunState, fileChanges: new Map(), reviewIssues: {}, agentThreads: [], expeditionModules: [], moduleStatuses: {}, earlyOrchestration: null, profile: null, mergeCommits: {}, liveAgentUsage: {}, enqueueStatus: null as 'running' | 'complete' | 'failed' | null, enqueueTitle: null, enqueueSource: null };

    case 'BATCH_LOAD': {
      // Replay all events through the handler registry, accumulating state.
      // Handlers are called with a running accumulator (not the original state).
      // events is set at the end from action.events to avoid O(n²) array growth.
      let acc: RunState = {
        ...initialRunState,
        fileChanges: new Map(),
        events: [],
      };

      for (const { event } of action.events) {
        const handler = (handlerRegistry as Record<string, ((e: never, s: Readonly<RunState>) => Partial<RunState> | undefined) | undefined>)[event.type];
        const delta = handler ? handler(event as never, acc) : undefined;
        if (delta) {
          acc = { ...acc, ...delta };
        }
      }

      // Apply server status as authoritative override when events are incomplete
      if (action.serverStatus && !acc.isComplete) {
        if (action.serverStatus === 'completed' || action.serverStatus === 'failed') {
          acc = { ...acc, isComplete: true, resultStatus: action.serverStatus };
        }
      }

      return { ...acc, events: action.events };
    }

    case 'ADD_EVENT': {
      const { event, eventId } = action;
      const handler = (handlerRegistry as Record<string, ((e: never, s: Readonly<RunState>) => Partial<RunState> | undefined) | undefined>)[event.type];
      const delta = handler ? handler(event as never, state) : undefined;
      const events = [...state.events, { event, eventId }];
      return delta ? { ...state, events, ...delta } : { ...state, events };
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
