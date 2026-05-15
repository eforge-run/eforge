import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { EforgeEvent } from '@eforge-build/engine/events';
import { prepareEvaluationSnapshot, type EvaluationSnapshot } from '@eforge-build/engine/evaluation';
import { runArchitectureEvaluate, runCohesionEvaluate, runPlanEvaluate } from '@eforge-build/engine/agents/plan-evaluator';
import { AgentTerminalError } from '@eforge-build/engine/harness';
import { ModelTracker } from '@eforge-build/engine/model-tracker';
import { runReviewCycle } from '@eforge-build/engine/pipeline';
import type { EvaluatorContinuationInput } from '@eforge-build/engine/retry';
import { createNoopTracingContext } from '@eforge-build/engine/tracing';
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
  await git(repo, ['commit', '--allow-empty', '-m', 'chore: base']);
  return repo;
}

async function writeRepoFile(repo: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(repo, path)), { recursive: true });
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

describe('compile evaluator enforcement', () => {
  const makeTempDir = useTempDir('eforge-compile-evaluator-enforcement-');

  it('applies accepted plan-review fixes, rejects rejected/review fixes, and creates a forged commit from structured submission', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'eforge/plans/demo/accepted.md', 'accepted original\n');
    await writeRepoFile(repo, 'eforge/plans/demo/rejected.md', 'rejected original\n');
    await writeRepoFile(repo, 'eforge/plans/demo/review.md', 'review original\n');
    await commitAll(repo, 'plan(demo): initial planning artifacts');

    await writeRepoFile(repo, 'eforge/plans/demo/accepted.md', 'accepted original\nreviewer accepted fix\n');
    await writeRepoFile(repo, 'eforge/plans/demo/rejected.md', 'rejected original\nreviewer rejected fix\n');
    await writeRepoFile(repo, 'eforge/plans/demo/review.md', 'review original\nreviewer debatable fix\n');
    const snapshot = await prepareEvaluationSnapshot(repo, 'HEAD~1');

    const harness = new StubHarness([{
      toolCalls: [{
        tool: 'submit_evaluation_verdicts',
        toolUseId: 'eval-1',
        input: { verdicts: [
          { file: 'eforge/plans/demo/accepted.md', action: 'accept', reason: 'Correct dependency fix' },
          { file: 'eforge/plans/demo/rejected.md', action: 'reject', reason: 'Changes planner intent' },
          { file: 'eforge/plans/demo/review.md', action: 'review', reason: 'Debatable wording' },
        ] },
        output: '',
      }],
    }]);

    const events = await collect(runPlanEvaluate({
      harness,
      planSetName: 'demo',
      sourceContent: 'PRD',
      cwd: repo,
      outputDir: 'eforge/plans',
      evaluationSnapshot: snapshot,
      allowedPathPrefix: 'eforge/plans/demo',
      commitMessage: 'plan(demo): planning artifacts',
    }));

    expect(events.find(e => e.type === 'planning:evaluate:complete')).toMatchObject({ accepted: 1, rejected: 2 });
    expect(await committedFile(repo, 'eforge/plans/demo/accepted.md')).toContain('reviewer accepted fix');
    expect(await committedFile(repo, 'eforge/plans/demo/rejected.md')).not.toContain('reviewer rejected fix');
    expect(await committedFile(repo, 'eforge/plans/demo/review.md')).not.toContain('reviewer debatable fix');
    expect(await lastCommitMessage(repo)).toContain('Co-Authored-By: forged-by-eforge');
  });

  it('applies accepted cohesion fixes inside the module plan directory', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'eforge/plans/demo/modules/auth.md', 'auth original\n');
    await commitAll(repo, 'plan(demo): initial planning artifacts');

    await writeRepoFile(repo, 'eforge/plans/demo/modules/auth.md', 'auth original\ncohesion fix\n');
    const snapshot = await prepareEvaluationSnapshot(repo, 'HEAD~1');

    const harness = new StubHarness([{
      toolCalls: [{
        tool: 'submit_evaluation_verdicts',
        toolUseId: 'eval-1',
        input: { verdicts: [{ file: 'eforge/plans/demo/modules/auth.md', action: 'accept', reason: 'Valid module fix' }] },
        output: '',
      }],
    }]);

    const events = await collect(runCohesionEvaluate({
      harness,
      planSetName: 'demo',
      sourceContent: 'PRD',
      cwd: repo,
      outputDir: 'eforge/plans',
      evaluationSnapshot: snapshot,
      allowedPathPrefix: 'eforge/plans/demo/modules',
      commitMessage: 'plan(demo): planning artifacts',
    }));

    expect(events.find(e => e.type === 'planning:cohesion:evaluate:complete')).toMatchObject({ accepted: 1, rejected: 0 });
    expect(await committedFile(repo, 'eforge/plans/demo/modules/auth.md')).toContain('cohesion fix');
  });

  it('rejects cohesion evaluator verdict paths outside the module plan directory before creating a commit', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'eforge/plans/demo/modules/auth.md', 'auth original\n');
    await writeRepoFile(repo, 'eforge/plans/demo/architecture.md', 'architecture original\n');
    await commitAll(repo, 'plan(demo): initial planning artifacts');
    const originalHead = await head(repo);

    await writeRepoFile(repo, 'eforge/plans/demo/modules/auth.md', 'auth original\ncohesion fix\n');
    await writeRepoFile(repo, 'eforge/plans/demo/architecture.md', 'architecture original\noutside fix\n');
    const snapshot = await prepareEvaluationSnapshot(repo, 'HEAD~1');

    const harness = new StubHarness([{
      toolCalls: [{
        tool: 'submit_evaluation_verdicts',
        toolUseId: 'eval-1',
        input: { verdicts: [
          { file: 'eforge/plans/demo/modules/auth.md', action: 'accept', reason: 'Valid module fix' },
          { file: 'eforge/plans/demo/architecture.md', action: 'accept', reason: 'Outside module directory' },
        ] },
        output: '',
      }],
    }]);

    const events = await collect(runCohesionEvaluate({
      harness,
      planSetName: 'demo',
      sourceContent: 'PRD',
      cwd: repo,
      outputDir: 'eforge/plans',
      evaluationSnapshot: snapshot,
      allowedPathPrefix: 'eforge/plans/demo/modules',
      commitMessage: 'plan(demo): planning artifacts',
    }));

    expect(events.find(e => e.type === 'planning:error')?.reason).toContain('outside the allowed planning artifact directory');
    expect(await head(repo)).toBe(originalHead);
    expect(await lastCommitMessage(repo)).not.toBe('plan(demo): planning artifacts');
  });

  it('applies architecture fixes through model-aware forge commits', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'eforge/plans/demo/architecture.md', 'architecture original\n');
    await commitAll(repo, 'plan(demo): initial planning artifacts');

    await writeRepoFile(repo, 'eforge/plans/demo/architecture.md', 'architecture original\naccepted architecture fix\n');
    const snapshot = await prepareEvaluationSnapshot(repo, 'HEAD~1');
    const tracker = new ModelTracker();
    tracker.record('architect-model');

    const harness = new StubHarness([{
      toolCalls: [{
        tool: 'submit_evaluation_verdicts',
        toolUseId: 'eval-1',
        input: { verdicts: [{ file: 'eforge/plans/demo/architecture.md', action: 'accept', reason: 'Completes contract' }] },
        output: '',
      }],
    }]);

    const events = await collect(runArchitectureEvaluate({
      harness,
      planSetName: 'demo',
      sourceContent: 'PRD',
      cwd: repo,
      outputDir: 'eforge/plans',
      evaluationSnapshot: snapshot,
      allowedPathPrefix: 'eforge/plans/demo',
      commitMessage: 'plan(demo): planning artifacts',
      modelTracker: tracker,
    }));

    expect(events.find(e => e.type === 'planning:architecture:evaluate:complete')).toMatchObject({ accepted: 1, rejected: 0 });
    expect(await committedFile(repo, 'eforge/plans/demo/architecture.md')).toContain('accepted architecture fix');
    const message = await lastCommitMessage(repo);
    expect(message).toContain('Models-Used: architect-model');
    expect(message).toContain('Co-Authored-By: forged-by-eforge');
  });

  it('prepares evaluator retry input once after review and reuses the snapshot/options on continuation', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'eforge/plans/demo/plan.md', 'original plan\n');
    await commitAll(repo, 'plan(demo): initial planning artifacts');

    const snapshot = {
      cwd: repo,
      capturedAt: 'test',
      baseHead: await head(repo),
      stagedPatch: '',
      candidatePatch: '',
      files: [],
    } as EvaluationSnapshot;
    const inputs: EvaluatorContinuationInput[] = [];
    let prepareCalls = 0;
    let attempts = 0;

    const events = await collect(runReviewCycle({
      tracing: createNoopTracingContext(),
      cwd: repo,
      reviewer: {
        role: 'plan-reviewer',
        metadata: { planSet: 'demo' },
        run: async function* () {
          await writeRepoFile(repo, 'eforge/plans/demo/plan.md', 'original plan\nreviewer fix\n');
          yield { timestamp: new Date().toISOString(), type: 'planning:progress', message: 'reviewed' };
        },
      },
      evaluator: {
        role: 'plan-evaluator',
        metadata: { planSet: 'demo' },
        prepareInput: async () => {
          prepareCalls += 1;
          return {
            evaluationSnapshot: snapshot,
            evaluatorOptions: {
              allowedPathPrefix: 'eforge/plans/demo',
              commitMessage: 'plan(demo): planning artifacts',
            },
          };
        },
        run: async function* (input) {
          attempts += 1;
          inputs.push(input);
          if (attempts === 1) {
            throw new AgentTerminalError('error_max_turns', 'turns exhausted');
          }
          yield { timestamp: new Date().toISOString(), type: 'planning:evaluate:complete', accepted: 0, rejected: 0, verdicts: [] };
        },
      },
    }));

    expect(prepareCalls).toBe(1);
    expect(attempts).toBe(2);
    expect(inputs[0].evaluationSnapshot).toBe(snapshot);
    expect(inputs[1].evaluationSnapshot).toBe(snapshot);
    expect(inputs[1].evaluatorOptions.allowedPathPrefix).toBe('eforge/plans/demo');
    expect(inputs[1].evaluatorOptions.commitMessage).toBe('plan(demo): planning artifacts');
    expect(inputs[1].evaluatorOptions.evaluatorContinuationContext).toEqual({ attempt: 1, maxContinuations: 1 });
    expect(events.find(e => e.type === 'agent:retry')).toMatchObject({ agent: 'plan-evaluator' });
    expect(events.find(e => e.type === 'planning:evaluate:continuation')).toMatchObject({ attempt: 1, maxContinuations: 1 });
  });

  it('emits planning:error and creates no evaluation commit when XML fallback references an unknown hunk', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'eforge/plans/demo/plan.md', 'line 1\nline 2\n');
    await commitAll(repo, 'plan(demo): initial planning artifacts');
    const originalHead = await head(repo);

    await writeRepoFile(repo, 'eforge/plans/demo/plan.md', 'changed line 1\nline 2\n');
    const snapshot = await prepareEvaluationSnapshot(repo, 'HEAD~1');

    const harness = new StubHarness([{
      text: `<evaluation>\n  <verdict file="eforge/plans/demo/plan.md" hunk="2" action="accept">Unknown hunk</verdict>\n</evaluation>`,
    }]);

    const events = await collect(runPlanEvaluate({
      harness,
      planSetName: 'demo',
      sourceContent: 'PRD',
      cwd: repo,
      outputDir: 'eforge/plans',
      evaluationSnapshot: snapshot,
      allowedPathPrefix: 'eforge/plans/demo',
      commitMessage: 'plan(demo): planning artifacts',
    }));

    expect(events.find(e => e.type === 'planning:error')?.reason).toContain('references hunk 2');
    expect(await head(repo)).toBe(originalHead);
    expect(await lastCommitMessage(repo)).not.toBe('plan(demo): planning artifacts');
  });
});
