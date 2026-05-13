import { describe, it, expect } from 'vitest';
import {
  reviewIssueSchema,
  evaluationEvidenceSchema,
  evaluationVerdictSchema,
  clarificationQuestionSchema,
  stalenessVerdictSchema,
  expeditionModuleSchema,
  planFileFrontmatterSchema,
  pipelineCompositionSchema,
  getSchemaYaml,
  getReviewIssueSchemaYaml,
  getCodeReviewIssueSchemaYaml,
  getSecurityReviewIssueSchemaYaml,
  getApiReviewIssueSchemaYaml,
  getDocsReviewIssueSchemaYaml,
  getPlanReviewIssueSchemaYaml,
  getEvaluationSchemaYaml,
  getClarificationSchemaYaml,
  getStalenessSchemaYaml,
  getModuleSchemaYaml,
  getPlanFrontmatterSchemaYaml,
  getPipelineCompositionSchemaYaml,
} from '@eforge-build/engine/schemas';
import { safeParseWithSchema } from '@eforge-build/client';

describe('getSchemaYaml', () => {
  it('returns YAML string containing expected fields', () => {
    const yaml = getSchemaYaml('test-review-issue', reviewIssueSchema);
    expect(yaml).toContain('severity');
    expect(yaml).toContain('category');
    expect(yaml).toContain('file');
    expect(yaml).toContain('description');
    expect(yaml).toContain('line');
    expect(yaml).toContain('fix');
  });

  it('caches and returns the same reference on second call', () => {
    const first = getSchemaYaml('cache-test', reviewIssueSchema);
    const second = getSchemaYaml('cache-test', reviewIssueSchema);
    // Same string reference (not just equal content) proves caching
    expect(first).toBe(second);
  });

  it('strips $schema and ~standard keys', () => {
    const yaml = getSchemaYaml('strip-test', reviewIssueSchema);
    expect(yaml).not.toContain('$schema');
    expect(yaml).not.toContain('~standard');
  });
});

describe('perspective-specific schema YAML getters', () => {
  it('getReviewIssueSchemaYaml contains general categories', () => {
    const yaml = getReviewIssueSchemaYaml();
    expect(yaml).toContain('bugs');
    expect(yaml).toContain('security');
    expect(yaml).toContain('maintainability');
  });

  it('getCodeReviewIssueSchemaYaml contains code categories', () => {
    const yaml = getCodeReviewIssueSchemaYaml();
    expect(yaml).toContain('bugs');
    expect(yaml).toContain('performance');
    // Code perspective excludes security
    expect(yaml).not.toContain('injection');
  });

  it('getSecurityReviewIssueSchemaYaml contains security categories', () => {
    const yaml = getSecurityReviewIssueSchemaYaml();
    expect(yaml).toContain('injection');
    expect(yaml).toContain('secrets');
    expect(yaml).toContain('data-exposure');
  });

  it('getApiReviewIssueSchemaYaml contains API categories', () => {
    const yaml = getApiReviewIssueSchemaYaml();
    expect(yaml).toContain('rest-conventions');
    expect(yaml).toContain('contracts');
    expect(yaml).toContain('breaking-changes');
  });

  it('getDocsReviewIssueSchemaYaml contains docs categories', () => {
    const yaml = getDocsReviewIssueSchemaYaml();
    expect(yaml).toContain('code-examples');
    expect(yaml).toContain('stale-docs');
    expect(yaml).toContain('readme');
  });

  it('getPlanReviewIssueSchemaYaml contains plan-review categories', () => {
    const yaml = getPlanReviewIssueSchemaYaml();
    expect(yaml).toContain('cohesion');
    expect(yaml).toContain('completeness');
    expect(yaml).toContain('feasibility');
    expect(yaml).toContain('dependency');
  });
});

describe('reviewIssueSchema safeParse', () => {
  it('accepts a valid ReviewIssue', () => {
    const result = safeParseWithSchema(reviewIssueSchema, {
      severity: 'critical',
      category: 'bugs',
      file: 'src/index.ts',
      line: 42,
      description: 'Off-by-one error in loop',
      fix: 'Changed < to <=',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a ReviewIssue without optional fields', () => {
    const result = safeParseWithSchema(reviewIssueSchema, {
      severity: 'suggestion',
      category: 'performance',
      file: 'src/utils.ts',
      description: 'Consider memoizing this computation',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid severity', () => {
    const result = safeParseWithSchema(reviewIssueSchema, {
      severity: 'blocker',
      category: 'bugs',
      file: 'src/index.ts',
      description: 'Something bad',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing description', () => {
    const result = safeParseWithSchema(reviewIssueSchema, {
      severity: 'warning',
      category: 'bugs',
      file: 'src/index.ts',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty description', () => {
    const result = safeParseWithSchema(reviewIssueSchema, {
      severity: 'warning',
      category: 'bugs',
      file: 'src/index.ts',
      description: '',
    });
    expect(result.success).toBe(false);
  });
});

describe('other schemas export and validate', () => {
  it('evaluationVerdictSchema accepts valid verdict', () => {
    const result = safeParseWithSchema(evaluationVerdictSchema, {
      file: 'src/foo.ts',
      action: 'accept',
      reason: 'Fix is correct',
    });
    expect(result.success).toBe(true);
  });

  it('evaluationEvidenceSchema accepts valid evidence', () => {
    const result = safeParseWithSchema(evaluationEvidenceSchema, {
      staged: 'Original code does X',
      fix: 'Fix changes X to Y',
      rationale: 'Y is correct',
      ifAccepted: 'Bug is fixed',
      ifRejected: 'Bug persists',
    });
    expect(result.success).toBe(true);
  });

  it('clarificationQuestionSchema accepts valid question', () => {
    const result = safeParseWithSchema(clarificationQuestionSchema, {
      id: 'q1',
      question: 'Which database?',
      options: ['Postgres', 'MySQL'],
      default: 'Postgres',
    });
    expect(result.success).toBe(true);
  });

  it('stalenessVerdictSchema accepts valid verdict', () => {
    const result = safeParseWithSchema(stalenessVerdictSchema, {
      verdict: 'proceed',
      justification: 'No changes since last plan',
    });
    expect(result.success).toBe(true);
  });

  it('expeditionModuleSchema accepts valid module', () => {
    const result = safeParseWithSchema(expeditionModuleSchema, {
      id: 'auth',
      description: 'Authentication module',
      dependsOn: ['foundation'],
    });
    expect(result.success).toBe(true);
  });

  it('planFileFrontmatterSchema accepts valid frontmatter', () => {
    const result = safeParseWithSchema(planFileFrontmatterSchema, {
      id: 'plan-01-auth',
      name: 'Auth Setup',
      dependsOn: [],
      branch: 'feat/auth',
    });
    expect(result.success).toBe(true);
  });

  it('evaluationVerdictSchema rejects invalid action', () => {
    const result = safeParseWithSchema(evaluationVerdictSchema, {
      file: 'src/foo.ts',
      action: 'skip',
      reason: 'Not relevant',
    });
    expect(result.success).toBe(false);
  });

  it('evaluationVerdictSchema accepts verdict with evidence and hunk', () => {
    const result = safeParseWithSchema(evaluationVerdictSchema, {
      file: 'src/bar.ts',
      action: 'reject',
      reason: 'Alters intent',
      evidence: {
        staged: 'Original code',
        fix: 'Fix code',
        rationale: 'Changes approach',
        ifAccepted: 'Different behavior',
        ifRejected: 'Original behavior preserved',
      },
      hunk: 2,
    });
    expect(result.success).toBe(true);
  });

  it('evaluationEvidenceSchema rejects missing required fields', () => {
    const result = safeParseWithSchema(evaluationEvidenceSchema, {
      staged: 'Code',
      fix: 'Fix',
    });
    expect(result.success).toBe(false);
  });

  it('clarificationQuestionSchema accepts minimal question', () => {
    const result = safeParseWithSchema(clarificationQuestionSchema, {
      id: 'q1',
      question: 'Which database?',
    });
    expect(result.success).toBe(true);
  });

  it('clarificationQuestionSchema rejects missing id', () => {
    const result = safeParseWithSchema(clarificationQuestionSchema, {
      question: 'Which database?',
    });
    expect(result.success).toBe(false);
  });

  it('stalenessVerdictSchema accepts revise with revision', () => {
    const result = safeParseWithSchema(stalenessVerdictSchema, {
      verdict: 'revise',
      justification: 'API changed',
      revision: 'Updated PRD content',
    });
    expect(result.success).toBe(true);
  });

  it('stalenessVerdictSchema rejects invalid verdict value', () => {
    const result = safeParseWithSchema(stalenessVerdictSchema, {
      verdict: 'maybe',
      justification: 'Not sure',
    });
    expect(result.success).toBe(false);
  });

  it('stalenessVerdictSchema rejects empty justification', () => {
    const result = safeParseWithSchema(stalenessVerdictSchema, {
      verdict: 'proceed',
      justification: '',
    });
    expect(result.success).toBe(false);
  });

  it('expeditionModuleSchema rejects missing dependsOn', () => {
    const result = safeParseWithSchema(expeditionModuleSchema, {
      id: 'auth',
      description: 'Auth module',
    });
    expect(result.success).toBe(false);
  });

  it('planFileFrontmatterSchema accepts frontmatter with migrations', () => {
    const result = safeParseWithSchema(planFileFrontmatterSchema, {
      id: 'plan-02-db',
      name: 'Database Migration',
      dependsOn: ['plan-01-auth'],
      branch: 'feat/db',
      migrations: [
        { timestamp: '20260318120000', description: 'Add users table' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('planFileFrontmatterSchema rejects missing branch', () => {
    const result = safeParseWithSchema(planFileFrontmatterSchema, {
      id: 'plan-01-auth',
      name: 'Auth Setup',
      dependsOn: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('remaining schema YAML getters', () => {
  it('getEvaluationSchemaYaml contains verdict fields', () => {
    const yaml = getEvaluationSchemaYaml();
    expect(yaml).toContain('file');
    expect(yaml).toContain('action');
    expect(yaml).toContain('reason');
    expect(yaml).toContain('accept');
    expect(yaml).toContain('reject');
    expect(yaml).toContain('review');
  });

  it('getClarificationSchemaYaml contains question fields', () => {
    const yaml = getClarificationSchemaYaml();
    expect(yaml).toContain('id');
    expect(yaml).toContain('question');
    expect(yaml).toContain('context');
    expect(yaml).toContain('options');
    expect(yaml).toContain('default');
  });

  it('getStalenessSchemaYaml contains verdict values', () => {
    const yaml = getStalenessSchemaYaml();
    expect(yaml).toContain('verdict');
    expect(yaml).toContain('justification');
    expect(yaml).toContain('proceed');
    expect(yaml).toContain('revise');
    expect(yaml).toContain('obsolete');
  });

  it('getModuleSchemaYaml contains module fields', () => {
    const yaml = getModuleSchemaYaml();
    expect(yaml).toContain('id');
    expect(yaml).toContain('description');
    expect(yaml).toContain('dependsOn');
  });

  it('getPlanFrontmatterSchemaYaml contains frontmatter fields', () => {
    const yaml = getPlanFrontmatterSchemaYaml();
    expect(yaml).toContain('id');
    expect(yaml).toContain('name');
    expect(yaml).toContain('dependsOn');
    expect(yaml).toContain('branch');
    expect(yaml).toContain('migrations');
  });

  it('getPipelineCompositionSchemaYaml contains pipeline composition fields', () => {
    const yaml = getPipelineCompositionSchemaYaml();
    expect(yaml).toContain('scope');
    expect(yaml).toContain('compile');
    expect(yaml).toContain('defaultBuild');
    expect(yaml).toContain('defaultReview');
    expect(yaml).toContain('rationale');
  });
});

describe('pipelineCompositionSchema', () => {
  const validReview = {
    strategy: 'auto' as const,
    perspectives: ['code'],
    maxRounds: 2,
    evaluatorStrictness: 'standard' as const,
  };

  it('accepts a valid pipeline composition', () => {
    const result = safeParseWithSchema(pipelineCompositionSchema, {
      scope: 'excursion',
      compile: ['planner'],
      defaultBuild: ['implement'],
      defaultReview: validReview,
      rationale: 'Standard pipeline for a typical feature',
    });
    expect(result.success).toBe(true);
  });

  it('accepts parallel build stages', () => {
    const result = safeParseWithSchema(pipelineCompositionSchema, {
      scope: 'expedition',
      compile: ['planner'],
      defaultBuild: ['implement', ['review-cycle', 'test']],
      defaultReview: validReview,
      rationale: 'Pipeline with parallel stages',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid scope', () => {
    const result = safeParseWithSchema(pipelineCompositionSchema, {
      scope: 'invalid',
      compile: ['planner'],
      defaultBuild: ['implement'],
      defaultReview: validReview,
      rationale: 'Test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty rationale', () => {
    const result = safeParseWithSchema(pipelineCompositionSchema, {
      scope: 'errand',
      compile: ['planner'],
      defaultBuild: ['implement'],
      defaultReview: { ...validReview, maxRounds: 1, evaluatorStrictness: 'lenient' as const },
      rationale: '',
    });
    expect(result.success).toBe(false);
  });
});
