import { describe, it, expect } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { parseOrchestrationConfig, validatePlanSet } from '@eforge-build/engine/plan';
import { parseBuildConfigBlock } from '@eforge-build/engine/agents/common';
import { useTempDir } from './test-tmpdir.js';
import type { PipelineComposition } from '@eforge-build/engine/schemas';

const TEST_PIPELINE: PipelineComposition = {
  scope: 'excursion',
  compile: ['planner', 'plan-review-cycle'],
  defaultBuild: ['implement', 'review-cycle'],
  defaultReview: { strategy: 'auto', perspectives: ['code'], maxRounds: 1, evaluatorStrictness: 'standard' },
  rationale: 'test pipeline',
};

describe('parseOrchestrationConfig per-plan build/review', () => {
  const makeTempDir = useTempDir();

  it('reads per-plan build and review from YAML', async () => {
    const dir = makeTempDir();
    const orchYaml = stringifyYaml({
      name: 'test-set',
      description: 'Test',
      created: '2026-01-01',
      mode: 'expedition',
      base_branch: 'main',
      pipeline: TEST_PIPELINE,
      plans: [
        {
          id: 'plan-01-auth',
          name: 'Auth module',
          depends_on: [],
          branch: 'test-set/auth',
          build: [['implement', 'doc-author'], 'doc-sync', 'review-cycle'],
          review: {
            strategy: 'parallel',
            perspectives: ['code', 'security'],
            maxRounds: 2,
            evaluatorStrictness: 'strict',
          },
        },
      ],
    });

    const yamlPath = resolve(dir, 'orchestration.yaml');
    await writeFile(yamlPath, orchYaml, 'utf-8');

    const config = await parseOrchestrationConfig(yamlPath);
    const plan = config.plans[0];

    expect(plan.build).toEqual([['implement', 'doc-author'], 'doc-sync', 'review-cycle']);
    expect(plan.review).toEqual({
      strategy: 'parallel',
      perspectives: ['code', 'security'],
      maxRounds: 2,
      evaluatorStrictness: 'strict',
    });
  });

  it('throws on invalid per-plan build config', async () => {
    const dir = makeTempDir();
    const orchYaml = stringifyYaml({
      name: 'test-set',
      description: 'Test',
      created: '2026-01-01',
      mode: 'errand',
      base_branch: 'main',
      pipeline: TEST_PIPELINE,
      plans: [
        {
          id: 'plan-01-bad',
          name: 'Bad plan',
          depends_on: [],
          branch: 'test-set/bad',
          build: 'not-an-array',
        },
      ],
    });

    const yamlPath = resolve(dir, 'orchestration.yaml');
    await writeFile(yamlPath, orchYaml, 'utf-8');

    await expect(parseOrchestrationConfig(yamlPath)).rejects.toThrow(/invalid or missing 'build'/);
  });

  it('throws on invalid per-plan review config', async () => {
    const dir = makeTempDir();
    const orchYaml = stringifyYaml({
      name: 'test-set',
      description: 'Test',
      created: '2026-01-01',
      mode: 'errand',
      base_branch: 'main',
      pipeline: TEST_PIPELINE,
      plans: [
        {
          id: 'plan-01-bad',
          name: 'Bad plan',
          depends_on: [],
          branch: 'test-set/bad',
          build: ['implement', 'review-cycle'],
          review: { strategy: 'invalid' },
        },
      ],
    });

    const yamlPath = resolve(dir, 'orchestration.yaml');
    await writeFile(yamlPath, orchYaml, 'utf-8');

    await expect(parseOrchestrationConfig(yamlPath)).rejects.toThrow(/invalid or missing 'review'/);
  });
});

describe('validatePlanSet per-plan stage name validation', () => {
  const makeTempDir = useTempDir();

  it('catches invalid per-plan build stage names', async () => {
    const dir = makeTempDir();
    const planDir = resolve(dir, 'plans');
    await mkdir(planDir, { recursive: true });

    const planContent = '---\nid: plan-01-test\nname: Test Plan\nbranch: test/branch\ndepends_on: []\n---\n\nTest body';
    await writeFile(resolve(planDir, 'plan-01-test.md'), planContent, 'utf-8');

    const orchYaml = stringifyYaml({
      name: 'test-set',
      description: 'Test',
      created: '2026-01-01',
      mode: 'errand',
      base_branch: 'main',
      pipeline: TEST_PIPELINE,
      plans: [
        {
          id: 'plan-01-test',
          name: 'Test Plan',
          depends_on: [],
          branch: 'test/branch',
          build: ['implement', 'nonexistent-stage'],
          review: {
            strategy: 'auto',
            perspectives: ['code'],
            maxRounds: 1,
            evaluatorStrictness: 'standard',
          },
        },
      ],
    });

    await writeFile(resolve(planDir, 'orchestration.yaml'), orchYaml, 'utf-8');

    const result = await validatePlanSet(resolve(planDir, 'orchestration.yaml'));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('nonexistent-stage'))).toBe(true);
  });
});

describe('parseBuildConfigBlock', () => {
  it('parses valid JSON with build and review fields', () => {
    const text = `Some message text
<build-config>
{
  "build": [["implement", "doc-author"], "doc-sync", "review-cycle"],
  "review": {
    "strategy": "parallel",
    "perspectives": ["code", "security"],
    "maxRounds": 2,
    "evaluatorStrictness": "strict"
  }
}
</build-config>
More text after`;

    const result = parseBuildConfigBlock(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok result');
    expect(result.config.build).toEqual([['implement', 'doc-author'], 'doc-sync', 'review-cycle']);
    expect(result.config.review.strategy).toBe('parallel');
    expect(result.config.review.perspectives).toEqual(['code', 'security']);
    expect(result.config.review.maxRounds).toBe(2);
    expect(result.config.review.evaluatorStrictness).toBe('strict');
  });

  it('returns no-block when no block is present', () => {
    const result = parseBuildConfigBlock('just some text without any blocks');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected failure result');
    expect(result.reason).toBe('no-block');
  });

  it('returns invalid-json on malformed JSON', () => {
    const text = '<build-config>not valid json</build-config>';
    const result = parseBuildConfigBlock(text);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected failure result');
    expect(result.reason).toBe('invalid-json');
    expect(typeof result.raw).toBe('string');
  });

  it('returns invalid-schema with errors when JSON does not match schema', () => {
    const text = '<build-config>{"build": "not-an-array"}</build-config>';
    const result = parseBuildConfigBlock(text);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected failure result');
    expect(result.reason).toBe('invalid-schema');
    if (result.reason !== 'invalid-schema') throw new Error('Expected invalid-schema');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns invalid-schema with errors when review field is missing', () => {
    const text = '<build-config>{"build": ["implement"]}</build-config>';
    const result = parseBuildConfigBlock(text);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected failure result');
    expect(result.reason).toBe('invalid-schema');
    if (result.reason !== 'invalid-schema') throw new Error('Expected invalid-schema');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns invalid-schema with errors mentioning perspectives when perspectives contains invalid value', () => {
    const text = `<build-config>${JSON.stringify({
      build: ['implement'],
      review: {
        strategy: 'single',
        perspectives: ['correctness'],
        maxRounds: 1,
        evaluatorStrictness: 'standard',
      },
    })}</build-config>`;
    const result = parseBuildConfigBlock(text);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected failure result');
    expect(result.reason).toBe('invalid-schema');
    if (result.reason !== 'invalid-schema') throw new Error('Expected invalid-schema');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes('perspectives'))).toBe(true);
  });
});
