import { describe, it, expect } from 'vitest';
import type { EforgeEvent } from '@eforge-build/engine/events';

describe('build:files_changed event', () => {
  it('is assignable to EforgeEvent', () => {
    // Type-level test: if this compiles, the event is part of the union
    const event: EforgeEvent = {
      type: 'plan:build:files_changed',
      planId: 'plan-01',
      files: ['src/foo.ts', 'src/bar.ts'],
    };

    expect(event.type).toBe('plan:build:files_changed');
    expect(event.planId).toBe('plan-01');
    expect(event.files).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('has the correct shape with planId and files array', () => {
    const event: EforgeEvent = {
      type: 'plan:build:files_changed',
      planId: 'test-plan',
      files: [],
    };

    expect(event).toHaveProperty('type', 'plan:build:files_changed');
    expect(event).toHaveProperty('planId', 'test-plan');
    expect(event).toHaveProperty('files');
  });

  it('accepts optional diffs and baseBranch fields', () => {
    const event: EforgeEvent = {
      type: 'plan:build:files_changed',
      planId: 'plan-01',
      files: ['src/foo.ts'],
      diffs: [{ path: 'src/foo.ts', diff: 'diff --git a/src/foo.ts b/src/foo.ts\n+added line' }],
      baseBranch: 'main',
    };

    expect(event.type).toBe('plan:build:files_changed');
    if (event.type === 'plan:build:files_changed') {
      expect(event.diffs).toHaveLength(1);
      expect(event.diffs![0].path).toBe('src/foo.ts');
      expect(event.baseBranch).toBe('main');
    }
  });

  it('works without diffs and baseBranch (backward compat)', () => {
    // This tests that the fields are truly optional - no diffs or baseBranch
    const event: EforgeEvent = {
      type: 'plan:build:files_changed',
      planId: 'plan-01',
      files: ['src/bar.ts'],
    };

    if (event.type === 'plan:build:files_changed') {
      expect(event.diffs).toBeUndefined();
      expect(event.baseBranch).toBeUndefined();
      expect(event.files).toEqual(['src/bar.ts']);
    }
  });

  it('can be discriminated from other build events', () => {
    const events: EforgeEvent[] = [
      { type: 'plan:build:implement:start', planId: 'p1' },
      { type: 'plan:build:implement:complete', planId: 'p1' },
      { type: 'plan:build:files_changed', planId: 'p1', files: ['a.ts', 'b.ts'] },
      { type: 'plan:build:review:start', planId: 'p1' },
    ];

    const filesChanged = events.find((e) => e.type === 'plan:build:files_changed');
    expect(filesChanged).toBeDefined();

    // Type narrowing works via discriminated union
    if (filesChanged && filesChanged.type === 'plan:build:files_changed') {
      expect(filesChanged.files).toEqual(['a.ts', 'b.ts']);
    }
  });
});
