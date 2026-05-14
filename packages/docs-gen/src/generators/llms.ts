/**
 * LLMs.txt generator.
 *
 * Produces agent-facing files:
 *   - llms.txt: curated index (summary + guides + reference docs + packages + schemas)
 *   - llms-full.txt: deterministic concatenation of all reference Markdown files
 *   - public docs/*.md: raw Markdown mirror of hand-authored guide pages
 *
 * llms.txt is generated from LLMS_MANIFEST and the reference files written
 * by the other surface generators; guide mirrors are copied from web/content/docs.
 * Run this generator last.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OutputPaths } from '../output-paths.js';
import type { ProvenanceInfo } from '../provenance.js';
import { LLMS_MANIFEST } from '../manifest.js';

async function writeToPath(content: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf-8');
}

function buildLlmsTxt(provenance: ProvenanceInfo): string {
  const lines: string[] = [
    '# eforge',
    '',
    `> ${LLMS_MANIFEST.summary}`,
    '',
    LLMS_MANIFEST.overview,
    '',
    '## Getting started',
    '',
  ];

  for (const guide of LLMS_MANIFEST.guides) {
    lines.push(`- [${guide.title}](${guide.url}): ${guide.description}`);
  }

  lines.push('');
  lines.push('## Canonical reference');
  lines.push('');

  for (const entry of LLMS_MANIFEST.entries) {
    lines.push(`- [${entry.title}](${entry.rawUrl}): ${entry.description}`);
  }

  lines.push('');
  lines.push('## Packages and source');
  lines.push('');

  for (const pkg of LLMS_MANIFEST.packages) {
    lines.push(`- [${pkg.title}](${pkg.url}): ${pkg.description}`);
  }

  lines.push('');
  lines.push('## Schemas');
  lines.push('');

  for (const schema of LLMS_MANIFEST.schemas) {
    lines.push(`- [${schema.title}](${schema.url})`);
  }

  lines.push('');
  lines.push('## Optional');
  lines.push('');

  for (const optional of LLMS_MANIFEST.optional) {
    lines.push(`- [${optional.title}](${optional.url}): ${optional.description}`);
  }

  lines.push('');
  lines.push(`eforge version: ${provenance.eforgeVersion}`);
  lines.push(`Docs commit: ${provenance.gitCommit}`);
  lines.push('');

  return lines.join('\n');
}

async function buildLlmsFullTxt(outputPaths: OutputPaths): Promise<string> {
  const surfaceToPath: Record<string, string> = {
    cli: outputPaths.publicCli,
    api: outputPaths.publicApi,
    events: outputPaths.publicEvents,
    config: outputPaths.publicConfig,
    tools: outputPaths.publicTools,
  };

  const chunks: string[] = [];

  for (const entry of LLMS_MANIFEST.entries) {
    const filePath = surfaceToPath[entry.surface];
    if (!filePath) continue;

    const content = await readFile(filePath, 'utf-8').catch(() => '');
    chunks.push(`\n<!-- section: ${entry.surface} -->\n`);
    chunks.push(content);
    chunks.push(`\n<!-- end-section: ${entry.surface} -->\n`);
  }

  return chunks.join('');
}

async function mirrorGuideMarkdown(repoRoot: string, outputPaths: OutputPaths): Promise<void> {
  const guideMirrors: Array<{ source: string; target: string }> = [
    {
      source: join(repoRoot, 'web', 'content', 'docs', 'getting-started.md'),
      target: outputPaths.publicDocsGettingStarted,
    },
    {
      source: join(repoRoot, 'web', 'content', 'docs', 'concepts.md'),
      target: outputPaths.publicDocsConcepts,
    },
    {
      source: join(repoRoot, 'web', 'content', 'docs', 'configuration.md'),
      target: outputPaths.publicDocsConfiguration,
    },
    // --- eforge:region plan-01-reference-and-mirror-content ---
    {
      source: join(repoRoot, 'web', 'content', 'docs', 'extensions.md'),
      target: outputPaths.publicDocsExtensions,
    },
    {
      source: join(repoRoot, 'web', 'content', 'docs', 'extensions-api.md'),
      target: outputPaths.publicDocsExtensionsApi,
    },
    // --- eforge:endregion plan-01-reference-and-mirror-content ---
    {
      source: join(repoRoot, 'web', 'content', 'docs', 'glossary.md'),
      target: outputPaths.publicDocsGlossary,
    },
  ];

  for (const mirror of guideMirrors) {
    const content = await readFile(mirror.source, 'utf-8');
    await writeToPath(content, mirror.target);
  }
}

export async function generateLlms(opts: {
  outputPaths: OutputPaths;
  provenance: ProvenanceInfo;
  repoRoot: string;
}): Promise<void> {
  await mirrorGuideMarkdown(opts.repoRoot, opts.outputPaths);

  const llmsTxt = buildLlmsTxt(opts.provenance);
  await writeToPath(llmsTxt, opts.outputPaths.llmsTxt);

  const llmsFullTxt = await buildLlmsFullTxt(opts.outputPaths);
  await writeToPath(llmsFullTxt, opts.outputPaths.llmsFullTxt);
}
