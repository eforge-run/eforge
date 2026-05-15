import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { AgentHarness, AgentRunOptions } from '@eforge-build/engine/harness';
import { isTransientTransportError } from '@eforge-build/engine/harness';
import type { EforgeEvent, AgentRole, AgentResultData, PlanFile } from '@eforge-build/engine/events';
import { builderImplement } from '@eforge-build/engine/agents/builder';
import { withRetry, DEFAULT_RETRY_POLICIES, type BuilderContinuationInput, type PlannerContinuationInput, type RetryPolicy } from '@eforge-build/engine/retry';
import { buildFailureSummary } from '@eforge-build/engine/recovery/failure-summary';
import { openDatabase } from '@eforge-build/monitor/db';
import { collectEvents, filterEvents, findEvent } from './test-events.js';
import { useTempDir } from './test-tmpdir.js';

const TRANSIENT_CLOSE = 'Backend error: WebSocket closed 1012';

const RESULT: AgentResultData = {
  durationMs: 10,
  durationApiMs: 8,
  numTurns: 1,
  totalCostUsd: 0,
  usage: { input: 0, output: 0, total: 0, cacheRead: 0, cacheCreation: 0 },
  modelUsage: {},
  resultText: 'done',
};

function makePlan(): PlanFile {
  return {
    id: 'plan-01-transport-resilience',
    name: 'Pi Transport Close Resilience',
    dependsOn: [],
    branch: 'test/transport-resilience',
    body: '# Plan\n\nImplement transport resilience.',
    filePath: '/tmp/plan.md',
  };
}

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@eforge.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
}

function commitFile(dir: string, file: string, content: string): void {
  writeFileSync(join(dir, file), content);
  execFileSync('git', ['add', file], { cwd: dir });
  execFileSync('git', ['commit', '-m', `test: commit ${file}`], { cwd: dir });
}

class BuilderScriptHarness implements AgentHarness {
  constructor(private readonly script: (options: AgentRunOptions, agentId: string, agent: AgentRole, planId?: string) => AsyncGenerator<EforgeEvent>) {}

  effectiveCustomToolName(name: string): string {
    return name;
  }

  async *run(options: AgentRunOptions, agent: AgentRole, planId?: string): AsyncGenerator<EforgeEvent> {
    const agentId = 'builder-agent-1';
    let error: string | undefined;
    yield {
      type: 'agent:start',
      timestamp: new Date().toISOString(),
      planId,
      agentId,
      agent,
      model: 'stub-model',
      harness: 'pi',
      harnessSource: 'tier',
      tier: 'stub',
      tierSource: 'tier',
    };
    try {
      yield* this.script(options, agentId, agent, planId);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      yield { type: 'agent:stop', timestamp: new Date().toISOString(), planId, agentId, agent, error };
    }
  }
}

function resultEvent(agentId: string, agent: AgentRole, planId?: string): EforgeEvent {
  return { type: 'agent:result', timestamp: new Date().toISOString(), planId, agentId, agent, result: RESULT };
}

describe('Pi transport transient classifier', () => {
  it('recognizes observed transient WebSocket close messages conservatively', () => {
    expect(isTransientTransportError('Backend error: WebSocket closed 1012')).toBe(true);
    expect(isTransientTransportError('Backend error: WebSocket error')).toBe(true);
    expect(isTransientTransportError('Backend error: invalid API key')).toBe(false);
  });
});

describe('builderImplement transient transport downgrade', () => {
  const makeTempDir = useTempDir('eforge-pi-transport-builder-');

  it('downgrades a post-result transient close only when HEAD advanced', async () => {
    const cwd = makeTempDir();
    initGitRepo(cwd);
    const harness = new BuilderScriptHarness(async function* (options, agentId, agent, planId) {
      commitFile(options.cwd, 'done.txt', 'done\n');
      yield resultEvent(agentId, agent, planId);
      throw new Error(TRANSIENT_CLOSE);
    });

    const events = await collectEvents(builderImplement(makePlan(), { harness, cwd }));

    const warnings = filterEvents(events, 'agent:warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('transient-transport-downgraded');
    expect(findEvent(events, 'plan:build:implement:complete')).toBeDefined();
    expect(filterEvents(events, 'plan:build:failed')).toHaveLength(0);
  });

  it('classifies a pre-result transient close as a build failure', async () => {
    const cwd = makeTempDir();
    initGitRepo(cwd);
    const harness = new BuilderScriptHarness(async function* () {
      throw new Error(TRANSIENT_CLOSE);
    });

    const events = await collectEvents(builderImplement(makePlan(), { harness, cwd }));

    const failures = filterEvents(events, 'plan:build:failed');
    expect(failures).toHaveLength(1);
    expect(failures[0].terminalSubtype).toBe('error_transient_transport');
    expect(filterEvents(events, 'plan:build:implement:complete')).toHaveLength(0);
  });

  it('does not downgrade post-result transient closes when HEAD did not advance', async () => {
    const cwd = makeTempDir();
    initGitRepo(cwd);
    const harness = new BuilderScriptHarness(async function* (_options, agentId, agent, planId) {
      yield resultEvent(agentId, agent, planId);
      throw new Error(TRANSIENT_CLOSE);
    });

    const events = await collectEvents(builderImplement(makePlan(), { harness, cwd }));

    const failures = filterEvents(events, 'plan:build:failed');
    expect(failures).toHaveLength(1);
    expect(failures[0].terminalSubtype).toBe('error_transient_transport');
    expect(filterEvents(events, 'agent:warning')).toHaveLength(0);
    expect(filterEvents(events, 'plan:build:implement:complete')).toHaveLength(0);
  });

  it('does not downgrade transient closes when HEAD advanced but no agent:result was emitted', async () => {
    const cwd = makeTempDir();
    initGitRepo(cwd);
    const harness = new BuilderScriptHarness(async function* (options) {
      commitFile(options.cwd, 'done.txt', 'done\n');
      throw new Error(TRANSIENT_CLOSE);
    });

    const events = await collectEvents(builderImplement(makePlan(), { harness, cwd }));

    const failures = filterEvents(events, 'plan:build:failed');
    expect(failures).toHaveLength(1);
    expect(failures[0].terminalSubtype).toBe('error_transient_transport');
    expect(filterEvents(events, 'agent:warning')).toHaveLength(0);
    expect(filterEvents(events, 'plan:build:implement:complete')).toHaveLength(0);
  });

  it('does not downgrade post-result non-transient backend failures', async () => {
    const cwd = makeTempDir();
    initGitRepo(cwd);
    const harness = new BuilderScriptHarness(async function* (options, agentId, agent, planId) {
      commitFile(options.cwd, 'done.txt', 'done\n');
      yield resultEvent(agentId, agent, planId);
      throw new Error('Backend error: invalid API key');
    });

    const events = await collectEvents(builderImplement(makePlan(), { harness, cwd }));

    const failures = filterEvents(events, 'plan:build:failed');
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toBe('Backend error: invalid API key');
    expect(failures[0].terminalSubtype).toBeUndefined();
    expect(filterEvents(events, 'agent:warning')).toHaveLength(0);
    expect(filterEvents(events, 'plan:build:implement:complete')).toHaveLength(0);
  });
});

describe('builder withRetry transient transport continuation', () => {
  const makeTempDir = useTempDir('eforge-pi-transport-builder-retry-');

  it('retries plain transient transport errors with the builder policy', async () => {
    const cwd = makeTempDir();
    initGitRepo(cwd);
    let attempts = 0;
    const runBuilderAttempt = async function* (input: BuilderContinuationInput): AsyncGenerator<EforgeEvent> {
      attempts++;
      if (attempts === 1) {
        writeFileSync(join(input.worktreePath, 'partial.txt'), 'partial progress\n');
        throw new Error(TRANSIENT_CLOSE);
      }
      yield { type: 'plan:build:implement:complete', timestamp: new Date().toISOString(), planId: input.planId };
    };

    const policy = DEFAULT_RETRY_POLICIES.builder as RetryPolicy<BuilderContinuationInput>;
    const events = await collectEvents(withRetry(runBuilderAttempt, policy, {
      worktreePath: cwd,
      baseBranch: 'main',
      planId: 'plan-01-transport-resilience',
      builderOptions: {},
    }));

    expect(attempts).toBe(2);
    const retry = findEvent(events, 'agent:retry');
    expect(retry).toMatchObject({
      agent: 'builder',
      subtype: 'error_transient_transport',
      label: 'builder-continuation',
      planId: 'plan-01-transport-resilience',
    });
    expect(findEvent(events, 'plan:build:implement:continuation')).toBeDefined();
    expect(findEvent(events, 'plan:build:implement:complete')).toBeDefined();
  });
});

describe('planner withRetry transient transport continuation', () => {
  const makeTempDir = useTempDir('eforge-pi-transport-planner-');

  it('retries a transient close before planning:submission using dropped-submission continuation context', async () => {
    const cwd = makeTempDir();
    const initialInput: PlannerContinuationInput = {
      sideEffects: { cwd, planSetName: 'set-1', outputDir: 'eforge/plans' },
      plannerOptions: {},
    };
    let attempts = 0;
    const seenInputs: PlannerContinuationInput[] = [];
    const runPlannerAttempt = async function* (input: PlannerContinuationInput): AsyncGenerator<EforgeEvent> {
      attempts++;
      seenInputs.push(input);
      if (attempts === 1) {
        yield { type: 'agent:result', timestamp: new Date().toISOString(), agentId: 'planner-1', agent: 'planner', result: RESULT };
        throw new Error(TRANSIENT_CLOSE);
      }
      yield { type: 'planning:submission', timestamp: new Date().toISOString(), planCount: 1, totalBodySize: 10, hasMigrations: false };
    };

    const policy = DEFAULT_RETRY_POLICIES.planner as RetryPolicy<PlannerContinuationInput>;
    const events = await collectEvents(withRetry(runPlannerAttempt, policy, initialInput));

    expect(attempts).toBe(2);
    expect(seenInputs[1]?.plannerOptions.continuationContext).toMatchObject({
      attempt: 1,
      maxContinuations: 2,
      reason: 'dropped_submission',
      existingPlans: '[No existing plans — previous attempt did not submit]',
    });
    const retry = findEvent(events, 'agent:retry');
    expect(retry?.subtype).toBe('error_transient_transport');
    const continuation = findEvent(events, 'planning:continuation');
    expect(continuation?.reason).toBe('dropped_submission');
    expect(findEvent(events, 'planning:submission')).toBeDefined();
  });

  it('does not retry a transient close after planning:submission already emitted', async () => {
    const cwd = makeTempDir();
    const initialInput: PlannerContinuationInput = {
      sideEffects: { cwd, planSetName: 'set-1', outputDir: 'eforge/plans' },
      plannerOptions: {},
    };
    let attempts = 0;
    const runPlannerAttempt = async function* (): AsyncGenerator<EforgeEvent> {
      attempts++;
      yield { type: 'planning:submission', timestamp: new Date().toISOString(), planCount: 1, totalBodySize: 10, hasMigrations: false };
      throw new Error(TRANSIENT_CLOSE);
    };

    const policy = DEFAULT_RETRY_POLICIES.planner as RetryPolicy<PlannerContinuationInput>;
    const events: EforgeEvent[] = [];
    await expect(async () => {
      for await (const event of withRetry(runPlannerAttempt, policy, initialInput)) {
        events.push(event);
      }
    }).rejects.toThrow(TRANSIENT_CLOSE);

    expect(attempts).toBe(1);
    expect(filterEvents(events, 'planning:submission')).toHaveLength(1);
    expect(filterEvents(events, 'agent:retry')).toHaveLength(0);
  });
});

describe('recovery event-history compile failure synthesis', () => {
  const makeTempDir = useTempDir('eforge-pi-transport-recovery-');

  it('synthesizes compile as the failing plan from failed phase:end plus planner agent:stop', async () => {
    const cwd = makeTempDir();
    initGitRepo(cwd);
    const dbPath = resolve(cwd, 'monitor.db');
    const db = openDatabase(dbPath);
    const runId = 'run-compile-1';
    const timestamp = new Date().toISOString();
    db.insertRun({ id: runId, sessionId: 'session-1', planSet: 'set-1', command: 'compile', status: 'failed', startedAt: timestamp, cwd });
    db.insertEvent({
      runId,
      type: 'agent:start',
      agent: 'planner',
      data: JSON.stringify({ type: 'agent:start', timestamp, agentId: 'planner-1', agent: 'planner', model: 'model-a', harness: 'pi', harnessSource: 'tier', tier: 'stub', tierSource: 'tier' }),
      timestamp,
    });
    db.insertEvent({
      runId,
      type: 'agent:stop',
      agent: 'planner',
      data: JSON.stringify({ type: 'agent:stop', timestamp, agentId: 'planner-1', agent: 'planner', error: TRANSIENT_CLOSE }),
      timestamp,
    });
    db.insertEvent({
      runId,
      type: 'phase:end',
      data: JSON.stringify({ type: 'phase:end', timestamp, runId, result: { status: 'failed', summary: 'compile failed' } }),
      timestamp,
    });
    db.close();

    const summary = await buildFailureSummary({ setName: 'set-1', prdId: 'prd-1', cwd, dbPath });

    expect(summary.failingPlan.planId).toBe('compile');
    expect(summary.failingPlan.agentRole).toBe('planner');
    expect(summary.failingPlan.agentId).toBe('planner-1');
    expect(summary.failingPlan.errorMessage).toContain('WebSocket closed 1012');
    expect(summary.failingPlan.terminalSubtype).toBe('error_transient_transport');
  });
});
