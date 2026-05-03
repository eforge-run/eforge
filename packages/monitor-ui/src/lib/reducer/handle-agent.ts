/**
 * Handlers for agent lifecycle events.
 *
 * Owns: agentThreads, liveAgentUsage, tokensIn, tokensOut, cacheRead,
 *       cacheCreation, totalCost.
 *
 * agent:start   — push a new AgentThread with all 11 runtime fields.
 * agent:usage   — non-final: additive delta; final: authoritative replacement.
 *                 Both paths update both liveAgentUsage and the matching thread.
 * agent:result  — finalize token totals (global accumulators), reverse-walk
 *                 thread match by (agent, planId) where durationMs === null,
 *                 then remove liveAgentUsage overlay for that agent.
 * agent:stop    — set thread.endedAt, delete liveAgentUsage entry.
 *
 * Private helpers:
 *   updateThread — finds and immutably patches a thread in the array.
 */
import type { AgentThread } from '../reducer';
import type { EventHandler } from './handler-types';
import { formatThinking } from '../format';

// ---------------------------------------------------------------------------
// Private helper
// ---------------------------------------------------------------------------

/**
 * Immutably updates the LAST thread in `threads` where `predicate` returns true,
 * returning a new array. Returns the original array reference when no match is found.
 */
function updateThread(
  threads: AgentThread[],
  predicate: (t: AgentThread) => boolean,
  patch: Partial<AgentThread>,
): AgentThread[] {
  for (let i = threads.length - 1; i >= 0; i--) {
    if (predicate(threads[i])) {
      return [
        ...threads.slice(0, i),
        { ...threads[i], ...patch },
        ...threads.slice(i + 1),
      ];
    }
  }
  return threads;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const handleAgentStart: EventHandler<'agent:start'> = (event, state) => {
  const thread: AgentThread = {
    agentId: event.agentId,
    agent: event.agent,
    planId: event.planId,
    startedAt: event.timestamp,
    endedAt: null,
    durationMs: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cacheRead: null,
    costUsd: null,
    numTurns: null,
    model: event.model,
    harness: event.harness,
    harnessSource: event.harnessSource,
    effort: event.effort,
    thinking: formatThinking(event.thinking),
    effortClamped: event.effortClamped,
    effortOriginal: event.effortOriginal,
    effortSource: event.effortSource,
    thinkingSource: event.thinkingSource,
    tier: event.tier,
    tierSource: event.tierSource,
    perspective: event.perspective,
  };
  return { agentThreads: [...state.agentThreads, thread] };
};

export const handleAgentUsage: EventHandler<'agent:usage'> = (event, state) => {
  const { agentId, usage, costUsd, numTurns, final } = event;

  if (final === true) {
    // Authoritative cumulative total — last-wins replacement.
    const liveAgentUsage = {
      ...state.liveAgentUsage,
      [agentId]: {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheCreation: usage.cacheCreation,
        cost: costUsd,
        turns: numTurns,
      },
    };
    const agentThreads = updateThread(
      state.agentThreads,
      (t) => t.agentId === agentId,
      {
        inputTokens: usage.input,
        outputTokens: usage.output,
        totalTokens: usage.total,
        cacheRead: usage.cacheRead,
        costUsd,
        numTurns,
      },
    );
    return { liveAgentUsage, agentThreads };
  } else {
    // Per-turn delta — additive into running totals.
    const base = state.liveAgentUsage[agentId] ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      cost: 0,
      turns: 0,
    };
    const liveAgentUsage = {
      ...state.liveAgentUsage,
      [agentId]: {
        input: base.input + usage.input,
        output: base.output + usage.output,
        cacheRead: base.cacheRead + usage.cacheRead,
        cacheCreation: base.cacheCreation + usage.cacheCreation,
        cost: base.cost + costUsd,
        turns: base.turns + numTurns,
      },
    };
    // Find the most recent thread for this agent (reverse scan) to compute deltas.
    let lastThread: AgentThread | undefined;
    for (let i = state.agentThreads.length - 1; i >= 0; i--) {
      if (state.agentThreads[i].agentId === agentId) {
        lastThread = state.agentThreads[i];
        break;
      }
    }
    const threadPatch: Partial<AgentThread> = lastThread
      ? (() => {
          const nextInput = (lastThread.inputTokens ?? 0) + usage.input;
          const nextOutput = (lastThread.outputTokens ?? 0) + usage.output;
          return {
            inputTokens: nextInput,
            outputTokens: nextOutput,
            // Derive total from running sums; don't trust the delta's `total` field.
            totalTokens: nextInput + nextOutput,
            cacheRead: (lastThread.cacheRead ?? 0) + usage.cacheRead,
            costUsd: (lastThread.costUsd ?? 0) + costUsd,
            numTurns: (lastThread.numTurns ?? 0) + numTurns,
          };
        })()
      : {};
    const agentThreads = updateThread(
      state.agentThreads,
      (t) => t.agentId === agentId,
      threadPatch,
    );
    return { liveAgentUsage, agentThreads };
  }
};

export const handleAgentResult: EventHandler<'agent:result'> = (event, state) => {
  const { result } = event;

  // Global token accumulation
  const tokensIn = state.tokensIn + (result.usage?.input ?? 0);
  const tokensOut = state.tokensOut + (result.usage?.output ?? 0);
  const cacheRead = state.cacheRead + (result.usage?.cacheRead ?? 0);
  const cacheCreation = state.cacheCreation + (result.usage?.cacheCreation ?? 0);
  const totalCost = state.totalCost + (result.totalCostUsd ?? 0);

  // Reverse-walk: find most recent thread matching (agent, planId) where durationMs === null
  const agentRole = event.agent;
  const eventPlanId = event.planId;
  let matchIdx = -1;
  for (let i = state.agentThreads.length - 1; i >= 0; i--) {
    const t = state.agentThreads[i];
    if (t.agent === agentRole && t.planId === eventPlanId && t.durationMs === null) {
      matchIdx = i;
      break;
    }
  }

  if (matchIdx === -1) {
    return { tokensIn, tokensOut, cacheRead, cacheCreation, totalCost };
  }

  const matchedThread = state.agentThreads[matchIdx];
  const updatedThread: AgentThread = {
    ...matchedThread,
    durationMs: result.durationMs,
    inputTokens: result.usage?.input ?? null,
    outputTokens: result.usage?.output ?? null,
    totalTokens: result.usage?.total ?? null,
    cacheRead: result.usage?.cacheRead ?? null,
    costUsd: result.totalCostUsd ?? null,
    numTurns: result.numTurns ?? null,
  };

  const agentThreads = [
    ...state.agentThreads.slice(0, matchIdx),
    updatedThread,
    ...state.agentThreads.slice(matchIdx + 1),
  ];

  // Remove live usage overlay — finalized totals are now in agent:result
  const liveAgentUsage = { ...state.liveAgentUsage };
  delete liveAgentUsage[matchedThread.agentId];

  return { tokensIn, tokensOut, cacheRead, cacheCreation, totalCost, agentThreads, liveAgentUsage };
};

export const handleAgentStop: EventHandler<'agent:stop'> = (event, state) => {
  const agentThreads = updateThread(
    state.agentThreads,
    (t) => t.agentId === event.agentId,
    { endedAt: event.timestamp },
  );
  const liveAgentUsage = { ...state.liveAgentUsage };
  delete liveAgentUsage[event.agentId];
  return { agentThreads, liveAgentUsage };
};
