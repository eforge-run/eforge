import type { EforgeEvent } from './types';
import type { PipelineStage } from './types';
import type { WaveInfo } from './wave-utils';
import { formatDuration } from './format';

export interface StoredEvent {
  event: EforgeEvent;
  eventId: string;
}

export interface RunState {
  events: StoredEvent[];
  startTime: number | null;
  planStatuses: Record<string, PipelineStage>;
  waves: WaveInfo[];
  tokensIn: number;
  tokensOut: number;
  totalCost: number;
  isComplete: boolean;
}

export const initialRunState: RunState = {
  events: [],
  startTime: null,
  planStatuses: {},
  waves: [],
  tokensIn: 0,
  tokensOut: 0,
  totalCost: 0,
  isComplete: false,
};

export type RunAction =
  | { type: 'ADD_EVENT'; event: EforgeEvent; eventId: string }
  | { type: 'RESET' };

export function eforgeReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case 'RESET':
      return { ...initialRunState };

    case 'ADD_EVENT': {
      const { event, eventId } = action;
      const newState = {
        ...state,
        events: [...state.events, { event, eventId }],
      };

      // Track start time
      if (event.type === 'eforge:start' && 'timestamp' in event) {
        newState.startTime = new Date(event.timestamp).getTime();
      }

      // Track completion
      if (event.type === 'eforge:end') {
        newState.isComplete = true;
      }

      // Accumulate tokens and cost
      if (event.type === 'agent:result' && event.result) {
        newState.tokensIn = state.tokensIn + (event.result.usage?.input || 0);
        newState.tokensOut = state.tokensOut + (event.result.usage?.output || 0);
        newState.totalCost = state.totalCost + (event.result.totalCostUsd || 0);
      }

      // Track waves
      if (event.type === 'wave:start') {
        newState.waves = [
          ...state.waves,
          { wave: event.wave, planIds: event.planIds },
        ];
      }

      // Track plan statuses
      const planId = 'planId' in event ? (event as { planId?: string }).planId : undefined;
      if (planId) {
        const planStatuses = { ...state.planStatuses };
        switch (event.type) {
          case 'build:start':
          case 'build:implement:start':
            planStatuses[planId] = 'implement';
            break;
          case 'build:implement:complete':
          case 'build:review:start':
            planStatuses[planId] = 'review';
            break;
          case 'build:review:complete':
          case 'build:evaluate:start':
            planStatuses[planId] = 'evaluate';
            break;
          case 'build:complete':
            planStatuses[planId] = 'complete';
            break;
          case 'build:failed':
            planStatuses[planId] = 'failed';
            break;
        }
        newState.planStatuses = planStatuses;
      }

      return newState;
    }

    default:
      return state;
  }
}

export function getSummaryStats(state: RunState): {
  duration: string;
  eventCount: number;
  tokensIn: number;
  tokensOut: number;
  totalCost: number;
  plansCompleted: number;
  plansFailed: number;
  plansTotal: number;
} {
  const duration = state.startTime
    ? formatDuration(Date.now() - state.startTime)
    : '--';

  const statuses = Object.values(state.planStatuses);
  return {
    duration,
    eventCount: state.events.length,
    tokensIn: state.tokensIn,
    tokensOut: state.tokensOut,
    totalCost: state.totalCost,
    plansCompleted: statuses.filter((s) => s === 'complete').length,
    plansFailed: statuses.filter((s) => s === 'failed').length,
    plansTotal: statuses.length,
  };
}
