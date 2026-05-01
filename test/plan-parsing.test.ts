import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { parsePlanFile, parseOrchestrationConfig, injectPipelineIntoOrchestrationYaml, transitiveReduce } from '@eforge-build/engine/plan';
import { useTempDir } from './test-tmpdir.js';
import type { PipelineComposition } from '@eforge-build/engine/schemas';

const TEST_PIPELINE: PipelineComposition = {
  scope: 'excursion',
  compile: ['planner', 'plan-review-cycle'],
  defaultBuild: ['implement', 'review-cycle'],
  defaultReview: { strategy: 'auto', perspectives: ['code'], maxRounds: 1, evaluatorStrictness: 'standard' },
  rationale: 'test pipeline',
};

const ERRAND_PIPELINE: PipelineComposition = {
  scope: 'errand',
  compile: ['planner'],
  defaultBuild: ['implement', 'review-cycle'],
  defaultReview: { strategy: 'auto', perspectives: ['code'], maxRounds: 1, evaluatorStrictness: 'standard' },
  rationale: 'test errand pipeline',
};

const fixturesDir = resolve(import.meta.dirname, 'fixtures');

describe('parsePlanFile', () => {
  it('parses valid plan correctly', async () => {
    const plan = await parsePlanFile(resolve(fixturesDir, 'plans/valid-plan.md'));
    expect(plan.id).toBe('test-plan');
    expect(plan.name).toBe('Test Plan');
    expect(plan.branch).toBe('feature/test');
    expect(plan.dependsOn).toEqual([]);
    expect(plan.migrations).toBeUndefined();
    expect(plan.body).toContain('This is the plan body.');
  });

  it('parses migrations and always returns dependsOn: []', async () => {
    const plan = await parsePlanFile(resolve(fixturesDir, 'plans/with-dependencies.md'));
    expect(plan.id).toBe('dependent-plan');
    expect(plan.dependsOn).toEqual([]);
    expect(plan.migrations).toHaveLength(2);
    expect(plan.migrations![0]).toEqual({
      timestamp: '20260101000000',
      description: 'Add users table',
    });
  });

  it('returns dependsOn: [] even when frontmatter contains legacy depends_on field', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eforge-legacy-deps-'));
    const planPath = join(dir, 'legacy-plan.md');
    writeFileSync(planPath, `---
id: legacy-plan
name: Legacy Plan
depends_on:
  - plan-99
branch: legacy/main
---

# Legacy plan body
`);
    try {
      const plan = await parsePlanFile(planPath);
      expect(plan.dependsOn).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on missing frontmatter', async () => {
    await expect(
      parsePlanFile(resolve(fixturesDir, 'plans/no-frontmatter.md')),
    ).rejects.toThrow(/frontmatter/i);
  });

  it('throws on missing id', async () => {
    await expect(
      parsePlanFile(resolve(fixturesDir, 'plans/missing-id.md')),
    ).rejects.toThrow(/id/i);
  });

  it('throws on nonexistent file', async () => {
    await expect(
      parsePlanFile(resolve(fixturesDir, 'plans/does-not-exist.md')),
    ).rejects.toThrow();
  });
});

describe('parseOrchestrationConfig', () => {
  it('parses valid config with inline profile', async () => {
    const config = await parseOrchestrationConfig(
      resolve(fixturesDir, 'orchestration/valid.yaml'),
    );
    expect(config.name).toBe('test-orchestration');
    expect(config.description).toBe('A test orchestration config');
    expect(config.mode).toBe('excursion');
    expect(config.baseBranch).toBe('main');
    expect(config.plans).toHaveLength(2);
    expect(config.plans[0]).toEqual({
      id: 'core',
      name: 'Core Module',
      dependsOn: [],
      branch: 'feature/core',
      build: [['implement', 'doc-author'], 'doc-sync', 'review-cycle'],
      review: {
        strategy: 'auto',
        perspectives: ['code'],
        maxRounds: 1,
        evaluatorStrictness: 'standard',
      },
    });
    expect(config.plans[1].dependsOn).toEqual(['core']);

    // Pipeline fields
    expect(config.pipeline.scope).toBe('excursion');
    expect(config.pipeline.compile).toEqual(['planner', 'plan-review-cycle']);
    expect(config.pipeline.rationale).toBe('test pipeline');
  });

  it('throws on missing name', async () => {
    await expect(
      parseOrchestrationConfig(resolve(fixturesDir, 'orchestration/no-name.yaml')),
    ).rejects.toThrow(/name/i);
  });

  it('throws when YAML has no pipeline field', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eforge-orch-test-'));
    const yamlPath = join(dir, 'orchestration.yaml');
    writeFileSync(yamlPath, stringifyYaml({
      name: 'test',
      description: 'test',
      created: '2026-01-01',
      mode: 'errand',
      base_branch: 'main',
      plans: [{ id: 'p1', name: 'Plan 1', branch: 'b1', build: ['implement', 'review-cycle'], review: { strategy: 'auto', perspectives: ['code'], maxRounds: 1, evaluatorStrictness: 'standard' } }],
    }));

    await expect(parseOrchestrationConfig(yamlPath)).rejects.toThrow(/pipeline/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws when pipeline field is malformed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eforge-orch-test-'));
    const yamlPath = join(dir, 'orchestration.yaml');
    writeFileSync(yamlPath, stringifyYaml({
      name: 'test',
      description: 'test',
      created: '2026-01-01',
      mode: 'errand',
      base_branch: 'main',
      pipeline: { scope: 'invalid' }, // Missing required fields and invalid scope
      plans: [{ id: 'p1', name: 'Plan 1', branch: 'b1', build: ['implement', 'review-cycle'], review: { strategy: 'auto', perspectives: ['code'], maxRounds: 1, evaluatorStrictness: 'standard' } }],
    }));

    await expect(parseOrchestrationConfig(yamlPath)).rejects.toThrow(/pipeline/i);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('transitiveReduce', () => {
  it('returns empty array for empty input', () => {
    expect(transitiveReduce([])).toEqual([]);
  });

  it('returns single plan with no deps unchanged', () => {
    const plans = [{ id: 'A', dependsOn: [] as string[] }];
    expect(transitiveReduce(plans)).toEqual(plans);
  });

  it('removes redundant edge in linear chain (A->B->C)', () => {
    const plans = [
      { id: 'A', dependsOn: [] as string[] },
      { id: 'B', dependsOn: ['A'] },
      { id: 'C', dependsOn: ['A', 'B'] },
    ];
    const result = transitiveReduce(plans);
    expect(result.find((p) => p.id === 'C')!.dependsOn).toEqual(['B']);
    // A and B should be unchanged
    expect(result.find((p) => p.id === 'A')!.dependsOn).toEqual([]);
    expect(result.find((p) => p.id === 'B')!.dependsOn).toEqual(['A']);
  });

  it('reduces diamond dependency pattern', () => {
    const plans = [
      { id: 'A', dependsOn: [] as string[] },
      { id: 'B', dependsOn: ['A'] },
      { id: 'C', dependsOn: ['A'] },
      { id: 'D', dependsOn: ['A', 'B', 'C'] },
    ];
    const result = transitiveReduce(plans);
    const dDeps = result.find((p) => p.id === 'D')!.dependsOn;
    expect(dDeps).toEqual(['B', 'C']);
  });

  it('passes through already-minimal graph unchanged', () => {
    const plans = [
      { id: 'A', dependsOn: [] as string[] },
      { id: 'B', dependsOn: ['A'] },
      { id: 'C', dependsOn: ['B'] },
    ];
    const result = transitiveReduce(plans);
    expect(result).toEqual(plans);
  });

  it('does not mutate the input array', () => {
    const plans = [
      { id: 'A', dependsOn: [] as string[] },
      { id: 'B', dependsOn: ['A'] },
      { id: 'C', dependsOn: ['A', 'B'] },
    ];
    const original = plans.map((p) => ({ ...p, dependsOn: [...p.dependsOn] }));
    transitiveReduce(plans);
    expect(plans).toEqual(original);
  });
});

describe('injectPipelineIntoOrchestrationYaml', () => {
  const makeTempDir = useTempDir('eforge-inject-pipeline-');

  it('reads existing orchestration.yaml, adds pipeline, and writes it back', async () => {
    const dir = makeTempDir();
    const yamlPath = join(dir, 'orchestration.yaml');

    // Write a minimal orchestration.yaml without pipeline
    writeFileSync(yamlPath, stringifyYaml({
      name: 'inject-test',
      description: 'Test injection',
      created: '2026-01-01',
      mode: 'errand',
      base_branch: 'main',
      plans: [{ id: 'p1', name: 'Plan 1', depends_on: [], branch: 'b1', build: ['implement', 'review-cycle'], review: { strategy: 'auto', perspectives: ['code'], maxRounds: 1, evaluatorStrictness: 'standard' } }],
    }));

    await injectPipelineIntoOrchestrationYaml(yamlPath, ERRAND_PIPELINE);

    // Parse the result to verify
    const config = await parseOrchestrationConfig(yamlPath);
    expect(config.name).toBe('inject-test');
    expect(config.pipeline.scope).toBe('errand');
    expect(config.pipeline.compile).toEqual(ERRAND_PIPELINE.compile);
  });

  it('overrides base_branch when provided', async () => {
    const dir = makeTempDir();
    const yamlPath = join(dir, 'orchestration.yaml');

    // Write orchestration.yaml with a wrong base_branch (simulates planner seeing feature branch)
    writeFileSync(yamlPath, stringifyYaml({
      name: 'branch-override-test',
      description: 'Test base_branch override',
      created: '2026-01-01',
      mode: 'errand',
      base_branch: 'eforge/some-feature-branch',
      plans: [{ id: 'p1', name: 'Plan 1', depends_on: [], branch: 'b1', build: ['implement', 'review-cycle'], review: { strategy: 'auto', perspectives: ['code'], maxRounds: 1, evaluatorStrictness: 'standard' } }],
    }));

    await injectPipelineIntoOrchestrationYaml(yamlPath, ERRAND_PIPELINE, 'develop');

    const config = await parseOrchestrationConfig(yamlPath);
    expect(config.baseBranch).toBe('develop');
  });

  it('backfills per-plan build/review from pipeline defaults when absent', async () => {
    const dir = makeTempDir();
    const yamlPath = join(dir, 'orchestration.yaml');

    // Write orchestration.yaml exactly as writePlanSet emits it: no per-plan build/review.
    writeFileSync(yamlPath, stringifyYaml({
      name: 'backfill-test',
      description: 'Test backfill',
      created: '2026-01-01',
      mode: 'errand',
      base_branch: 'main',
      plans: [{ id: 'p1', name: 'Plan 1', depends_on: [], branch: 'b1' }],
    }));

    await injectPipelineIntoOrchestrationYaml(yamlPath, ERRAND_PIPELINE);

    // Before the fix, parseOrchestrationConfig would throw: "Plan 'p1' has invalid or missing 'build' field".
    const config = await parseOrchestrationConfig(yamlPath);
    expect(config.plans[0].build).toEqual(ERRAND_PIPELINE.defaultBuild);
    expect(config.plans[0].review).toEqual(ERRAND_PIPELINE.defaultReview);
  });

  it('preserves per-plan build/review when planner specifies them (planner-override path)', async () => {
    const dir = makeTempDir();
    const yamlPath = join(dir, 'orchestration.yaml');

    // Plan A has planner-chosen build/review; plan B has neither (backfill path).
    const planABuild = [['implement', 'doc-author'], 'doc-sync', 'review-cycle'];
    const planAReview = { strategy: 'parallel' as const, perspectives: ['code', 'security'], maxRounds: 2, evaluatorStrictness: 'strict' as const };

    writeFileSync(yamlPath, stringifyYaml({
      name: 'planner-override-test',
      description: 'Test planner per-plan build/review override',
      created: '2026-01-01',
      mode: 'errand',
      base_branch: 'main',
      plans: [
        { id: 'plan-a', name: 'Plan A', depends_on: [], branch: 'branch-a', build: planABuild, review: planAReview },
        { id: 'plan-b', name: 'Plan B', depends_on: ['plan-a'], branch: 'branch-b' },
      ],
    }));

    await injectPipelineIntoOrchestrationYaml(yamlPath, ERRAND_PIPELINE);

    const config = await parseOrchestrationConfig(yamlPath);

    // Plan A: planner-chosen values must be preserved, not overwritten by ERRAND_PIPELINE defaults.
    expect(config.plans[0].build).toEqual(planABuild);
    expect(config.plans[0].review.strategy).toBe('parallel');
    expect(config.plans[0].review.maxRounds).toBe(2);

    // Plan B: no planner override, so composer defaults kick in.
    expect(config.plans[1].build).toEqual(ERRAND_PIPELINE.defaultBuild);
    expect(config.plans[1].review).toEqual(ERRAND_PIPELINE.defaultReview);
  });

  it('preserves base_branch when baseBranch arg is omitted', async () => {
    const dir = makeTempDir();
    const yamlPath = join(dir, 'orchestration.yaml');

    writeFileSync(yamlPath, stringifyYaml({
      name: 'no-override-test',
      description: 'Test base_branch preserved',
      created: '2026-01-01',
      mode: 'errand',
      base_branch: 'main',
      plans: [{ id: 'p1', name: 'Plan 1', depends_on: [], branch: 'b1', build: ['implement', 'review-cycle'], review: { strategy: 'auto', perspectives: ['code'], maxRounds: 1, evaluatorStrictness: 'standard' } }],
    }));

    await injectPipelineIntoOrchestrationYaml(yamlPath, ERRAND_PIPELINE);

    const config = await parseOrchestrationConfig(yamlPath);
    expect(config.baseBranch).toBe('main');
  });
});

// --- Per-plan agents tuning ---

describe('parsePlanFile agents tuning', () => {
  const makeTempDir = useTempDir('eforge-plan-agents-');

  it('round-trips frontmatter with valid agents block', async () => {
    const dir = makeTempDir();
    const planPath = join(dir, 'plan-with-agents.md');
    writeFileSync(planPath, `---
id: plan-01-refactor
name: Refactor Auth
branch: refactor/main
agents:
  builder:
    effort: xhigh
    rationale: complex refactor
  reviewer:
    effort: high
---

# Refactor plan body
`);

    const plan = await parsePlanFile(planPath);
    expect(plan.id).toBe('plan-01-refactor');
    expect(plan.agents).toBeDefined();
    expect(plan.agents!.builder).toEqual({ effort: 'xhigh', rationale: 'complex refactor' });
    expect(plan.agents!.reviewer).toEqual({ effort: 'high' });
  });

  it('malformed agents block is dropped (no throw, agents field is undefined)', async () => {
    const dir = makeTempDir();
    const planPath = join(dir, 'plan-bad-agents.md');
    writeFileSync(planPath, `---
id: plan-02-bad
name: Bad Agents Plan
branch: bad/main
agents:
  builder:
    effort: invalid-value
---

# Plan body
`);

    // Should not throw
    const plan = await parsePlanFile(planPath);
    expect(plan.id).toBe('plan-02-bad');
    expect(plan.agents).toBeUndefined();
  });

  it('malformed agents block returns warnings field with diagnostic message', async () => {
    const dir = makeTempDir();
    const planPath = join(dir, 'plan-warn-agents.md');
    writeFileSync(planPath, `---
id: plan-03-warn
name: Warn Agents Plan
branch: warn/main
agents:
  builder:
    effort: not-a-valid-effort
---

# Plan body
`);

    const plan = await parsePlanFile(planPath);
    // agents is silently dropped
    expect(plan.agents).toBeUndefined();
    // but a warning is returned describing the problem
    expect(plan.warnings).toBeDefined();
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings![0]).toContain('agents');
  });

  it('valid agents block has no warnings', async () => {
    const dir = makeTempDir();
    const planPath = join(dir, 'plan-ok-agents.md');
    writeFileSync(planPath, `---
id: plan-04-ok
name: OK Agents Plan
branch: ok/main
agents:
  builder:
    effort: high
    rationale: solid rationale
---

# Plan body
`);

    const plan = await parsePlanFile(planPath);
    expect(plan.agents).toBeDefined();
    expect(plan.warnings).toBeUndefined();
  });

  it('plan without agents block has undefined agents', async () => {
    const plan = await parsePlanFile(resolve(fixturesDir, 'plans/valid-plan.md'));
    expect(plan.agents).toBeUndefined();
    expect(plan.warnings).toBeUndefined();
  });
});

describe('parseOrchestrationConfig agents propagation', () => {
  const makeTempDir = useTempDir('eforge-orch-agents-');

  it('propagates agents from plan entries in orchestration.yaml', async () => {
    const dir = makeTempDir();
    const yamlPath = join(dir, 'orchestration.yaml');
    writeFileSync(yamlPath, stringifyYaml({
      name: 'agents-test',
      description: 'Test agents propagation',
      created: '2026-01-01',
      mode: 'errand',
      base_branch: 'main',
      pipeline: ERRAND_PIPELINE,
      plans: [{
        id: 'p1',
        name: 'Plan 1',
        depends_on: [],
        branch: 'b1',
        build: ['implement', 'review-cycle'],
        review: { strategy: 'auto', perspectives: ['code'], maxRounds: 1, evaluatorStrictness: 'standard' },
        agents: {
          builder: { effort: 'xhigh', rationale: 'complex work' },
          reviewer: { effort: 'high' },
        },
      }],
    }));

    const config = await parseOrchestrationConfig(yamlPath);
    expect(config.plans[0].agents).toBeDefined();
    expect(config.plans[0].agents!.builder).toEqual({ effort: 'xhigh', rationale: 'complex work' });
    expect(config.plans[0].agents!.reviewer).toEqual({ effort: 'high' });
  });

  it('plan entry without agents has no agents field', async () => {
    const dir = makeTempDir();
    const yamlPath = join(dir, 'orchestration.yaml');
    writeFileSync(yamlPath, stringifyYaml({
      name: 'no-agents-test',
      description: 'No agents',
      created: '2026-01-01',
      mode: 'errand',
      base_branch: 'main',
      pipeline: ERRAND_PIPELINE,
      plans: [{
        id: 'p1',
        name: 'Plan 1',
        depends_on: [],
        branch: 'b1',
        build: ['implement', 'review-cycle'],
        review: { strategy: 'auto', perspectives: ['code'], maxRounds: 1, evaluatorStrictness: 'standard' },
      }],
    }));

    const config = await parseOrchestrationConfig(yamlPath);
    expect(config.plans[0].agents).toBeUndefined();
    expect(config.warnings).toBeUndefined();
  });

  it('malformed agents block in plan entry returns warnings (no throw)', async () => {
    const dir = makeTempDir();
    const yamlPath = join(dir, 'orchestration.yaml');
    writeFileSync(yamlPath, stringifyYaml({
      name: 'bad-agents-orch-test',
      description: 'Test malformed agents in orch config',
      created: '2026-01-01',
      mode: 'errand',
      base_branch: 'main',
      pipeline: ERRAND_PIPELINE,
      plans: [{
        id: 'p1',
        name: 'Plan 1',
        depends_on: [],
        branch: 'b1',
        build: ['implement', 'review-cycle'],
        review: { strategy: 'auto', perspectives: ['code'], maxRounds: 1, evaluatorStrictness: 'standard' },
        agents: {
          builder: { effort: 'not-a-real-effort-level' },
        },
      }],
    }));

    // Should not throw — invalid agents are silently dropped
    const config = await parseOrchestrationConfig(yamlPath);
    expect(config.plans[0].agents).toBeUndefined();
    // But a warning is returned
    expect(config.warnings).toBeDefined();
    expect(config.warnings!.length).toBeGreaterThan(0);
    expect(config.warnings![0]).toContain('p1');
  });

  it('valid agents block in orchestration config has no warnings', async () => {
    const dir = makeTempDir();
    const yamlPath = join(dir, 'orchestration.yaml');
    writeFileSync(yamlPath, stringifyYaml({
      name: 'valid-agents-orch-test',
      description: 'Test valid agents in orch config',
      created: '2026-01-01',
      mode: 'errand',
      base_branch: 'main',
      pipeline: ERRAND_PIPELINE,
      plans: [{
        id: 'p1',
        name: 'Plan 1',
        depends_on: [],
        branch: 'b1',
        build: ['implement', 'review-cycle'],
        review: { strategy: 'auto', perspectives: ['code'], maxRounds: 1, evaluatorStrictness: 'standard' },
        agents: {
          builder: { effort: 'high', rationale: 'good work' },
        },
      }],
    }));

    const config = await parseOrchestrationConfig(yamlPath);
    expect(config.plans[0].agents).toBeDefined();
    expect(config.warnings).toBeUndefined();
  });
});
