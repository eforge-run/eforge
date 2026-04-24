import { describe, it, expect } from 'vitest';
import type { EforgeEvent, TestIssue } from '@eforge-build/engine/events';
import { StubHarness } from './stub-harness.js';
import { collectEvents, findEvent } from './test-events.js';
import { runTestWriter, runTester } from '@eforge-build/engine/agents/tester';
import { parseTestIssues, testIssueToReviewIssue } from '@eforge-build/engine/agents/common';
import type { BuildStageSpec } from '@eforge-build/engine/config';

// ---------------------------------------------------------------------------
// parseTestIssues
// ---------------------------------------------------------------------------

describe('parseTestIssues', () => {
  it('parses well-formed XML with multiple issues', () => {
    const xml = `<test-issues>
  <issue severity="critical" category="production-bug" file="src/foo.ts" testFile="test/foo.test.ts">
    Memory leak in handler
    <test-output>Error: heap exceeded</test-output>
    <fix>Use WeakRef</fix>
  </issue>
  <issue severity="warning" category="missing-behavior" file="src/bar.ts" testFile="test/bar.test.ts">
    Missing null check
  </issue>
</test-issues>`;

    const issues = parseTestIssues(xml);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      severity: 'critical',
      category: 'production-bug',
      file: 'src/foo.ts',
      testFile: 'test/foo.test.ts',
      description: 'Memory leak in handler',
      testOutput: 'Error: heap exceeded',
      fix: 'Use WeakRef',
    });
    expect(issues[1]).toMatchObject({
      severity: 'warning',
      category: 'missing-behavior',
      file: 'src/bar.ts',
      testFile: 'test/bar.test.ts',
      description: 'Missing null check',
    });
    expect(issues[1].testOutput).toBeUndefined();
    expect(issues[1].fix).toBeUndefined();
  });

  it('returns empty array when no test-issues block is present', () => {
    const text = 'All tests pass. No issues found.';
    expect(parseTestIssues(text)).toEqual([]);
  });

  it('handles malformed XML gracefully', () => {
    // Missing required attributes — should be skipped
    const xml = `<test-issues>
  <issue severity="critical" file="src/a.ts">Missing category and testFile</issue>
  <issue severity="invalid" category="production-bug" file="src/b.ts" testFile="test/b.test.ts">Invalid severity</issue>
</test-issues>`;

    const issues = parseTestIssues(xml);
    expect(issues).toEqual([]);
  });

  it('parses issues with optional fix and test-output children', () => {
    const xmlWithBoth = `<test-issues>
  <issue severity="critical" category="regression" file="src/a.ts" testFile="test/a.test.ts">
    Regression in handler
    <test-output>Expected 1, got 2</test-output>
    <fix>Restore original logic</fix>
  </issue>
</test-issues>`;

    const xmlWithNeither = `<test-issues>
  <issue severity="warning" category="production-bug" file="src/b.ts" testFile="test/b.test.ts">
    Edge case not handled
  </issue>
</test-issues>`;

    const withBoth = parseTestIssues(xmlWithBoth);
    expect(withBoth).toHaveLength(1);
    expect(withBoth[0].testOutput).toBe('Expected 1, got 2');
    expect(withBoth[0].fix).toBe('Restore original logic');

    const withNeither = parseTestIssues(xmlWithNeither);
    expect(withNeither).toHaveLength(1);
    expect(withNeither[0].testOutput).toBeUndefined();
    expect(withNeither[0].fix).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// testIssueToReviewIssue
// ---------------------------------------------------------------------------

describe('testIssueToReviewIssue', () => {
  it('converts TestIssue to ReviewIssue, dropping test-specific fields', () => {
    const testIssue: TestIssue = {
      severity: 'critical',
      category: 'production-bug',
      file: 'src/handler.ts',
      testFile: 'test/handler.test.ts',
      description: 'Null pointer in handler',
      testOutput: 'TypeError: cannot read property',
      fix: 'Add null guard',
    };

    const reviewIssue = testIssueToReviewIssue(testIssue);
    expect(reviewIssue).toEqual({
      severity: 'critical',
      category: 'production-bug',
      file: 'src/handler.ts',
      description: 'Null pointer in handler',
      fix: 'Add null guard',
    });
    // testFile and testOutput should not be present
    expect(reviewIssue).not.toHaveProperty('testFile');
    expect(reviewIssue).not.toHaveProperty('testOutput');
  });
});

// ---------------------------------------------------------------------------
// runTestWriter
// ---------------------------------------------------------------------------

describe('runTestWriter wiring', () => {
  it('yields start/complete lifecycle events with parsed test count', async () => {
    const backend = new StubHarness([{
      text: 'Tests written.\n<test-write-summary count="3">',
    }]);

    const events = await collectEvents(runTestWriter({
      harness: backend,
      cwd: '/tmp',
      planId: 'plan-1',
      planContent: 'Test plan content',
    }));

    const start = findEvent(events, 'plan:build:test:write:start');
    expect(start).toBeDefined();
    expect(start!.planId).toBe('plan-1');

    const complete = findEvent(events, 'plan:build:test:write:complete');
    expect(complete).toBeDefined();
    expect(complete!.planId).toBe('plan-1');
    expect(complete!.testsWritten).toBe(3);
  });

  it('defaults testsWritten to 0 when no summary block is present', async () => {
    const backend = new StubHarness([{
      text: 'Did some work but no summary block.',
    }]);

    const events = await collectEvents(runTestWriter({
      harness: backend,
      cwd: '/tmp',
      planId: 'plan-1',
      planContent: 'Test plan content',
    }));

    const complete = findEvent(events, 'plan:build:test:write:complete');
    expect(complete).toBeDefined();
    expect(complete!.testsWritten).toBe(0);
  });

  it('is non-fatal on error — still yields complete event', async () => {
    const backend = new StubHarness([{ error: new Error('Test writer crashed') }]);

    const events = await collectEvents(runTestWriter({
      harness: backend,
      cwd: '/tmp',
      planId: 'plan-1',
      planContent: 'Test plan content',
    }));

    const complete = findEvent(events, 'plan:build:test:write:complete');
    expect(complete).toBeDefined();
    expect(complete!.testsWritten).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runTester
// ---------------------------------------------------------------------------

describe('runTester wiring', () => {
  it('yields start/complete lifecycle with parsed issues and summary', async () => {
    const backend = new StubHarness([{
      text: `<test-issues>
  <issue severity="critical" category="production-bug" file="src/foo.ts" testFile="test/foo.test.ts">
    Bug found in foo
  </issue>
</test-issues>
<test-summary passed="4" failed="1" test_bugs_fixed="2">`,
    }]);

    const events = await collectEvents(runTester({
      harness: backend,
      cwd: '/tmp',
      planId: 'plan-1',
      planContent: 'Test plan content',
    }));

    const start = findEvent(events, 'plan:build:test:start');
    expect(start).toBeDefined();
    expect(start!.planId).toBe('plan-1');

    const complete = findEvent(events, 'plan:build:test:complete');
    expect(complete).toBeDefined();
    expect(complete!.passed).toBe(4);
    expect(complete!.failed).toBe(1);
    expect(complete!.testBugsFixed).toBe(2);
    expect(complete!.productionIssues).toHaveLength(1);
    expect(complete!.productionIssues[0].file).toBe('src/foo.ts');
  });

  it('handles empty test issues', async () => {
    const backend = new StubHarness([{
      text: '<test-issues></test-issues>\n<test-summary passed="5" failed="0" test_bugs_fixed="0">',
    }]);

    const events = await collectEvents(runTester({
      harness: backend,
      cwd: '/tmp',
      planId: 'plan-1',
      planContent: 'Test plan content',
    }));

    const complete = findEvent(events, 'plan:build:test:complete');
    expect(complete).toBeDefined();
    expect(complete!.passed).toBe(5);
    expect(complete!.failed).toBe(0);
    expect(complete!.testBugsFixed).toBe(0);
    expect(complete!.productionIssues).toEqual([]);
  });

  it('is non-fatal on error — still yields complete event with zeroed counts', async () => {
    const backend = new StubHarness([{ error: new Error('Tester crashed') }]);

    const events = await collectEvents(runTester({
      harness: backend,
      cwd: '/tmp',
      planId: 'plan-1',
      planContent: 'Test plan content',
    }));

    const complete = findEvent(events, 'plan:build:test:complete');
    expect(complete).toBeDefined();
    expect(complete!.passed).toBe(0);
    expect(complete!.failed).toBe(0);
    expect(complete!.testBugsFixed).toBe(0);
    expect(complete!.productionIssues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Verification scope detection (hasTestStages logic)
// ---------------------------------------------------------------------------

describe('verification scope detection', () => {
  // hasTestStages is a private function in pipeline.ts, so we test the logic inline.
  // The function checks whether any build stage spec starts with 'test'.
  function hasTestStages(build: BuildStageSpec[]): boolean {
    return build.some((spec) => {
      if (Array.isArray(spec)) return spec.some((s) => s.startsWith('test'));
      return spec.startsWith('test');
    });
  }

  it('returns true when build includes test-cycle', () => {
    expect(hasTestStages(['implement', 'test-cycle', 'review-cycle'])).toBe(true);
  });

  it('returns true when test stages are in a parallel group', () => {
    expect(hasTestStages([['implement', 'test-write'], 'test-cycle', 'review-cycle'])).toBe(true);
  });

  it('returns false when build has no test stages', () => {
    expect(hasTestStages(['implement', 'review-cycle'])).toBe(false);
  });

  it('returns false for empty build', () => {
    expect(hasTestStages([])).toBe(false);
  });
});
