/**
 * Event protocol generator.
 *
 * Imports EforgeEventSchema (TypeBox) from @eforge-build/client, serialises it
 * as events.schema.json, and emits a per-variant Markdown reference.
 *
 * TypeBox schemas are plain JSON-serialisable objects — Symbol-keyed internal
 * properties (Type, Hint, etc.) are ignored by JSON.stringify, leaving
 * standard JSON Schema.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EforgeEventSchema } from '@eforge-build/client';
import type { OutputPaths } from '../output-paths.js';
import type { ProvenanceInfo } from '../provenance.js';
import { buildProvenanceHeader } from '../provenance.js';

async function writeToAll(content: string, paths: string[]): Promise<void> {
  for (const p of paths) {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, 'utf-8');
  }
}

interface JsonSchemaObject {
  type?: string;
  const?: unknown;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  anyOf?: JsonSchemaObject[];
  allOf?: JsonSchemaObject[];
  items?: JsonSchemaObject;
  description?: string;
  [key: string]: unknown;
}

interface EventVariant {
  type: string;
  fields: string[];
}

function extractVariants(schema: JsonSchemaObject): EventVariant[] {
  // EforgeEventSchema = Intersect([envelope, variantsUnion])
  // TypeBox Intersect -> { allOf: [...] }
  // TypeBox Union -> { anyOf: [...] }
  const allOf = schema.allOf ?? [];

  let variantsSchema: JsonSchemaObject | undefined;
  for (const item of allOf) {
    if (Array.isArray(item.anyOf)) {
      variantsSchema = item;
      break;
    }
  }

  if (!variantsSchema?.anyOf) return [];

  const variants: EventVariant[] = [];
  for (const variant of variantsSchema.anyOf) {
    if (!variant.properties) continue;
    const typeField = variant.properties['type'];
    if (!typeField) continue;
    const typeValue = typeField.const;
    if (typeof typeValue !== 'string') continue;
    const fields = Object.keys(variant.properties)
      .filter((k) => k !== 'type')
      .sort();
    variants.push({ type: typeValue, fields });
  }

  return variants;
}

export async function generateEvents(opts: {
  outputPaths: OutputPaths;
  provenance: ProvenanceInfo;
  repoRoot: string;
}): Promise<void> {
  const header = buildProvenanceHeader({
    sourceFiles: ['packages/client/src/events.schemas.ts'],
    eforgeVersion: opts.provenance.eforgeVersion,
    gitCommit: opts.provenance.gitCommit,
  });

  // Write JSON Schema — TypeBox schema objects are JSON Schema (sans Symbol keys)
  const schemaJson = JSON.stringify(EforgeEventSchema, null, 2);
  await mkdir(dirname(opts.outputPaths.schemaEvents), { recursive: true });
  await writeFile(opts.outputPaths.schemaEvents, schemaJson + '\n', 'utf-8');

  // Extract event variants for Markdown
  const variants = extractVariants(EforgeEventSchema as JsonSchemaObject);

  const lines: string[] = [
    header,
    '# eforge Event Protocol Reference',
    '',
    'All events emitted on the eforge SSE stream conform to the `EforgeEvent` discriminated',
    'union defined in `packages/client/src/events.schemas.ts`.',
    '',
    'Each event carries an optional envelope (`sessionId`, `runId`, `timestamp`) intersected',
    'with one of the variant objects below. The `type` field discriminates the variant.',
    '',
    '## Event Variants',
    '',
    `Total variants: ${variants.length}`,
    '',
    '| Event type | Additional fields |',
    '|------------|-------------------|',
  ];

  for (const v of variants) {
    const fields =
      v.fields.length > 0 ? v.fields.map((f) => `\`${f}\``).join(', ') : '-';
    lines.push(`| \`${v.type}\` | ${fields} |`);
  }

  lines.push('');
  lines.push('## JSON Schema');
  lines.push('');
  lines.push(
    'The complete machine-readable schema is at [`/schemas/events.schema.json`](/schemas/events.schema.json).',
  );
  lines.push('Use `safeParseEforgeEvent(value)` from `@eforge-build/client` to validate at runtime.');
  lines.push('');

  const content = lines.join('\n');
  await writeToAll(content, [opts.outputPaths.contentEvents, opts.outputPaths.publicEvents]);
}
