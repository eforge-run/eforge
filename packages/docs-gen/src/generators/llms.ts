/**
 * LLMs.txt generator.
 *
 * Produces two files:
 *   - llms.txt: curated index (overview + links to reference docs and schemas)
 *   - llms-full.txt: deterministic concatenation of all reference Markdown files
 *
 * Both files are generated from LLMS_MANIFEST and the reference files written
 * by the other surface generators. Run this generator last.
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
    LLMS_MANIFEST.overview,
    '',
    '## Canonical reference',
    '',
  ];

  for (const entry of LLMS_MANIFEST.entries) {
    lines.push(`- [${entry.title}](${entry.rawUrl}): ${entry.description}`);
  }

  lines.push('');
  lines.push('## Schemas');
  lines.push('');

  for (const schema of LLMS_MANIFEST.schemas) {
    lines.push(`- [${schema.title}](${schema.url})`);
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

export async function generateLlms(opts: {
  outputPaths: OutputPaths;
  provenance: ProvenanceInfo;
  repoRoot: string;
}): Promise<void> {
  const llmsTxt = buildLlmsTxt(opts.provenance);
  await writeToPath(llmsTxt, opts.outputPaths.llmsTxt);

  const llmsFullTxt = await buildLlmsFullTxt(opts.outputPaths);
  await writeToPath(llmsFullTxt, opts.outputPaths.llmsFullTxt);
}
