/**
 * Wire parity tests for EforgeEventSchema.
 *
 * Fixture-driven tests that exercise representative valid payloads for every
 * discriminant variant and confirm that known-bad payloads are rejected with
 * useful error messages.
 *
 * These tests guard against accidental schema drift when migrating from Zod to
 * TypeBox: the wire shapes must remain identical.
 */

import { describe, it, expect } from 'vitest';
import { safeParseEforgeEvent } from '../events.schemas.js';

// ---------------------------------------------------------------------------
// Valid payloads — one representative per discriminant variant group
// ---------------------------------------------------------------------------

const validPayloads: Array<{ label: string; payload: unknown }> = [
  // Session lifecycle
  {
    label: 'session:start',
    payload: { type: 'session:start', timestamp: '2025-01-01T00:00:00.000Z', sessionId: 'sess-1' },
  },
  {
    label: 'session:end',
    payload: {
      type: 'session:end',
      timestamp: '2025-01-01T00:01:00.000Z',
      sessionId: 'sess-1',
      result: { status: 'completed', summary: 'all plans merged' },
    },
  },
  {
    label: 'session:profile',
    payload: {
      type: 'session:profile',
      timestamp: '2025-01-01T00:00:00.000Z',
      profileName: 'default',
      source: 'project',
      scope: 'project',
      config: null,
    },
  },

  // Phase lifecycle
  {
    label: 'phase:start',
    payload: {
      type: 'phase:start',
      timestamp: '2025-01-01T00:00:00.000Z',
      runId: 'run-1',
      planSet: 'my-set',
      command: 'build',
    },
  },
  {
    label: 'phase:end',
    payload: {
      type: 'phase:end',
      timestamp: '2025-01-01T00:01:00.000Z',
      runId: 'run-1',
      result: { status: 'completed', summary: 'done' },
    },
  },

  // Config and plan warnings
  {
    label: 'config:warning',
    payload: {
      type: 'config:warning',
      timestamp: '2025-01-01T00:00:00.000Z',
      message: 'unknown key',
      source: 'eforge.yaml',
    },
  },
  {
    label: 'planning:warning',
    payload: {
      type: 'planning:warning',
      timestamp: '2025-01-01T00:00:00.000Z',
      message: 'plan too large',
      source: 'planner',
    },
  },
  {
    label: 'planning:module:build-config:invalid',
    payload: {
      type: 'planning:module:build-config:invalid',
      timestamp: '2025-01-01T00:00:00.000Z',
      moduleId: 'mod-1',
      reason: 'invalid-json',
      errors: ['unexpected token'],
    },
  },
  // --- eforge:region plan-01-native-event-runtime-foundation ---
  {
    label: 'extension:event-handler:failed',
    payload: {
      type: 'extension:event-handler:failed',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionName: 'audit-log',
      extensionPath: '/project/.eforge/extensions/audit-log.js',
      pattern: 'plan:build:*',
      triggeringEventType: 'plan:build:failed',
      message: 'boom',
      stack: 'Error: boom',
    },
  },
  {
    label: 'extension:event-handler:timeout',
    payload: {
      type: 'extension:event-handler:timeout',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionName: 'audit-log',
      extensionPath: '/project/.eforge/extensions/audit-log.js',
      pattern: '*',
      triggeringEventType: 'plan:build:complete',
      timeoutMs: 5000,
    },
  },
  // --- eforge:endregion plan-01-native-event-runtime-foundation ---

  // Planning
  {
    label: 'planning:start',
    payload: { type: 'planning:start', timestamp: '2025-01-01T00:00:00.000Z', source: 'cli' },
  },
  {
    label: 'planning:skip',
    payload: { type: 'planning:skip', timestamp: '2025-01-01T00:00:00.000Z', reason: 'already planned' },
  },
  {
    label: 'planning:submission',
    payload: {
      type: 'planning:submission',
      timestamp: '2025-01-01T00:00:00.000Z',
      planCount: 3,
      totalBodySize: 12000,
      hasMigrations: false,
    },
  },
  {
    label: 'planning:error',
    payload: { type: 'planning:error', timestamp: '2025-01-01T00:00:00.000Z', reason: 'timeout' },
  },
  {
    label: 'planning:clarification',
    payload: {
      type: 'planning:clarification',
      timestamp: '2025-01-01T00:00:00.000Z',
      questions: [{ id: 'q1', question: 'what scope?' }],
    },
  },
  {
    label: 'planning:clarification:answer',
    payload: {
      type: 'planning:clarification:answer',
      timestamp: '2025-01-01T00:00:00.000Z',
      answers: { q1: 'excursion' },
    },
  },
  {
    label: 'planning:progress',
    payload: {
      type: 'planning:progress',
      timestamp: '2025-01-01T00:00:00.000Z',
      message: 'Writing plan 1 of 3',
    },
  },
  {
    label: 'planning:continuation',
    payload: {
      type: 'planning:continuation',
      timestamp: '2025-01-01T00:00:00.000Z',
      attempt: 1,
      maxContinuations: 3,
    },
  },
  {
    label: 'planning:pipeline',
    payload: {
      type: 'planning:pipeline',
      timestamp: '2025-01-01T00:00:00.000Z',
      scope: 'excursion',
      compile: ['planner'],
      defaultBuild: ['builder', 'reviewer'],
      defaultReview: {
        strategy: 'auto',
        perspectives: ['code'],
        maxRounds: 2,
        evaluatorStrictness: 'standard',
      },
      rationale: 'small scope',
    },
  },
  {
    label: 'planning:complete',
    payload: {
      type: 'planning:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      plans: [
        {
          id: 'plan-01',
          name: 'Plan 01',
          dependsOn: [],
          branch: 'feat/plan-01',
          body: '# Plan 01',
          filePath: '.eforge/plans/plan-01.md',
        },
      ],
    },
  },

  // Planning review
  {
    label: 'planning:review:start',
    payload: { type: 'planning:review:start', timestamp: '2025-01-01T00:00:00.000Z' },
  },
  {
    label: 'planning:review:complete',
    payload: {
      type: 'planning:review:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      issues: [],
    },
  },
  {
    label: 'planning:evaluate:start',
    payload: { type: 'planning:evaluate:start', timestamp: '2025-01-01T00:00:00.000Z' },
  },
  {
    label: 'planning:evaluate:continuation',
    payload: {
      type: 'planning:evaluate:continuation',
      timestamp: '2025-01-01T00:00:00.000Z',
      attempt: 1,
      maxContinuations: 2,
    },
  },
  {
    label: 'planning:evaluate:complete',
    payload: {
      type: 'planning:evaluate:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      accepted: 3,
      rejected: 0,
    },
  },

  // Architecture review
  {
    label: 'planning:architecture:review:start',
    payload: { type: 'planning:architecture:review:start', timestamp: '2025-01-01T00:00:00.000Z' },
  },
  {
    label: 'planning:architecture:review:complete',
    payload: {
      type: 'planning:architecture:review:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      issues: [],
    },
  },
  {
    label: 'planning:architecture:evaluate:start',
    payload: { type: 'planning:architecture:evaluate:start', timestamp: '2025-01-01T00:00:00.000Z' },
  },
  {
    label: 'planning:architecture:evaluate:continuation',
    payload: {
      type: 'planning:architecture:evaluate:continuation',
      timestamp: '2025-01-01T00:00:00.000Z',
      attempt: 1,
      maxContinuations: 2,
    },
  },
  {
    label: 'planning:architecture:evaluate:complete',
    payload: {
      type: 'planning:architecture:evaluate:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      accepted: 2,
      rejected: 0,
    },
  },

  // Cohesion review
  {
    label: 'planning:cohesion:start',
    payload: { type: 'planning:cohesion:start', timestamp: '2025-01-01T00:00:00.000Z' },
  },
  {
    label: 'planning:cohesion:complete',
    payload: {
      type: 'planning:cohesion:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      issues: [],
    },
  },
  {
    label: 'planning:cohesion:evaluate:start',
    payload: { type: 'planning:cohesion:evaluate:start', timestamp: '2025-01-01T00:00:00.000Z' },
  },
  {
    label: 'planning:cohesion:evaluate:continuation',
    payload: {
      type: 'planning:cohesion:evaluate:continuation',
      timestamp: '2025-01-01T00:00:00.000Z',
      attempt: 1,
      maxContinuations: 2,
    },
  },
  {
    label: 'planning:cohesion:evaluate:complete',
    payload: {
      type: 'planning:cohesion:evaluate:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      accepted: 1,
      rejected: 0,
    },
  },

  // Building (per-plan)
  {
    label: 'plan:build:start',
    payload: { type: 'plan:build:start', timestamp: '2025-01-01T00:00:00.000Z', planId: 'plan-01' },
  },
  {
    label: 'plan:build:implement:start',
    payload: { type: 'plan:build:implement:start', timestamp: '2025-01-01T00:00:00.000Z', planId: 'plan-01' },
  },
  {
    label: 'plan:build:implement:progress',
    payload: {
      type: 'plan:build:implement:progress',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      message: 'writing files',
    },
  },
  {
    label: 'plan:build:implement:continuation',
    payload: {
      type: 'plan:build:implement:continuation',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      attempt: 1,
      maxContinuations: 3,
    },
  },
  {
    label: 'plan:build:implement:complete',
    payload: { type: 'plan:build:implement:complete', timestamp: '2025-01-01T00:00:00.000Z', planId: 'plan-01' },
  },
  {
    label: 'plan:build:files_changed',
    payload: {
      type: 'plan:build:files_changed',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      files: ['src/foo.ts'],
    },
  },
  {
    label: 'plan:build:review:start',
    payload: { type: 'plan:build:review:start', timestamp: '2025-01-01T00:00:00.000Z', planId: 'plan-01' },
  },
  {
    label: 'plan:build:review:complete',
    payload: {
      type: 'plan:build:review:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      issues: [],
    },
  },
  {
    label: 'plan:build:review:parallel:start',
    payload: {
      type: 'plan:build:review:parallel:start',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      perspectives: ['code', 'security'],
    },
  },
  {
    label: 'plan:build:review:parallel:perspective:start',
    payload: {
      type: 'plan:build:review:parallel:perspective:start',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      perspective: 'code',
    },
  },
  {
    label: 'plan:build:review:parallel:perspective:complete',
    payload: {
      type: 'plan:build:review:parallel:perspective:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      perspective: 'code',
      issues: [],
    },
  },
  {
    label: 'plan:build:review:parallel:perspective:error',
    payload: {
      type: 'plan:build:review:parallel:perspective:error',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      perspective: 'security',
      error: 'agent timeout',
    },
  },
  {
    label: 'plan:build:review:fix:start',
    payload: {
      type: 'plan:build:review:fix:start',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      issueCount: 3,
    },
  },
  {
    label: 'plan:build:review:fix:complete',
    payload: { type: 'plan:build:review:fix:complete', timestamp: '2025-01-01T00:00:00.000Z', planId: 'plan-01' },
  },
  {
    label: 'plan:build:evaluate:start',
    payload: { type: 'plan:build:evaluate:start', timestamp: '2025-01-01T00:00:00.000Z', planId: 'plan-01' },
  },
  {
    label: 'plan:build:evaluate:continuation',
    payload: {
      type: 'plan:build:evaluate:continuation',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      attempt: 1,
      maxContinuations: 2,
    },
  },
  {
    label: 'plan:build:evaluate:complete',
    payload: {
      type: 'plan:build:evaluate:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      accepted: 5,
      rejected: 0,
    },
  },
  {
    label: 'plan:build:doc-author:start',
    payload: { type: 'plan:build:doc-author:start', timestamp: '2025-01-01T00:00:00.000Z', planId: 'plan-01' },
  },
  {
    label: 'plan:build:doc-author:complete',
    payload: {
      type: 'plan:build:doc-author:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      docsAuthored: 2,
    },
  },
  {
    label: 'plan:build:doc-sync:start',
    payload: { type: 'plan:build:doc-sync:start', timestamp: '2025-01-01T00:00:00.000Z', planId: 'plan-01' },
  },
  {
    label: 'plan:build:doc-sync:complete',
    payload: {
      type: 'plan:build:doc-sync:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      docsSynced: 1,
    },
  },
  {
    label: 'plan:build:test:write:start',
    payload: { type: 'plan:build:test:write:start', timestamp: '2025-01-01T00:00:00.000Z', planId: 'plan-01' },
  },
  {
    label: 'plan:build:test:write:complete',
    payload: {
      type: 'plan:build:test:write:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      testsWritten: 4,
    },
  },
  {
    label: 'plan:build:test:start',
    payload: { type: 'plan:build:test:start', timestamp: '2025-01-01T00:00:00.000Z', planId: 'plan-01' },
  },
  {
    label: 'plan:build:test:complete',
    payload: {
      type: 'plan:build:test:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      passed: 10,
      failed: 0,
      testBugsFixed: 0,
      productionIssues: [],
    },
  },
  {
    label: 'plan:build:complete',
    payload: { type: 'plan:build:complete', timestamp: '2025-01-01T00:00:00.000Z', planId: 'plan-01' },
  },
  {
    label: 'plan:build:failed',
    payload: {
      type: 'plan:build:failed',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      error: 'agent exceeded max turns',
    },
  },
  {
    label: 'plan:build:progress',
    payload: {
      type: 'plan:build:progress',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      message: 'running tests',
    },
  },

  // Plan lifecycle state events
  {
    label: 'plan:status:change',
    payload: {
      type: 'plan:status:change',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      status: 'running',
    },
  },
  {
    label: 'plan:error:set',
    payload: {
      type: 'plan:error:set',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      error: 'build failed',
    },
  },
  {
    label: 'plan:error:clear',
    payload: { type: 'plan:error:clear', timestamp: '2025-01-01T00:00:00.000Z', planId: 'plan-01' },
  },

  // Orchestration
  {
    label: 'schedule:start',
    payload: {
      type: 'schedule:start',
      timestamp: '2025-01-01T00:00:00.000Z',
      planIds: ['plan-01', 'plan-02'],
    },
  },
  {
    label: 'plan:schedule:ready',
    payload: {
      type: 'plan:schedule:ready',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      reason: 'deps satisfied',
    },
  },
  {
    label: 'plan:merge:start',
    payload: { type: 'plan:merge:start', timestamp: '2025-01-01T00:00:00.000Z', planId: 'plan-01' },
  },
  {
    label: 'plan:merge:complete',
    payload: {
      type: 'plan:merge:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      commitSha: 'abc123',
    },
  },
  {
    label: 'plan:merge:resolve:start',
    payload: { type: 'plan:merge:resolve:start', timestamp: '2025-01-01T00:00:00.000Z', planId: 'plan-01' },
  },
  {
    label: 'plan:merge:resolve:complete',
    payload: {
      type: 'plan:merge:resolve:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      resolved: true,
    },
  },
  {
    label: 'merge:finalize:start',
    payload: {
      type: 'merge:finalize:start',
      timestamp: '2025-01-01T00:00:00.000Z',
      featureBranch: 'feat/my-set',
      baseBranch: 'main',
    },
  },
  {
    label: 'merge:finalize:complete',
    payload: {
      type: 'merge:finalize:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      featureBranch: 'feat/my-set',
      baseBranch: 'main',
    },
  },
  {
    label: 'merge:finalize:skipped',
    payload: {
      type: 'merge:finalize:skipped',
      timestamp: '2025-01-01T00:00:00.000Z',
      featureBranch: 'feat/my-set',
      baseBranch: 'main',
      reason: 'nothing to merge',
    },
  },
  {
    label: 'merge:worktree:set',
    payload: {
      type: 'merge:worktree:set',
      timestamp: '2025-01-01T00:00:00.000Z',
      path: '/tmp/merge-worktree',
    },
  },
  {
    label: 'merge:worktree:clear',
    payload: { type: 'merge:worktree:clear', timestamp: '2025-01-01T00:00:00.000Z' },
  },

  // Expedition planning phases
  {
    label: 'expedition:architecture:complete',
    payload: {
      type: 'expedition:architecture:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      modules: [{ id: 'mod-1', description: 'core', dependsOn: [] }],
    },
  },
  {
    label: 'expedition:wave:start',
    payload: {
      type: 'expedition:wave:start',
      timestamp: '2025-01-01T00:00:00.000Z',
      wave: 1,
      moduleIds: ['mod-1'],
    },
  },
  {
    label: 'expedition:wave:complete',
    payload: { type: 'expedition:wave:complete', timestamp: '2025-01-01T00:00:00.000Z', wave: 1 },
  },
  {
    label: 'expedition:module:start',
    payload: { type: 'expedition:module:start', timestamp: '2025-01-01T00:00:00.000Z', moduleId: 'mod-1' },
  },
  {
    label: 'expedition:module:complete',
    payload: { type: 'expedition:module:complete', timestamp: '2025-01-01T00:00:00.000Z', moduleId: 'mod-1' },
  },
  {
    label: 'expedition:compile:start',
    payload: { type: 'expedition:compile:start', timestamp: '2025-01-01T00:00:00.000Z' },
  },
  {
    label: 'expedition:compile:complete',
    payload: {
      type: 'expedition:compile:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      plans: [],
    },
  },

  // Agent lifecycle
  {
    label: 'agent:start',
    payload: {
      type: 'agent:start',
      timestamp: '2025-01-01T00:00:00.000Z',
      agentId: 'agent-1',
      agent: 'builder',
      model: 'claude-sonnet-4-5',
      harness: 'claude-sdk',
      harnessSource: 'tier',
      tier: 'standard',
      tierSource: 'tier',
    },
  },
  {
    label: 'agent:warning',
    payload: {
      type: 'agent:warning',
      timestamp: '2025-01-01T00:00:00.000Z',
      agentId: 'agent-1',
      agent: 'builder',
      code: 'WARN001',
      message: 'context approaching limit',
    },
  },
  {
    label: 'agent:stop',
    payload: {
      type: 'agent:stop',
      timestamp: '2025-01-01T00:00:00.000Z',
      agentId: 'agent-1',
      agent: 'builder',
    },
  },
  {
    label: 'agent:usage',
    payload: {
      type: 'agent:usage',
      timestamp: '2025-01-01T00:00:00.000Z',
      agentId: 'agent-1',
      agent: 'builder',
      usage: { input: 1000, output: 500, total: 1500, cacheRead: 200, cacheCreation: 100 },
      costUsd: 0.05,
      numTurns: 10,
    },
  },
  {
    label: 'agent:message',
    payload: {
      type: 'agent:message',
      timestamp: '2025-01-01T00:00:00.000Z',
      agentId: 'agent-1',
      agent: 'builder',
      content: 'thinking...',
    },
  },
  {
    label: 'agent:tool_use',
    payload: {
      type: 'agent:tool_use',
      timestamp: '2025-01-01T00:00:00.000Z',
      agentId: 'agent-1',
      agent: 'builder',
      tool: 'Write',
      toolUseId: 'tu-1',
      input: { file_path: 'src/foo.ts', content: 'export {}' },
    },
  },
  {
    label: 'agent:tool_result',
    payload: {
      type: 'agent:tool_result',
      timestamp: '2025-01-01T00:00:00.000Z',
      agentId: 'agent-1',
      agent: 'builder',
      tool: 'Write',
      toolUseId: 'tu-1',
      output: 'ok',
    },
  },
  {
    label: 'agent:result (with agentId)',
    payload: {
      type: 'agent:result',
      timestamp: '2025-01-01T00:00:00.000Z',
      agentId: 'agt-123e4567-e89b-12d3-a456-426614174000',
      agent: 'builder',
      result: {
        durationMs: 5000,
        durationApiMs: 4500,
        numTurns: 10,
        totalCostUsd: 0.05,
        usage: { input: 1000, output: 500, total: 1500, cacheRead: 0, cacheCreation: 0 },
        modelUsage: {
          'claude-sonnet-4-5': {
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0.05,
          },
        },
      },
    },
  },
  {
    label: 'agent:result (without agentId, backward compatibility)',
    payload: {
      type: 'agent:result',
      timestamp: '2025-01-01T00:00:00.000Z',
      agent: 'builder',
      result: {
        durationMs: 5000,
        durationApiMs: 4500,
        numTurns: 10,
        totalCostUsd: 0.05,
        usage: { input: 1000, output: 500, total: 1500, cacheRead: 0, cacheCreation: 0 },
        modelUsage: {
          'claude-sonnet-4-5': {
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0.05,
          },
        },
      },
    },
  },
  {
    label: 'agent:activity (exact attribution)',
    payload: {
      type: 'agent:activity',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      agentId: 'agt-123e4567-e89b-12d3-a456-426614174000',
      agent: 'builder',
      files: [
        { path: 'src/foo.ts', status: 'M', additions: 10, deletions: 3, binary: false },
        { path: 'src/bar.ts', status: 'A', additions: 42, deletions: 0, binary: false },
      ],
      totals: { filesChanged: 2, additions: 52, deletions: 3 },
      attribution: 'exact',
      notes: [],
    },
  },
  {
    label: 'agent:retry',
    payload: {
      type: 'agent:retry',
      timestamp: '2025-01-01T00:00:00.000Z',
      agent: 'builder',
      attempt: 1,
      maxAttempts: 3,
      subtype: 'error_max_turns',
      label: 'plan-01:builder',
    },
  },

  // Validation
  {
    label: 'validation:start',
    payload: { type: 'validation:start', timestamp: '2025-01-01T00:00:00.000Z', commands: ['pnpm test'] },
  },
  {
    label: 'validation:command:start',
    payload: { type: 'validation:command:start', timestamp: '2025-01-01T00:00:00.000Z', command: 'pnpm test' },
  },
  {
    label: 'validation:command:complete',
    payload: {
      type: 'validation:command:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      command: 'pnpm test',
      exitCode: 0,
      output: 'all tests passed',
    },
  },
  {
    label: 'validation:command:timeout',
    payload: {
      type: 'validation:command:timeout',
      timestamp: '2025-01-01T00:00:00.000Z',
      command: 'pnpm test',
      timeoutMs: 60000,
      pid: 1234,
    },
  },
  {
    label: 'validation:complete',
    payload: { type: 'validation:complete', timestamp: '2025-01-01T00:00:00.000Z', passed: true },
  },
  {
    label: 'validation:fix:start',
    payload: {
      type: 'validation:fix:start',
      timestamp: '2025-01-01T00:00:00.000Z',
      attempt: 1,
      maxAttempts: 3,
    },
  },
  {
    label: 'validation:fix:complete',
    payload: { type: 'validation:fix:complete', timestamp: '2025-01-01T00:00:00.000Z', attempt: 1 },
  },

  // PRD validation
  {
    label: 'prd_validation:start',
    payload: { type: 'prd_validation:start', timestamp: '2025-01-01T00:00:00.000Z' },
  },
  {
    label: 'prd_validation:complete',
    payload: {
      type: 'prd_validation:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      passed: true,
      gaps: [],
    },
  },

  // Gap closing
  {
    label: 'gap_close:start',
    payload: { type: 'gap_close:start', timestamp: '2025-01-01T00:00:00.000Z' },
  },
  {
    label: 'gap_close:plan_ready',
    payload: {
      type: 'gap_close:plan_ready',
      timestamp: '2025-01-01T00:00:00.000Z',
      planBody: '# Gap closure plan',
      gaps: [{ requirement: 'req1', explanation: 'missing' }],
    },
  },
  {
    label: 'gap_close:complete',
    payload: { type: 'gap_close:complete', timestamp: '2025-01-01T00:00:00.000Z' },
  },

  // Reconciliation
  {
    label: 'reconciliation:start',
    payload: { type: 'reconciliation:start', timestamp: '2025-01-01T00:00:00.000Z' },
  },
  {
    label: 'reconciliation:complete',
    payload: {
      type: 'reconciliation:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      report: { valid: ['plan-01'], missing: [], corrupt: [], cleared: [] },
    },
  },

  // Cleanup
  {
    label: 'cleanup:start',
    payload: { type: 'cleanup:start', timestamp: '2025-01-01T00:00:00.000Z', planSet: 'my-set' },
  },
  {
    label: 'cleanup:complete',
    payload: { type: 'cleanup:complete', timestamp: '2025-01-01T00:00:00.000Z', planSet: 'my-set' },
  },

  // User interaction
  {
    label: 'approval:needed',
    payload: {
      type: 'approval:needed',
      timestamp: '2025-01-01T00:00:00.000Z',
      action: 'merge',
      details: 'merge plan-01',
    },
  },
  {
    label: 'approval:response',
    payload: { type: 'approval:response', timestamp: '2025-01-01T00:00:00.000Z', approved: true },
  },

  // Enqueue
  {
    label: 'enqueue:start',
    payload: { type: 'enqueue:start', timestamp: '2025-01-01T00:00:00.000Z', source: 'cli' },
  },
  {
    label: 'enqueue:complete',
    payload: {
      type: 'enqueue:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      id: 'prd-1',
      filePath: '.eforge/queue/prd-1.md',
      title: 'My PRD',
      planSet: 'my-set',
    },
  },
  {
    label: 'enqueue:failed',
    payload: { type: 'enqueue:failed', timestamp: '2025-01-01T00:00:00.000Z', error: 'file not found' },
  },
  {
    label: 'enqueue:commit-failed',
    payload: { type: 'enqueue:commit-failed', timestamp: '2025-01-01T00:00:00.000Z', error: 'git error' },
  },

  // Recovery analysis
  {
    label: 'recovery:start',
    payload: {
      type: 'recovery:start',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-1',
      setName: 'my-set',
    },
  },
  {
    label: 'recovery:summary',
    payload: {
      type: 'recovery:summary',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-1',
      summary: {
        prdId: 'prd-1',
        setName: 'my-set',
        featureBranch: 'feat/my-set',
        baseBranch: 'main',
        plans: [],
        failingPlan: { planId: 'plan-01' },
        landedCommits: [],
        diffStat: '3 files changed',
        modelsUsed: ['claude-sonnet-4-5'],
        failedAt: '2025-01-01T00:00:00.000Z',
      },
    },
  },
  {
    label: 'recovery:complete',
    payload: {
      type: 'recovery:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-1',
      verdict: {
        verdict: 'retry',
        confidence: 'high',
        rationale: 'transient error',
        completedWork: [],
        remainingWork: ['implement'],
        risks: [],
      },
    },
  },
  {
    label: 'recovery:error',
    payload: {
      type: 'recovery:error',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-1',
      error: 'analysis failed',
    },
  },

  // Recovery apply
  {
    label: 'recovery:apply:start',
    payload: { type: 'recovery:apply:start', timestamp: '2025-01-01T00:00:00.000Z', prdId: 'prd-1' },
  },
  {
    label: 'recovery:apply:complete',
    payload: {
      type: 'recovery:apply:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-1',
      verdict: 'retry',
      noAction: false,
    },
  },
  {
    label: 'recovery:apply:error',
    payload: {
      type: 'recovery:apply:error',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-1',
      message: 'could not apply',
    },
  },

  // Daemon run-state upsert
  {
    label: 'daemon:run:upsert',
    payload: {
      type: 'daemon:run:upsert',
      timestamp: '2025-01-01T00:00:00.000Z',
      run: {
        id: 'run-1',
        planSet: 'my-set',
        command: 'build',
        status: 'running',
        startedAt: '2025-01-01T00:00:00.000Z',
        cwd: '/project',
      },
    },
  },

  // Daemon internal
  {
    label: 'daemon:auto-build:paused',
    payload: {
      type: 'daemon:auto-build:paused',
      timestamp: '2025-01-01T00:00:00.000Z',
      reason: 'build failed',
    },
  },

  // Daemon lifecycle
  {
    label: 'daemon:lifecycle:starting',
    payload: {
      type: 'daemon:lifecycle:starting',
      timestamp: '2025-01-01T00:00:00.000Z',
      pid: 1234,
      port: 3737,
      version: '1.0.0',
      mode: 'auto',
    },
  },
  {
    label: 'daemon:lifecycle:ready',
    payload: {
      type: 'daemon:lifecycle:ready',
      timestamp: '2025-01-01T00:00:00.000Z',
      pid: 1234,
      port: 3737,
      version: '1.0.0',
      mode: 'auto',
      recoveryDurationMs: 50,
    },
  },
  {
    label: 'daemon:lifecycle:shutdown:start',
    payload: {
      type: 'daemon:lifecycle:shutdown:start',
      timestamp: '2025-01-01T00:00:00.000Z',
      signal: 'SIGTERM',
      reason: 'user request',
    },
  },
  {
    label: 'daemon:lifecycle:shutdown:complete',
    payload: {
      type: 'daemon:lifecycle:shutdown:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      durationMs: 200,
    },
  },
  {
    label: 'daemon:heartbeat',
    payload: {
      type: 'daemon:heartbeat',
      timestamp: '2025-01-01T00:00:00.000Z',
      uptime: 60000,
      queueDepth: 0,
      runningBuilds: 1,
      autoBuild: {
        enabled: true,
        paused: false,
        // --- eforge:region plan-01-supervisor-foundation ---
        desired: 'enabled',
        mode: 'running',
        scheduler: { alive: true, paused: false },
        lastTransition: {
          at: '2025-01-01T00:00:00.000Z',
          previousMode: 'starting',
          nextMode: 'running',
          desired: 'enabled',
          source: 'watcher',
          reason: 'watcher started',
        },
        reason: 'watcher started',
        // --- eforge:endregion plan-01-supervisor-foundation ---
      },
      subscribers: 2,
    },
  },

  // Daemon scheduler
  {
    label: 'daemon:scheduler:dequeued',
    payload: {
      type: 'daemon:scheduler:dequeued',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-1',
      queueDepth: 0,
      capacityRemaining: 1,
    },
  },
  {
    label: 'daemon:scheduler:capacity-blocked',
    payload: {
      type: 'daemon:scheduler:capacity-blocked',
      timestamp: '2025-01-01T00:00:00.000Z',
      queueDepth: 2,
      runningCount: 2,
      limit: 2,
    },
  },
  {
    label: 'daemon:scheduler:dependency-blocked',
    payload: {
      type: 'daemon:scheduler:dependency-blocked',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-2',
      blockedBy: ['prd-1'],
    },
  },

  // Daemon auto-build extensions
  {
    label: 'daemon:auto-build:enabled',
    payload: { type: 'daemon:auto-build:enabled', timestamp: '2025-01-01T00:00:00.000Z' },
  },
  {
    label: 'daemon:auto-build:disabled',
    payload: { type: 'daemon:auto-build:disabled', timestamp: '2025-01-01T00:00:00.000Z' },
  },
  {
    label: 'daemon:auto-build:resumed',
    payload: { type: 'daemon:auto-build:resumed', timestamp: '2025-01-01T00:00:00.000Z' },
  },
  {
    label: 'daemon:auto-build:triggered',
    payload: {
      type: 'daemon:auto-build:triggered',
      timestamp: '2025-01-01T00:00:00.000Z',
      trigger: 'file-watch',
      prdsEnqueued: 1,
    },
  },
  // --- eforge:region plan-01-supervisor-foundation ---
  {
    label: 'daemon:auto-build:transition',
    payload: {
      type: 'daemon:auto-build:transition',
      timestamp: '2025-01-01T00:00:00.000Z',
      previousMode: 'starting',
      nextMode: 'running',
      desired: 'enabled',
      reason: 'watcher started',
      source: 'watcher',
    },
  },
  // --- eforge:endregion plan-01-supervisor-foundation ---

  // Daemon recovery
  {
    label: 'daemon:recovery:start',
    payload: { type: 'daemon:recovery:start', timestamp: '2025-01-01T00:00:00.000Z' },
  },
  {
    label: 'daemon:recovery:run-marked-failed',
    payload: {
      type: 'daemon:recovery:run-marked-failed',
      timestamp: '2025-01-01T00:00:00.000Z',
      runId: 'run-1',
      planSet: 'my-set',
      reason: 'orphaned',
    },
  },
  {
    label: 'daemon:recovery:lock-removed',
    payload: {
      type: 'daemon:recovery:lock-removed',
      timestamp: '2025-01-01T00:00:00.000Z',
      path: '/tmp/eforge.lock',
      pid: 1234,
    },
  },
  {
    label: 'daemon:recovery:complete',
    payload: {
      type: 'daemon:recovery:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      runsFailed: 0,
      locksRemoved: 0,
      durationMs: 10,
    },
  },

  // Daemon orphan reaping
  {
    label: 'daemon:orphan:reaped',
    payload: {
      type: 'daemon:orphan:reaped',
      timestamp: '2025-01-01T00:00:00.000Z',
      runId: 'run-1',
      sessionId: 'sess-1',
      planSet: 'my-set',
      pid: 5678,
    },
  },

  // Daemon errors and warnings
  {
    label: 'daemon:warning',
    payload: {
      type: 'daemon:warning',
      timestamp: '2025-01-01T00:00:00.000Z',
      source: 'scheduler',
      message: 'queue stalled',
    },
  },
  {
    label: 'daemon:error',
    payload: {
      type: 'daemon:error',
      timestamp: '2025-01-01T00:00:00.000Z',
      source: 'db',
      message: 'connection refused',
    },
  },

  // Queue events
  {
    label: 'queue:start',
    payload: { type: 'queue:start', timestamp: '2025-01-01T00:00:00.000Z', prdCount: 2, dir: '/queue' },
  },
  {
    label: 'queue:prd:start',
    payload: {
      type: 'queue:prd:start',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-1',
      title: 'My PRD',
    },
  },
  {
    label: 'queue:prd:discovered',
    payload: {
      type: 'queue:prd:discovered',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-1',
      title: 'My PRD',
    },
  },
  {
    label: 'queue:prd:stale',
    payload: {
      type: 'queue:prd:stale',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-1',
      title: 'My PRD',
      verdict: 'proceed',
      justification: 'still relevant',
    },
  },
  {
    label: 'queue:prd:skip',
    payload: {
      type: 'queue:prd:skip',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-1',
      reason: 'already completed',
    },
  },
  {
    label: 'queue:prd:commit-failed',
    payload: {
      type: 'queue:prd:commit-failed',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-1',
      title: 'My PRD',
      error: 'git error',
    },
  },
  {
    label: 'queue:prd:complete',
    payload: {
      type: 'queue:prd:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-1',
      status: 'completed',
    },
  },
  {
    label: 'queue:complete',
    payload: {
      type: 'queue:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      processed: 2,
      skipped: 0,
    },
  },

  // Build decision
  {
    label: 'plan:build:decision',
    payload: {
      type: 'plan:build:decision',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      decision: {
        kind: 'review-strategy',
        rationale: 'small diff',
        strategy: 'single',
        source: 'config',
      },
    },
  },

  // Planning decision
  {
    label: 'planning:decision',
    payload: {
      type: 'planning:decision',
      timestamp: '2025-01-01T00:00:00.000Z',
      decision: {
        kind: 'scope-selected',
        rationale: 'small scope',
        scope: 'excursion',
        source: 'planner',
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Valid payload tests
// ---------------------------------------------------------------------------

describe('events-wire-parity — valid payloads', () => {
  for (const { label, payload } of validPayloads) {
    it(`accepts valid ${label} payload`, () => {
      const result = safeParseEforgeEvent(payload);
      expect(result.success, `${label} should be valid but got error: ${!result.success ? result.error.message : ''}`).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Invalid payload tests — three categories
// ---------------------------------------------------------------------------

describe('events-wire-parity — invalid payloads (missing required field)', () => {
  it('rejects session:start missing sessionId', () => {
    const result = safeParseEforgeEvent({
      type: 'session:start',
      timestamp: '2025-01-01T00:00:00.000Z',
      // sessionId missing
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  it('rejects plan:build:failed missing error field', () => {
    const result = safeParseEforgeEvent({
      type: 'plan:build:failed',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      // error missing
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  it('rejects enqueue:complete missing required planSet field', () => {
    const result = safeParseEforgeEvent({
      type: 'enqueue:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      id: 'prd-1',
      filePath: '.eforge/queue/prd-1.md',
      title: 'My PRD',
      // planSet missing
    });
    expect(result.success).toBe(false);
  });

  it('rejects daemon:heartbeat missing uptime', () => {
    const result = safeParseEforgeEvent({
      type: 'daemon:heartbeat',
      timestamp: '2025-01-01T00:00:00.000Z',
      // uptime missing
      queueDepth: 0,
      runningBuilds: 1,
      autoBuild: { enabled: true, paused: false },
      subscribers: 2,
    });
    expect(result.success).toBe(false);
  });

  // --- eforge:region plan-01-native-event-runtime-foundation ---
  it('rejects extension:event-handler:failed missing extensionName', () => {
    const result = safeParseEforgeEvent({
      type: 'extension:event-handler:failed',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionPath: '/x.js',
      pattern: '*',
      triggeringEventType: 'plan:build:failed',
      message: 'boom',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extension:event-handler:timeout missing timeoutMs', () => {
    const result = safeParseEforgeEvent({
      type: 'extension:event-handler:timeout',
      timestamp: '2025-01-01T00:00:00.000Z',
      extensionName: 'x',
      extensionPath: '/x.js',
      pattern: '*',
      triggeringEventType: 'plan:build:failed',
    });
    expect(result.success).toBe(false);
  });
  // --- eforge:endregion plan-01-native-event-runtime-foundation ---

  it('rejects any event missing timestamp (required envelope field)', () => {
    const result = safeParseEforgeEvent({
      type: 'session:start',
      sessionId: 'sess-1',
      // timestamp missing
    });
    expect(result.success).toBe(false);
  });
});

describe('events-wire-parity — invalid payloads (wrong literal)', () => {
  it('rejects plan:status:change with invalid status literal', () => {
    const result = safeParseEforgeEvent({
      type: 'plan:status:change',
      timestamp: '2025-01-01T00:00:00.000Z',
      planId: 'plan-01',
      status: 'invalid-status',
    });
    expect(result.success).toBe(false);
  });

  it('rejects session:end with invalid result status literal', () => {
    const result = safeParseEforgeEvent({
      type: 'session:end',
      timestamp: '2025-01-01T00:00:00.000Z',
      sessionId: 'sess-1',
      result: { status: 'unknown-status', summary: 'done' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects agent:start with invalid harness value', () => {
    const result = safeParseEforgeEvent({
      type: 'agent:start',
      timestamp: '2025-01-01T00:00:00.000Z',
      agentId: 'agent-1',
      agent: 'builder',
      model: 'claude-sonnet-4-5',
      harness: 'unknown-harness',
      harnessSource: 'tier',
      tier: 'standard',
      tierSource: 'tier',
    });
    expect(result.success).toBe(false);
  });

  it('rejects queue:prd:complete with invalid status literal', () => {
    const result = safeParseEforgeEvent({
      type: 'queue:prd:complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      prdId: 'prd-1',
      status: 'in-progress',
    });
    expect(result.success).toBe(false);
  });

  it('rejects agent:activity missing required attribution field', () => {
    const result = safeParseEforgeEvent({
      type: 'agent:activity',
      timestamp: '2025-01-01T00:00:00.000Z',
      agentId: 'agt-abc',
      agent: 'builder',
      totals: { filesChanged: 1, additions: 5, deletions: 0 },
      // attribution intentionally omitted
    });
    expect(result.success).toBe(false);
  });
});

describe('events-wire-parity — invalid payloads (unknown discriminant)', () => {
  it('rejects an event with a completely unknown type', () => {
    const result = safeParseEforgeEvent({
      type: 'completely:unknown:event:type',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  it('rejects an event with a near-miss type (extra suffix)', () => {
    const result = safeParseEforgeEvent({
      type: 'session:start:extra',
      timestamp: '2025-01-01T00:00:00.000Z',
      sessionId: 'sess-1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-object payload', () => {
    const result = safeParseEforgeEvent('not-an-object');
    expect(result.success).toBe(false);
  });

  it('rejects a null payload', () => {
    const result = safeParseEforgeEvent(null);
    expect(result.success).toBe(false);
  });

  it('rejects an empty object', () => {
    const result = safeParseEforgeEvent({});
    expect(result.success).toBe(false);
  });
});
