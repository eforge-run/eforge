import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { parsePlanFile, parseOrchestrationConfig, injectPipelineIntoOrchestrationYaml } from '../src/engine/plan.js';
import { useTempDir } from './test-tmpdir.js';
import type { PipelineComposition } from '../src/engine/schemas.js';

const TEST_PIPELINE: PipelineComposition = {
  scope: 'excursion',
  compile: ['planner', 'plan-review-cycle'],
  defaultBuild: ['implement', 'review-cycle'],
  defaultReview: { strategy: 'auto', perspectives: ['code'], maxRounds: 1, evaluatorStrictness: 'standard' },
  rationale: 'test pipeline',
};

const ERRAND_PIPELINE: PipelineComposition = {
  scope: 'errand',
  compile: ['prd-passthrough'],
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

  it('parses dependencies and migrations', async () => {
    const plan = await parsePlanFile(resolve(fixturesDir, 'plans/with-dependencies.md'));
    expect(plan.id).toBe('dependent-plan');
    expect(plan.dependsOn).toEqual(['core', 'config']);
    expect(plan.migrations).toHaveLength(2);
    expect(plan.migrations![0]).toEqual({
      timestamp: '20260101000000',
      description: 'Add users table',
    });
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
      build: [['implement', 'doc-update'], 'review-cycle'],
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
