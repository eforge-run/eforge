import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { parsePlanFile, parseOrchestrationConfig } from '../src/engine/plan.js';

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
  it('parses valid config', async () => {
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
    });
    expect(config.plans[1].dependsOn).toEqual(['core']);
  });

  it('throws on missing name', async () => {
    await expect(
      parseOrchestrationConfig(resolve(fixturesDir, 'orchestration/no-name.yaml')),
    ).rejects.toThrow(/name/i);
  });
});
