import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { PlanFile, OrchestrationConfig, ExpeditionModule } from './events.js';

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

  return {
    name: data.name,
    description: (data.description as string) ?? '',
    created: (data.created as string) ?? '',
    status: (data.status as string) ?? 'draft',
    mode: 'expedition',
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
    ? (data.plans as Array<Record<string, unknown>>).map((p) => ({
        id: typeof p.id === 'string' ? p.id : String(p.id ?? ''),
        name: typeof p.name === 'string' ? p.name : String(p.name ?? ''),
        dependsOn: Array.isArray(p.depends_on) ? (p.depends_on as string[]) : [],
        branch: typeof p.branch === 'string' ? p.branch : '',
      }))
    : [];

  return {
    name: data.name as string,
    description: (data.description as string) ?? '',
    created: (data.created as string) ?? '',
    mode: (data.mode as OrchestrationConfig['mode']) ?? 'errand',
    baseBranch: (data.base_branch as string) ?? 'main',
    plans,
  };
}

/**
 * Resolve a dependency graph into execution waves (topological sort via Kahn's algorithm)
 * and a merge order (topological — dependencies merge first, dependents last).
 */
export function resolveDependencyGraph(
  plans: OrchestrationConfig['plans'],
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
