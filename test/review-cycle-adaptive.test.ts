import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_CONFIG, DEFAULT_REVIEW } from '@eforge-build/engine/config';
import type { AgentRunOptions } from '@eforge-build/engine/harness';
import { singletonRegistry } from '@eforge-build/engine/agent-runtime-registry';
import type { AgentRole, EforgeEvent, OrchestrationConfig, PlanFile } from '@eforge-build/engine/events';
import { getBuildStage, type BuildStageContext } from '@eforge-build/engine/pipeline';
import { ModelTracker } from '@eforge-build/engine/model-tracker';
import { createNoopTracingContext } from '@eforge-build/engine/tracing';
import type { ReviewProfileConfig } from '@eforge-build/client';
import type { PipelineComposition } from '@eforge-build/engine/schemas';
import { StubHarness, type StubResponse } from './stub-harness.js';
import { collectEvents, filterEvents } from './test-events.js';
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

function makeContext(repo: string, harness: StubHarness, preImplementCommit: string): BuildStageContext {
  const planId = 'plan-01-adaptive-review-cycle-perspectives';
  const review: ReviewProfileConfig = {
    strategy: 'parallel',
    perspectives: ['code', 'docs', 'api'],
    maxRounds: 2,
    evaluatorStrictness: 'standard',
  };
  const pipeline: PipelineComposition = {
    scope: 'excursion',
    compile: [],
    defaultBuild: ['review-cycle'],
    defaultReview: DEFAULT_REVIEW,
    rationale: 'adaptive review-cycle test',
  };
  const planFile: PlanFile = {
    id: planId,
    name: 'Adaptive Review-Cycle Perspective Selection',
    dependsOn: [],
    branch: `test/${planId}`,
    body: '# Plan\n\nImplement the feature.\n',
    filePath: join(repo, 'plan.md'),
  };
  const orchConfig: OrchestrationConfig = {
    name: 'adaptive-test',
    description: 'adaptive test',
    created: new Date().toISOString(),
    mode: 'errand',
    baseBranch: 'main',
    pipeline,
    plans: [{ id: planId, name: planFile.name, dependsOn: [], branch: planFile.branch, build: ['review-cycle'], review }],
  };

  return {
    agentRuntimes: singletonRegistry(harness),
    config: DEFAULT_CONFIG,
    pipeline,
    tracing: createNoopTracingContext(),
    cwd: repo,
    planSetName: 'adaptive-test',
    sourceContent: '',
    modelTracker: new ModelTracker(),
    plans: [planFile],
    expeditionModules: [],
    moduleBuildConfigs: new Map(),
    planId,
    worktreePath: repo,
    planFile,
    orchConfig,
    planEntry: orchConfig.plans[0],
    reviewIssues: [],
    build: ['review-cycle'],
    review,
    preImplementCommit,
  };
}

describe('adaptive review-cycle perspective selection', () => {
  const makeTempDir = useTempDir('eforge-review-cycle-adaptive-');

  it('starts round 2 with fewer reviewer perspectives and records dropped perspectives', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'src/app.ts', 'export const value = 1;\n');
    await writeRepoFile(repo, 'docs/guide.md', '# Guide\n');
    await commitAll(repo, 'chore: initial');
    const preImplementCommit = await head(repo);

    await writeRepoFile(repo, 'src/app.ts', 'export const value = 2;\n');
    await commitAll(repo, 'feat: implementation');

    const round1Issue = `<review-issues>
  <issue severity="warning" category="bugs" file="src/app.ts">
    Value needs a follow-up fix.
    <fix>Change value from 2 to 3.</fix>
  </issue>
</review-issues>`;

    class FixingHarness extends StubHarness {
      private readonly reviewerResponses: Record<string, StubResponse[]>;

      constructor(nonReviewerResponses: StubResponse[], reviewerResponses: Record<string, StubResponse[]>) {
        super(nonReviewerResponses);
        this.reviewerResponses = reviewerResponses;
      }

      async *run(options: AgentRunOptions, agent: AgentRole, planId?: string): AsyncGenerator<EforgeEvent> {
        if (agent === 'reviewer') {
          const perspective = options.perspective;
          const routedResponse = perspective ? this.reviewerResponses[perspective]?.shift() : undefined;
          if (!perspective || !routedResponse) {
            throw new Error(`Missing routed reviewer response for perspective ${perspective ?? '<none>'}`);
          }
          for await (const event of new StubHarness([routedResponse]).run(options, agent, planId)) {
            yield event;
          }
          return;
        }

        for await (const event of super.run(options, agent, planId)) {
          yield event;
          if (event.type === 'agent:stop' && agent === 'review-fixer') {
            const current = await readFile(join(repo, 'src/app.ts'), 'utf8');
            await writeRepoFile(repo, 'src/app.ts', current.replace('2', '3'));
          }
        }
      }
    }

    const harness = new FixingHarness([
      { text: 'Applied review fix.' },
      { toolCalls: [{ tool: 'submit_evaluation_verdicts', toolUseId: 'eval-1', input: { verdicts: [{ file: 'src/app.ts', action: 'accept', reason: 'Correct' }] }, output: '' }] },
    ], {
      code: [{ text: round1Issue }, { text: '<review-issues></review-issues>' }],
      docs: [{ text: '<review-issues></review-issues>' }],
      api: [{ text: '<review-issues></review-issues>' }],
    });
    const ctx = makeContext(repo, harness, preImplementCommit);

    const events = await collectEvents(getBuildStage('review-cycle')(ctx));
    const reviewStarts = filterEvents(events, 'plan:build:review:parallel:start');

    expect(reviewStarts).toHaveLength(2);
    expect(reviewStarts[0].perspectives).toHaveLength(3);
    expect(reviewStarts[1].perspectives.length).toBeLessThan(reviewStarts[0].perspectives.length);

    const respawned = events.filter(
      (event): event is Extract<EforgeEvent, { type: 'plan:build:decision' }> =>
        event.type === 'plan:build:decision' && event.decision.kind === 'perspectives-respawned',
    );
    expect(respawned).toHaveLength(2);
    expect(respawned[0].decision.perspectives).toEqual(['code', 'docs', 'api']);
    expect(respawned[0].decision.dropped).toEqual([]);
    const round2Respawned = respawned[1].decision;
    expect(round2Respawned.perspectives).toEqual(reviewStarts[1].perspectives);
    expect(round2Respawned.perspectives).toEqual(['code']);
    expect(round2Respawned.dropped).toEqual(['docs', 'api']);
    expect(round2Respawned.rationale).toContain('Retained 1 perspective(s) and dropped 2');
    for (const dropped of round2Respawned.dropped) {
      expect(round2Respawned.perspectives).not.toContain(dropped);
    }
  });
});
