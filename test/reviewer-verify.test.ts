/**
 * Unit tests for the verify reviewer perspective wiring.
 * Tests: schema YAML generation, prompt variable rendering, issue parsing.
 */

import { describe, it, expect } from 'vitest';
import type { ReviewIssue } from '@eforge-build/engine/events';
import { StubHarness } from './stub-harness.js';
import { collectEvents, findEvent } from './test-events.js';
import { getVerifyReviewIssueSchemaYaml, verifyReviewIssueSchema } from '@eforge-build/engine/schemas';
import { runParallelReview } from '@eforge-build/engine/agents/parallel-reviewer';
import { safeParseWithSchema } from '@eforge-build/client';

// ---------------------------------------------------------------------------
// Schema YAML
// ---------------------------------------------------------------------------

describe('getVerifyReviewIssueSchemaYaml', () => {
  it('generates non-empty YAML', () => {
    const yaml = getVerifyReviewIssueSchemaYaml();
    expect(yaml.length).toBeGreaterThan(0);
  });

  it('constrains severity to critical only', () => {
    const yaml = getVerifyReviewIssueSchemaYaml();
    expect(yaml).toContain('critical');
    // warning and suggestion should not appear as enum values for severity
    // (they may appear in description text, but the enum should be single-valued)
  });

  it('constrains category to verification-failure only', () => {
    const yaml = getVerifyReviewIssueSchemaYaml();
    expect(yaml).toContain('verification-failure');
  });

  it('returns cached result on subsequent calls', () => {
    const first = getVerifyReviewIssueSchemaYaml();
    const second = getVerifyReviewIssueSchemaYaml();
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// verifyReviewIssueSchema
// ---------------------------------------------------------------------------

describe('verifyReviewIssueSchema', () => {
  it('accepts a valid verify issue', () => {
    const result = safeParseWithSchema(verifyReviewIssueSchema, {
      severity: 'critical',
      category: 'verification-failure',
      file: '.',
      description: 'Command `pnpm type-check` failed with exit code 1.',
      fix: 'Command: pnpm type-check\nExit code: 1\nstderr: error TS2345',
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-critical severity', () => {
    const result = safeParseWithSchema(verifyReviewIssueSchema, {
      severity: 'warning',
      category: 'verification-failure',
      file: '.',
      description: 'Some issue',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-verification-failure category', () => {
    const result = safeParseWithSchema(verifyReviewIssueSchema, {
      severity: 'critical',
      category: 'bugs',
      file: '.',
      description: 'Some issue',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runParallelReview with verify perspective
// ---------------------------------------------------------------------------

describe('runParallelReview with verify perspective', () => {
  it('dispatches to reviewer-verify prompt when verify perspective is requested', async () => {
    // The stub harness returns a verify failure issue
    const failureIssue = `<review-issues>
  <issue severity="critical" category="verification-failure" file=".">
    Command \`pnpm type-check\` failed with exit code 1.
    <fix>Command: pnpm type-check
Exit code: 1
stderr: error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.</fix>
  </issue>
</review-issues>`;

    const backend = new StubHarness([{ text: failureIssue }]);

    const events = await collectEvents(
      runParallelReview({
        harness: backend,
        planContent: '# Plan\n\nSome plan.\n\n## Verification\n\n- [ ] `pnpm type-check`',
        baseBranch: 'main',
        planId: 'plan-01-test',
        cwd: '/tmp',
        strategy: 'parallel',
        perspectives: ['verify'],
      }),
    );

    // Should emit review lifecycle events
    expect(findEvent(events, 'plan:build:review:start')).toBeDefined();
    expect(findEvent(events, 'plan:build:review:complete')).toBeDefined();
    expect(findEvent(events, 'plan:build:review:parallel:start')).toBeDefined();

    // The stub should have been called once (for the verify perspective)
    expect(backend.prompts).toHaveLength(1);

    // The prompt should contain verify-specific content from reviewer-verify.md
    const prompt = backend.prompts[0];
    expect(prompt).toContain('verification specialist');
    expect(prompt).toContain('verification-failure');
    expect(prompt).toContain('subprocess commands');

    // The complete event should carry the parsed issue
    const complete = findEvent(events, 'plan:build:review:complete');
    expect(complete).toBeDefined();
    expect(complete!.issues).toHaveLength(1);
    const issue = complete!.issues[0] as ReviewIssue;
    expect(issue.severity).toBe('critical');
    expect(issue.category).toBe('verification-failure');
    expect(issue.fix).toContain('pnpm type-check');
    expect(issue.fix).toContain('Exit code: 1');
  });

  it('includes plan content and review issue schema in the verify prompt', async () => {
    const planContent = '# My Plan\n\nDo some work.\n\n## Verification\n\n- [ ] `pnpm build`';
    const backend = new StubHarness([{ text: '<review-issues></review-issues>' }]);

    await collectEvents(
      runParallelReview({
        harness: backend,
        planContent,
        baseBranch: 'feature-branch',
        planId: 'plan-02',
        cwd: '/tmp',
        strategy: 'parallel',
        perspectives: ['verify'],
      }),
    );

    expect(backend.prompts).toHaveLength(1);
    const prompt = backend.prompts[0];

    // {{plan_content}} should be substituted with the plan body
    expect(prompt).toContain('My Plan');
    expect(prompt).toContain('pnpm build');

    // {{base_branch}} should be substituted
    expect(prompt).toContain('feature-branch');

    // {{review_issue_schema}} should be substituted with YAML (verification-failure appears in schema)
    expect(prompt).toContain('verification-failure');
  });

  it('emits empty issues when verify agent finds no failures', async () => {
    const backend = new StubHarness([{ text: '<review-issues></review-issues>' }]);

    const events = await collectEvents(
      runParallelReview({
        harness: backend,
        planContent: '# Plan\n\n## Verification\n\n- [ ] `pnpm build`',
        baseBranch: 'main',
        planId: 'plan-03',
        cwd: '/tmp',
        strategy: 'parallel',
        perspectives: ['verify'],
      }),
    );

    const complete = findEvent(events, 'plan:build:review:complete');
    expect(complete).toBeDefined();
    expect(complete!.issues).toHaveLength(0);
  });
});
