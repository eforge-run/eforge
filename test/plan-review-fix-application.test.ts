import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  applyPlanReviewFixes,
  applyCohesionReviewFixes,
  applyArchitectureReviewFixes,
  parsePlanFile,
  parseOrchestrationConfig,
} from '@eforge-build/engine/plan';
import {
  planReviewSubmissionSchema,
  cohesionReviewSubmissionSchema,
  architectureReviewSubmissionSchema,
} from '@eforge-build/engine/schemas';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'eforge-plan-review-fix-test-'));
}

/**
 * Create a minimal plan set on disk and return the plan dir path.
 * Creates:
 *   <tempDir>/eforge/plans/<planSetName>/orchestration.yaml
 *   <tempDir>/eforge/plans/<planSetName>/<planId>.md
 */
async function createPlanSet(
  tempDir: string,
  planSetName: string,
  options: {
    planId?: string;
    planName?: string;
    planBranch?: string;
    planBody?: string;
    orchDescription?: string;
    orchBaseBranch?: string;
    withPipeline?: boolean;
  } = {},
): Promise<{ planDir: string; planId: string }> {
  const planId = options.planId ?? 'plan-01-auth';
  const planName = options.planName ?? 'Auth Plan';
  const planBranch = options.planBranch ?? 'auth/main';
  const planBody = options.planBody ?? '# Auth Plan\n\nImplement authentication.';
  const orchDescription = options.orchDescription ?? 'Test plan set';
  const orchBaseBranch = options.orchBaseBranch ?? 'main';

  const planDir = join(tempDir, 'eforge/plans', planSetName);
  await mkdir(planDir, { recursive: true });

  // Write plan file
  const frontmatter = { id: planId, name: planName, branch: planBranch };
  const planContent = `---\n${stringifyYaml(frontmatter).trim()}\n---\n\n${planBody}`;
  await writeFile(join(planDir, `${planId}.md`), planContent, 'utf-8');

  // Write orchestration.yaml
  const orchConfig: Record<string, unknown> = {
    name: planSetName,
    description: orchDescription,
    base_branch: orchBaseBranch,
    mode: 'excursion',
    validate: [],
    plans: [{
      id: planId,
      name: planName,
      depends_on: [],
      branch: planBranch,
    }],
  };

  if (options.withPipeline) {
    orchConfig.pipeline = {
      scope: 'excursion',
      compile: [],
      defaultBuild: ['implement'],
      defaultReview: {
        strategy: 'single',
        perspectives: ['general'],
        maxRounds: 1,
        evaluatorStrictness: 'standard',
      },
      rationale: 'Default pipeline',
    };
    // Add required build/review to plans for parseOrchestrationConfig to work
    (orchConfig.plans as Array<Record<string, unknown>>)[0].build = ['implement'];
    (orchConfig.plans as Array<Record<string, unknown>>)[0].review = {
      strategy: 'single',
      perspectives: ['general'],
      maxRounds: 1,
      evaluatorStrictness: 'standard',
    };
  }

  await writeFile(join(planDir, 'orchestration.yaml'), stringifyYaml(orchConfig), 'utf-8');

  return { planDir, planId };
}

/**
 * Create a module plan set with a modules/ subdirectory.
 */
async function createModulePlanSet(
  tempDir: string,
  planSetName: string,
  moduleId: string,
  options: {
    moduleName?: string;
    moduleBranch?: string;
    moduleBody?: string;
  } = {},
): Promise<{ planDir: string; modulesDir: string }> {
  const moduleName = options.moduleName ?? 'Auth Module';
  const moduleBranch = options.moduleBranch ?? 'auth/main';
  const moduleBody = options.moduleBody ?? '# Auth Module\n\nImplement authentication.';

  const planDir = join(tempDir, 'eforge/plans', planSetName);
  const modulesDir = join(planDir, 'modules');
  await mkdir(modulesDir, { recursive: true });

  // Write module plan file
  const frontmatter = { id: moduleId, name: moduleName, branch: moduleBranch };
  const moduleContent = `---\n${stringifyYaml(frontmatter).trim()}\n---\n\n${moduleBody}`;
  await writeFile(join(modulesDir, `${moduleId}.md`), moduleContent, 'utf-8');

  return { planDir, modulesDir };
}

// ---------------------------------------------------------------------------
// applyPlanReviewFixes: replace_orchestration
// ---------------------------------------------------------------------------

describe('applyPlanReviewFixes: replace_orchestration', () => {
  it('round-trip: description containing ": " is preserved by parseOrchestrationConfig', async () => {
    const tempDir = await makeTempDir();
    const { planId } = await createPlanSet(tempDir, 'test-set', { withPipeline: true });

    const descriptionWithColon = 'Auth: handle tokens and sessions';

    await applyPlanReviewFixes({
      cwd: tempDir,
      outputDir: 'eforge/plans',
      planSetName: 'test-set',
      fixes: [{
        kind: 'replace_orchestration',
        description: descriptionWithColon,
        baseBranch: 'main',
        validate: [],
        plans: [{
          id: planId,
          name: 'Auth Plan',
          dependsOn: [],
          branch: 'auth/main',
          build: ['implement'],
          review: {
            strategy: 'single',
            perspectives: ['general'],
            maxRounds: 1,
            evaluatorStrictness: 'standard',
          },
        }],
      }],
    });

    const orchPath = join(tempDir, 'eforge/plans/test-set/orchestration.yaml');
    const config = await parseOrchestrationConfig(orchPath);
    expect(config.description).toBe(descriptionWithColon);
  });

  it('preserves the pipeline field when the fix payload omits it', async () => {
    const tempDir = await makeTempDir();
    const { planId } = await createPlanSet(tempDir, 'test-set', { withPipeline: true });

    await applyPlanReviewFixes({
      cwd: tempDir,
      outputDir: 'eforge/plans',
      planSetName: 'test-set',
      fixes: [{
        kind: 'replace_orchestration',
        description: 'Updated description',
        baseBranch: 'main',
        validate: [],
        plans: [{
          id: planId,
          name: 'Auth Plan',
          dependsOn: [],
          branch: 'auth/main',
          build: ['implement'],
          review: {
            strategy: 'single',
            perspectives: ['general'],
            maxRounds: 1,
            evaluatorStrictness: 'standard',
          },
        }],
      }],
    });

    const orchPath = join(tempDir, 'eforge/plans/test-set/orchestration.yaml');
    const raw = await readFile(orchPath, 'utf-8');
    const data = parseYaml(raw) as Record<string, unknown>;

    // Pipeline must be preserved
    expect(data.pipeline).toBeDefined();
    const pipeline = data.pipeline as Record<string, unknown>;
    expect(pipeline.scope).toBe('excursion');
    expect(pipeline.rationale).toBe('Default pipeline');
  });

  it('translates baseBranch to base_branch and dependsOn to depends_on on disk', async () => {
    const tempDir = await makeTempDir();
    await createPlanSet(tempDir, 'test-set', { withPipeline: true });

    // Add a second plan with a dependency
    const planDir = join(tempDir, 'eforge/plans/test-set');
    const plan2Frontmatter = { id: 'plan-02-api', name: 'API Plan', branch: 'api/main' };
    const plan2Content = `---\n${stringifyYaml(plan2Frontmatter).trim()}\n---\n\n# API Plan`;
    await writeFile(join(planDir, 'plan-02-api.md'), plan2Content, 'utf-8');

    await applyPlanReviewFixes({
      cwd: tempDir,
      outputDir: 'eforge/plans',
      planSetName: 'test-set',
      fixes: [{
        kind: 'replace_orchestration',
        description: 'Test plan set',
        baseBranch: 'feature-branch',
        validate: [],
        plans: [
          {
            id: 'plan-01-auth',
            name: 'Auth Plan',
            dependsOn: [],
            branch: 'auth/main',
            build: ['implement'],
            review: {
              strategy: 'single',
              perspectives: ['general'],
              maxRounds: 1,
              evaluatorStrictness: 'standard',
            },
          },
          {
            id: 'plan-02-api',
            name: 'API Plan',
            dependsOn: ['plan-01-auth'],
            branch: 'api/main',
            build: ['implement'],
            review: {
              strategy: 'single',
              perspectives: ['general'],
              maxRounds: 1,
              evaluatorStrictness: 'standard',
            },
          },
        ],
      }],
    });

    const orchPath = join(planDir, 'orchestration.yaml');
    const raw = await readFile(orchPath, 'utf-8');
    const data = parseYaml(raw) as Record<string, unknown>;

    // camelCase translated to snake_case
    expect(data.base_branch).toBe('feature-branch');
    expect(data.baseBranch).toBeUndefined();

    const plans = data.plans as Array<Record<string, unknown>>;
    expect(plans[1].depends_on).toEqual(['plan-01-auth']);
    expect(plans[1].dependsOn).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyPlanReviewFixes: replace_plan_file
// ---------------------------------------------------------------------------

describe('applyPlanReviewFixes: replace_plan_file', () => {
  it('round-trip: plan name containing ": " is preserved by parsePlanFile', async () => {
    const tempDir = await makeTempDir();
    const { planId } = await createPlanSet(tempDir, 'test-set');

    const nameWithColon = 'Auth: Token Management';

    await applyPlanReviewFixes({
      cwd: tempDir,
      outputDir: 'eforge/plans',
      planSetName: 'test-set',
      fixes: [{
        kind: 'replace_plan_file',
        planId,
        frontmatter: {
          id: planId,
          name: nameWithColon,
          branch: 'auth/main',
        },
        body: '# Auth Plan\n\nUpdated body.',
      }],
    });

    const planPath = join(tempDir, 'eforge/plans/test-set', `${planId}.md`);
    const planFile = await parsePlanFile(planPath);
    expect(planFile.name).toBe(nameWithColon);
  });

  it('writes complete frontmatter and body', async () => {
    const tempDir = await makeTempDir();
    const { planId } = await createPlanSet(tempDir, 'test-set');

    await applyPlanReviewFixes({
      cwd: tempDir,
      outputDir: 'eforge/plans',
      planSetName: 'test-set',
      fixes: [{
        kind: 'replace_plan_file',
        planId,
        frontmatter: {
          id: planId,
          name: 'Auth Plan Revised',
          branch: 'auth/feature',
          migrations: [{ timestamp: '20260415120000', description: 'Add users table' }],
        },
        body: '# Revised Body',
      }],
    });

    const planPath = join(tempDir, 'eforge/plans/test-set', `${planId}.md`);
    const planFile = await parsePlanFile(planPath);
    expect(planFile.name).toBe('Auth Plan Revised');
    expect(planFile.branch).toBe('auth/feature');
    expect(planFile.body).toBe('# Revised Body');

    const raw = await readFile(planPath, 'utf-8');
    expect(raw).toContain('migrations:');
    expect(raw).toContain('20260415120000');
  });
});

// ---------------------------------------------------------------------------
// applyPlanReviewFixes: replace_plan_body
// ---------------------------------------------------------------------------

describe('applyPlanReviewFixes: replace_plan_body', () => {
  it('preserves the existing frontmatter byte-identically', async () => {
    const tempDir = await makeTempDir();
    const { planId } = await createPlanSet(tempDir, 'test-set', {
      planName: 'Auth: Token Management',
    });

    const planPath = join(tempDir, 'eforge/plans/test-set', `${planId}.md`);
    const originalContent = await readFile(planPath, 'utf-8');
    const originalFrontmatterMatch = originalContent.match(/^---\n([\s\S]*?)\n---\n/);
    expect(originalFrontmatterMatch).toBeTruthy();
    const originalFrontmatterBlock = `---\n${originalFrontmatterMatch![1]}\n---\n`;

    await applyPlanReviewFixes({
      cwd: tempDir,
      outputDir: 'eforge/plans',
      planSetName: 'test-set',
      fixes: [{
        kind: 'replace_plan_body',
        planId,
        body: '# New Body\n\nNew content here.',
      }],
    });

    const updatedContent = await readFile(planPath, 'utf-8');
    // Frontmatter block is byte-identical
    expect(updatedContent.startsWith(originalFrontmatterBlock)).toBe(true);
    // New body is present
    expect(updatedContent).toContain('# New Body');
    expect(updatedContent).toContain('New content here.');
  });
});

// ---------------------------------------------------------------------------
// planReviewSubmissionSchema: unknown kind
// ---------------------------------------------------------------------------

describe('planReviewSubmissionSchema', () => {
  it('rejects an unknown kind value', () => {
    const result = planReviewSubmissionSchema.safeParse({
      fixes: [{
        kind: 'replace_nonexistent',
        planId: 'plan-01-auth',
        body: 'some body',
      }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts an empty fixes array', () => {
    const result = planReviewSubmissionSchema.safeParse({ fixes: [] });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyCohesionReviewFixes: replace_plan_file
// ---------------------------------------------------------------------------

describe('applyCohesionReviewFixes: replace_plan_file', () => {
  it('round-trip against <planSet>/modules/<planId>.md', async () => {
    const tempDir = await makeTempDir();
    const moduleId = 'auth';
    await createModulePlanSet(tempDir, 'test-expedition', moduleId, {
      moduleName: 'Auth Module',
    });

    await applyCohesionReviewFixes({
      cwd: tempDir,
      outputDir: 'eforge/plans',
      planSetName: 'test-expedition',
      fixes: [{
        kind: 'replace_plan_file',
        planId: moduleId,
        frontmatter: {
          id: moduleId,
          name: 'Auth: Revised Module',
          branch: 'auth/updated',
        },
        body: '# Auth Module Revised\n\nUpdated content.',
      }],
    });

    const modulePath = join(tempDir, 'eforge/plans/test-expedition/modules', `${moduleId}.md`);
    const planFile = await parsePlanFile(modulePath);
    expect(planFile.name).toBe('Auth: Revised Module');
    expect(planFile.branch).toBe('auth/updated');
    expect(planFile.body).toBe('# Auth Module Revised\n\nUpdated content.');
  });
});

// ---------------------------------------------------------------------------
// applyCohesionReviewFixes: replace_plan_body
// ---------------------------------------------------------------------------

describe('applyCohesionReviewFixes: replace_plan_body', () => {
  it('preserves frontmatter byte-identically against a module file', async () => {
    const tempDir = await makeTempDir();
    const moduleId = 'auth';
    await createModulePlanSet(tempDir, 'test-expedition', moduleId, {
      moduleName: 'Auth: Token Handler',
    });

    const modulePath = join(tempDir, 'eforge/plans/test-expedition/modules', `${moduleId}.md`);
    const originalContent = await readFile(modulePath, 'utf-8');
    const originalFrontmatterMatch = originalContent.match(/^---\n([\s\S]*?)\n---\n/);
    expect(originalFrontmatterMatch).toBeTruthy();
    const originalFrontmatterBlock = `---\n${originalFrontmatterMatch![1]}\n---\n`;

    await applyCohesionReviewFixes({
      cwd: tempDir,
      outputDir: 'eforge/plans',
      planSetName: 'test-expedition',
      fixes: [{
        kind: 'replace_plan_body',
        planId: moduleId,
        body: '# Updated Module Body\n\nNew cohesion-reviewed content.',
      }],
    });

    const updatedContent = await readFile(modulePath, 'utf-8');
    expect(updatedContent.startsWith(originalFrontmatterBlock)).toBe(true);
    expect(updatedContent).toContain('# Updated Module Body');
  });
});

// ---------------------------------------------------------------------------
// cohesionReviewSubmissionSchema: unknown kind
// ---------------------------------------------------------------------------

describe('cohesionReviewSubmissionSchema', () => {
  it('rejects an unknown kind value', () => {
    const result = cohesionReviewSubmissionSchema.safeParse({
      fixes: [{
        kind: 'replace_orchestration',
        description: 'should not be valid for cohesion',
        baseBranch: 'main',
        validate: [],
        plans: [],
      }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts an empty fixes array', () => {
    const result = cohesionReviewSubmissionSchema.safeParse({ fixes: [] });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyArchitectureReviewFixes: replace_architecture
// ---------------------------------------------------------------------------

describe('applyArchitectureReviewFixes: replace_architecture', () => {
  it('writes agent-supplied markdown to <planSet>/architecture.md verbatim', async () => {
    const tempDir = await makeTempDir();
    const planDir = join(tempDir, 'eforge/plans/test-expedition');
    await mkdir(planDir, { recursive: true });

    // Create an initial architecture.md
    await writeFile(join(planDir, 'architecture.md'), '# Original Architecture', 'utf-8');

    const newArchContent = '# Revised Architecture\n\n## Module: auth\n\nToken: validation service';

    await applyArchitectureReviewFixes({
      cwd: tempDir,
      outputDir: 'eforge/plans',
      planSetName: 'test-expedition',
      fixes: [{
        kind: 'replace_architecture',
        content: newArchContent,
      }],
    });

    const written = await readFile(join(planDir, 'architecture.md'), 'utf-8');
    expect(written).toBe(newArchContent);
  });
});

// ---------------------------------------------------------------------------
// architectureReviewSubmissionSchema: unknown kind
// ---------------------------------------------------------------------------

describe('architectureReviewSubmissionSchema', () => {
  it('rejects an unknown kind value', () => {
    const result = architectureReviewSubmissionSchema.safeParse({
      fixes: [{
        kind: 'replace_plan_file',
        planId: 'auth',
        frontmatter: { id: 'auth', name: 'Auth', branch: 'auth/main' },
        body: 'body',
      }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts an empty fixes array', () => {
    const result = architectureReviewSubmissionSchema.safeParse({ fixes: [] });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No-op for empty fixes array
// ---------------------------------------------------------------------------

describe('apply helpers: no-op for empty fixes array', () => {
  it('applyPlanReviewFixes does not modify any file when fixes is empty', async () => {
    const tempDir = await makeTempDir();
    const { planId } = await createPlanSet(tempDir, 'test-set');
    const orchPath = join(tempDir, 'eforge/plans/test-set/orchestration.yaml');
    const planPath = join(tempDir, 'eforge/plans/test-set', `${planId}.md`);

    const orchStatBefore = await stat(orchPath);
    const planStatBefore = await stat(planPath);

    // Small delay to ensure mtime would differ if modified
    await new Promise(r => setTimeout(r, 50));

    await applyPlanReviewFixes({
      cwd: tempDir,
      outputDir: 'eforge/plans',
      planSetName: 'test-set',
      fixes: [],
    });

    const orchStatAfter = await stat(orchPath);
    const planStatAfter = await stat(planPath);

    expect(orchStatAfter.mtimeMs).toBe(orchStatBefore.mtimeMs);
    expect(planStatAfter.mtimeMs).toBe(planStatBefore.mtimeMs);
  });

  it('applyCohesionReviewFixes does not modify any file when fixes is empty', async () => {
    const tempDir = await makeTempDir();
    const moduleId = 'auth';
    const { modulesDir } = await createModulePlanSet(tempDir, 'test-expedition', moduleId);
    const modulePath = join(modulesDir, `${moduleId}.md`);

    const statBefore = await stat(modulePath);

    await new Promise(r => setTimeout(r, 50));

    await applyCohesionReviewFixes({
      cwd: tempDir,
      outputDir: 'eforge/plans',
      planSetName: 'test-expedition',
      fixes: [],
    });

    const statAfter = await stat(modulePath);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });

  it('applyArchitectureReviewFixes does not modify any file when fixes is empty', async () => {
    const tempDir = await makeTempDir();
    const planDir = join(tempDir, 'eforge/plans/test-expedition');
    await mkdir(planDir, { recursive: true });
    const archPath = join(planDir, 'architecture.md');
    await writeFile(archPath, '# Architecture', 'utf-8');

    const statBefore = await stat(archPath);

    await new Promise(r => setTimeout(r, 50));

    await applyArchitectureReviewFixes({
      cwd: tempDir,
      outputDir: 'eforge/plans',
      planSetName: 'test-expedition',
      fixes: [],
    });

    const statAfter = await stat(archPath);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });
});
