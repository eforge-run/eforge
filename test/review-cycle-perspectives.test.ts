import { describe, expect, it } from 'vitest';
import {
  selectNextReviewPerspectives,
  type ReviewCycleEvaluationSummary,
  type ReviewPerspective,
} from '@eforge-build/engine/review-cycle-perspectives';
import type { ReviewIssue } from '@eforge-build/engine/events';

const cleanEvaluation: ReviewCycleEvaluationSummary = {
  ran: true,
  accepted: 0,
  rejected: 0,
  review: 0,
  files: [],
};

function issue(file = 'src/app.ts'): ReviewIssue {
  return {
    severity: 'warning',
    category: 'bugs',
    file,
    description: 'Fix the issue',
  };
}

function issuesByPerspective(perspectives: ReviewPerspective[], withIssues: ReviewPerspective[] = []) {
  return Object.fromEntries(
    perspectives.map(perspective => [perspective, withIssues.includes(perspective) ? [issue()] : []]),
  );
}

describe('selectNextReviewPerspectives', () => {
  it('drops zero-issue perspectives when evaluator evidence does not overlap', () => {
    const result = selectNextReviewPerspectives({
      initialOrder: ['code', 'docs'],
      previousActive: ['code', 'docs'],
      issuesByPerspective: issuesByPerspective(['code', 'docs']),
      evaluation: cleanEvaluation,
      previousReviewWasParallel: true,
    });

    expect(result.fallback).toBe(false);
    expect(result.perspectives).toEqual([]);
    expect(result.dropped).toEqual(['code', 'docs']);
  });

  it('retains perspectives that reported prior issues', () => {
    const result = selectNextReviewPerspectives({
      initialOrder: ['code', 'docs'],
      previousActive: ['code', 'docs'],
      issuesByPerspective: issuesByPerspective(['code', 'docs'], ['docs']),
      evaluation: cleanEvaluation,
      previousReviewWasParallel: true,
    });

    expect(result.perspectives).toEqual(['docs']);
    expect(result.dropped).toEqual(['code']);
  });

  it('retains zero-issue perspectives whose concern area appears in accepted evaluator files', () => {
    const result = selectNextReviewPerspectives({
      initialOrder: ['code', 'docs'],
      previousActive: ['code', 'docs'],
      issuesByPerspective: issuesByPerspective(['code', 'docs']),
      evaluation: {
        ran: true,
        accepted: 1,
        rejected: 0,
        review: 0,
        files: [{ file: 'docs/guide.md', mode: 'file', action: 'accept', acceptedHunks: [], rejectedHunks: [], reviewHunks: [] }],
      },
      previousReviewWasParallel: true,
    });

    expect(result.perspectives).toEqual(['docs']);
    expect(result.dropped).toEqual(['code']);
  });

  it('counts rejected and review verdict files as concern evidence', () => {
    const result = selectNextReviewPerspectives({
      initialOrder: ['api', 'test', 'docs'],
      previousActive: ['api', 'test', 'docs'],
      issuesByPerspective: issuesByPerspective(['api', 'test', 'docs']),
      evaluation: {
        ran: true,
        accepted: 0,
        rejected: 2,
        review: 1,
        files: [
          { file: 'src/api/users.ts', mode: 'file', action: 'reject', acceptedHunks: [], rejectedHunks: [], reviewHunks: [] },
          { file: 'test/users.test.ts', mode: 'hunks', acceptedHunks: [], rejectedHunks: [], reviewHunks: [1] },
        ],
      },
      previousReviewWasParallel: true,
    });

    expect(result.perspectives).toEqual(['api', 'test']);
    expect(result.dropped).toEqual(['docs']);
  });

  it('retains security for code and dependency paths', () => {
    const codeResult = selectNextReviewPerspectives({
      initialOrder: ['security'],
      previousActive: ['security'],
      issuesByPerspective: issuesByPerspective(['security']),
      evaluation: {
        ran: true,
        accepted: 1,
        rejected: 0,
        review: 0,
        files: [{ file: 'src/app.ts', mode: 'file', action: 'accept', acceptedHunks: [], rejectedHunks: [], reviewHunks: [] }],
      },
      previousReviewWasParallel: true,
    });
    const depsResult = selectNextReviewPerspectives({
      initialOrder: ['security'],
      previousActive: ['security'],
      issuesByPerspective: issuesByPerspective(['security']),
      evaluation: {
        ran: true,
        accepted: 1,
        rejected: 0,
        review: 0,
        files: [{ file: 'pnpm-lock.yaml', mode: 'file', action: 'accept', acceptedHunks: [], rejectedHunks: [], reviewHunks: [] }],
      },
      previousReviewWasParallel: true,
    });

    expect(codeResult.perspectives).toEqual(['security']);
    expect(depsResult.perspectives).toEqual(['security']);
  });

  it('retains verify after prior verification issues', () => {
    const result = selectNextReviewPerspectives({
      initialOrder: ['verify'],
      previousActive: ['verify'],
      issuesByPerspective: issuesByPerspective(['verify'], ['verify']),
      evaluation: cleanEvaluation,
      previousReviewWasParallel: true,
    });

    expect(result.perspectives).toEqual(['verify']);
    expect(result.dropped).toEqual([]);
  });

  it.each([
    ['code', 'src/app.ts'],
    ['test', 'test/app.test.ts'],
    ['dependency', 'package.json'],
    ['config', 'tsconfig.json'],
    ['unknown', 'assets/logo.svg'],
  ])('retains verify after accepted %s paths', (_label, file) => {
    const result = selectNextReviewPerspectives({
      initialOrder: ['verify'],
      previousActive: ['verify'],
      issuesByPerspective: issuesByPerspective(['verify']),
      evaluation: {
        ran: true,
        accepted: 1,
        rejected: 0,
        review: 0,
        files: [{ file, mode: 'file', action: 'accept', acceptedHunks: [], rejectedHunks: [], reviewHunks: [] }],
      },
      previousReviewWasParallel: true,
    });

    expect(result.perspectives).toEqual(['verify']);
  });

  it('retains verify after accepted hunk-level non-doc changes', () => {
    const result = selectNextReviewPerspectives({
      initialOrder: ['verify'],
      previousActive: ['verify'],
      issuesByPerspective: issuesByPerspective(['verify']),
      evaluation: {
        ran: true,
        accepted: 1,
        rejected: 0,
        review: 0,
        files: [{ file: 'src/app.ts', mode: 'hunks', acceptedHunks: [1], rejectedHunks: [], reviewHunks: [] }],
      },
      previousReviewWasParallel: true,
    });

    expect(result.perspectives).toEqual(['verify']);
  });

  it('drops verify after a clean round with docs-only accepted paths', () => {
    const result = selectNextReviewPerspectives({
      initialOrder: ['verify'],
      previousActive: ['verify'],
      issuesByPerspective: issuesByPerspective(['verify']),
      evaluation: {
        ran: true,
        accepted: 1,
        rejected: 0,
        review: 0,
        files: [{ file: 'docs/guide.md', mode: 'file', action: 'accept', acceptedHunks: [], rejectedHunks: [], reviewHunks: [] }],
      },
      previousReviewWasParallel: true,
    });

    expect(result.perspectives).toEqual([]);
    expect(result.dropped).toEqual(['verify']);
  });

  it('drops verify when rejected and review verdicts on non-doc files are the only evidence', () => {
    const result = selectNextReviewPerspectives({
      initialOrder: ['verify'],
      previousActive: ['verify'],
      issuesByPerspective: issuesByPerspective(['verify']),
      evaluation: {
        ran: true,
        accepted: 0,
        rejected: 1,
        review: 1,
        files: [
          { file: 'src/app.ts', mode: 'file', action: 'reject', acceptedHunks: [], rejectedHunks: [], reviewHunks: [] },
          { file: 'src/other.ts', mode: 'hunks', acceptedHunks: [], rejectedHunks: [], reviewHunks: [1] },
        ],
      },
      previousReviewWasParallel: true,
    });

    expect(result.perspectives).toEqual([]);
    expect(result.dropped).toEqual(['verify']);
  });

  it('preserves stable initial ordering for active and dropped lists', () => {
    const result = selectNextReviewPerspectives({
      initialOrder: ['api', 'code', 'docs'],
      previousActive: ['code', 'docs', 'api'],
      issuesByPerspective: issuesByPerspective(['code', 'docs', 'api'], ['code']),
      evaluation: {
        ran: true,
        accepted: 1,
        rejected: 0,
        review: 0,
        files: [{ file: 'docs/guide.md', mode: 'file', action: 'accept', acceptedHunks: [], rejectedHunks: [], reviewHunks: [] }],
      },
      previousReviewWasParallel: true,
    });

    expect(result.perspectives).toEqual(['code', 'docs']);
    expect(result.dropped).toEqual(['api']);
  });

  it('uses previous active order when no explicit initial order exists', () => {
    const result = selectNextReviewPerspectives({
      initialOrder: [],
      previousActive: ['docs', 'code', 'api'],
      issuesByPerspective: issuesByPerspective(['docs', 'code', 'api'], ['code']),
      evaluation: {
        ran: true,
        accepted: 1,
        rejected: 0,
        review: 0,
        files: [{ file: 'docs/guide.md', mode: 'file', action: 'accept', acceptedHunks: [], rejectedHunks: [], reviewHunks: [] }],
      },
      previousReviewWasParallel: true,
    });

    expect(result.perspectives).toEqual(['docs', 'code']);
    expect(result.dropped).toEqual(['api']);
  });

  it('falls back to the previous active list when completion data is missing', () => {
    const result = selectNextReviewPerspectives({
      initialOrder: ['code', 'docs'],
      previousActive: ['code', 'docs'],
      issuesByPerspective: { code: [] },
      evaluation: cleanEvaluation,
      previousReviewWasParallel: true,
    });

    expect(result.fallback).toBe(true);
    expect(result.perspectives).toEqual(['code', 'docs']);
    expect(result.dropped).toEqual([]);
    expect(result.rationale).toMatch(/completion data was missing/i);
  });

  it('falls back to the previous active list when evaluation data is missing', () => {
    const result = selectNextReviewPerspectives({
      initialOrder: ['code', 'docs'],
      previousActive: ['code', 'docs'],
      issuesByPerspective: issuesByPerspective(['code', 'docs']),
      previousReviewWasParallel: true,
    });

    expect(result.fallback).toBe(true);
    expect(result.perspectives).toEqual(['code', 'docs']);
    expect(result.dropped).toEqual([]);
    expect(result.rationale).toMatch(/evaluation summary data was missing/i);
  });

  it('falls back to the previous active list when evaluation did not run', () => {
    const result = selectNextReviewPerspectives({
      initialOrder: ['code', 'docs'],
      previousActive: ['code', 'docs'],
      issuesByPerspective: issuesByPerspective(['code', 'docs']),
      evaluation: { ran: false, accepted: 0, rejected: 0, review: 0, files: [] },
      previousReviewWasParallel: true,
    });

    expect(result.fallback).toBe(true);
    expect(result.perspectives).toEqual(['code', 'docs']);
    expect(result.dropped).toEqual([]);
    expect(result.rationale).toMatch(/evaluation did not run/i);
  });

  it('falls back to the previous active list when verdict counts have no file summaries', () => {
    const result = selectNextReviewPerspectives({
      initialOrder: ['code', 'docs'],
      previousActive: ['code', 'docs'],
      issuesByPerspective: issuesByPerspective(['code', 'docs']),
      evaluation: { ran: true, accepted: 0, rejected: 1, review: 1, files: [] },
      previousReviewWasParallel: true,
    });

    expect(result.fallback).toBe(true);
    expect(result.perspectives).toEqual(['code', 'docs']);
    expect(result.dropped).toEqual([]);
    expect(result.rationale).toMatch(/file verdict summaries were missing/i);
  });

  it.each([
    ['the prior review was not parallel', { previousReviewWasParallel: false }],
    ['a perspective errored', { previousReviewWasParallel: true, perspectiveErrors: ['docs'] as ReviewPerspective[] }],
  ])('falls back to the previous active list when %s', (_label, overrides) => {
    const result = selectNextReviewPerspectives({
      initialOrder: ['code', 'docs'],
      previousActive: ['code', 'docs'],
      issuesByPerspective: issuesByPerspective(['code', 'docs']),
      evaluation: cleanEvaluation,
      previousReviewWasParallel: true,
      ...overrides,
    });

    expect(result.fallback).toBe(true);
    expect(result.perspectives).toEqual(['code', 'docs']);
    expect(result.dropped).toEqual([]);
    expect(result.rationale).toMatch(/Fallback/i);
  });
});
