import { describe, it, expect } from 'vitest';
import {
  resolveBuildStage,
  getBuildStageStatuses,
  buildStageName,
} from '../agent-stage-map';
import type { BuildStageSpec } from '@/lib/types';
import type { AgentThread } from '@/lib/reducer';

function makeThread(overrides: Partial<AgentThread> = {}): AgentThread {
  return {
    agentId: 'a1',
    agent: 'builder',
    planId: 'plan-01',
    startedAt: '2024-01-15T10:00:00.000Z',
    endedAt: null,
    durationMs: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cacheRead: null,
    costUsd: null,
    numTurns: null,
    model: 'claude-sonnet',
    ...overrides,
  };
}

describe('buildStageName', () => {
  it('returns the string as-is for a simple stage', () => {
    expect(buildStageName('implement')).toBe('implement');
    expect(buildStageName('review')).toBe('review');
    expect(buildStageName('test')).toBe('test');
  });

  it('joins parallel group stages with "+" for array specs', () => {
    expect(buildStageName(['review', 'evaluate'] as BuildStageSpec)).toBe('review+evaluate');
    expect(buildStageName(['test', 'evaluate'] as BuildStageSpec)).toBe('test+evaluate');
  });
});

describe('resolveBuildStage', () => {
  it('returns the raw stage when buildStages is empty', () => {
    expect(resolveBuildStage('review', [])).toBe('review');
    expect(resolveBuildStage('review', undefined)).toBe('review');
  });

  it('returns the raw stage when it directly matches a build stage', () => {
    const buildStages: BuildStageSpec[] = ['implement', 'review'];
    expect(resolveBuildStage('review', buildStages)).toBe('review');
    expect(resolveBuildStage('implement', buildStages)).toBe('implement');
  });

  it('resolves "review" to "review-cycle" when review-cycle is in buildStages', () => {
    const buildStages: BuildStageSpec[] = ['implement', 'review-cycle'];
    expect(resolveBuildStage('review', buildStages)).toBe('review-cycle');
  });

  it('resolves "evaluate" to "review-cycle" when review-cycle is in buildStages', () => {
    const buildStages: BuildStageSpec[] = ['implement', 'review-cycle'];
    expect(resolveBuildStage('evaluate', buildStages)).toBe('review-cycle');
  });

  it('resolves "test" to "test-cycle" when test-cycle is in buildStages', () => {
    const buildStages: BuildStageSpec[] = ['implement', 'test-cycle'];
    expect(resolveBuildStage('test', buildStages)).toBe('test-cycle');
  });

  it('resolves "evaluate" to "test-cycle" when test-cycle is in buildStages', () => {
    const buildStages: BuildStageSpec[] = ['implement', 'test-cycle'];
    expect(resolveBuildStage('evaluate', buildStages)).toBe('test-cycle');
  });

  it('does not resolve to composite when composite is not in buildStages', () => {
    const buildStages: BuildStageSpec[] = ['implement', 'review', 'evaluate'];
    expect(resolveBuildStage('review', buildStages)).toBe('review');
    expect(resolveBuildStage('evaluate', buildStages)).toBe('evaluate');
  });
});

describe('getBuildStageStatuses', () => {
  const stages: BuildStageSpec[] = ['implement', 'review-cycle', 'validate'];

  it('returns all pending when no currentStage', () => {
    const statuses = getBuildStageStatuses(stages, undefined);
    expect(statuses).toEqual(['pending', 'pending', 'pending']);
  });

  it('returns all completed when currentStage is "complete"', () => {
    const statuses = getBuildStageStatuses(stages, 'complete');
    expect(statuses).toEqual(['completed', 'completed', 'completed']);
  });

  it('marks stages before current as completed and current as active', () => {
    // currentStage 'review' maps to 'review-cycle' (index 1)
    const statuses = getBuildStageStatuses(stages, 'review');
    expect(statuses[0]).toBe('completed'); // implement
    expect(statuses[1]).toBe('active');    // review-cycle
    expect(statuses[2]).toBe('pending');   // validate
  });

  it('marks implement as active when currentStage is "implement"', () => {
    const statuses = getBuildStageStatuses(stages, 'implement');
    expect(statuses[0]).toBe('active');
    expect(statuses[1]).toBe('pending');
    expect(statuses[2]).toBe('pending');
  });

  it('marks the furthest-reached stage as failed and prior stages as completed on "failed"', () => {
    const threads = [makeThread({ agent: 'reviewer' })]; // reviewer → 'review' → 'review-cycle' at index 1
    const statuses = getBuildStageStatuses(stages, 'failed', threads);
    expect(statuses[0]).toBe('completed'); // implement
    expect(statuses[1]).toBe('failed');    // review-cycle
    expect(statuses[2]).toBe('pending');   // validate
  });

  it('falls back to last stage as failed when no thread data available', () => {
    const statuses = getBuildStageStatuses(stages, 'failed', []);
    expect(statuses[0]).toBe('completed');
    expect(statuses[1]).toBe('completed');
    expect(statuses[2]).toBe('failed');
  });

  it('handles parallel group build stages', () => {
    const parallelStages: BuildStageSpec[] = ['implement', ['review', 'evaluate'], 'validate'];
    // currentStage 'review' is part of the parallel group at index 1
    const statuses = getBuildStageStatuses(parallelStages, 'review');
    expect(statuses[0]).toBe('completed'); // implement
    expect(statuses[1]).toBe('active');    // ['review','evaluate'] group
    expect(statuses[2]).toBe('pending');   // validate
  });
});
