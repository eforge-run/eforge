/**
 * Daemon HTTP API surface generator.
 *
 * Imports API_ROUTES from @eforge-build/client and emits a sorted Markdown
 * reference table for every declared route.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { API_ROUTES } from '@eforge-build/client';
import type { OutputPaths } from '../output-paths.js';
import type { ProvenanceInfo } from '../provenance.js';
import { buildProvenanceHeader } from '../provenance.js';

async function writeToAll(content: string, paths: string[]): Promise<void> {
  for (const p of paths) {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, 'utf-8');
  }
}

export async function generateApi(opts: {
  outputPaths: OutputPaths;
  provenance: ProvenanceInfo;
  repoRoot: string;
}): Promise<void> {
  const header = buildProvenanceHeader({
    sourceFiles: ['packages/client/src/routes.ts'],
    eforgeVersion: opts.provenance.eforgeVersion,
    gitCommit: opts.provenance.gitCommit,
  });

  // Sort routes alphabetically for deterministic output
  const sortedRoutes = (Object.entries(API_ROUTES) as [string, string][]).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  const lines: string[] = [
    header,
    '# eforge Daemon HTTP API Reference',
    '',
    'The eforge daemon exposes an HTTP API at `http://localhost:{port}/api/...`.',
    'Clients should import route constants from `@eforge-build/client` (`API_ROUTES`) rather',
    'than embedding literal path strings.',
    '',
    '## Routes',
    '',
    `Total routes: ${sortedRoutes.length}`,
    '',
    '| Route key | Path pattern |',
    '|-----------|-------------|',
  ];

  for (const [key, path] of sortedRoutes) {
    lines.push(`| \`${key}\` | \`${path}\` |`);
  }

  lines.push('');
  lines.push('## SSE Streams');
  lines.push('');
  lines.push(
    '- `GET /api/daemon-events` — daemon-wide event stream with `stream:hello` snapshot on connect.',
  );
  lines.push(
    '- `GET /api/events/:runId` — session-specific event stream with `stream:hello` snapshot on connect.',
  );
  lines.push('');
  lines.push('Use `buildPath(pattern, params)` from `@eforge-build/client` to resolve `:param` placeholders.');
  lines.push('');

  const content = lines.join('\n');
  await writeToAll(content, [opts.outputPaths.contentApi, opts.outputPaths.publicApi]);
}
