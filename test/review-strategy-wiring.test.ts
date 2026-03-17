import { describe, it, expect } from 'vitest';
import type { ReviewIssue } from '../src/engine/events.js';
import { STRICTNESS_BLOCKS } from '../src/engine/agents/builder.js';
import { filterIssuesBySeverity } from '../src/engine/pipeline.js';

function makeIssue(severity: ReviewIssue['severity'], desc = `${severity} issue`): ReviewIssue {
  return {
    severity,
    category: 'test',
    file: 'test.ts',
    description: desc,
  };
}

// --- Issue severity filtering ---

describe('filterIssuesBySeverity', () => {
  it('returns all issues when autoAcceptBelow is undefined', () => {
    const issues = [makeIssue('critical'), makeIssue('warning'), makeIssue('suggestion')];
    const { filtered, autoAccepted } = filterIssuesBySeverity(issues, undefined);
    expect(filtered).toEqual(issues);
    expect(autoAccepted).toEqual([]);
  });

  it('auto-accepts suggestion issues when autoAcceptBelow is "suggestion"', () => {
    const critical = makeIssue('critical');
    const warning = makeIssue('warning');
    const suggestion = makeIssue('suggestion');
    const { filtered, autoAccepted } = filterIssuesBySeverity(
      [critical, warning, suggestion],
      'suggestion',
    );
    expect(filtered).toEqual([critical, warning]);
    expect(autoAccepted).toEqual([suggestion]);
  });

  it('auto-accepts warning and suggestion issues when autoAcceptBelow is "warning"', () => {
    const critical = makeIssue('critical');
    const warning = makeIssue('warning');
    const suggestion = makeIssue('suggestion');
    const { filtered, autoAccepted } = filterIssuesBySeverity(
      [critical, warning, suggestion],
      'warning',
    );
    expect(filtered).toEqual([critical]);
    expect(autoAccepted).toEqual([warning, suggestion]);
  });

  it('returns empty filtered array when all issues are below threshold', () => {
    const suggestion = makeIssue('suggestion');
    const { filtered, autoAccepted } = filterIssuesBySeverity([suggestion], 'suggestion');
    expect(filtered).toEqual([]);
    expect(autoAccepted).toEqual([suggestion]);
  });
});

// --- Evaluator strictness blocks ---

describe('STRICTNESS_BLOCKS', () => {
  it('strict block contains "high bar" text', () => {
    expect(STRICTNESS_BLOCKS['strict']).toContain('high bar');
  });

  it('lenient block contains "low bar" text', () => {
    expect(STRICTNESS_BLOCKS['lenient']).toContain('low bar');
  });

  it('standard block is empty string', () => {
    expect(STRICTNESS_BLOCKS['standard']).toBe('');
  });

  it('strict block mentions rejecting when in doubt', () => {
    expect(STRICTNESS_BLOCKS['strict']).toContain('When in doubt, reject');
  });

  it('lenient block mentions accepting when in doubt', () => {
    expect(STRICTNESS_BLOCKS['lenient']).toContain('When in doubt, accept');
  });
});
