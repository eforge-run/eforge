import { readFile, writeFile, mkdir, access as fsAccess } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { PlanFile, OrchestrationConfig, ExpeditionModule } from './events.js';
import type { BuildStageSpec, ReviewProfileConfig } from './config.js';
import { buildStageSpecSchema, reviewProfileConfigSchema } from './config.js';
import { pipelineCompositionSchema } from './schemas.js';
import type { PipelineComposition } from './schemas.js';
import { z } from 'zod/v4';

const execAsync = promisify(execFile);

/**
 * Derive a kebab-case plan set name from a source string.
 * If it looks like a file path, use the filename without extension.
 * For free-text prompts, only strips short extensions (1-4 chars) to avoid
 * truncating sentences that contain periods.
 */
export function deriveNameFromSource(source: string): string {
  const hasPathSeparator = /[\\/]/.test(source);
  let base = source.replace(/^.*[\\/]/, '');

  // Only strip extension for file-like inputs (has path separator or short extension)
  if (hasPathSeparator) {
    base = base.replace(/\.[^.]+$/, '');
  } else {
    base = base.replace(/\.[a-z]{1,4}$/i, '');
  }

  const name = base
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

  return name || 'unnamed';
}

/**
 * Validate a plan set name for use in file paths.
 * Rejects empty strings, path traversal, and non-kebab-case names.
 */
export function validatePlanSetName(name: string): void {
  if (!name || name === 'unnamed') {
    throw new Error(`Invalid plan set name (empty or unnamed): "${name}"`);
  }
  if (name.includes('..')) {
    throw new Error(`Invalid plan set name (path traversal): ${name}`);
  }
  if (/[\\/]/.test(name)) {
    throw new Error(`Invalid plan set name (contains path separator): ${name}`);
  }
}

/**
 * Parsed expedition index.yaml.
 */
export interface ExpeditionIndex {
  name: string;
  description: string;
  created: string;
  status: string;
  mode: 'expedition';
  validate?: string[];
  architecture: { status: string; lastUpdated?: string };
  modules: Record<string, { status: string; description: string; dependsOn: string[] }>;
}

/**
 * Parse an expedition index.yaml file.
 */
export async function parseExpeditionIndex(yamlPath: string): Promise<ExpeditionIndex> {
  const absPath = resolve(yamlPath);
  const raw = await readFile(absPath, 'utf-8');
  const data = parseYaml(raw) as Record<string, unknown>;

  if (!data.name || typeof data.name !== 'string') {
    throw new Error(`Expedition index missing required 'name' field: ${absPath}`);
  }

  const modulesRaw = (data.modules ?? {}) as Record<string, Record<string, unknown>>;
  const modules: ExpeditionIndex['modules'] = {};

  for (const [id, mod] of Object.entries(modulesRaw)) {
    modules[id] = {
      status: (mod.status as string) ?? 'pending',
      description: (mod.description as string) ?? '',
      dependsOn: Array.isArray(mod.depends_on) ? (mod.depends_on as string[]) : [],
    };
  }

  const arch = (data.architecture ?? {}) as Record<string, unknown>;

  const validate = Array.isArray(data.validate)
    ? (data.validate as unknown[]).filter((v): v is string => typeof v === 'string')
    : undefined;

  return {
    name: data.name,
    description: (data.description as string) ?? '',
    created: (data.created as string) ?? '',
    status: (data.status as string) ?? 'draft',
    mode: 'expedition',
    ...(validate && validate.length > 0 && { validate }),
    architecture: {
      status: (arch.status as string) ?? 'pending',
      lastUpdated: arch.last_updated as string | undefined,
    },
    modules,
  };
}

/**
 * Convert ExpeditionIndex modules to ExpeditionModule array.
 */
export function indexModulesToExpeditionModules(
  modules: ExpeditionIndex['modules'],
): ExpeditionModule[] {
  return Object.entries(modules).map(([id, mod]) => ({
    id,
    description: mod.description,
    dependsOn: mod.dependsOn,
  }));
}

/**
 * Parse a plan file (.md) with YAML frontmatter into a PlanFile.
 * Format: ---\n<yaml>\n---\n<markdown body>
 */
export async function parsePlanFile(mdPath: string): Promise<PlanFile> {
  const absPath = resolve(mdPath);
  const raw = await readFile(absPath, 'utf-8');

  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`Invalid plan file format (missing YAML frontmatter): ${absPath}`);
  }

  const frontmatter = parseYaml(match[1]) as Record<string, unknown>;
  const body = match[2].trim();

  if (!frontmatter.id || typeof frontmatter.id !== 'string') {
    throw new Error(`Plan file missing required 'id' field: ${absPath}`);
  }
  if (!frontmatter.name || typeof frontmatter.name !== 'string') {
    throw new Error(`Plan file missing required 'name' field: ${absPath}`);
  }

  return {
    id: frontmatter.id,
    name: frontmatter.name,
    dependsOn: Array.isArray(frontmatter.depends_on) ? frontmatter.depends_on : [],
    branch: typeof frontmatter.branch === 'string' ? frontmatter.branch : '',
    migrations: Array.isArray(frontmatter.migrations) ? frontmatter.migrations : undefined,
    body,
    filePath: absPath,
  };
}

/**
 * Parse an orchestration.yaml file into OrchestrationConfig.
 */
export async function parseOrchestrationConfig(yamlPath: string): Promise<OrchestrationConfig> {
  const absPath = resolve(yamlPath);
  const raw = await readFile(absPath, 'utf-8');
  const data = parseYaml(raw) as Record<string, unknown>;

  if (!data.name || typeof data.name !== 'string') {
    throw new Error(`Orchestration config missing required 'name' field: ${absPath}`);
  }

  const plans = Array.isArray(data.plans)
    ? (data.plans as Array<Record<string, unknown>>).map((p) => {
        const id = typeof p.id === 'string' ? p.id : String(p.id ?? '');

        // Parse required per-plan build/review
        const buildResult = z.array(buildStageSpecSchema).safeParse(p.build);
        if (!buildResult.success) {
          throw new Error(`Plan '${id}' has invalid or missing 'build' field: ${buildResult.error.message}`);
        }
        const reviewResult = reviewProfileConfigSchema.safeParse(p.review);
        if (!reviewResult.success) {
          throw new Error(`Plan '${id}' has invalid or missing 'review' field: ${reviewResult.error.message}`);
        }

        return {
          id,
          name: typeof p.name === 'string' ? p.name : String(p.name ?? ''),
          dependsOn: Array.isArray(p.depends_on) ? (p.depends_on as string[]) : [],
          branch: typeof p.branch === 'string' ? p.branch : '',
          build: buildResult.data,
          review: reviewResult.data,
          ...(typeof p.max_continuations === 'number' ? { maxContinuations: p.max_continuations } : {}),
        };
      })
    : [];

  const validate = Array.isArray(data.validate)
    ? (data.validate as unknown[]).filter((v): v is string => typeof v === 'string')
    : undefined;

  // Parse and validate required pipeline field
  if (!data.pipeline || typeof data.pipeline !== 'object') {
    throw new Error(`Orchestration config missing required 'pipeline' field: ${absPath}`);
  }
  const pipelineResult = pipelineCompositionSchema.safeParse(data.pipeline);
  if (!pipelineResult.success) {
    throw new Error(`Orchestration config has malformed 'pipeline' field: ${absPath}`);
  }

  return {
    name: data.name as string,
    description: (data.description as string) ?? '',
    created: (data.created as string) ?? '',
    mode: (data.mode as OrchestrationConfig['mode']) ?? 'errand',
    baseBranch: (data.base_branch as string) ?? 'main',
    pipeline: pipelineResult.data,
    plans: transitiveReduce(plans),
    ...(validate && validate.length > 0 && { validate }),
  };
}

/**
 * Remove redundant transitive edges from a plans dependency graph.
 * For each plan, if a dependency is reachable through another dependency's
 * transitive closure, the direct edge is redundant and removed.
 *
 * Returns a new array with minimized `dependsOn` arrays (does not mutate input).
 */
export function transitiveReduce<T extends { id: string; dependsOn: string[] }>(
  plans: T[],
): T[] {
  if (plans.length === 0) return [];

  // Build adjacency: id -> set of direct dependencies
  const depsMap = new Map<string, string[]>();
  for (const plan of plans) {
    depsMap.set(plan.id, plan.dependsOn);
  }

  // For a given start node, collect all nodes reachable via BFS (excluding start itself)
  function reachableFrom(startId: string): Set<string> {
    const visited = new Set<string>();
    const queue = [...(depsMap.get(startId) ?? [])];
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const dep of depsMap.get(current) ?? []) {
        if (!visited.has(dep)) queue.push(dep);
      }
    }
    return visited;
  }

  return plans.map((plan) => {
    if (plan.dependsOn.length <= 1) return plan;

    // For each direct dep, check if it's reachable through any other direct dep
    const redundant = new Set<string>();
    for (const dep of plan.dependsOn) {
      // Check if `dep` is reachable from any other direct dependency
      for (const otherDep of plan.dependsOn) {
        if (otherDep === dep) continue;
        if (redundant.has(otherDep)) continue; // already redundant, skip
        const reachable = reachableFrom(otherDep);
        if (reachable.has(dep)) {
          redundant.add(dep);
          break;
        }
      }
    }

    if (redundant.size === 0) return plan;
    return { ...plan, dependsOn: plan.dependsOn.filter((d) => !redundant.has(d)) };
  });
}

/**
 * Resolve a dependency graph into execution waves (topological sort via Kahn's algorithm)
 * and a merge order (topological — dependencies merge first, dependents last).
 */
export function resolveDependencyGraph(
  plans: Array<{ id: string; dependsOn: string[] }>,
): { waves: string[][]; mergeOrder: string[] } {
  const ids = new Set(plans.map((p) => p.id));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const plan of plans) {
    inDegree.set(plan.id, 0);
    dependents.set(plan.id, []);
  }

  for (const plan of plans) {
    for (const dep of plan.dependsOn) {
      if (!ids.has(dep)) {
        throw new Error(`Plan '${plan.id}' depends on unknown plan '${dep}'`);
      }
      inDegree.set(plan.id, (inDegree.get(plan.id) ?? 0) + 1);
      dependents.get(dep)!.push(plan.id);
    }
  }

  const waves: string[][] = [];
  let queue = plans.filter((p) => inDegree.get(p.id) === 0).map((p) => p.id);

  if (queue.length === 0 && plans.length > 0) {
    throw new Error('Circular dependency detected: no plans have zero dependencies');
  }

  let processed = 0;

  while (queue.length > 0) {
    waves.push([...queue]);
    const nextQueue: string[] = [];

    for (const id of queue) {
      processed++;
      for (const dep of dependents.get(id) ?? []) {
        const newDegree = (inDegree.get(dep) ?? 1) - 1;
        inDegree.set(dep, newDegree);
        if (newDegree === 0) {
          nextQueue.push(dep);
        }
      }
    }

    queue = nextQueue;
  }

  if (processed !== plans.length) {
    throw new Error(
      `Circular dependency detected: processed ${processed} of ${plans.length} plans`,
    );
  }

  // Merge order: topological order (waves flattened) — dependencies merge first
  const mergeOrder = waves.flat();

  return { waves, mergeOrder };
}

/**
 * Validate a plan set: check orchestration config and all referenced plan files.
 */
export async function validatePlanSet(
  configPath: string,
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];
  const absConfigPath = resolve(configPath);

  let config: OrchestrationConfig;
  try {
    config = await parseOrchestrationConfig(absConfigPath);
  } catch (err) {
    return { valid: false, errors: [`Failed to parse orchestration config: ${(err as Error).message}`] };
  }

  if (!config.name) {
    errors.push('Orchestration config missing name');
  }
  if (!config.baseBranch) {
    errors.push('Orchestration config missing baseBranch');
  }
  if (config.plans.length === 0) {
    errors.push('Orchestration config has no plans');
  }

  // Check for duplicate plan IDs
  const seenIds = new Set<string>();
  for (const plan of config.plans) {
    if (!plan.id) {
      errors.push('Plan entry missing id');
      continue;
    }
    if (seenIds.has(plan.id)) {
      errors.push(`Duplicate plan ID: '${plan.id}'`);
    }
    seenIds.add(plan.id);

    if (!plan.name) errors.push(`Plan '${plan.id}' missing name`);
    if (!plan.branch) errors.push(`Plan '${plan.id}' missing branch`);

    // Validate per-plan build stage names against the registry
    if (plan.build) {
      const { getBuildStageNames } = await import('./pipeline.js');
      const buildStageNames = getBuildStageNames();
      const flatStages = plan.build.flatMap((spec) => Array.isArray(spec) ? spec : [spec]);
      for (const name of flatStages) {
        if (!buildStageNames.has(name)) {
          errors.push(`Plan '${plan.id}' has unknown build stage: "${name}"`);
        }
      }
    }
  }

  // Check dependency graph is valid
  try {
    resolveDependencyGraph(config.plans);
  } catch (err) {
    errors.push((err as Error).message);
  }

  // Try to parse each plan file
  const configDir = dirname(absConfigPath);
  for (const plan of config.plans) {
    const planPath = resolve(configDir, `${plan.id}.md`);
    try {
      await parsePlanFile(planPath);
    } catch (err) {
      errors.push(`Plan file '${plan.id}': ${(err as Error).message}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate runtime readiness for a build. Returns warning strings for:
 * - Dirty git working directory
 * - Existing plan branches
 * - Unwritable worktree parent directory
 */
export async function validateRuntimeReadiness(
  repoRoot: string,
  plans: OrchestrationConfig['plans'],
): Promise<string[]> {
  const warnings: string[] = [];

  // Check for dirty git working directory
  try {
    const { stdout } = await execAsync('git', ['status', '--porcelain'], { cwd: repoRoot });
    if (stdout.trim().length > 0) {
      warnings.push('Git working directory has uncommitted changes');
    }
  } catch {
    warnings.push('Unable to check git status');
  }

  // Check for existing plan branches
  for (const plan of plans) {
    if (!plan.branch) continue;
    try {
      const { stdout } = await execAsync('git', ['branch', '--list', plan.branch], { cwd: repoRoot });
      if (stdout.trim().length > 0) {
        warnings.push(`Branch '${plan.branch}' already exists (plan: ${plan.id})`);
      }
    } catch {
      // Ignore branch check failures
    }
  }

  // Check writable worktree parent directory
  const worktreeParent = dirname(repoRoot);
  try {
    await fsAccess(worktreeParent, constants.W_OK);
  } catch {
    warnings.push(`Worktree parent directory is not writable: ${worktreeParent}`);
  }

  return warnings;
}

/**
 * Extract the first H1 heading from markdown content.
 * Returns the heading text, or undefined if no H1 is found.
 */
export function extractPlanTitle(markdown: string): string | undefined {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : undefined;
}

/**
 * Derive a kebab-case plan set name from content's H1 heading.
 * Returns undefined if no H1 heading is found.
 */
export function deriveNameFromContent(content: string): string | undefined {
  const title = extractPlanTitle(content);
  if (!title) return undefined;
  const name = title
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return name || undefined;
}

/**
 * Detect validation commands from package.json scripts and lockfile.
 * Returns an array of runnable commands (e.g., ['pnpm type-check', 'pnpm test']).
 */
export async function detectValidationCommands(cwd: string): Promise<string[]> {
  // Detect package manager from lockfile
  let runner = 'npm run';
  if (existsSync(resolve(cwd, 'pnpm-lock.yaml'))) {
    runner = 'pnpm';
  } else if (existsSync(resolve(cwd, 'yarn.lock'))) {
    runner = 'yarn';
  } else if (existsSync(resolve(cwd, 'package-lock.json'))) {
    runner = 'npm run';
  }

  // Read package.json scripts
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf-8'));
    scripts = pkg.scripts ?? {};
  } catch {
    return [];
  }

  const commands: string[] = [];
  if (scripts['type-check']) commands.push(`${runner} type-check`);
  else if (scripts['typecheck']) commands.push(`${runner} typecheck`);
  if (scripts['test']) commands.push(`${runner} test`);

  return commands;
}

/**
 * Write plan file + orchestration.yaml for an adopted plan.
 * Returns the created PlanFile.
 */
export interface WritePlanArtifactsOptions {
  cwd: string;
  planSetName: string;
  sourceContent: string;
  planName: string;
  baseBranch: string;
  pipeline: PipelineComposition;
  validate?: string[];
  mode?: 'errand' | 'excursion';
  /** Per-plan build stage sequence (written to orchestration.yaml plan entry). */
  build?: BuildStageSpec[];
  /** Per-plan review config (written to orchestration.yaml plan entry). */
  review?: ReviewProfileConfig;
  /** Plan output directory (defaults to 'eforge/plans'). */
  outputDir?: string;
}

export async function writePlanArtifacts(options: WritePlanArtifactsOptions): Promise<PlanFile> {
  const { cwd, planSetName, sourceContent, planName, baseBranch, validate } = options;
  const planDir = resolve(cwd, options.outputDir ?? 'eforge/plans', planSetName);
  await mkdir(planDir, { recursive: true });

  const planId = `plan-01-${planSetName}`;
  const branch = `${planSetName}/main`;

  // Write plan file with YAML frontmatter
  const frontmatter = {
    id: planId,
    name: planName,
    depends_on: [] as string[],
    branch,
  };

  const planContent = `---\n${stringifyYaml(frontmatter).trim()}\n---\n\n${sourceContent}`;
  const planPath = resolve(planDir, `${planId}.md`);
  await writeFile(planPath, planContent, 'utf-8');

  // Write orchestration.yaml
  const orchConfig: Record<string, unknown> = {
    name: planSetName,
    description: planName,
    created: new Date().toISOString().split('T')[0],
    mode: options.mode ?? 'errand',
    base_branch: baseBranch,
    pipeline: options.pipeline,
    ...(validate && validate.length > 0 && { validate }),
    plans: [{
      id: planId,
      name: planName,
      depends_on: [] as string[],
      branch,
      ...(options.build && { build: options.build }),
      ...(options.review && { review: options.review }),
    }],
  };

  await writeFile(resolve(planDir, 'orchestration.yaml'), stringifyYaml(orchConfig), 'utf-8');

  return {
    id: planId,
    name: planName,
    dependsOn: [],
    branch,
    body: sourceContent,
    filePath: planPath,
  };
}

/**
 * Inject a pipeline composition (and optionally override base_branch) into an existing orchestration.yaml.
 * Reads the YAML, adds/replaces the `pipeline` field, and writes it back.
 * Used by the pipeline after the composer and planner agents run.
 */
export async function injectPipelineIntoOrchestrationYaml(
  orchestrationYamlPath: string,
  pipeline: PipelineComposition,
  baseBranch?: string,
): Promise<void> {
  const absPath = resolve(orchestrationYamlPath);
  const raw = await readFile(absPath, 'utf-8');
  const data = parseYaml(raw) as Record<string, unknown>;
  data.pipeline = pipeline;
  if (baseBranch) {
    data.base_branch = baseBranch;
  }
  await writeFile(absPath, stringifyYaml(data), 'utf-8');
}
