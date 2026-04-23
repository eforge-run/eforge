/**
 * Pipeline validation — validatePipeline split into focused sub-functions.
 */

import { getCompileStageNames, getBuildStageNames, getCompileStageDescriptors, getBuildStageDescriptors } from './registry.js';
import type { StageDescriptor } from './types.js';

function checkStageExistence(compile: string[], flatBuild: string[], errors: string[]): void {
  const compileNames = getCompileStageNames();
  const buildNames = getBuildStageNames();
  for (const name of compile) {
    if (!compileNames.has(name)) {
      errors.push(`Unknown compile stage: "${name}"`);
    }
  }
  for (const name of flatBuild) {
    if (!buildNames.has(name)) {
      errors.push(`Unknown build stage: "${name}"`);
    }
  }
}

function checkPredecessorOrdering(
  compile: string[],
  flatBuild: string[],
  build: Array<string | string[]>,
  compileDescs: Map<string, StageDescriptor>,
  buildDescs: Map<string, StageDescriptor>,
  errors: string[],
): void {
  // Check compile predecessor ordering
  for (let i = 0; i < compile.length; i++) {
    const descriptor = compileDescs.get(compile[i]);
    if (!descriptor?.predecessors) continue;
    const preceding = new Set(compile.slice(0, i));
    for (const pred of descriptor.predecessors) {
      if (!preceding.has(pred)) {
        errors.push(`Compile stage "${compile[i]}" requires predecessor "${pred}" to appear before it`);
      }
    }
  }

  // Build parallel peers map for build stages
  const parallelPeers = new Map<string, Set<string>>();
  for (const spec of build) {
    if (Array.isArray(spec) && spec.length > 1) {
      for (const name of spec) {
        const peers = new Set(spec.filter((s) => s !== name));
        parallelPeers.set(name, peers);
      }
    }
  }

  // Check build predecessor ordering (using flattened order)
  for (let i = 0; i < flatBuild.length; i++) {
    const descriptor = buildDescs.get(flatBuild[i]);
    if (!descriptor?.predecessors) continue;
    const preceding = new Set(flatBuild.slice(0, i));
    const peers = parallelPeers.get(flatBuild[i]);
    for (const pred of descriptor.predecessors) {
      if (peers?.has(pred)) {
        errors.push(`Build stage "${flatBuild[i]}" requires predecessor "${pred}" but both are in the same parallel group`);
      } else if (!preceding.has(pred)) {
        errors.push(`Build stage "${flatBuild[i]}" requires predecessor "${pred}" to appear before it`);
      }
    }
  }
}

function checkConflicts(
  compile: string[],
  flatBuild: string[],
  compileDescs: Map<string, StageDescriptor>,
  buildDescs: Map<string, StageDescriptor>,
  errors: string[],
): void {
  const allCompile = new Set(compile);
  const allBuild = new Set(flatBuild);
  const seenConflicts = new Set<string>();

  for (const name of compile) {
    const descriptor = compileDescs.get(name);
    if (!descriptor?.conflictsWith) continue;
    for (const conflict of descriptor.conflictsWith) {
      if (allCompile.has(conflict)) {
        const key = [name, conflict].sort().join('::');
        if (!seenConflicts.has(key)) {
          seenConflicts.add(key);
          errors.push(`Compile stage "${name}" conflicts with "${conflict}"`);
        }
      }
    }
  }

  for (const name of flatBuild) {
    const descriptor = buildDescs.get(name);
    if (!descriptor?.conflictsWith) continue;
    for (const conflict of descriptor.conflictsWith) {
      if (allBuild.has(conflict)) {
        const key = [name, conflict].sort().join('::');
        if (!seenConflicts.has(key)) {
          seenConflicts.add(key);
          errors.push(`Build stage "${name}" conflicts with "${conflict}"`);
        }
      }
    }
  }
}

function checkParallelizability(
  build: Array<string | string[]>,
  buildDescs: Map<string, StageDescriptor>,
  warnings: string[],
): void {
  for (const spec of build) {
    if (!Array.isArray(spec)) continue;
    for (const name of spec) {
      const descriptor = buildDescs.get(name);
      if (!descriptor) continue;
      if (descriptor.parallelizable === false) {
        warnings.push(`Build stage "${name}" is not parallelizable but appears in a parallel group`);
      }
    }
  }
}

/** Validate a pipeline configuration against registered stage descriptors. */
export function validatePipeline(
  compile: string[],
  build: Array<string | string[]>,
): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Flatten build specs for validation
  const flatBuild: string[] = build.flatMap((spec) => (Array.isArray(spec) ? spec : [spec]));

  checkStageExistence(compile, flatBuild, errors);

  // Build descriptor maps for lookup (built once, passed to all sub-checks)
  const compileDescs = new Map(getCompileStageDescriptors().map((d) => [d.name, d]));
  const buildDescs = new Map(getBuildStageDescriptors().map((d) => [d.name, d]));

  checkPredecessorOrdering(compile, flatBuild, build, compileDescs, buildDescs, errors);
  checkConflicts(compile, flatBuild, compileDescs, buildDescs, errors);
  checkParallelizability(build, buildDescs, warnings);

  return { valid: errors.length === 0, errors, warnings };
}
