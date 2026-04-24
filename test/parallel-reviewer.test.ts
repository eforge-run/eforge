import { describe, it, expect } from 'vitest';
import type { ReviewIssue } from '@eforge-build/engine/events';
import { StubHarness } from './stub-harness.js';
import { collectEvents, findEvent, filterEvents } from './test-events.js';
import { deduplicateIssues } from '@eforge-build/engine/agents/parallel-reviewer';
import { runReviewFixer } from '@eforge-build/engine/agents/review-fixer';

describe('deduplicateIssues', () => {
  it('removes exact duplicates keeping highest severity', () => {
    const issues: ReviewIssue[] = [
      { severity: 'warning', category: 'types', file: 'a.ts', line: 10, description: 'Unsafe cast' },
      { severity: 'critical', category: 'security', file: 'a.ts', line: 10, description: 'Unsafe cast' },
    ];

    const result = deduplicateIssues(issues);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('critical');
  });

  it('keeps distinct issues from different files', () => {
    const issues: ReviewIssue[] = [
      { severity: 'warning', category: 'bugs', file: 'a.ts', line: 10, description: 'Bug found' },
      { severity: 'warning', category: 'bugs', file: 'b.ts', line: 10, description: 'Bug found' },
    ];

    const result = deduplicateIssues(issues);
    expect(result).toHaveLength(2);
  });

  it('keeps issues with different lines in the same file', () => {
    const issues: ReviewIssue[] = [
      { severity: 'warning', category: 'bugs', file: 'a.ts', line: 10, description: 'Same desc' },
      { severity: 'warning', category: 'bugs', file: 'a.ts', line: 20, description: 'Same desc' },
    ];

    const result = deduplicateIssues(issues);
    expect(result).toHaveLength(2);
  });

  it('keeps issues with different descriptions at the same location', () => {
    const issues: ReviewIssue[] = [
      { severity: 'warning', category: 'bugs', file: 'a.ts', line: 10, description: 'Issue one' },
      { severity: 'warning', category: 'security', file: 'a.ts', line: 10, description: 'Issue two' },
    ];

    const result = deduplicateIssues(issues);
    expect(result).toHaveLength(2);
  });

  it('handles empty input', () => {
    expect(deduplicateIssues([])).toEqual([]);
  });

  it('handles issues without line numbers', () => {
    const issues: ReviewIssue[] = [
      { severity: 'suggestion', category: 'dry', file: 'a.ts', description: 'Extract method' },
      { severity: 'warning', category: 'dry', file: 'a.ts', description: 'Extract method' },
    ];

    const result = deduplicateIssues(issues);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('warning');
  });
});

describe('runReviewFixer', () => {
  it('emits fix start and complete events', async () => {
    const backend = new StubHarness([{ text: 'Fixed all issues.' }]);

    const issues: ReviewIssue[] = [
      { severity: 'critical', category: 'bugs', file: 'a.ts', line: 10, description: 'Null pointer', fix: 'Add null check' },
    ];

    const events = await collectEvents(
      runReviewFixer({
        harness: backend,
        planId: 'plan-01',
        cwd: '/tmp/test',
        issues,
      }),
    );

    const fixStart = findEvent(events, 'plan:build:review:fix:start');
    expect(fixStart).toBeDefined();
    expect(fixStart!.planId).toBe('plan-01');
    expect(fixStart!.issueCount).toBe(1);

    const fixComplete = findEvent(events, 'plan:build:review:fix:complete');
    expect(fixComplete).toBeDefined();
    expect(fixComplete!.planId).toBe('plan-01');
  });

  it('runs with coding tools', async () => {
    const backend = new StubHarness([{ text: 'Done.' }]);

    await collectEvents(
      runReviewFixer({
        harness: backend,
        planId: 'plan-01',
        cwd: '/tmp/test',
        issues: [{ severity: 'warning', category: 'bugs', file: 'a.ts', description: 'Issue' }],
      }),
    );

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0].tools).toBe('coding');
  });

  it('uses review-fixer agent role', async () => {
    const backend = new StubHarness([{ text: 'Done.' }]);

    const events = await collectEvents(
      runReviewFixer({
        harness: backend,
        planId: 'plan-01',
        cwd: '/tmp/test',
        issues: [{ severity: 'warning', category: 'bugs', file: 'a.ts', description: 'Issue' }],
      }),
    );

    const agentStart = findEvent(events, 'agent:start');
    expect(agentStart).toBeDefined();
    expect(agentStart!.agent).toBe('review-fixer');
  });

  it('survives backend errors gracefully', async () => {
    const backend = new StubHarness([{ error: new Error('Backend failed') }]);

    // Should not throw — review fixer errors are non-fatal
    const events = await collectEvents(
      runReviewFixer({
        harness: backend,
        planId: 'plan-01',
        cwd: '/tmp/test',
        issues: [{ severity: 'warning', category: 'bugs', file: 'a.ts', description: 'Issue' }],
      }),
    );

    // Should still emit fix:start and fix:complete
    expect(findEvent(events, 'plan:build:review:fix:start')).toBeDefined();
    expect(findEvent(events, 'plan:build:review:fix:complete')).toBeDefined();
  });
});
