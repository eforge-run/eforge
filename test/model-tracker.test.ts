import { describe, it, expect } from 'vitest';
import { ModelTracker, composeCommitMessage } from '@eforge-build/engine/model-tracker';

describe('ModelTracker', () => {
  describe('record and size', () => {
    it('starts with size 0', () => {
      const tracker = new ModelTracker();
      expect(tracker.size).toBe(0);
    });

    it('records a single model', () => {
      const tracker = new ModelTracker();
      tracker.record('claude-sonnet-4-5');
      expect(tracker.size).toBe(1);
      expect(tracker.has('claude-sonnet-4-5')).toBe(true);
    });

    it('deduplicates repeated model IDs', () => {
      const tracker = new ModelTracker();
      tracker.record('claude-sonnet-4-5');
      tracker.record('claude-sonnet-4-5');
      tracker.record('claude-sonnet-4-5');
      expect(tracker.size).toBe(1);
    });

    it('tracks multiple distinct models', () => {
      const tracker = new ModelTracker();
      tracker.record('claude-sonnet-4-5');
      tracker.record('claude-opus-4-5');
      expect(tracker.size).toBe(2);
      expect(tracker.has('claude-sonnet-4-5')).toBe(true);
      expect(tracker.has('claude-opus-4-5')).toBe(true);
    });

    it('has() returns false for unrecorded models', () => {
      const tracker = new ModelTracker();
      expect(tracker.has('claude-opus-4-5')).toBe(false);
    });
  });

  describe('toTrailer', () => {
    it('returns empty string when no models recorded', () => {
      const tracker = new ModelTracker();
      expect(tracker.toTrailer()).toBe('');
    });

    it('returns a single-model trailer', () => {
      const tracker = new ModelTracker();
      tracker.record('claude-sonnet-4-5');
      expect(tracker.toTrailer()).toBe('Models-Used: claude-sonnet-4-5');
    });

    it('sorts model IDs lexicographically', () => {
      const tracker = new ModelTracker();
      // Input order: sonnet, opus, sonnet (duplicate)
      tracker.record('claude-sonnet-4-5');
      tracker.record('claude-opus-4-5');
      tracker.record('claude-sonnet-4-5');
      // Expected: opus before sonnet (lexicographic)
      expect(tracker.toTrailer()).toBe('Models-Used: claude-opus-4-5, claude-sonnet-4-5');
    });

    it('is deterministic regardless of insertion order', () => {
      const tracker1 = new ModelTracker();
      tracker1.record('z-model');
      tracker1.record('a-model');

      const tracker2 = new ModelTracker();
      tracker2.record('a-model');
      tracker2.record('z-model');

      expect(tracker1.toTrailer()).toBe(tracker2.toTrailer());
      expect(tracker1.toTrailer()).toBe('Models-Used: a-model, z-model');
    });
  });

  describe('merge', () => {
    it('merges another tracker into this one', () => {
      const t1 = new ModelTracker();
      t1.record('model-a');

      const t2 = new ModelTracker();
      t2.record('model-b');
      t2.record('model-c');

      t1.merge(t2);
      expect(t1.size).toBe(3);
      expect(t1.has('model-a')).toBe(true);
      expect(t1.has('model-b')).toBe(true);
      expect(t1.has('model-c')).toBe(true);
    });

    it('deduplicates overlapping models during merge', () => {
      const t1 = new ModelTracker();
      t1.record('model-a');
      t1.record('model-b');

      const t2 = new ModelTracker();
      t2.record('model-b');
      t2.record('model-c');

      t1.merge(t2);
      expect(t1.size).toBe(3);
    });

    it('merging empty tracker is a no-op', () => {
      const t1 = new ModelTracker();
      t1.record('model-a');

      t1.merge(new ModelTracker());
      expect(t1.size).toBe(1);
    });
  });
});

describe('composeCommitMessage', () => {
  it('returns body unchanged when no tracker provided', () => {
    const body = 'feat(plan-01): implement feature';
    expect(composeCommitMessage(body)).toBe(body);
  });

  it('returns body unchanged when tracker is empty', () => {
    const body = 'feat(plan-01): implement feature';
    const tracker = new ModelTracker();
    expect(composeCommitMessage(body, tracker)).toBe(body);
  });

  it('appends Models-Used trailer when tracker is non-empty', () => {
    const body = 'feat(plan-01): implement feature';
    const tracker = new ModelTracker();
    tracker.record('claude-sonnet-4-5');
    const result = composeCommitMessage(body, tracker);
    expect(result).toBe('feat(plan-01): implement feature\n\nModels-Used: claude-sonnet-4-5');
  });

  it('appends sorted multi-model trailer', () => {
    const body = 'feat(plan-01): implement feature';
    const tracker = new ModelTracker();
    tracker.record('claude-sonnet-4-5');
    tracker.record('claude-opus-4-5');
    const result = composeCommitMessage(body, tracker);
    expect(result).toBe('feat(plan-01): implement feature\n\nModels-Used: claude-opus-4-5, claude-sonnet-4-5');
  });

  it('produces body + blank line + trailer (no extra trailing content)', () => {
    const body = 'chore(plan-01): post-parallel-group auto-commit';
    const tracker = new ModelTracker();
    tracker.record('model-x');
    const result = composeCommitMessage(body, tracker);
    const parts = result.split('\n\n');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe(body);
    expect(parts[1]).toBe('Models-Used: model-x');
  });
});
