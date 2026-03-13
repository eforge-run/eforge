import { describe, it, expect } from 'vitest';
import { parseClarificationBlocks } from '../src/engine/agents/common.js';
import { parseReviewIssues } from '../src/engine/agents/reviewer.js';
import { parseEvaluationBlock } from '../src/engine/agents/builder.js';

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
});
