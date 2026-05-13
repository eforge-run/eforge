/**
 * Provenance metadata for generated reference files.
 *
 * Every generated file begins with a provenance header that records the
 * eforge version and git commit. No timestamps are included so that
 * byte-identical regeneration is possible on the same commit.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ProvenanceInfo {
  eforgeVersion: string;
  gitCommit: string;
}

/**
 * Gather provenance information from the repo.
 *
 * Falls back gracefully when git is unavailable (e.g. detached CI) by
 * reading `EFORGE_GIT_COMMIT` from the environment.
 */
export function gatherProvenance(repoRoot: string): ProvenanceInfo {
  let eforgeVersion = 'unknown';
  try {
    const pkgPath = resolve(repoRoot, 'packages', 'eforge', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    eforgeVersion = pkg.version ?? 'unknown';
  } catch {
    // Ignore — keep 'unknown'
  }

  let gitCommit = process.env['EFORGE_GIT_COMMIT'] ?? 'unknown';
  try {
    gitCommit = execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: repoRoot,
    })
      .toString()
      .trim();
  } catch {
    // Ignore — keep env value or 'unknown'
  }

  return { eforgeVersion, gitCommit };
}

/**
 * Build the standard provenance header block for a generated Markdown file.
 *
 * The header uses HTML comments so it is invisible in rendered output but
 * visible in the raw file and diffs.
 */
export function buildProvenanceHeader(opts: {
  sourceFiles: string[];
  eforgeVersion: string;
  gitCommit: string;
}): string {
  const sourceList = opts.sourceFiles.join(', ');
  return [
    '<!-- Generated file. Do not edit. -->',
    `<!-- eforge version: ${opts.eforgeVersion} -->`,
    `<!-- Commit: ${opts.gitCommit} -->`,
    `<!-- Source: ${sourceList} -->`,
    '',
  ].join('\n');
}
