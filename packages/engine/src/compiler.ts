/**
 * Expedition compiler — deterministic transformation from modules to plan files.
 * No LLM calls. Reads index.yaml + modules/*.md, generates plan files + orchestration.yaml.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { stringify as stringifyYaml } from 'yaml';
import type { PlanFile } from './events.js';
import type { BuildStageSpec, ReviewProfileConfig } from './config.js';
import { parseExpeditionIndex, resolveDependencyGraph } from './plan.js';

const exec = promisify(execFile);

/**
 * Compile an expedition's modules into plan files and orchestration.yaml.
 *
 * 1. Reads index.yaml for module list + dependencies
 * 2. Reads each modules/{id}.md
 * 3. Topological sort to determine plan numbering
 * 4. Generates plan-NN-{id}.md files with YAML frontmatter
 * 5. Generates orchestration.yaml
 * 6. Updates index.yaml status to compiled
 */
export async function compileExpedition(
  cwd: string,
  planSetName: string,
  profile?: { description: string; compile: string[] },
  moduleBuildConfigs?: Map<string, { build: BuildStageSpec[]; review: ReviewProfileConfig }>,
  outputDir?: string,
): Promise<PlanFile[]> {
  const planDir = resolve(cwd, outputDir ?? 'eforge/plans', planSetName);
  const indexPath = resolve(planDir, 'index.yaml');
  const modulesDir = resolve(planDir, 'modules');

  // Read index
  const index = await parseExpeditionIndex(indexPath);

  // Read module files
  const moduleEntries = Object.entries(index.modules);
  const moduleContents = new Map<string, string>();

  for (const [id] of moduleEntries) {
    const modPath = resolve(modulesDir, `${id}.md`);
    try {
      const content = await readFile(modPath, 'utf-8');
      moduleContents.set(id, content);
    } catch {
      // Skip modules without files
    }
  }

  // Build plans array for dependency resolution
  const plansForGraph = moduleEntries.map(([id, mod]) => ({
    id,
    name: mod.description,
    dependsOn: mod.dependsOn,
    branch: `${planSetName}/${id}`,
  }));

  // Topological sort
  const { waves } = resolveDependencyGraph(plansForGraph);

  // Assign plan numbers based on wave order
  let planNumber = 1;
  const moduleToPlanId = new Map<string, string>();
  const orderedModules: Array<{ id: string; planId: string; planNumber: number }> = [];

  for (const wave of waves) {
    const sorted = [...wave].sort(); // alphabetical within wave
    for (const moduleId of sorted) {
      const planId = `plan-${String(planNumber).padStart(2, '0')}-${moduleId}`;
      moduleToPlanId.set(moduleId, planId);
      orderedModules.push({ id: moduleId, planId, planNumber });
      planNumber++;
    }
  }

  // Determine base branch
  let baseBranch = 'main';
  try {
    const { stdout } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    baseBranch = stdout.trim();
  } catch {
    // Fall back to main
  }

  // Generate plan files
  const planFiles: PlanFile[] = [];

  for (const { id: moduleId, planId } of orderedModules) {
    const mod = index.modules[moduleId];
    const body = moduleContents.get(moduleId) ?? '';

    // Translate module dependency IDs to plan IDs
    const dependsOn = mod.dependsOn
      .map((depId) => moduleToPlanId.get(depId))
      .filter((id): id is string => id !== undefined);

    const frontmatter = {
      id: planId,
      name: mod.description,
      depends_on: dependsOn,
      branch: `${planSetName}/${moduleId}`,
    };

    const planContent = `---\n${stringifyYaml(frontmatter).trim()}\n---\n\n${body}`;
    const planPath = resolve(planDir, `${planId}.md`);
    await writeFile(planPath, planContent, 'utf-8');

    planFiles.push({
      id: planId,
      name: mod.description,
      dependsOn,
      branch: `${planSetName}/${moduleId}`,
      body,
      filePath: planPath,
    });
  }

  // Generate orchestration.yaml
  const orchConfig: Record<string, unknown> = {
    name: planSetName,
    description: index.description,
    created: index.created,
    compiled: new Date().toISOString().split('T')[0],
    mode: 'expedition',
    base_branch: baseBranch,
    ...(profile && { profile }),
    ...(index.validate && index.validate.length > 0 && { validate: index.validate }),
    plans: planFiles.map((p) => {
      // Find the module ID from the plan's branch (branch format: `{planSetName}/{moduleId}`)
      const moduleId = p.branch.replace(`${planSetName}/`, '');
      const modConfig = moduleBuildConfigs?.get(moduleId);
      return {
        id: p.id,
        name: p.name,
        depends_on: p.dependsOn,
        branch: p.branch,
        ...(modConfig?.build && { build: modConfig.build }),
        ...(modConfig?.review && { review: modConfig.review }),
      };
    }),
  };

  await writeFile(
    resolve(planDir, 'orchestration.yaml'),
    stringifyYaml(orchConfig),
    'utf-8',
  );

  // Update index.yaml status
  const indexRaw = await readFile(indexPath, 'utf-8');
  const updatedIndex = indexRaw
    .replace(/^status:.*$/m, 'status: compiled')
    .replace(/^(compiled:.*$)/m, `compiled: "${new Date().toISOString().split('T')[0]}"`);

  // Add compiled field if it doesn't exist
  if (!updatedIndex.includes('compiled:')) {
    const statusLine = updatedIndex.match(/^status:.*$/m);
    if (statusLine) {
      await writeFile(
        indexPath,
        updatedIndex.replace(
          statusLine[0],
          `${statusLine[0]}\ncompiled: "${new Date().toISOString().split('T')[0]}"`,
        ),
        'utf-8',
      );
    }
  } else {
    await writeFile(indexPath, updatedIndex, 'utf-8');
  }

  return planFiles;
}
