/**
 * Drift check module.
 *
 * Generates all reference artifacts into a temporary directory, then
 * compares them byte-for-byte with the checked-in copies under web/.
 *
 * Used by:
 *   - `docs-gen check` CLI subcommand
 *   - `test/docs-gen-determinism.test.ts` vitest spec
 */

import { mkdtempSync } from 'node:fs';
import { rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRepoRoot, getOutputPaths, type OutputPaths } from './output-paths.js';
import { gatherProvenance } from './provenance.js';
import { generateCli } from './generators/cli.js';
import { generateApi } from './generators/api.js';
import { generateEvents } from './generators/events.js';
import { generateConfig } from './generators/config.js';
import { generateTools } from './generators/tools.js';
import { generateLlms } from './generators/llms.js';

export interface DriftCheckResult {
  ok: boolean;
  /** Keys (from OutputPaths) of files that differ from the checked-in copies. */
  changed: string[];
}

/** Run all generators against `outputPaths`. */
export async function runGenerators(
  repoRoot: string,
  outputPaths: OutputPaths,
): Promise<void> {
  const provenance = gatherProvenance(repoRoot);
  const shared = { outputPaths, provenance, repoRoot };

  await generateCli(shared);
  await generateApi(shared);
  await generateEvents(shared);
  await generateConfig(shared);
  await generateTools(shared);
  // llms must run last — it reads the other generated files
  await generateLlms(shared);
}

/**
 * Normalize content for drift comparison by stripping commit-hash lines.
 *
 * The commit hash in provenance headers changes every time a commit is made,
 * creating a circular dependency when comparing checked-in files against
 * freshly generated ones (different HEAD). We strip those lines so only
 * actual content changes trigger a drift failure.
 *
 * Two formats are normalized:
 *   - HTML comment: `<!-- Commit: <hash> -->`  (Markdown reference files)
 *   - Plain text:   `Docs commit: <hash>`       (llms.txt)
 */
function normalizeForDrift(content: string): string {
  return content
    .replace(/^<!-- Commit: [0-9a-f]+ -->$/gm, '<!-- Commit: <normalized> -->')
    .replace(/^Docs commit: [0-9a-f]+$/gm, 'Docs commit: <normalized>');
}

/**
 * Generate all docs into a temp directory and diff against checked-in files.
 *
 * The comparison normalizes commit-hash provenance lines so that routine
 * commit-hash churn does not register as content drift.
 *
 * @returns `{ ok: true, changed: [] }` when all files are byte-identical,
 *          `{ ok: false, changed: ['contentCli', ...] }` on drift.
 */
export async function runDriftCheck(repoRoot?: string): Promise<DriftCheckResult> {
  const root = repoRoot ?? findRepoRoot();
  const checkedInPaths = getOutputPaths(root);

  const tmpBase = mkdtempSync(join(tmpdir(), 'eforge-docs-check-'));
  try {
    const tmpPaths = getOutputPaths(tmpBase);
    await runGenerators(root, tmpPaths);

    const changed: string[] = [];
    const entries = Object.entries(checkedInPaths) as Array<[keyof OutputPaths, string]>;

    for (const [key, checkedInPath] of entries) {
      const tmpPath = tmpPaths[key];
      const [checkedIn, generated] = await Promise.all([
        readFile(checkedInPath, 'utf-8').catch(() => null),
        readFile(tmpPath, 'utf-8').catch(() => null),
      ]);
      if (normalizeForDrift(checkedIn ?? '') !== normalizeForDrift(generated ?? '')) {
        changed.push(key);
      }
    }

    return { ok: changed.length === 0, changed };
  } finally {
    await rm(tmpBase, { recursive: true, force: true }).catch(() => {
      // Ignore cleanup errors
    });
  }
}
