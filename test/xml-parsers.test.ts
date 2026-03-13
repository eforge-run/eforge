import { describe, it, expect } from 'vitest';
import { parseClarificationBlocks, parseScopeBlock, parseModulesBlock } from '../src/engine/agents/common.js';
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

describe('parseScopeBlock', () => {
  it('parses a valid errand scope', () => {
    const text = `
<scope assessment="errand">
  Adding a single CLI flag — one area, no migrations.
</scope>`;

    const result = parseScopeBlock(text);
    expect(result).toEqual({
      assessment: 'errand',
      justification: 'Adding a single CLI flag — one area, no migrations.',
    });
  });

  it('parses all valid assessment levels', () => {
    const complete = parseScopeBlock('<scope assessment="complete">Source is fully implemented.</scope>');
    expect(complete?.assessment).toBe('complete');

    const excursion = parseScopeBlock('<scope assessment="excursion">Cross-cutting change.</scope>');
    expect(excursion?.assessment).toBe('excursion');

    const expedition = parseScopeBlock('<scope assessment="expedition">Large initiative.</scope>');
    expect(expedition?.assessment).toBe('expedition');
  });

  it('returns null for invalid assessment value', () => {
    const text = '<scope assessment="tiny">Small change.</scope>';
    expect(parseScopeBlock(text)).toBeNull();
  });

  it('returns null when no scope block present', () => {
    expect(parseScopeBlock('just plain text')).toBeNull();
  });

  it('returns null for empty justification', () => {
    const text = '<scope assessment="errand">   </scope>';
    expect(parseScopeBlock(text)).toBeNull();
  });

  it('extracts only the first scope block', () => {
    const text = `
<scope assessment="errand">First assessment.</scope>
<scope assessment="expedition">Second assessment.</scope>`;

    const result = parseScopeBlock(text);
    expect(result?.assessment).toBe('errand');
    expect(result?.justification).toBe('First assessment.');
  });

  it('ignores surrounding text', () => {
    const text = `Here is some preamble.
<scope assessment="excursion">Migration before feature code.</scope>
And trailing text.`;

    const result = parseScopeBlock(text);
    expect(result).toEqual({
      assessment: 'excursion',
      justification: 'Migration before feature code.',
    });
  });

  it('trims whitespace from justification', () => {
    const text = `<scope assessment="errand">
      Lots of whitespace around this.
    </scope>`;

    const result = parseScopeBlock(text);
    expect(result?.justification).toBe('Lots of whitespace around this.');
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
