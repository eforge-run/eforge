/**
 * Canonical output path constants for docs-gen.
 *
 * All paths are rooted at the provided `repoRoot`. Keeping them in one place
 * lets plan-02, tests, and the drift check import the same constants rather
 * than duplicating path strings.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Walk up from `startDir` until a directory containing `pnpm-workspace.yaml`
 * is found, then return that directory as the repo root.
 */
export function findRepoRoot(startDir?: string): string {
  let dir = startDir ?? dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Cannot find repo root (no pnpm-workspace.yaml found walking up from ${startDir ?? 'module dir'})`,
      );
    }
    dir = parent;
  }
}

export function getOutputPaths(repoRoot: string) {
  const webContent = join(repoRoot, 'web', 'content', 'reference');
  const webPublicRef = join(repoRoot, 'web', 'public', 'reference');
  const webPublicSchemas = join(repoRoot, 'web', 'public', 'schemas');
  const webPublicRoot = join(repoRoot, 'web', 'public');

  return {
    // Content Markdown files (will be rendered as pages by plan-02)
    contentCli: join(webContent, 'cli.md'),
    contentApi: join(webContent, 'api.md'),
    contentEvents: join(webContent, 'events.md'),
    contentConfig: join(webContent, 'config.md'),
    contentTools: join(webContent, 'tools.md'),

    // Raw public reference mirror (for agents and direct linking)
    publicCli: join(webPublicRef, 'cli.md'),
    publicApi: join(webPublicRef, 'api.md'),
    publicEvents: join(webPublicRef, 'events.md'),
    publicConfig: join(webPublicRef, 'config.md'),
    publicTools: join(webPublicRef, 'tools.md'),

    // JSON Schemas
    schemaEvents: join(webPublicSchemas, 'events.schema.json'),
    schemaConfig: join(webPublicSchemas, 'config.schema.json'),

    // LLMs files
    llmsTxt: join(webPublicRoot, 'llms.txt'),
    llmsFullTxt: join(webPublicRoot, 'llms-full.txt'),
  };
}

export type OutputPaths = ReturnType<typeof getOutputPaths>;
