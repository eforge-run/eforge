import { describe, it, expect } from 'vitest';
import { deriveNameFromSource, validatePlanSetName } from '../src/engine/plan.js';

describe('deriveNameFromSource', () => {
  it('extracts kebab-case name from file path', () => {
    expect(deriveNameFromSource('docs/init-prd.md')).toBe('init-prd');
  });

  it('converts camelCase to kebab-case', () => {
    expect(deriveNameFromSource('MyFeature.md')).toBe('my-feature');
  });

  it('handles Windows-style paths', () => {
    expect(deriveNameFromSource('docs\\init-prd.md')).toBe('init-prd');
  });

  it('converts spaces and underscores to hyphens', () => {
    expect(deriveNameFromSource('my feature_plan.md')).toBe('my-feature-plan');
  });

  it('handles inline prompt without dots', () => {
    expect(deriveNameFromSource('add auth')).toBe('add-auth');
  });

  it('preserves long extensions in free-text prompts', () => {
    expect(deriveNameFromSource('Add authentication to the API')).toBe(
      'add-authentication-to-the-api',
    );
  });

  it('strips short extensions from bare filenames', () => {
    expect(deriveNameFromSource('feature.md')).toBe('feature');
  });

  it('returns "unnamed" for empty-ish inputs', () => {
    expect(deriveNameFromSource('.md')).toBe('unnamed');
    expect(deriveNameFromSource('.')).toBe('unnamed');
    expect(deriveNameFromSource('/')).toBe('unnamed');
  });

  it('strips non-alphanumeric characters', () => {
    expect(deriveNameFromSource('hello@world!')).toBe('hello-world');
  });
});

describe('validatePlanSetName', () => {
  it('accepts valid kebab-case names', () => {
    expect(() => validatePlanSetName('my-plan')).not.toThrow();
    expect(() => validatePlanSetName('init-prd')).not.toThrow();
    expect(() => validatePlanSetName('v2')).not.toThrow();
  });

  it('rejects empty strings', () => {
    expect(() => validatePlanSetName('')).toThrow(/empty or unnamed/);
  });

  it('rejects "unnamed"', () => {
    expect(() => validatePlanSetName('unnamed')).toThrow(/empty or unnamed/);
  });

  it('rejects path traversal', () => {
    expect(() => validatePlanSetName('../etc')).toThrow(/path traversal/);
    expect(() => validatePlanSetName('foo/../bar')).toThrow(/path traversal/);
  });

  it('rejects path separators', () => {
    expect(() => validatePlanSetName('foo/bar')).toThrow(/path separator/);
    expect(() => validatePlanSetName('foo\\bar')).toThrow(/path separator/);
  });
});
