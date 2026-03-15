import { describe, it, expect } from 'vitest';
import {
  categorizeFiles,
  determineApplicableReviews,
  shouldParallelizeReview,
  type FileCategories,
} from '../src/engine/review-heuristics.js';

describe('categorizeFiles', () => {
  it('assigns TypeScript files to code', () => {
    const result = categorizeFiles(['src/engine/agents/reviewer.ts']);
    expect(result.code).toEqual(['src/engine/agents/reviewer.ts']);
  });

  it('assigns route files to api', () => {
    const result = categorizeFiles(['src/routes/users.ts', 'src/api/auth.ts']);
    expect(result.api).toEqual(['src/routes/users.ts', 'src/api/auth.ts']);
  });

  it('assigns README to docs', () => {
    const result = categorizeFiles(['README.md']);
    expect(result.docs).toEqual(['README.md']);
  });

  it('assigns package.json to deps', () => {
    const result = categorizeFiles(['package.json']);
    expect(result.deps).toEqual(['package.json']);
  });

  it('assigns config files to config', () => {
    const result = categorizeFiles(['.eslintrc.json', 'tsconfig.json']);
    expect(result.config).toEqual(['.eslintrc.json', 'tsconfig.json']);
  });

  it('assigns markdown files to docs', () => {
    const result = categorizeFiles(['docs/guide.md', 'CHANGELOG.md']);
    expect(result.docs).toEqual(['docs/guide.md', 'CHANGELOG.md']);
  });

  it('handles mixed file types', () => {
    const result = categorizeFiles([
      'src/engine/eforge.ts',
      'package.json',
      'README.md',
      '.gitignore',
      'src/api/users.ts',
    ]);
    expect(result.code).toEqual(['src/engine/eforge.ts']);
    expect(result.deps).toEqual(['package.json']);
    expect(result.docs).toEqual(['README.md']);
    expect(result.config).toEqual(['.gitignore']);
    expect(result.api).toEqual(['src/api/users.ts']);
  });

  it('returns empty categories for empty input', () => {
    const result = categorizeFiles([]);
    expect(result.code).toEqual([]);
    expect(result.api).toEqual([]);
    expect(result.docs).toEqual([]);
    expect(result.config).toEqual([]);
    expect(result.deps).toEqual([]);
  });
});

describe('determineApplicableReviews', () => {
  it('returns code + security for code files', () => {
    const categories: FileCategories = {
      code: ['a.ts'],
      api: [],
      docs: [],
      config: [],
      deps: [],
    };
    const result = determineApplicableReviews(categories);
    expect(result).toContain('code');
    expect(result).toContain('security');
    expect(result).toHaveLength(2);
  });

  it('adds api perspective for API files', () => {
    const categories: FileCategories = {
      code: ['a.ts'],
      api: ['src/routes/users.ts'],
      docs: [],
      config: [],
      deps: [],
    };
    const result = determineApplicableReviews(categories);
    expect(result).toContain('code');
    expect(result).toContain('security');
    expect(result).toContain('api');
  });

  it('adds docs perspective for doc files', () => {
    const categories: FileCategories = {
      code: [],
      api: [],
      docs: ['README.md'],
      config: [],
      deps: [],
    };
    const result = determineApplicableReviews(categories);
    expect(result).toEqual(['docs']);
  });

  it('adds security for deps files without duplicating', () => {
    const categories: FileCategories = {
      code: ['a.ts'],
      api: [],
      docs: [],
      config: [],
      deps: ['package.json'],
    };
    const result = determineApplicableReviews(categories);
    // code triggers code + security, deps also triggers security but it's already there
    expect(result).toContain('code');
    expect(result).toContain('security');
    expect(result).toHaveLength(2);
  });

  it('returns security only for deps-only changes', () => {
    const categories: FileCategories = {
      code: [],
      api: [],
      docs: [],
      config: [],
      deps: ['package.json'],
    };
    const result = determineApplicableReviews(categories);
    expect(result).toEqual(['security']);
  });

  it('returns empty for config-only changes', () => {
    const categories: FileCategories = {
      code: [],
      api: [],
      docs: [],
      config: ['.eslintrc.json'],
      deps: [],
    };
    const result = determineApplicableReviews(categories);
    expect(result).toEqual([]);
  });
});

describe('shouldParallelizeReview', () => {
  it('returns false below both thresholds', () => {
    expect(shouldParallelizeReview(['a.ts'], { lines: 100 })).toBe(false);
  });

  it('returns true at 10 files', () => {
    expect(shouldParallelizeReview(Array(10).fill('a.ts'), { lines: 100 })).toBe(true);
  });

  it('returns false at 9 files below line threshold', () => {
    expect(shouldParallelizeReview(Array(9).fill('a.ts'), { lines: 499 })).toBe(false);
  });

  it('returns true at 500 lines', () => {
    expect(shouldParallelizeReview(['a.ts'], { lines: 500 })).toBe(true);
  });

  it('returns true when both thresholds exceeded', () => {
    expect(shouldParallelizeReview(Array(15).fill('a.ts'), { lines: 1000 })).toBe(true);
  });

  it('returns false for empty file list', () => {
    expect(shouldParallelizeReview([], { lines: 0 })).toBe(false);
  });
});
