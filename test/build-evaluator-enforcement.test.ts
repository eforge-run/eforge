import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { EforgeEvent, PlanFile, OrchestrationConfig, AgentRole } from '@eforge-build/engine/events';
import type { AgentRunOptions } from '@eforge-build/engine/harness';
import { DEFAULT_CONFIG, DEFAULT_REVIEW } from '@eforge-build/engine/config';
import { getBuildStage, type BuildStageContext } from '@eforge-build/engine/pipeline';
import { singletonRegistry } from '@eforge-build/engine/agent-runtime-registry';
import { createNoopTracingContext } from '@eforge-build/engine/tracing';
import { ModelTracker } from '@eforge-build/engine/model-tracker';
import { StubHarness } from './stub-harness.js';
import { useTempDir } from './test-tmpdir.js';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout;
}

async function initRepo(dir: string): Promise<string> {
  const repo = join(dir, 'repo');
  await git(dir, ['init', '-b', 'main', repo]);
  await git(repo, ['config', 'user.email', 'test@eforge.build']);
  await git(repo, ['config', 'user.name', 'eforge-test']);
  return repo;
}

async function writeRepoFile(repo: string, path: string, content: string): Promise<void> {
  await mkdir(join(repo, path, '..'), { recursive: true });
  await writeFile(join(repo, path), content, 'utf8');
}

async function commitAll(repo: string, message: string): Promise<void> {
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', message]);
}

async function head(repo: string): Promise<string> {
  return (await git(repo, ['rev-parse', 'HEAD'])).trim();
}

async function lastCommitMessage(repo: string): Promise<string> {
  return (await git(repo, ['log', '-1', '--format=%B'])).trim();
}

async function committedFile(repo: string, path: string): Promise<string> {
  return git(repo, ['show', `HEAD:${path}`]);
}

async function collect(gen: AsyncGenerator<EforgeEvent>): Promise<EforgeEvent[]> {
  const events: EforgeEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

function makeCtx(repo: string, harness: StubHarness, preImplementCommit: string, tracker = new ModelTracker()): BuildStageContext {
  const planFile: PlanFile = {
    id: 'plan-02-build-evaluator-enforcement',
    name: 'Build Evaluator Enforcement and Reporting',
    dependsOn: [],
    branch: 'test/plan-02',
    body: '# Plan',
    filePath: join(repo, 'plan.md'),
  };
  const orchConfig: OrchestrationConfig = {
    name: 'test',
    description: 'test',
    created: new Date().toISOString(),
    mode: 'errand',
    baseBranch: 'main',
    pipeline: { scope: 'errand', compile: [], defaultBuild: ['evaluate'], defaultReview: DEFAULT_REVIEW, rationale: 'test' },
    plans: [{ id: planFile.id, name: planFile.name, dependsOn: [], branch: planFile.branch, build: ['evaluate'], review: DEFAULT_REVIEW }],
  };
  return {
    agentRuntimes: singletonRegistry(harness),
    config: DEFAULT_CONFIG,
    pipeline: orchConfig.pipeline,
    tracing: createNoopTracingContext(),
    cwd: repo,
    planSetName: 'test',
    sourceContent: '',
    modelTracker: tracker,
    plans: [planFile],
    expeditionModules: [],
    moduleBuildConfigs: new Map(),
    planId: planFile.id,
    worktreePath: repo,
    planFile,
    orchConfig,
    reviewIssues: [{ severity: 'warning', category: 'bugs', file: 'accepted.txt', description: 'fix it' }],
    build: ['evaluate'],
    review: DEFAULT_REVIEW,
    preImplementCommit,
  };
}

describe('build evaluator enforcement stage', () => {
  const makeTempDir = useTempDir('eforge-build-evaluator-enforcement-');

  it('applies accepted file-level fixes, rejects rejected/review fixes, and emits completion after commit', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'accepted.txt', 'base accepted\n');
    await writeRepoFile(repo, 'rejected.txt', 'base rejected\n');
    await commitAll(repo, 'chore: initial');
    const resetTarget = await head(repo);

    await writeRepoFile(repo, 'accepted.txt', 'base accepted\nimplementation\n');
    await writeRepoFile(repo, 'rejected.txt', 'base rejected\nimplementation\n');
    await commitAll(repo, 'feat: implementation');

    await writeRepoFile(repo, 'accepted.txt', 'base accepted\nimplementation\nreview fix\n');
    await writeRepoFile(repo, 'rejected.txt', 'base rejected\nimplementation\nreject fix\n');

    const harness = new StubHarness([{
      toolCalls: [{
        tool: 'submit_evaluation_verdicts',
        toolUseId: 'eval-1',
        input: { verdicts: [
          { file: 'accepted.txt', action: 'accept', reason: 'Correct' },
          { file: 'rejected.txt', action: 'review', reason: 'Debatable' },
        ] },
        output: '',
      }],
    }]);
    const ctx = makeCtx(repo, harness, resetTarget);

    const events = await collect(getBuildStage('evaluate')(ctx));

    expect(events.find(e => e.type === 'plan:build:evaluate:complete')).toBeDefined();
    expect(await committedFile(repo, 'accepted.txt')).toContain('review fix');
    expect(await committedFile(repo, 'rejected.txt')).not.toContain('reject fix');
    expect(ctx.reviewIssues).toHaveLength(0);
  });

  it('preserves hunk metadata in completion summaries', async () => {
    const repo = await initRepo(makeTempDir());
    const base = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    await writeRepoFile(repo, 'src.txt', `${base.join('\n')}\n`);
    await commitAll(repo, 'chore: initial');
    const resetTarget = await head(repo);

    const implementation = [...base];
    implementation[0] = 'implementation line 1';
    await writeRepoFile(repo, 'src.txt', `${implementation.join('\n')}\n`);
    await commitAll(repo, 'feat: implementation');

    const reviewer = [...implementation];
    reviewer[4] = 'accepted reviewer line 5';
    reviewer[17] = 'rejected reviewer line 18';
    await writeRepoFile(repo, 'src.txt', `${reviewer.join('\n')}\n`);

    const harness = new StubHarness([{
      toolCalls: [{
        tool: 'submit_evaluation_verdicts',
        toolUseId: 'eval-1',
        input: { verdicts: [
          { file: 'src.txt', hunk: 1, action: 'accept', reason: 'Correct' },
          { file: 'src.txt', hunk: 2, action: 'reject', reason: 'Wrong' },
        ] },
        output: '',
      }],
    }]);
    const ctx = makeCtx(repo, harness, resetTarget);

    const events = await collect(getBuildStage('evaluate')(ctx));
    const complete = events.find(e => e.type === 'plan:build:evaluate:complete');

    expect(complete?.verdicts).toEqual([
      { file: 'src.txt', hunk: 1, action: 'accept', reason: 'Correct' },
      { file: 'src.txt', hunk: 2, action: 'reject', reason: 'Wrong' },
    ]);
    expect(await committedFile(repo, 'src.txt')).toContain('accepted reviewer line 5');
    expect(await committedFile(repo, 'src.txt')).not.toContain('rejected reviewer line 18');
  });

  it('does not create an evaluation commit when no verdict submission or XML fallback is produced', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'src.txt', 'base\n');
    await commitAll(repo, 'chore: initial');
    const resetTarget = await head(repo);
    await writeRepoFile(repo, 'src.txt', 'implementation\n');
    await commitAll(repo, 'feat: implementation');
    const builderHead = await head(repo);
    await writeRepoFile(repo, 'src.txt', 'implementation\nreview\n');

    const ctx = makeCtx(repo, new StubHarness([{ text: 'I have thoughts but no verdicts.' }]), resetTarget);
    const events = await collect(getBuildStage('evaluate')(ctx));

    const warning = events.find(e => e.type === 'agent:warning');
    expect(warning).toBeDefined();
    expect(warning?.code).toBe('evaluation-verdicts-missing');
    expect(warning?.message).toContain('no verdicts');
    expect(await head(repo)).toBe(builderHead);
    expect(await readFile(join(repo, 'src.txt'), 'utf8')).toContain('review');
  });

  it('fails the build without an evaluation commit when the evaluator mutates the captured diff without verdicts', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'src.txt', 'base\n');
    await commitAll(repo, 'chore: initial');
    const resetTarget = await head(repo);
    await writeRepoFile(repo, 'src.txt', 'implementation\n');
    await commitAll(repo, 'feat: implementation');
    const builderHead = await head(repo);
    await writeRepoFile(repo, 'src.txt', 'implementation\nreview\n');

    class MutatingHarness extends StubHarness {
      async *run(options: AgentRunOptions, agent: AgentRole, planId?: string): AsyncGenerator<EforgeEvent> {
        for await (const event of super.run(options, agent, planId)) {
          yield event;
          if (event.type === 'agent:stop') {
            await writeRepoFile(repo, 'src.txt', 'implementation\nreview\nevaluator drift\n');
          }
        }
      }
    }

    const ctx = makeCtx(repo, new MutatingHarness([{ text: 'No verdicts.' }]), resetTarget);
    const events = await collect(getBuildStage('evaluate')(ctx));

    const failed = events.find(e => e.type === 'plan:build:failed');
    expect(failed).toBeDefined();
    expect(ctx.buildFailed).toBe(true);
    expect(events.find(e => e.type === 'agent:warning' && e.code === 'evaluation-verdicts-missing')).toBeUndefined();
    expect(await head(repo)).toBe(builderHead);
    expect(await lastCommitMessage(repo)).not.toContain(`feat(${ctx.planId}): ${ctx.planFile.name}`);
  });

  it('fails the build without an evaluation commit when the evaluator mutates the captured diff', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'src.txt', 'base\n');
    await commitAll(repo, 'chore: initial');
    const resetTarget = await head(repo);
    await writeRepoFile(repo, 'src.txt', 'implementation\n');
    await commitAll(repo, 'feat: implementation');
    const builderHead = await head(repo);
    await writeRepoFile(repo, 'src.txt', 'implementation\nreview\n');

    class MutatingHarness extends StubHarness {
      async *run(options: AgentRunOptions, agent: AgentRole, planId?: string): AsyncGenerator<EforgeEvent> {
        for await (const event of super.run(options, agent, planId)) {
          yield event;
          if (event.type === 'agent:stop') {
            await writeRepoFile(repo, 'src.txt', 'implementation\nreview\nevaluator drift\n');
          }
        }
      }
    }

    const harness = new MutatingHarness([{
      toolCalls: [{
        tool: 'submit_evaluation_verdicts',
        toolUseId: 'eval-1',
        input: { verdicts: [{ file: 'src.txt', action: 'accept', reason: 'Correct' }] },
        output: '',
      }],
    }]);
    const ctx = makeCtx(repo, harness, resetTarget);

    const events = await collect(getBuildStage('evaluate')(ctx));

    const failed = events.find(e => e.type === 'plan:build:failed');
    expect(failed).toBeDefined();
    expect(ctx.buildFailed).toBe(true);
    expect(events.find(e => e.type === 'plan:build:evaluate:complete')).toBeUndefined();
    expect(await head(repo)).toBe(builderHead);
    expect(await lastCommitMessage(repo)).not.toContain(`feat(${ctx.planId}): ${ctx.planFile.name}`);
  });

  it('does not emit completion and marks the build failed when the evaluation commit fails', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'src.txt', 'base\n');
    await commitAll(repo, 'chore: initial');
    const resetTarget = await head(repo);
    await writeRepoFile(repo, 'src.txt', 'implementation\n');
    await commitAll(repo, 'feat: implementation');
    const builderHead = await head(repo);
    await writeRepoFile(repo, 'src.txt', 'implementation\nreview\n');

    const gitDir = (await git(repo, ['rev-parse', '--git-dir'])).trim();
    const hooksDir = gitDir.startsWith('/') ? join(gitDir, 'hooks') : join(repo, gitDir, 'hooks');
    await mkdir(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, 'pre-commit');
    await writeFile(hookPath, '#!/bin/sh\necho blocked by test hook >&2\nexit 1\n', 'utf8');
    await chmod(hookPath, 0o755);

    const harness = new StubHarness([{
      toolCalls: [{
        tool: 'submit_evaluation_verdicts',
        toolUseId: 'eval-1',
        input: { verdicts: [{ file: 'src.txt', action: 'accept', reason: 'Correct' }] },
        output: '',
      }],
    }]);
    const ctx = makeCtx(repo, harness, resetTarget);

    const events = await collect(getBuildStage('evaluate')(ctx));

    const failed = events.find(e => e.type === 'plan:build:failed');
    expect(failed).toBeDefined();
    expect(failed?.error).toContain('blocked by test hook');
    expect(ctx.buildFailed).toBe(true);
    expect(events.find(e => e.type === 'plan:build:evaluate:complete')).toBeUndefined();
    expect(await head(repo)).toBe(builderHead);
  });

  it('reports max-round review-cycle termination with final evaluation metadata instead of stale review issues', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'src.txt', 'base\n');
    await commitAll(repo, 'chore: initial');
    const resetTarget = await head(repo);
    await writeRepoFile(repo, 'src.txt', 'implementation\n');
    await commitAll(repo, 'feat: implementation');

    const reviewIssueXml = (round: number) => `<review-issues>
  <issue severity="warning" category="bugs" file="src.txt">round ${round} issue</issue>
</review-issues>`;

    class FixingHarness extends StubHarness {
      private fixCount = 0;

      async *run(options: AgentRunOptions, agent: AgentRole, planId?: string): AsyncGenerator<EforgeEvent> {
        for await (const event of super.run(options, agent, planId)) {
          yield event;
          if (event.type === 'agent:stop' && agent === 'review-fixer') {
            this.fixCount += 1;
            const current = await readFile(join(repo, 'src.txt'), 'utf8');
            await writeRepoFile(repo, 'src.txt', `${current.trimEnd()}\nreview fix ${this.fixCount}\n`);
          }
        }
      }
    }

    const harness = new FixingHarness([
      { text: reviewIssueXml(1) },
      { text: 'Applied round 1 fix.' },
      { toolCalls: [{ tool: 'submit_evaluation_verdicts', toolUseId: 'eval-1', input: { verdicts: [{ file: 'src.txt', action: 'accept', reason: 'Correct' }] }, output: '' }] },
      { text: reviewIssueXml(2) },
      { text: 'Applied round 2 fix.' },
      { toolCalls: [{ tool: 'submit_evaluation_verdicts', toolUseId: 'eval-2', input: { verdicts: [{ file: 'src.txt', action: 'accept', reason: 'Correct' }] }, output: '' }] },
    ]);
    const ctx = makeCtx(repo, harness, resetTarget);
    ctx.build = ['review-cycle'];
    ctx.review = { ...DEFAULT_REVIEW, strategy: 'single', maxRounds: 2 };

    const events = await collect(getBuildStage('review-cycle')(ctx));
    const termination = events.find(
      (event): event is Extract<EforgeEvent, { type: 'plan:build:decision' }> =>
        event.type === 'plan:build:decision' &&
        event.decision.kind === 'cycle-terminated' &&
        event.decision.reason === 'max-rounds',
    );

    expect(termination).toBeDefined();
    expect(termination!.decision).toMatchObject({
      round: 1,
      issuesRemaining: 0,
      lastReviewIssueCount: 1,
      finalEvaluationRan: true,
      finalEvaluationAccepted: 1,
      finalEvaluationRejected: 0,
    });
    expect(termination!.decision.rationale).toContain('last review found 1 issue(s)');
    expect(termination!.decision.rationale).not.toMatch(/issues remaining/i);
    expect(ctx.reviewIssues).toHaveLength(0);
  });

  it('creates build-stage evaluation commits with forged attribution and model trailers', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'src.txt', 'base\n');
    await commitAll(repo, 'chore: initial');
    const resetTarget = await head(repo);
    await writeRepoFile(repo, 'src.txt', 'implementation\n');
    await commitAll(repo, 'feat: implementation');
    await writeRepoFile(repo, 'src.txt', 'implementation\nreview\n');

    const harness = new StubHarness([{
      toolCalls: [{
        tool: 'submit_evaluation_verdicts',
        toolUseId: 'eval-1',
        input: { verdicts: [{ file: 'src.txt', action: 'accept', reason: 'Correct' }] },
        output: '',
      }],
    }]);
    const tracker = new ModelTracker();
    tracker.record('evaluator-model');
    tracker.record('builder-model');
    const ctx = makeCtx(repo, harness, resetTarget, tracker);

    await collect(getBuildStage('evaluate')(ctx));

    const message = await lastCommitMessage(repo);
    expect(message).toContain(`feat(${ctx.planId}): ${ctx.planFile.name}`);
    expect(message).toContain('Models-Used: builder-model, evaluator-model');
    expect(message).toContain('Co-Authored-By: forged-by-eforge');
  });
});
