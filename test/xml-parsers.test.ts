import { describe, it, expect } from 'vitest';
import { parseClarificationBlocks, parseSkipBlock, parseModulesBlock, parseStalenessBlock } from '../src/engine/agents/common.js';
import { parseReviewIssues } from '../src/engine/agents/reviewer.js';
import { parseEvaluationBlock } from '../src/engine/agents/common.js';
import { formatPriorClarifications } from '../src/engine/agents/planner.js';

describe('parseClarificationBlocks', () => {
  it('parses a single question with all attributes', () => {
    const text = `
<clarification>
  <question id="q1" default="PostgreSQL">
    Which database?
    <context>We need migrations</context>
    <option>Prisma</option>
    <option>Drizzle</option>
  </question>
</clarification>`;

    const result = parseClarificationBlocks(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 'q1',
      question: 'Which database?',
      default: 'PostgreSQL',
      context: 'We need migrations',
      options: ['Prisma', 'Drizzle'],
    });
  });

  it('parses multiple questions in one block', () => {
    const text = `
<clarification>
  <question id="q1">First?</question>
  <question id="q2">Second?</question>
</clarification>`;

    const result = parseClarificationBlocks(text);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('q1');
    expect(result[1].id).toBe('q2');
  });

  it('merges questions from multiple blocks', () => {
    const text = `
<clarification>
  <question id="q1">First?</question>
</clarification>
Some text in between
<clarification>
  <question id="q2">Second?</question>
</clarification>`;

    const result = parseClarificationBlocks(text);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('q1');
    expect(result[1].id).toBe('q2');
  });

  it('returns empty array when no blocks present', () => {
    expect(parseClarificationBlocks('just plain text')).toEqual([]);
  });

  it('skips questions missing id attribute', () => {
    const text = `
<clarification>
  <question>No id here</question>
  <question id="valid">Has id</question>
</clarification>`;

    const result = parseClarificationBlocks(text);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('valid');
  });

  it('ignores surrounding text outside blocks', () => {
    const text = `Here is some preamble.
<clarification>
  <question id="q1">Question?</question>
</clarification>
And some trailing text.`;

    const result = parseClarificationBlocks(text);
    expect(result).toHaveLength(1);
    expect(result[0].question).toBe('Question?');
  });

  it('strips inner tags from question text', () => {
    const text = `
<clarification>
  <question id="q1">
    What ORM?
    <context>Need migrations</context>
    <option>Prisma</option>
  </question>
</clarification>`;

    const result = parseClarificationBlocks(text);
    expect(result[0].question).toBe('What ORM?');
    expect(result[0].context).toBe('Need migrations');
    expect(result[0].options).toEqual(['Prisma']);
  });

  it('omits optional fields when not present', () => {
    const text = `
<clarification>
  <question id="q1">Simple question</question>
</clarification>`;

    const result = parseClarificationBlocks(text);
    expect(result[0]).toEqual({ id: 'q1', question: 'Simple question' });
    expect(result[0].context).toBeUndefined();
    expect(result[0].options).toBeUndefined();
    expect(result[0].default).toBeUndefined();
  });
});

describe('parseSkipBlock', () => {
  it('parses a valid skip block', () => {
    const text = '<skip>Already implemented in a previous PR.</skip>';
    const result = parseSkipBlock(text);
    expect(result).toBe('Already implemented in a previous PR.');
  });

  it('returns null when no skip block present', () => {
    expect(parseSkipBlock('just plain text')).toBeNull();
  });

  it('returns null for empty content', () => {
    const text = '<skip>   </skip>';
    expect(parseSkipBlock(text)).toBeNull();
  });

  it('ignores surrounding text', () => {
    const text = `Here is some preamble.
<skip>Feature already exists in codebase.</skip>
And trailing text.`;

    const result = parseSkipBlock(text);
    expect(result).toBe('Feature already exists in codebase.');
  });
});

describe('parseModulesBlock', () => {
  it('parses modules with dependencies', () => {
    const text = `
<modules>
  <module id="foundation" depends_on="">Core types and utilities</module>
  <module id="auth" depends_on="foundation">Authentication system</module>
  <module id="api" depends_on="foundation,auth">API endpoints</module>
</modules>`;

    const result = parseModulesBlock(text);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ id: 'foundation', description: 'Core types and utilities', dependsOn: [] });
    expect(result[1]).toEqual({ id: 'auth', description: 'Authentication system', dependsOn: ['foundation'] });
    expect(result[2]).toEqual({ id: 'api', description: 'API endpoints', dependsOn: ['foundation', 'auth'] });
  });

  it('returns empty array when no block present', () => {
    expect(parseModulesBlock('no modules here')).toEqual([]);
  });

  it('skips modules missing id', () => {
    const text = `
<modules>
  <module depends_on="">No id</module>
  <module id="valid" depends_on="">Has id</module>
</modules>`;

    const result = parseModulesBlock(text);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('valid');
  });

  it('skips modules with empty description', () => {
    const text = `
<modules>
  <module id="empty" depends_on="">   </module>
  <module id="valid" depends_on="">Has description</module>
</modules>`;

    const result = parseModulesBlock(text);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('valid');
  });

  it('handles missing depends_on attribute', () => {
    const text = `
<modules>
  <module id="standalone">Independent module</module>
</modules>`;

    const result = parseModulesBlock(text);
    expect(result).toHaveLength(1);
    expect(result[0].dependsOn).toEqual([]);
  });

  it('ignores surrounding text', () => {
    const text = `Here is some analysis.
<modules>
  <module id="core" depends_on="">Core module</module>
</modules>
And some trailing text.`;

    const result = parseModulesBlock(text);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('core');
  });
});

describe('parseReviewIssues', () => {
  it('parses issue with all required attributes', () => {
    const text = `
<review-issues>
  <issue severity="critical" category="bug" file="src/app.ts">Memory leak in handler</issue>
</review-issues>`;

    const result = parseReviewIssues(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      severity: 'critical',
      category: 'bug',
      file: 'src/app.ts',
      description: 'Memory leak in handler',
    });
  });

  it('parses optional line and fix', () => {
    const text = `
<review-issues>
  <issue severity="warning" category="perf" file="src/db.ts" line="42">
    Slow query
    <fix>Add index on user_id</fix>
  </issue>
</review-issues>`;

    const result = parseReviewIssues(text);
    expect(result).toHaveLength(1);
    expect(result[0].line).toBe(42);
    expect(result[0].fix).toBe('Add index on user_id');
    expect(result[0].description).toBe('Slow query');
  });

  it('skips issues with invalid severity', () => {
    const text = `
<review-issues>
  <issue severity="info" category="style" file="src/a.ts">Minor thing</issue>
  <issue severity="warning" category="style" file="src/b.ts">Valid one</issue>
</review-issues>`;

    const result = parseReviewIssues(text);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('warning');
  });

  it('skips issues with missing required attributes', () => {
    const text = `
<review-issues>
  <issue severity="critical" file="src/a.ts">Missing category</issue>
  <issue severity="critical" category="bug">Missing file</issue>
  <issue category="bug" file="src/a.ts">Missing severity</issue>
</review-issues>`;

    const result = parseReviewIssues(text);
    expect(result).toHaveLength(0);
  });

  it('skips issues with empty description', () => {
    const text = `
<review-issues>
  <issue severity="critical" category="bug" file="src/a.ts">   </issue>
</review-issues>`;

    const result = parseReviewIssues(text);
    expect(result).toHaveLength(0);
  });

  it('merges issues from multiple blocks', () => {
    const text = `
<review-issues>
  <issue severity="critical" category="bug" file="a.ts">Issue 1</issue>
</review-issues>
<review-issues>
  <issue severity="warning" category="perf" file="b.ts">Issue 2</issue>
</review-issues>`;

    const result = parseReviewIssues(text);
    expect(result).toHaveLength(2);
  });

  it('returns empty array for no XML', () => {
    expect(parseReviewIssues('plain text, no XML')).toEqual([]);
  });

  it('ignores non-numeric line attribute', () => {
    const text = `
<review-issues>
  <issue severity="suggestion" category="style" file="a.ts" line="abc">Use const</issue>
</review-issues>`;

    const result = parseReviewIssues(text);
    expect(result).toHaveLength(1);
    expect(result[0].line).toBeUndefined();
  });
});

describe('formatPriorClarifications', () => {
  it('returns empty string for empty input', () => {
    expect(formatPriorClarifications([])).toBe('');
  });

  it('returns empty string when no answers match questions', () => {
    const result = formatPriorClarifications([{
      questions: [{ id: 'q1', question: 'What DB?' }],
      answers: { q2: 'irrelevant' },
    }]);
    expect(result).toBe('');
  });

  it('formats a single round of Q&A', () => {
    const result = formatPriorClarifications([{
      questions: [
        { id: 'q1', question: 'What database?' },
        { id: 'q2', question: 'Which ORM?' },
      ],
      answers: { q1: 'PostgreSQL', q2: 'Drizzle' },
    }]);

    expect(result).toContain('## Prior Clarifications');
    expect(result).toContain('Do NOT re-ask');
    expect(result).toContain('| q1: What database? | PostgreSQL |');
    expect(result).toContain('| q2: Which ORM? | Drizzle |');
  });

  it('escapes pipe characters in questions and answers', () => {
    const result = formatPriorClarifications([{
      questions: [{ id: 'q1', question: 'PostgreSQL | MySQL?' }],
      answers: { q1: 'PostgreSQL | with extensions' },
    }]);

    expect(result).toContain('| q1: PostgreSQL \\| MySQL? | PostgreSQL \\| with extensions |');
  });

  it('accumulates multiple clarification rounds', () => {
    const result = formatPriorClarifications([
      {
        questions: [{ id: 'q1', question: 'First?' }],
        answers: { q1: 'yes' },
      },
      {
        questions: [{ id: 'q2', question: 'Second?' }],
        answers: { q2: 'no' },
      },
    ]);

    expect(result).toContain('| q1: First? | yes |');
    expect(result).toContain('| q2: Second? | no |');
  });
});

describe('parseEvaluationBlock', () => {
  it('parses accept verdict', () => {
    const text = `
<evaluation>
  <verdict file="src/app.ts" action="accept">Good change</verdict>
</evaluation>`;

    const result = parseEvaluationBlock(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ file: 'src/app.ts', action: 'accept', reason: 'Good change' });
  });

  it('parses reject verdict', () => {
    const text = `
<evaluation>
  <verdict file="src/app.ts" action="reject">Breaks API</verdict>
</evaluation>`;

    const result = parseEvaluationBlock(text);
    expect(result[0].action).toBe('reject');
  });

  it('parses review verdict', () => {
    const text = `
<evaluation>
  <verdict file="src/app.ts" action="review">Needs discussion</verdict>
</evaluation>`;

    const result = parseEvaluationBlock(text);
    expect(result[0].action).toBe('review');
  });

  it('skips verdicts with invalid action', () => {
    const text = `
<evaluation>
  <verdict file="a.ts" action="maybe">Unsure</verdict>
  <verdict file="b.ts" action="accept">Valid</verdict>
</evaluation>`;

    const result = parseEvaluationBlock(text);
    expect(result).toHaveLength(1);
    expect(result[0].action).toBe('accept');
  });

  it('skips verdicts with missing attributes', () => {
    const text = `
<evaluation>
  <verdict action="accept">Missing file</verdict>
  <verdict file="a.ts">Missing action</verdict>
</evaluation>`;

    const result = parseEvaluationBlock(text);
    expect(result).toHaveLength(0);
  });

  it('returns empty array when no block present', () => {
    expect(parseEvaluationBlock('no evaluation here')).toEqual([]);
  });

  it('merges verdicts from multiple blocks', () => {
    const text = `
<evaluation>
  <verdict file="a.ts" action="accept">Ok</verdict>
</evaluation>
<evaluation>
  <verdict file="b.ts" action="reject">Bad</verdict>
</evaluation>`;

    const result = parseEvaluationBlock(text);
    expect(result).toHaveLength(2);
  });

  it('parses verdict with all 5 structured evidence elements', () => {
    const text = `
<evaluation>
  <verdict file="src/app.ts" action="accept">
    <staged>Implements the handler with string concatenation</staged>
    <fix>Replaces string concat with template literal</fix>
    <rationale>Template literal prevents injection when input contains special chars</rationale>
    <if-accepted>Handler safely interpolates user input</if-accepted>
    <if-rejected>String concat remains vulnerable to format-breaking input</if-rejected>
  </verdict>
</evaluation>`;

    const result = parseEvaluationBlock(text);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('src/app.ts');
    expect(result[0].action).toBe('accept');
    expect(result[0].evidence).toBeDefined();
    expect(result[0].evidence!.staged).toBe('Implements the handler with string concatenation');
    expect(result[0].evidence!.fix).toBe('Replaces string concat with template literal');
    expect(result[0].evidence!.rationale).toBe('Template literal prevents injection when input contains special chars');
    expect(result[0].evidence!.ifAccepted).toBe('Handler safely interpolates user input');
    expect(result[0].evidence!.ifRejected).toBe('String concat remains vulnerable to format-breaking input');
  });

  it('parses verdict with <original> tag (plan-evaluator format)', () => {
    const text = `
<evaluation>
  <verdict file="plans/v1/plan-01.md" action="reject">
    <original>Plan specifies Prisma as ORM</original>
    <fix>Reviewer changed ORM to Drizzle</fix>
    <rationale>This alters the planner's architectural decision</rationale>
    <if-accepted>ORM choice changes from Prisma to Drizzle</if-accepted>
    <if-rejected>Plan retains Prisma as originally chosen</if-rejected>
  </verdict>
</evaluation>`;

    const result = parseEvaluationBlock(text);
    expect(result).toHaveLength(1);
    expect(result[0].evidence).toBeDefined();
    expect(result[0].evidence!.staged).toBe('Plan specifies Prisma as ORM');
  });

  it('returns undefined evidence and populated reason for plain-text verdict', () => {
    const text = `
<evaluation>
  <verdict file="src/utils.ts" action="accept">Simple plain text reason</verdict>
</evaluation>`;

    const result = parseEvaluationBlock(text);
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe('Simple plain text reason');
    expect(result[0].evidence).toBeUndefined();
  });

  it('extracts hunk attribute from verdict', () => {
    const text = `
<evaluation>
  <verdict file="src/handler.ts" hunk="2" action="reject">
    <staged>Handler processes input in hunk 2</staged>
    <fix>Reviewer refactored error handling</fix>
    <rationale>Changes the error handling strategy</rationale>
    <if-accepted>Error handling changes</if-accepted>
    <if-rejected>Original error handling preserved</if-rejected>
  </verdict>
</evaluation>`;

    const result = parseEvaluationBlock(text);
    expect(result).toHaveLength(1);
    expect(result[0].hunk).toBe(2);
  });

  it('returns undefined hunk for verdicts without hunk attribute', () => {
    const text = `
<evaluation>
  <verdict file="src/app.ts" action="accept">No hunk here</verdict>
</evaluation>`;

    const result = parseEvaluationBlock(text);
    expect(result).toHaveLength(1);
    expect(result[0].hunk).toBeUndefined();
  });
});

describe('parseStalenessBlock', () => {
  it('parses proceed verdict', () => {
    const text = '<staleness verdict="proceed">PRD is still relevant.</staleness>';
    const result = parseStalenessBlock(text);
    expect(result).toEqual({
      verdict: 'proceed',
      justification: 'PRD is still relevant.',
    });
  });

  it('parses revise verdict with revision content', () => {
    const text = '<staleness verdict="revise">API changed.<revision>Updated PRD content here.</revision></staleness>';
    const result = parseStalenessBlock(text);
    expect(result).toEqual({
      verdict: 'revise',
      justification: 'API changed.',
      revision: 'Updated PRD content here.',
    });
  });

  it('parses obsolete verdict', () => {
    const text = '<staleness verdict="obsolete">Feature was already built.</staleness>';
    const result = parseStalenessBlock(text);
    expect(result).toEqual({
      verdict: 'obsolete',
      justification: 'Feature was already built.',
    });
  });

  it('returns null when no staleness block present', () => {
    expect(parseStalenessBlock('just plain text')).toBeNull();
  });

  it('returns null for malformed verdict (not proceed/revise/obsolete)', () => {
    const text = '<staleness verdict="maybe">Unsure about this.</staleness>';
    expect(parseStalenessBlock(text)).toBeNull();
  });

  it('returns null for empty justification', () => {
    const text = '<staleness verdict="proceed">   </staleness>';
    expect(parseStalenessBlock(text)).toBeNull();
  });
});
