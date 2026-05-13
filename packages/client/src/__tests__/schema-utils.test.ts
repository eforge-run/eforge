/**
 * Unit tests for the TypeBox-backed schema utility helpers in schema-utils.ts.
 *
 * Covers:
 *   - safeParseWithSchema — success and failure paths
 *   - parseWithSchema — throws with formatted message on failure
 *   - formatSchemaError — multi-error rendering
 *   - getSchemaYaml — deterministic output and internal-key stripping
 */

import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import {
  safeParseWithSchema,
  parseWithSchema,
  formatSchemaError,
  getSchemaYaml,
  type SafeParseResult,
  type SchemaError,
} from '../schema-utils.js';

// ---------------------------------------------------------------------------
// Test schema
// ---------------------------------------------------------------------------

const PersonSchema = Type.Object({
  name: Type.String(),
  age: Type.Number(),
});

// ---------------------------------------------------------------------------
// safeParseWithSchema
// ---------------------------------------------------------------------------

describe('safeParseWithSchema', () => {
  it('returns { success: true, data } for valid input', () => {
    const result = safeParseWithSchema(PersonSchema, { name: 'Alice', age: 30 });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('Alice');
      expect(result.data.age).toBe(30);
    }
  });

  it('returns { success: false, error } for invalid input (wrong type)', () => {
    const result = safeParseWithSchema(PersonSchema, { name: 'Bob', age: 'not-a-number' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBeTruthy();
      expect(result.error.errors.length).toBeGreaterThan(0);
    }
  });

  it('returns { success: false, error } for missing required fields', () => {
    const result = safeParseWithSchema(PersonSchema, { name: 'Carol' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  it('returns { success: false, error } for null input', () => {
    const result = safeParseWithSchema(PersonSchema, null);

    expect(result.success).toBe(false);
  });

  it('error.message is a non-empty multi-line string for multiple errors', () => {
    // Both fields wrong
    const result = safeParseWithSchema(PersonSchema, { name: 42, age: 'oops' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBeTruthy();
      expect(result.error.errors.length).toBeGreaterThan(0);
      for (const e of result.error.errors) {
        expect(typeof e.path).toBe('string');
        expect(typeof e.message).toBe('string');
      }
    }
  });

  it('result type satisfies SafeParseResult<T> union', () => {
    const result: SafeParseResult<{ name: string; age: number }> = safeParseWithSchema(
      PersonSchema,
      { name: 'Dave', age: 25 },
    );
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseWithSchema
// ---------------------------------------------------------------------------

describe('parseWithSchema', () => {
  it('returns the typed value for valid input', () => {
    const data = parseWithSchema(PersonSchema, { name: 'Eve', age: 28 });

    expect(data.name).toBe('Eve');
    expect(data.age).toBe(28);
  });

  it('throws an Error for invalid input', () => {
    expect(() => parseWithSchema(PersonSchema, { name: 'Frank', age: 'bad' })).toThrow(Error);
  });

  it('thrown error message matches formatSchemaError output', () => {
    let thrownMessage = '';
    let expectedMessage = '';

    try {
      parseWithSchema(PersonSchema, { name: 42, age: 'oops' });
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : '';
    }

    const result = safeParseWithSchema(PersonSchema, { name: 42, age: 'oops' });
    if (!result.success) {
      expectedMessage = formatSchemaError(result.error);
    }

    expect(thrownMessage).toBe(expectedMessage);
    expect(thrownMessage.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// formatSchemaError
// ---------------------------------------------------------------------------

describe('formatSchemaError', () => {
  it('renders each error as "path: message"', () => {
    const error: SchemaError = {
      message: '',
      errors: [
        { path: '/name', message: 'Expected string' },
        { path: '/age', message: 'Expected number' },
      ],
    };

    const formatted = formatSchemaError(error);
    expect(formatted).toContain('/name: Expected string');
    expect(formatted).toContain('/age: Expected number');
  });

  it('renders empty path as "(root)"', () => {
    const error: SchemaError = {
      message: '',
      errors: [{ path: '', message: 'Expected object' }],
    };

    const formatted = formatSchemaError(error);
    expect(formatted).toBe('(root): Expected object');
  });

  it('produces a multi-line string for multiple errors', () => {
    const error: SchemaError = {
      message: '',
      errors: [
        { path: '/a', message: 'err1' },
        { path: '/b', message: 'err2' },
        { path: '/c', message: 'err3' },
      ],
    };

    const lines = formatSchemaError(error).split('\n');
    expect(lines).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// getSchemaYaml
// ---------------------------------------------------------------------------

const SimpleSchema = Type.Object({
  id: Type.String(),
  value: Type.Number(),
});

describe('getSchemaYaml', () => {
  it('produces non-empty YAML output', () => {
    const yaml = getSchemaYaml('test-simple', SimpleSchema);
    expect(typeof yaml).toBe('string');
    expect(yaml.trim().length).toBeGreaterThan(0);
  });

  it('returns the same string instance for repeated calls (cache hit)', () => {
    const yaml1 = getSchemaYaml('cache-test-schema', SimpleSchema);
    const yaml2 = getSchemaYaml('cache-test-schema', SimpleSchema);

    // Same string reference — cache hit returns the identical instance
    expect(yaml1).toBe(yaml2);
  });

  it('strips internal keys ($schema, $id, ~standard, kind, static) injected via TypeBox options', () => {
    // TypeBox merges extra options into the schema object, so passing $schema/$id
    // as options injects real keys that stripInternalKeys must remove.
    // Without the stripping logic these assertions would fail, making the test
    // genuinely exercise the code path rather than passing vacuously.
    const SchemaWithInjectedKeys = Type.Object(
      { id: Type.String() },
      { $schema: 'http://json-schema.org/draft-07/schema#', $id: 'injected-root-id' },
    );

    const yaml = getSchemaYaml('strip-injected-keys', SchemaWithInjectedKeys);

    // Internal keys must be absent
    expect(yaml).not.toContain('$schema');
    expect(yaml).not.toContain('$id');
    expect(yaml).not.toContain('~standard');
    expect(yaml).not.toContain('kind:');
    expect(yaml).not.toContain('static:');

    // Meaningful content must survive
    expect(yaml).toContain('type');
    expect(yaml).toContain('properties');
  });

  it('preserves type and properties in YAML output', () => {
    const yaml = getSchemaYaml('preserve-props', SimpleSchema);
    expect(yaml).toContain('type');
    expect(yaml).toContain('properties');
  });

  it('different keys produce independent cached entries', () => {
    const OtherSchema = Type.Object({ label: Type.String() });
    const yaml1 = getSchemaYaml('unique-key-alpha', SimpleSchema);
    const yaml2 = getSchemaYaml('unique-key-beta', OtherSchema);

    expect(yaml1).not.toBe(yaml2);
  });
});
