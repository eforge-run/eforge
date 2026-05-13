/**
 * docs-gen determinism and drift guard.
 *
 * Runs the documentation generator in-process and asserts:
 *   1. All generated files are byte-identical to the checked-in copies (drift check).
 *   2. Running the generator twice produces byte-identical output (determinism check).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRepoRoot, getOutputPaths } from '@eforge-build/docs-gen/output-paths';
import { runDriftCheck, runGenerators } from '@eforge-build/docs-gen/check';

describe('docs-gen drift check', () => {
  it('checked-in generated files are byte-identical to what the generator produces', async () => {
    const result = await runDriftCheck();
    if (!result.ok) {
      throw new Error(
        `Docs drift detected in ${result.changed.length} file(s): ${result.changed.join(', ')}\n` +
          'Run `pnpm docs:generate` to update the checked-in artifacts.',
      );
    }
    expect(result.ok).toBe(true);
    expect(result.changed).toHaveLength(0);
  }, 120_000);
});

describe('docs-gen determinism', () => {
  it('generates byte-identical output on two consecutive runs', async () => {
    const repoRoot = findRepoRoot();

    const tmpA = mkdtempSync(join(tmpdir(), 'eforge-docs-det-a-'));
    const tmpB = mkdtempSync(join(tmpdir(), 'eforge-docs-det-b-'));

    try {
      const pathsA = getOutputPaths(tmpA);
      const pathsB = getOutputPaths(tmpB);

      await runGenerators(repoRoot, pathsA);
      await runGenerators(repoRoot, pathsB);

      const allKeys = Object.keys(pathsA) as Array<keyof typeof pathsA>;
      const mismatches: string[] = [];

      for (const key of allKeys) {
        const [contentA, contentB] = await Promise.all([
          readFile(pathsA[key], 'utf-8').catch(() => null),
          readFile(pathsB[key], 'utf-8').catch(() => null),
        ]);
        if (contentA !== contentB) {
          mismatches.push(key);
        }
      }

      if (mismatches.length > 0) {
        throw new Error(
          `Non-deterministic output detected for: ${mismatches.join(', ')}`,
        );
      }

      expect(mismatches).toHaveLength(0);
    } finally {
      await Promise.allSettled([
        rm(tmpA, { recursive: true, force: true }),
        rm(tmpB, { recursive: true, force: true }),
      ]);
    }
  }, 120_000);
});
