/**
 * TypeBox-backed schema utility helpers.
 *
 * Provides generic safe-parse, parse, error-format, and schema-YAML helpers
 * that act as the boundary between eforge-owned schemas and their consumers.
 * Consumers call these helpers rather than TypeBox / Zod methods directly,
 * so future implementation swaps do not ripple through every callsite.
 */

import { type TSchema, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { stringify as stringifyYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single validation error with a JSON-pointer path and human-readable message. */
export interface ValueError {
  path: string;
  message: string;
}

/**
 * Wraps TypeBox validation errors with a pre-formatted message string.
 * The `message` field is a multi-line string with one `path: message` entry
 * per error, matching the readability bar set by `z.prettifyError()`.
 */
export interface SchemaError {
  /** Pre-formatted multi-line string: one `path: message` per error. */
  message: string;
  /** Individual validation errors. */
  errors: ValueError[];
}

/**
 * Mirrors Zod's familiar `safeParse` result shape so consumer migration is
 * mechanical:
 *   `{ success: true; data: T } | { success: false; error: SchemaError }`
 */
export type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: SchemaError };

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

/**
 * Formats a `SchemaError` as a multi-line human-readable string.
 * Each line has the form `<path>: <message>`.
 * The path `""` (root) is rendered as `(root)`.
 */
export function formatSchemaError(error: SchemaError): string {
  return error.errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('\n');
}

// ---------------------------------------------------------------------------
// Safe parse
// ---------------------------------------------------------------------------

/**
 * Validates `value` against `schema` without throwing.
 *
 * Returns `{ success: true, data }` when valid, or
 * `{ success: false, error }` with a formatted `SchemaError` when invalid.
 */
export function safeParseWithSchema<T extends TSchema>(
  schema: T,
  value: unknown,
): SafeParseResult<Static<T>> {
  if (Value.Check(schema, value)) {
    return { success: true, data: value as Static<T> };
  }

  const errors: ValueError[] = [...Value.Errors(schema, value)].map((e) => ({
    path: e.path,
    message: e.message,
  }));

  const message = errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('\n');

  return { success: false, error: { message, errors } };
}

// ---------------------------------------------------------------------------
// Parse (throws on failure)
// ---------------------------------------------------------------------------

/**
 * Validates `value` against `schema`, returning the typed value on success.
 *
 * Throws an `Error` whose `message` matches `formatSchemaError(error)` when
 * validation fails.
 */
export function parseWithSchema<T extends TSchema>(schema: T, value: unknown): Static<T> {
  const result = safeParseWithSchema(schema, value);
  if (result.success) {
    return result.data;
  }
  throw new Error(formatSchemaError(result.error));
}

// ---------------------------------------------------------------------------
// Schema to YAML (cached)
// ---------------------------------------------------------------------------

/**
 * TypeBox-internal keys that must be stripped before serialising a schema to
 * YAML / JSON Schema output.  These keys are injected by TypeBox at schema
 * construction time and have no meaning outside the TypeBox runtime.
 */
const INTERNAL_KEYS = new Set<string>(['$id', '$schema', '~standard', 'static', 'params', 'kind']);

function stripInternalKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripInternalKeys);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!INTERNAL_KEYS.has(k)) {
        out[k] = stripInternalKeys(v);
      }
    }
    return out;
  }
  return value;
}

const yamlCache = new Map<string, string>();

/**
 * Serialises a TypeBox schema to a YAML string.
 *
 * Strips TypeBox-internal keys (`$id`, `$schema`, `~standard`, `static`,
 * `params`, `kind`) so the output is clean JSON-Schema-compatible YAML.
 * Results are memoised by `key` since schemas are static — repeated calls
 * with the same key return the identical string instance.
 */
export function getSchemaYaml(key: string, schema: TSchema): string {
  const cached = yamlCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const cleaned = stripInternalKeys(schema);
  const yaml = stringifyYaml(cleaned);
  yamlCache.set(key, yaml);
  return yaml;
}
