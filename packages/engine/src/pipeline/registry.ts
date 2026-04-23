/**
 * Stage registry — maps, register/get functions, and formatStageRegistry.
 */

import type { CompileStage, BuildStage, StageDescriptor } from './types.js';

const compileStages = new Map<string, { fn: CompileStage; descriptor: StageDescriptor }>();
const buildStages = new Map<string, { fn: BuildStage; descriptor: StageDescriptor }>();

export function registerCompileStage(descriptor: StageDescriptor, stage: CompileStage): void {
  compileStages.set(descriptor.name, { fn: stage, descriptor });
}

export function registerBuildStage(descriptor: StageDescriptor, stage: BuildStage): void {
  buildStages.set(descriptor.name, { fn: stage, descriptor });
}

export function getCompileStage(name: string): CompileStage {
  const entry = compileStages.get(name);
  if (!entry) throw new Error(`Unknown compile stage: "${name}"`);
  return entry.fn;
}

export function getBuildStage(name: string): BuildStage {
  const entry = buildStages.get(name);
  if (!entry) throw new Error(`Unknown build stage: "${name}"`);
  return entry.fn;
}

/** Return the set of registered compile stage names (for pipeline validation). */
export function getCompileStageNames(): Set<string> {
  return new Set(compileStages.keys());
}

/** Return the set of registered build stage names (for pipeline validation). */
export function getBuildStageNames(): Set<string> {
  return new Set(buildStages.keys());
}

/** Return all registered compile stage descriptors. */
export function getCompileStageDescriptors(): StageDescriptor[] {
  return Array.from(compileStages.values()).map((entry) => entry.descriptor);
}

/** Return all registered build stage descriptors. */
export function getBuildStageDescriptors(): StageDescriptor[] {
  return Array.from(buildStages.values()).map((entry) => entry.descriptor);
}

/** Format the full stage registry as a markdown table for prompt injection. */
export function formatStageRegistry(): string {
  const allDescriptors = [
    ...getCompileStageDescriptors(),
    ...getBuildStageDescriptors(),
  ];

  const lines: string[] = [
    '| Name | Phase | Description | When to Use | Cost | Predecessors | Conflicts | Parallelizable |',
    '|------|-------|-------------|-------------|------|--------------|-----------|----------------|',
  ];

  for (const d of allDescriptors) {
    const preds = d.predecessors?.join(', ') || '-';
    const conflicts = d.conflictsWith?.join(', ') || '-';
    const parallel = d.parallelizable === false ? 'No' : 'Yes';
    lines.push(`| ${d.name} | ${d.phase} | ${d.description} | ${d.whenToUse} | ${d.costHint} | ${preds} | ${conflicts} | ${parallel} |`);
  }

  return lines.join('\n');
}
