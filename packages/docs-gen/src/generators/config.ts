/**
 * Config schema generator.
 *
 * Imports the Zod v4 engine config schema, converts it to JSON Schema via
 * z.toJSONSchema(), and emits both config.schema.json and the Markdown
 * reference.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { eforgeConfigSchema } from '@eforge-build/engine/config';
import type { OutputPaths } from '../output-paths.js';
import type { ProvenanceInfo } from '../provenance.js';
import { buildProvenanceHeader } from '../provenance.js';

async function writeToAll(content: string, paths: string[]): Promise<void> {
  for (const p of paths) {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, 'utf-8');
  }
}

interface JsonSchemaProperty {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchemaProperty>;
  $ref?: string;
  anyOf?: JsonSchemaProperty[];
  allOf?: JsonSchemaProperty[];
  items?: JsonSchemaProperty;
  [key: string]: unknown;
}

interface ConfigJsonSchema {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  [key: string]: unknown;
}

export async function generateConfig(opts: {
  outputPaths: OutputPaths;
  provenance: ProvenanceInfo;
  repoRoot: string;
}): Promise<void> {
  const header = buildProvenanceHeader({
    sourceFiles: ['packages/engine/src/config.ts'],
    eforgeVersion: opts.provenance.eforgeVersion,
    gitCommit: opts.provenance.gitCommit,
  });

  // Generate JSON Schema using Zod v4 native converter
  const jsonSchema = z.toJSONSchema(eforgeConfigSchema) as ConfigJsonSchema;
  const schemaJson = JSON.stringify(jsonSchema, null, 2);
  await mkdir(dirname(opts.outputPaths.schemaConfig), { recursive: true });
  await writeFile(opts.outputPaths.schemaConfig, schemaJson + '\n', 'utf-8');

  // Build Markdown from the JSON schema properties — sorted for determinism
  const properties = jsonSchema.properties ?? {};
  const sortedFields = Object.entries(properties).sort(([a], [b]) => a.localeCompare(b));

  const lines: string[] = [
    header,
    '# eforge Configuration Reference',
    '',
    'eforge merges configuration from three tiers (highest precedence first):',
    '',
    '1. `.eforge/config.yaml` — project-local, gitignored, developer-personal',
    '2. `eforge/config.yaml` — project-level, committed',
    '3. `~/.config/eforge/config.yaml` — user-global',
    '',
    '## Top-level fields',
    '',
    '| Field | Description |',
    '|-------|-------------|',
  ];

  for (const [key, prop] of sortedFields) {
    const desc = (prop.description ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| \`${key}\` | ${desc} |`);
  }

  lines.push('');
  lines.push('## JSON Schema');
  lines.push('');
  lines.push(
    'The complete machine-readable schema is at [`/schemas/config.schema.json`](/schemas/config.schema.json).',
  );
  lines.push('');

  const content = lines.join('\n');
  await writeToAll(content, [opts.outputPaths.contentConfig, opts.outputPaths.publicConfig]);
}
