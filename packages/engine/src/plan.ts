import { readFile, writeFile, mkdir, access as fsAccess } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { PlanFile, OrchestrationConfig, ExpeditionModule } from './events.js';
import type { BuildStageSpec, ReviewProfileConfig } from './config.js';
import { buildStageSpecSchema, reviewProfileConfigSchema } from './config.js';
import { pipelineCompositionSchema, agentTuningSchema } from './schemas.js';
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
 * Validate a plan ID for use in file paths.
 * Rejects empty strings, path traversal, path separators, and characters outside [A-Za-z0-9_-].
 */
function validatePlanId(planId: string): void {
  if (!planId) {
    throw new Error(`Invalid plan ID (empty): "${planId}"`);
  }
  if (planId.includes('..')) {
    throw new Error(`Invalid plan ID (path traversal): "${planId}"`);
  }
  if (/[\\/]/.test(planId)) {
    throw new Error(`Invalid plan ID (contains path separator): "${planId}"`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(planId)) {
    throw new Error(`Invalid plan ID (must only contain [A-Za-z0-9_-]): "${planId}"`);
  }
}

/**
 * Split a plan file's raw content into its frontmatter block and body.
 * Returns null if the file does not have valid YAML frontmatter.
 */
function splitFrontmatter(raw: string): { frontmatterBlock: string; body: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  return { frontmatterBlock: `---\n${match[1]}\n---\n`, body: match[2] };
}

/**
 * Serialize a plan frontmatter object to a YAML frontmatter block string.
 */
function serializePlanFrontmatter(frontmatter: {
  id: string;
  name: string;
  branch: string;
  migrations?: Array<{ timestamp: string; description: string }>;
  agents?: unknown;
}): string {
  const fm: Record<string, unknown> = {
    id: frontmatter.id,
    name: frontmatter.name,
    branch: frontmatter.branch,
  };
  if (frontmatter.migrations && frontmatter.migrations.length > 0) {
    fm.migrations = frontmatter.migrations;
  }
  if (frontmatter.agents) {
    fm.agents = frontmatter.agents;
  }
  return `---\n${stringifyYaml(fm).trim()}\n---\n`;
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
 *
 * When `tiers` is provided, validates that every `agents.<role>.tier`
 * reference names a tier declared in the config. Throws if a dangling
 * reference is found, with the plan file path, role name, and referenced
 * tier name in the message.
 */
export async function parsePlanFile(mdPath: string, tiers?: Record<string, unknown>): Promise<PlanFile> {
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

  // Parse optional agents block with graceful fallback
  let agents: PlanFile['agents'] | undefined;
  const planWarnings: string[] = [];
  if (frontmatter.agents !== undefined) {
    const agentsValidator = z.record(z.string(), agentTuningSchema);
    const agentsResult = agentsValidator.safeParse(frontmatter.agents);
    if (agentsResult.success) {
      agents = agentsResult.data as PlanFile['agents'];
    } else {
      planWarnings.push(`[eforge] Plan file ${absPath}: malformed 'agents' block will be ignored: ${z.prettifyError(agentsResult.error)}`);
    }
  }

  // Validate tier references when tiers map is provided.
  if (tiers && agents) {
    for (const [roleName, roleConfig] of Object.entries(agents)) {
      const tier = (roleConfig as { tier?: string }).tier;
      if (tier !== undefined && !(tier in tiers)) {
        const declared = Object.keys(tiers).join(', ') || '(none)';
        throw new Error(
          `Plan file ${absPath}: role "${roleName}" references tier "${tier}" ` +
          `which is not declared in agents.tiers. Declared: ${declared}.`,
        );
      }
    }
  }

  return {
    id: frontmatter.id,
    name: frontmatter.name,
    dependsOn: [],
    branch: typeof frontmatter.branch === 'string' ? frontmatter.branch : '',
    migrations: Array.isArray(frontmatter.migrations) ? frontmatter.migrations : undefined,
    ...(agents && { agents }),
    ...(planWarnings.length > 0 && { warnings: planWarnings }),
    body,
    filePath: absPath,
  };
}

/**
 * Parse an orchestration.yaml file into OrchestrationConfig.
 * Warnings about malformed optional fields are returned in the `warnings` property
 * of the result. Callers with an active event stream should yield `plan:warning`
 * events for each warning.
 */
export async function parseOrchestrationConfig(yamlPath: string): Promise<OrchestrationConfig> {
  const absPath = resolve(yamlPath);
  const raw = await readFile(absPath, 'utf-8');
  const data = parseYaml(raw) as Record<string, unknown>;
  const orchWarnings: string[] = [];

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

        // Parse optional agents block
        let agents: Record<string, { effort?: string; thinking?: boolean | object; rationale?: string; tier?: string }> | undefined;
        if (p.agents !== undefined) {
          const agentsValidator = z.record(z.string(), agentTuningSchema);
          const agentsResult = agentsValidator.safeParse(p.agents);
          if (agentsResult.success) {
            agents = agentsResult.data as Record<string, { effort?: string; thinking?: boolean | object; rationale?: string; tier?: string }>;
          } else {
            orchWarnings.push(`[eforge] Plan '${id}': malformed 'agents' block in orchestration config will be ignored`);
          }
        }

        return {
          id,
          name: typeof p.name === 'string' ? p.name : String(p.name ?? ''),
          dependsOn: Array.isArray(p.depends_on) ? (p.depends_on as string[]) : [],
          branch: typeof p.branch === 'string' ? p.branch : '',
          build: buildResult.data,
          review: reviewResult.data,
          ...(typeof p.max_continuations === 'number' ? { maxContinuations: p.max_continuations } : {}),
          ...(agents && { agents }),
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
    ...(orchWarnings.length > 0 && { warnings: orchWarnings }),
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
 * Write plan files and orchestration.yaml from a validated plan set submission payload.
 * Receives already-validated data (validation happens in the submission handler).
 */
export interface WritePlanSetOptions {
  cwd: string;
  outputDir: string;
  planSetName: string;
  payload: import('./schemas.js').PlanSetSubmission;
}

export async function writePlanSet(options: WritePlanSetOptions): Promise<void> {
  const { cwd, outputDir, planSetName, payload } = options;
  const planDir = resolve(cwd, outputDir, planSetName);
  await mkdir(planDir, { recursive: true });

  // Write each plan file with YAML frontmatter
  for (const plan of payload.plans) {
    const frontmatter: Record<string, unknown> = {
      id: plan.frontmatter.id,
      name: plan.frontmatter.name,
      branch: plan.frontmatter.branch,
    };
    if (plan.frontmatter.migrations && plan.frontmatter.migrations.length > 0) {
      frontmatter.migrations = plan.frontmatter.migrations;
    }
    if (plan.frontmatter.agents) {
      frontmatter.agents = plan.frontmatter.agents;
    }
    const content = `---\n${stringifyYaml(frontmatter).trim()}\n---\n\n${plan.body}`;
    await writeFile(resolve(planDir, `${plan.frontmatter.id}.md`), content, 'utf-8');
  }

  // Write orchestration.yaml
  const orchConfig: Record<string, unknown> = {
    name: payload.name,
    description: payload.description,
    base_branch: payload.baseBranch,
    mode: payload.mode,
    validate: payload.orchestration.validate ?? [],
    plans: payload.orchestration.plans.map(p => {
      const planData = payload.plans.find(pd => pd.frontmatter.id === p.id);
      return {
        id: p.id,
        name: p.name,
        depends_on: p.dependsOn,
        branch: p.branch,
        ...(p.build ? { build: p.build } : {}),
        ...(p.review ? { review: p.review } : {}),
        ...(planData?.frontmatter.agents ? { agents: planData.frontmatter.agents } : {}),
      };
    }),
  };
  await writeFile(resolve(planDir, 'orchestration.yaml'), stringifyYaml(orchConfig), 'utf-8');
}

/**
 * Write architecture files from a validated architecture submission payload.
 * Creates architecture.md, index.yaml, and modules/ directory.
 */
export interface WriteArchitectureOptions {
  cwd: string;
  outputDir: string;
  planSetName: string;
  payload: import('./schemas.js').ArchitectureSubmission;
}

export async function writeArchitecture(options: WriteArchitectureOptions): Promise<void> {
  const { cwd, outputDir, planSetName, payload } = options;
  const planDir = resolve(cwd, outputDir, planSetName);
  await mkdir(planDir, { recursive: true });

  // Write architecture.md
  await writeFile(resolve(planDir, 'architecture.md'), payload.architecture, 'utf-8');

  // Write index.yaml with modules
  const modules: Record<string, { description: string; depends_on: string[]; status: string }> = {};
  for (const mod of payload.modules) {
    modules[mod.id] = {
      description: mod.description,
      depends_on: mod.dependsOn,
      status: 'pending',
    };
  }
  const indexYaml: Record<string, unknown> = {
    name: payload.index.name,
    description: payload.index.description,
    created: new Date().toISOString().split('T')[0],
    status: 'draft',
    mode: payload.index.mode,
    validate: payload.index.validate,
    architecture: { status: 'complete' },
    modules,
  };
  await writeFile(resolve(planDir, 'index.yaml'), stringifyYaml(indexYaml), 'utf-8');

  // Create modules/ directory
  await mkdir(resolve(planDir, 'modules'), { recursive: true });
}

/**
 * Options for applying plan-reviewer fixes.
 */
export interface ApplyPlanReviewFixesOptions {
  cwd: string;
  outputDir: string;
  planSetName: string;
  fixes: import('./schemas.js').PlanReviewSubmission['fixes'];
}

/**
 * Apply fixes emitted by the plan-reviewer agent to plan artifacts.
 * Handles replace_orchestration (merges with existing, translates camelCase to snake_case),
 * replace_plan_file (writes full file through stringifyYaml), and
 * replace_plan_body (preserves existing frontmatter, replaces body).
 * Does NOT run git add — fixes remain unstaged.
 */
export async function applyPlanReviewFixes(options: ApplyPlanReviewFixesOptions): Promise<void> {
  const { cwd, outputDir, planSetName, fixes } = options;
  if (fixes.length === 0) return;

  const planDir = resolve(cwd, outputDir, planSetName);

  const errors: Error[] = [];
  for (const fix of fixes) {
    try {
      if (fix.kind === 'replace_orchestration') {
        const orchPath = resolve(planDir, 'orchestration.yaml');
        const raw = await readFile(orchPath, 'utf-8');
        const parsedYaml = parseYaml(raw);
        // Issue #9: validate the parsed YAML is a non-null plain object
        if (!parsedYaml || typeof parsedYaml !== 'object' || Array.isArray(parsedYaml)) {
          throw new Error(`Cannot apply replace_orchestration: existing orchestration.yaml did not parse to a plain object: ${orchPath}`);
        }
        const existing = parsedYaml as Record<string, unknown>;

        // Translate camelCase agent fields to snake_case, merge over existing
        const mergedPlans = fix.plans.map(p => {
          const planEntry: Record<string, unknown> = {
            id: p.id,
            name: p.name,
            depends_on: p.dependsOn,
            branch: p.branch,
          };
          if (p.build !== undefined) planEntry.build = p.build;
          if (p.review !== undefined) planEntry.review = p.review;
          if (p.agents !== undefined) planEntry.agents = p.agents;
          // Preserve build/review/agents/max_continuations from existing plan entry if not supplied
          if (p.build === undefined || p.review === undefined || p.agents === undefined) {
            const existingPlans = Array.isArray(existing.plans)
              ? (existing.plans as Array<Record<string, unknown>>)
              : [];
            const existingPlan = existingPlans.find(ep => ep.id === p.id);
            if (existingPlan) {
              if (p.build === undefined && existingPlan.build !== undefined) planEntry.build = existingPlan.build;
              if (p.review === undefined && existingPlan.review !== undefined) planEntry.review = existingPlan.review;
              // Issue #1: preserve agents when not supplied
              if (p.agents === undefined && existingPlan.agents !== undefined) planEntry.agents = existingPlan.agents;
              // Issue #2: preserve max_continuations when present
              if (existingPlan.max_continuations !== undefined) planEntry.max_continuations = existingPlan.max_continuations;
            }
          }
          return planEntry;
        });

        const updated: Record<string, unknown> = {
          ...existing,
          description: fix.description,
          base_branch: fix.baseBranch,
          validate: fix.validate,
          plans: mergedPlans,
        };
        // pipeline is always preserved from existing

        await writeFile(orchPath, stringifyYaml(updated), 'utf-8');
      } else if (fix.kind === 'replace_plan_file') {
        // Issue #3: validate planId before resolving path
        validatePlanId(fix.planId);
        // Issue #5: planId and frontmatter.id must match
        if (fix.planId !== fix.frontmatter.id) {
          throw new Error(`Cannot apply replace_plan_file: planId "${fix.planId}" does not match frontmatter.id "${fix.frontmatter.id}"`);
        }
        const planPath = resolve(planDir, `${fix.planId}.md`);
        // Issue #7: use shared serialization helper
        const content = `${serializePlanFrontmatter(fix.frontmatter)}\n${fix.body}`;
        await writeFile(planPath, content, 'utf-8');
      } else if (fix.kind === 'replace_plan_body') {
        // Issue #3: validate planId before resolving path
        validatePlanId(fix.planId);
        const planPath = resolve(planDir, `${fix.planId}.md`);
        const raw = await readFile(planPath, 'utf-8');
        // Issue #8: use shared splitFrontmatter helper
        const split = splitFrontmatter(raw);
        if (!split) {
          throw new Error(`Cannot apply replace_plan_body: plan file has no valid frontmatter: ${planPath}`);
        }
        await writeFile(planPath, `${split.frontmatterBlock}\n${fix.body}`, 'utf-8');
      }
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  }
  // Issue #6: report all fix errors after attempting every fix
  if (errors.length > 0) {
    const messages = errors.map((e, i) => `  Fix ${i + 1}: ${e.message}`).join('\n');
    throw new Error(`applyPlanReviewFixes encountered ${errors.length} error(s):\n${messages}`);
  }
}

/**
 * Options for applying cohesion-reviewer fixes.
 */
export interface ApplyCohesionReviewFixesOptions {
  cwd: string;
  outputDir: string;
  planSetName: string;
  fixes: import('./schemas.js').CohesionReviewSubmission['fixes'];
}

/**
 * Apply fixes emitted by the cohesion-reviewer agent to module plan artifacts.
 * Operates on files under <planSet>/modules/.
 * Does NOT run git add — fixes remain unstaged.
 */
export async function applyCohesionReviewFixes(options: ApplyCohesionReviewFixesOptions): Promise<void> {
  const { cwd, outputDir, planSetName, fixes } = options;
  if (fixes.length === 0) return;

  const modulesDir = resolve(cwd, outputDir, planSetName, 'modules');

  const errors: Error[] = [];
  for (const fix of fixes) {
    try {
      if (fix.kind === 'replace_plan_file') {
        // Issue #3: validate planId before resolving path
        validatePlanId(fix.planId);
        // Issue #5: planId and frontmatter.id must match
        if (fix.planId !== fix.frontmatter.id) {
          throw new Error(`Cannot apply replace_plan_file: planId "${fix.planId}" does not match frontmatter.id "${fix.frontmatter.id}"`);
        }
        const planPath = resolve(modulesDir, `${fix.planId}.md`);
        // Issue #7: use shared serialization helper
        const content = `${serializePlanFrontmatter(fix.frontmatter)}\n${fix.body}`;
        await writeFile(planPath, content, 'utf-8');
      } else if (fix.kind === 'replace_plan_body') {
        // Issue #3: validate planId before resolving path
        validatePlanId(fix.planId);
        const planPath = resolve(modulesDir, `${fix.planId}.md`);
        const raw = await readFile(planPath, 'utf-8');
        // Issue #8: use shared splitFrontmatter helper
        const split = splitFrontmatter(raw);
        if (!split) {
          throw new Error(`Cannot apply replace_plan_body: module plan file has no valid frontmatter: ${planPath}`);
        }
        await writeFile(planPath, `${split.frontmatterBlock}\n${fix.body}`, 'utf-8');
      }
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  }
  // Issue #6: report all fix errors after attempting every fix
  if (errors.length > 0) {
    const messages = errors.map((e, i) => `  Fix ${i + 1}: ${e.message}`).join('\n');
    throw new Error(`applyCohesionReviewFixes encountered ${errors.length} error(s):\n${messages}`);
  }
}

/**
 * Options for applying architecture-reviewer fixes.
 */
export interface ApplyArchitectureReviewFixesOptions {
  cwd: string;
  outputDir: string;
  planSetName: string;
  fixes: import('./schemas.js').ArchitectureReviewSubmission['fixes'];
}

/**
 * Apply fixes emitted by the architecture-reviewer agent to the architecture document.
 * Writes architecture.md verbatim.
 * Does NOT run git add — fixes remain unstaged.
 */
export async function applyArchitectureReviewFixes(options: ApplyArchitectureReviewFixesOptions): Promise<void> {
  const { cwd, outputDir, planSetName, fixes } = options;
  if (fixes.length === 0) return;

  const planDir = resolve(cwd, outputDir, planSetName);

  for (const fix of fixes) {
    if (fix.kind === 'replace_architecture') {
      await writeFile(resolve(planDir, 'architecture.md'), fix.content, 'utf-8');
    }
  }
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
  // Backfill per-plan build/review from pipeline defaults for any plan that
  // omitted them. Planner submissions may now include per-plan build/review
  // overrides; writePlanSet passes them through when present. This step
  // fills in the composer defaults only for plans that omitted them, so
  // parseOrchestrationConfig always sees both fields populated.
  if (Array.isArray(data.plans)) {
    data.plans = (data.plans as Array<Record<string, unknown>>).map((p) => ({
      ...p,
      build: p.build ?? pipeline.defaultBuild,
      review: p.review ?? pipeline.defaultReview,
    }));
  }
  await writeFile(absPath, stringifyYaml(data), 'utf-8');
}
