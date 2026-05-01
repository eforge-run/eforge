import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { compileExpedition } from '@eforge-build/engine/compiler';
import {
  parseExpeditionIndex,
  indexModulesToExpeditionModules,
  injectPipelineIntoOrchestrationYaml,
  parseOrchestrationConfig,
} from '@eforge-build/engine/plan';
import type { PipelineComposition } from '@eforge-build/engine/schemas';

describe('parseExpeditionIndex', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'eforge-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses a valid index.yaml', async () => {
    const yaml = `
name: test-expedition
description: Test expedition
created: "2026-03-13"
status: architecture-complete
mode: expedition

architecture:
  status: complete
  last_updated: 2026-03-13

modules:
  foundation:
    status: pending
    description: Core types
  auth:
    status: pending
    description: Auth system
    depends_on: [foundation]
`;
    await writeFile(resolve(tmpDir, 'index.yaml'), yaml);

    const index = await parseExpeditionIndex(resolve(tmpDir, 'index.yaml'));
    expect(index.name).toBe('test-expedition');
    expect(index.status).toBe('architecture-complete');
    expect(index.mode).toBe('expedition');
    expect(Object.keys(index.modules)).toEqual(['foundation', 'auth']);
    expect(index.modules.foundation.dependsOn).toEqual([]);
    expect(index.modules.auth.dependsOn).toEqual(['foundation']);
  });
});

describe('indexModulesToExpeditionModules', () => {
  it('converts index modules to ExpeditionModule array', () => {
    const modules = {
      foundation: { status: 'pending', description: 'Core types', dependsOn: [] },
      auth: { status: 'pending', description: 'Auth system', dependsOn: ['foundation'] },
    };

    const result = indexModulesToExpeditionModules(modules);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: 'foundation', description: 'Core types', dependsOn: [] });
    expect(result[1]).toEqual({ id: 'auth', description: 'Auth system', dependsOn: ['foundation'] });
  });
});

describe('compileExpedition', () => {
  let tmpDir: string;
  let planDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'eforge-test-'));
    planDir = resolve(tmpDir, 'eforge', 'plans', 'test-exp');
    await mkdir(resolve(planDir, 'modules'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('compiles modules into plan files and orchestration.yaml', async () => {
    // Write index.yaml
    await writeFile(
      resolve(planDir, 'index.yaml'),
      `
name: test-exp
description: Test expedition
created: "2026-03-13"
status: architecture-complete
mode: expedition

architecture:
  status: complete

modules:
  foundation:
    status: planned
    description: Core types and utilities
  planner:
    status: planned
    description: Planner agent
    depends_on: [foundation]
  cli:
    status: planned
    description: CLI layer
    depends_on: [planner]
`,
    );

    // Write module files
    await writeFile(resolve(planDir, 'modules', 'foundation.md'), '# Foundation\n\nCore types implementation.');
    await writeFile(resolve(planDir, 'modules', 'planner.md'), '# Planner\n\nPlanner agent implementation.');
    await writeFile(resolve(planDir, 'modules', 'cli.md'), '# CLI\n\nCLI layer implementation.');

    const plans = await compileExpedition(tmpDir, 'test-exp');

    // Should produce 3 plan files in topological order
    expect(plans).toHaveLength(3);
    expect(plans[0].id).toBe('plan-01-foundation');
    expect(plans[0].dependsOn).toEqual([]);
    expect(plans[1].id).toBe('plan-02-planner');
    expect(plans[1].dependsOn).toEqual(['plan-01-foundation']);
    expect(plans[2].id).toBe('plan-03-cli');
    expect(plans[2].dependsOn).toEqual(['plan-02-planner']);

    // Check plan file content
    const planContent = await readFile(resolve(planDir, 'plan-01-foundation.md'), 'utf-8');
    expect(planContent).toContain('id: plan-01-foundation');
    expect(planContent).toContain('Core types implementation.');

    // Check orchestration.yaml was generated
    const orchContent = await readFile(resolve(planDir, 'orchestration.yaml'), 'utf-8');
    expect(orchContent).toContain('mode: expedition');
    expect(orchContent).toContain('plan-01-foundation');
    expect(orchContent).toContain('plan-02-planner');
    expect(orchContent).toContain('plan-03-cli');

    // Check index.yaml was updated
    const indexContent = await readFile(resolve(planDir, 'index.yaml'), 'utf-8');
    expect(indexContent).toContain('status: compiled');
  });

  it('handles parallel modules (same wave) with alphabetical ordering', async () => {
    await writeFile(
      resolve(planDir, 'index.yaml'),
      `
name: test-exp
description: Parallel test
created: "2026-03-13"
status: architecture-complete
mode: expedition

architecture:
  status: complete

modules:
  zebra:
    status: planned
    description: Zebra module
  alpha:
    status: planned
    description: Alpha module
  beta:
    status: planned
    description: Beta module
    depends_on: [alpha, zebra]
`,
    );

    await writeFile(resolve(planDir, 'modules', 'zebra.md'), '# Zebra');
    await writeFile(resolve(planDir, 'modules', 'alpha.md'), '# Alpha');
    await writeFile(resolve(planDir, 'modules', 'beta.md'), '# Beta');

    const plans = await compileExpedition(tmpDir, 'test-exp');

    // alpha and zebra are wave 1 (no deps), beta is wave 2
    // Within wave 1, alphabetical order
    expect(plans[0].id).toBe('plan-01-alpha');
    expect(plans[1].id).toBe('plan-02-zebra');
    expect(plans[2].id).toBe('plan-03-beta');
    expect(plans[2].dependsOn).toEqual(['plan-01-alpha', 'plan-02-zebra']);
  });

  it('produces orchestration.yaml that round-trips through parseOrchestrationConfig after pipeline inject (no per-module configs)', async () => {
    await writeFile(
      resolve(planDir, 'index.yaml'),
      `
name: test-exp
description: Round-trip test
created: "2026-04-23"
status: architecture-complete
mode: expedition

architecture:
  status: complete

modules:
  foundation:
    status: planned
    description: Core types
  planner:
    status: planned
    description: Planner agent
    depends_on: [foundation]
`,
    );

    await writeFile(resolve(planDir, 'modules', 'foundation.md'), '# Foundation');
    await writeFile(resolve(planDir, 'modules', 'planner.md'), '# Planner');

    await compileExpedition(tmpDir, 'test-exp');

    const pipeline: PipelineComposition = {
      scope: 'expedition',
      compile: ['planner', 'compile-expedition'],
      defaultBuild: ['implement', ['review-cycle', 'doc-author']],
      defaultReview: {
        strategy: 'auto',
        perspectives: ['code'],
        maxRounds: 1,
        evaluatorStrictness: 'standard',
      },
      rationale: 'test',
    };
    const orchPath = resolve(planDir, 'orchestration.yaml');
    await injectPipelineIntoOrchestrationYaml(orchPath, pipeline, 'main');

    const config = await parseOrchestrationConfig(orchPath);
    expect(config.plans).toHaveLength(2);
    expect(config.baseBranch).toBe('main');
    for (const p of config.plans) {
      expect(p.build).toEqual(pipeline.defaultBuild);
      expect(p.review).toEqual(pipeline.defaultReview);
    }
  });

  it('preserves per-module build/review when moduleBuildConfigs are provided and backfills defaults for the rest', async () => {
    await writeFile(
      resolve(planDir, 'index.yaml'),
      `
name: test-exp
description: Per-module config test
created: "2026-04-23"
status: architecture-complete
mode: expedition

architecture:
  status: complete

modules:
  foundation:
    status: planned
    description: Core types
  planner:
    status: planned
    description: Planner agent
    depends_on: [foundation]
`,
    );

    await writeFile(resolve(planDir, 'modules', 'foundation.md'), '# Foundation');
    await writeFile(resolve(planDir, 'modules', 'planner.md'), '# Planner');

    const moduleBuildConfigs = new Map([
      [
        'foundation',
        {
          build: ['implement'] as Array<string | string[]>,
          review: {
            strategy: 'single' as const,
            perspectives: ['code'],
            maxRounds: 2,
            evaluatorStrictness: 'lenient' as const,
          },
        },
      ],
    ]);
    await compileExpedition(tmpDir, 'test-exp', moduleBuildConfigs);

    const pipeline: PipelineComposition = {
      scope: 'expedition',
      compile: ['planner', 'compile-expedition'],
      defaultBuild: ['implement', 'review-cycle'],
      defaultReview: {
        strategy: 'auto',
        perspectives: ['code'],
        maxRounds: 1,
        evaluatorStrictness: 'standard',
      },
      rationale: 'test',
    };
    const orchPath = resolve(planDir, 'orchestration.yaml');
    await injectPipelineIntoOrchestrationYaml(orchPath, pipeline, 'main');

    const config = await parseOrchestrationConfig(orchPath);
    const foundation = config.plans.find((p) => p.id === 'plan-01-foundation');
    const planner = config.plans.find((p) => p.id === 'plan-02-planner');

    // Per-module config wins for foundation
    expect(foundation?.build).toEqual(['implement']);
    expect(foundation?.review.strategy).toBe('single');
    expect(foundation?.review.maxRounds).toBe(2);
    expect(foundation?.review.evaluatorStrictness).toBe('lenient');

    // Planner falls back to pipeline defaults
    expect(planner?.build).toEqual(pipeline.defaultBuild);
    expect(planner?.review).toEqual(pipeline.defaultReview);
  });

  it('skips modules without .md files', async () => {
    await writeFile(
      resolve(planDir, 'index.yaml'),
      `
name: test-exp
description: Missing module file
created: "2026-03-13"
status: architecture-complete
mode: expedition

architecture:
  status: complete

modules:
  existing:
    status: planned
    description: Has a file
  missing:
    status: planned
    description: No file
`,
    );

    await writeFile(resolve(planDir, 'modules', 'existing.md'), '# Existing module');
    // Intentionally not creating missing.md

    const plans = await compileExpedition(tmpDir, 'test-exp');

    // Both get plan files, but missing has empty body
    expect(plans).toHaveLength(2);
    const missingPlan = plans.find((p) => p.id.includes('missing'));
    expect(missingPlan?.body).toBe('');
  });
});
