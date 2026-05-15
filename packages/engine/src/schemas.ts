/**
 * TypeBox schemas for all structured XML blocks emitted by eforge agents.
 * Leaf-level file — imports only @sinclair/typebox and @eforge-build/client, no engine imports.
 *
 * Pattern: define TypeBox schemas with `description` options, convert to YAML via
 * `getSchemaYaml()` from @eforge-build/client, inject into prompts.
 */
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import {
  REVIEW_PERSPECTIVES,
  getSchemaYaml,
  safeParseWithSchema,
  type SafeParseResult,
  type ValueError,
} from '@eforge-build/client';
import type { ReviewProfileConfig } from '@eforge-build/client';

// Re-export getSchemaYaml so existing consumers that import it from this module continue to work.
export { getSchemaYaml };

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

const severitySchema = Type.Union(
  [Type.Literal('critical'), Type.Literal('warning'), Type.Literal('suggestion')],
  { description: 'Issue severity: critical = must fix before merge, warning = should fix, suggestion = nice to have' },
);

// ---------------------------------------------------------------------------
// Per-perspective category enums
// ---------------------------------------------------------------------------

/** General reviewer (single-reviewer mode) categories. */
const generalCategorySchema = Type.Union(
  ['bugs', 'security', 'error-handling', 'edge-cases', 'types', 'dry', 'performance', 'maintainability'].map(v => Type.Literal(v)),
  { description: 'Review category for the general perspective' },
);

/** Code quality specialist categories. */
const codeCategorySchema = Type.Union(
  ['bugs', 'error-handling', 'edge-cases', 'types', 'dry', 'performance', 'maintainability'].map(v => Type.Literal(v)),
  { description: 'Review category for the code perspective' },
);

/** Security specialist categories. */
const securityCategorySchema = Type.Union(
  ['injection', 'secrets', 'auth', 'unsafe-ops', 'cryptography', 'dependencies', 'data-exposure'].map(v => Type.Literal(v)),
  { description: 'Review category for the security perspective' },
);

/** API design specialist categories. */
const apiCategorySchema = Type.Union(
  ['rest-conventions', 'contracts', 'input-validation', 'breaking-changes', 'error-responses', 'versioning'].map(v => Type.Literal(v)),
  { description: 'Review category for the api perspective' },
);

/** Documentation specialist categories. */
const docsCategorySchema = Type.Union(
  ['code-examples', 'env-vars', 'stale-docs', 'completeness', 'readme'].map(v => Type.Literal(v)),
  { description: 'Review category for the docs perspective' },
);

/** Test quality specialist categories. */
const testCategorySchema = Type.Union(
  ['coverage-gaps', 'test-quality', 'test-isolation', 'fixtures', 'assertions', 'flaky-patterns', 'test-design'].map(v => Type.Literal(v)),
  { description: 'Review category for the test perspective' },
);

/** Verify perspective category — always verification-failure. */
const verifyCategorySchema = Type.Union(
  [Type.Literal('verification-failure')],
  { description: 'Review category for the verify perspective — always verification-failure' },
);

/** Verify perspective severity — always critical. */
const verifySeveritySchema = Type.Union(
  [Type.Literal('critical')],
  { description: 'Verify issue severity: always critical — a failing command must be fixed before merge' },
);

// ---------------------------------------------------------------------------
// TestIssue schemas
// ---------------------------------------------------------------------------

const testIssueCategorySchema = Type.Union(
  ['production-bug', 'missing-behavior', 'regression'].map(v => Type.Literal(v)),
  { description: 'Category of test-discovered issue' },
);

const testIssueSeveritySchema = Type.Union(
  [Type.Literal('critical'), Type.Literal('warning')],
  { description: 'Test issue severity: critical = failing test, warning = missing coverage' },
);

export const testIssueSchema = Type.Object({
  severity: testIssueSeveritySchema,
  category: testIssueCategorySchema,
  file: Type.String({ description: 'Production file with the bug' }),
  testFile: Type.String({ description: 'Test file that exposed the issue' }),
  description: Type.String({ minLength: 1, description: 'Description of the issue' }),
  testOutput: Type.Optional(Type.String({ description: 'Relevant test failure output' })),
  fix: Type.Optional(Type.String({ description: 'Description of unstaged fix applied' })),
});

/** Plan reviewer and cohesion reviewer categories. */
const planReviewCategorySchema = Type.Union(
  ['cohesion', 'completeness', 'correctness', 'feasibility', 'dependency', 'scope'].map(v => Type.Literal(v)),
  { description: 'Review category for plan reviews' },
);

// ---------------------------------------------------------------------------
// ReviewIssue schema
// ---------------------------------------------------------------------------

/** Base review issue schema with string category (union of all perspectives). */
export const reviewIssueSchema = Type.Object({
  severity: severitySchema,
  category: Type.String({ description: 'Review category — allowed values depend on the review perspective' }),
  file: Type.String({ description: 'Relative file path from the repository root' }),
  line: Type.Optional(Type.Integer({ minimum: 1, description: 'Line number in the file (optional)' })),
  description: Type.String({ minLength: 1, description: 'Description of the issue' }),
  fix: Type.Optional(Type.String({ description: 'Description of the fix applied, if any' })),
});

// ---------------------------------------------------------------------------
// EvaluationVerdict schema
// ---------------------------------------------------------------------------

export const evaluationEvidenceSchema = Type.Object({
  staged: Type.String({ description: 'What the staged/original code does' }),
  fix: Type.String({ description: "What the reviewer's fix does" }),
  rationale: Type.String({ description: 'Why the verdict was chosen' }),
  ifAccepted: Type.String({ description: 'Consequence if the fix is accepted' }),
  ifRejected: Type.String({ description: 'Consequence if the fix is rejected' }),
}, { description: 'Structured evidence when the evaluator uses child elements' });

export const evaluationVerdictSchema = Type.Object({
  file: Type.String({ description: 'File path being evaluated' }),
  action: Type.Union([Type.Literal('accept'), Type.Literal('reject'), Type.Literal('review')], { description: 'Verdict action' }),
  reason: Type.String({ description: 'Reason for the verdict' }),
  evidence: Type.Optional(evaluationEvidenceSchema),
  hunk: Type.Optional(Type.Integer({ minimum: 1, description: 'Hunk number for per-hunk evaluation (1-indexed)' })),
});

// --- eforge:region plan-01-evaluation-application-core ---
export type EvaluationEvidence = Static<typeof evaluationEvidenceSchema>;
export type EvaluationVerdict = Static<typeof evaluationVerdictSchema>;

export const evaluationSubmissionSchema = Type.Object({
  verdicts: Type.Array(evaluationVerdictSchema, {
    description: 'Evaluation verdicts covering every captured file or every captured hunk in the immutable evaluation snapshot',
  }),
});

export type EvaluationSubmission = Static<typeof evaluationSubmissionSchema>;
// --- eforge:endregion plan-01-evaluation-application-core ---

// ---------------------------------------------------------------------------
// Clarification schema
// ---------------------------------------------------------------------------

export const clarificationQuestionSchema = Type.Object({
  id: Type.String({ description: 'Unique question identifier' }),
  question: Type.String({ description: 'The question text' }),
  context: Type.Optional(Type.String({ description: 'Additional context for the question' })),
  options: Type.Optional(Type.Array(Type.String(), { description: 'Suggested answer options' })),
  default: Type.Optional(Type.String({ description: 'Default answer value' })),
});

// ---------------------------------------------------------------------------
// Staleness schema
// ---------------------------------------------------------------------------

export const stalenessVerdictSchema = Type.Object({
  verdict: Type.Union(
    [Type.Literal('proceed'), Type.Literal('revise'), Type.Literal('obsolete')],
    { description: 'Staleness assessment verdict' },
  ),
  justification: Type.String({ minLength: 1, description: 'Reason for the verdict' }),
  revision: Type.Optional(Type.String({ description: 'Revised PRD content when verdict is revise' })),
});

// ---------------------------------------------------------------------------
// Recovery Verdict schema
// ---------------------------------------------------------------------------

export const recoveryVerdictSchema = Type.Object({
  verdict: Type.Union(
    [Type.Literal('retry'), Type.Literal('split'), Type.Literal('abandon'), Type.Literal('manual')],
    {
      description:
        'Recovery verdict: retry = transient failure, split = partially complete (use suggestedSuccessorPrd), abandon = no longer viable, manual = human review required (safe default)',
    },
  ),
  confidence: Type.Union(
    [Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')],
    { description: 'Confidence in the verdict based on available evidence' },
  ),
  rationale: Type.String({
    minLength: 1,
    description: 'Explanation of the verdict with concrete evidence from the failure summary',
  }),
  completedWork: Type.Array(Type.String(), {
    description: 'Work items that were completed before the failure (each item on its own line)',
  }),
  remainingWork: Type.Array(Type.String(), {
    description: 'Work items that still need to be done (each item on its own line)',
  }),
  risks: Type.Array(Type.String(), {
    description: 'Risks identified in the recovery assessment (each risk on its own line)',
  }),
  suggestedSuccessorPrd: Type.Optional(Type.String({
    description: 'Full successor PRD content when verdict is split — must be complete and self-contained',
  })),
  partial: Type.Optional(Type.Boolean({
    description: 'When true, the recovery analysis was based on partial context (some context was unavailable)',
  })),
  recoveryError: Type.Optional(Type.String({
    description: 'Error message when recovery failed or context was incomplete',
  })),
});

// ---------------------------------------------------------------------------
// Apply Recovery schemas
// ---------------------------------------------------------------------------

/** Options for applyRecovery() — reserved for future extension. */
export const applyRecoveryOptionsSchema = Type.Object({});
export type ApplyRecoveryOptions = Static<typeof applyRecoveryOptionsSchema>;

/** The verdict value union — a convenience alias for the enum in recoveryVerdictSchema. */
export type RecoveryVerdictValue = Static<typeof recoveryVerdictSchema>['verdict'];

/**
 * Return type of EforgeEngine.applyRecovery().
 * commitSha is absent for the `manual` no-op verdict.
 */
export interface ApplyRecoveryResult {
  verdict: RecoveryVerdictValue;
  successorPrdId?: string;
  noAction: boolean;
  commitSha?: string;
}

// ---------------------------------------------------------------------------
// Expedition module schema
// ---------------------------------------------------------------------------

export const expeditionModuleSchema = Type.Object({
  id: Type.String({ description: 'Module identifier' }),
  description: Type.String({ description: 'Module description' }),
  dependsOn: Type.Array(Type.String(), { description: 'IDs of modules this module depends on' }),
});

// ---------------------------------------------------------------------------
// Agent Tuning schema (effort/thinking overrides per agent role)
// ---------------------------------------------------------------------------

// Effort and thinking schemas duplicated from config.ts to keep schemas.ts leaf-level
const effortLevelForTuningSchema = Type.Union(
  ['low', 'medium', 'high', 'xhigh', 'max'].map(v => Type.Literal(v)),
  {
    description:
      'Effort level for thinking depth. Set xhigh only for modules with significant ambiguity, novel API design, or large refactors. Omit to use the role default.',
  },
);

const thinkingForTuningSchema = Type.Union([
  Type.Object({ type: Type.Literal('adaptive') }),
  Type.Object({ type: Type.Literal('enabled'), budgetTokens: Type.Optional(Type.Integer({ minimum: 1 })) }),
  Type.Object({ type: Type.Literal('disabled') }),
], { description: "Controls the agent's thinking/reasoning behavior" });

// ---------------------------------------------------------------------------
// ShardScope schema (parallel implementation shards for mechanical refactors)
// ---------------------------------------------------------------------------

export const shardScopeSchema = Type.Object({
  id: Type.String({ minLength: 1, description: 'Unique shard identifier within the plan' }),
  roots: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: 'Directory roots claimed by this shard (matched via path prefix)',
  })),
  files: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: 'Explicit file paths claimed by this shard',
  })),
}, { description: 'Scope definition for a single implementation shard' });

export type ShardScope = Static<typeof shardScopeSchema>;

/**
 * Post-parse validator for shardScopeSchema.
 * Enforces that each shard specifies at least one of roots or files.
 */
export function validateShardScope(data: ShardScope): SafeParseResult<ShardScope> {
  const hasRoots = data.roots !== undefined && data.roots.length > 0;
  const hasFiles = data.files !== undefined && data.files.length > 0;
  if (!hasRoots && !hasFiles) {
    const err: ValueError = { path: '', message: 'Each shard must specify at least one of roots or files' };
    return { success: false, error: { message: err.message, errors: [err] } };
  }
  return { success: true, data };
}

export const agentTuningSchema = Type.Object({
  effort: Type.Optional(effortLevelForTuningSchema),
  thinking: Type.Optional(thinkingForTuningSchema),
  rationale: Type.Optional(Type.String({ description: 'Why this tuning was chosen' })),
  tier: Type.Optional(Type.Union(
    ['planning', 'implementation', 'review', 'evaluation'].map(v => Type.Literal(v)),
    { description: 'Override the tier this role belongs to (the tier carries harness/model/effort defaults)' },
  )),
  shards: Type.Optional(Type.Array(shardScopeSchema, {
    description: 'Parallel implementation shards (builder role only)',
  })),
}, { description: 'Per-agent effort/thinking/tier tuning' });

const planAgentsSchema = Type.Optional(Type.Object({
  builder: Type.Optional(agentTuningSchema),
  reviewer: Type.Optional(agentTuningSchema),
  'review-fixer': Type.Optional(agentTuningSchema),
  evaluator: Type.Optional(agentTuningSchema),
  'doc-author': Type.Optional(agentTuningSchema),
  'doc-syncer': Type.Optional(agentTuningSchema),
  'test-writer': Type.Optional(agentTuningSchema),
  tester: Type.Optional(agentTuningSchema),
}, { description: 'Per-agent tuning overrides for build-stage agents in this plan' }));

// ---------------------------------------------------------------------------
// PlanFile frontmatter schema
// ---------------------------------------------------------------------------

export const planFileFrontmatterSchema = Type.Object({
  id: Type.String({ description: 'Plan identifier (e.g., plan-01-auth)' }),
  name: Type.String({ description: 'Human-readable plan name' }),
  dependsOn: Type.Array(Type.String(), { description: 'IDs of plans this plan depends on' }),
  branch: Type.String({ description: 'Git branch name for this plan' }),
  migrations: Type.Optional(Type.Array(Type.Object({
    timestamp: Type.String({ description: 'Migration timestamp' }),
    description: Type.String({ description: 'Migration description' }),
  }), { description: 'Database migrations included in this plan' })),
  agents: planAgentsSchema,
});

// ---------------------------------------------------------------------------
// Per-perspective ReviewIssue schema builders
// ---------------------------------------------------------------------------

function makeReviewIssueSchemaWithCategory<T extends TSchema>(categorySchema: T) {
  return Type.Object({
    ...reviewIssueSchema.properties,
    category: categorySchema,
  });
}

// ---------------------------------------------------------------------------
// Per-perspective schemas (hoisted to avoid reconstruction on every getter call)
// ---------------------------------------------------------------------------

const generalReviewIssueSchema = makeReviewIssueSchemaWithCategory(generalCategorySchema);
const codeReviewIssueSchema = makeReviewIssueSchemaWithCategory(codeCategorySchema);
const securityReviewIssueSchema = makeReviewIssueSchemaWithCategory(securityCategorySchema);
const apiReviewIssueSchema = makeReviewIssueSchemaWithCategory(apiCategorySchema);
const docsReviewIssueSchema = makeReviewIssueSchemaWithCategory(docsCategorySchema);
const testReviewIssueSchema = makeReviewIssueSchemaWithCategory(testCategorySchema);
const planReviewIssueSchema = makeReviewIssueSchemaWithCategory(planReviewCategorySchema);
export const verifyReviewIssueSchema = Type.Object({
  ...reviewIssueSchema.properties,
  severity: verifySeveritySchema,
  category: verifyCategorySchema,
});

// ---------------------------------------------------------------------------
// Convenience getters — one per perspective
// ---------------------------------------------------------------------------

/** Schema YAML for the general (single) reviewer perspective. */
export function getReviewIssueSchemaYaml(): string {
  return getSchemaYaml('review-issue-general', generalReviewIssueSchema);
}

/** Schema YAML for the code quality perspective. */
export function getCodeReviewIssueSchemaYaml(): string {
  return getSchemaYaml('review-issue-code', codeReviewIssueSchema);
}

/** Schema YAML for the security perspective. */
export function getSecurityReviewIssueSchemaYaml(): string {
  return getSchemaYaml('review-issue-security', securityReviewIssueSchema);
}

/** Schema YAML for the API design perspective. */
export function getApiReviewIssueSchemaYaml(): string {
  return getSchemaYaml('review-issue-api', apiReviewIssueSchema);
}

/** Schema YAML for the documentation perspective. */
export function getDocsReviewIssueSchemaYaml(): string {
  return getSchemaYaml('review-issue-docs', docsReviewIssueSchema);
}

/** Schema YAML for the test quality perspective. */
export function getTestsReviewIssueSchemaYaml(): string {
  return getSchemaYaml('review-issue-test', testReviewIssueSchema);
}

/** Schema YAML for the verify perspective (subprocess command failures). */
export function getVerifyReviewIssueSchemaYaml(): string {
  return getSchemaYaml('review-issue-verify', verifyReviewIssueSchema);
}

/** Schema YAML for test issues (used by tester agent). */
export function getTestIssueSchemaYaml(): string {
  return getSchemaYaml('test-issue', testIssueSchema);
}

/** Schema YAML for plan reviewers and cohesion reviewers. */
export function getPlanReviewIssueSchemaYaml(): string {
  return getSchemaYaml('review-issue-plan-review', planReviewIssueSchema);
}

// ---------------------------------------------------------------------------
// Non-review schema YAML getters
// ---------------------------------------------------------------------------

/** Schema YAML for evaluation verdicts (used by evaluator, plan-evaluator, cohesion-evaluator). */
export function getEvaluationSchemaYaml(): string {
  return getSchemaYaml('evaluation-verdict', evaluationVerdictSchema);
}

// --- eforge:region plan-01-evaluation-application-core ---
/** Schema YAML for evaluation verdict submissions (used by evaluator tools). */
export function getEvaluationSubmissionSchemaYaml(): string {
  return getSchemaYaml('evaluation-submission', evaluationSubmissionSchema);
}
// --- eforge:endregion plan-01-evaluation-application-core ---

/** Schema YAML for clarification questions (used by planner). */
export function getClarificationSchemaYaml(): string {
  return getSchemaYaml('clarification-question', clarificationQuestionSchema);
}

/** Schema YAML for staleness verdicts (used by staleness-assessor). */
export function getStalenessSchemaYaml(): string {
  return getSchemaYaml('staleness-verdict', stalenessVerdictSchema);
}

/** Schema YAML for recovery verdicts (used by recovery-analyst). */
export function getRecoveryVerdictSchemaYaml(): string {
  return getSchemaYaml('recovery-verdict', recoveryVerdictSchema);
}

/** Schema YAML for expedition modules (used by planner). */
export function getModuleSchemaYaml(): string {
  return getSchemaYaml('expedition-module', expeditionModuleSchema);
}

/** Schema YAML for plan file frontmatter (used by planner). */
export function getPlanFrontmatterSchemaYaml(): string {
  return getSchemaYaml('plan-file-frontmatter', planFileFrontmatterSchema);
}

// ---------------------------------------------------------------------------
// Pipeline Build/Review stage schemas
// (declared here so orchestrationPlanSchema can reference them without TDZ)
// Exported so plan.ts and agents/common.ts can use them as TypeBox versions
// of the config.ts buildStageSpecSchema / reviewProfileConfigSchema.
// ---------------------------------------------------------------------------

/**
 * Build stage spec for pipeline composition — TypeBox counterpart of buildStageSpecSchema from config.ts.
 * Exported for use by plan.ts and agents/common.ts (config.ts migration is deferred).
 */
export const pipelineBuildStageSpecSchema = Type.Union([
  Type.String({ description: 'A single stage name' }),
  Type.Array(Type.String(), { description: 'Stage names to run in parallel' }),
], { description: 'A stage name or array of stage names to run in parallel' });

/**
 * Review profile config for pipeline composition — TypeBox counterpart of reviewProfileConfigSchema from config.ts.
 * Typed to be structurally compatible with ReviewProfileConfig from @eforge-build/client.
 * Exported for use by plan.ts and agents/common.ts (config.ts migration is deferred).
 */
export const pipelineReviewProfileConfigSchema = Type.Object({
  strategy: Type.Union(
    [Type.Literal('auto'), Type.Literal('single'), Type.Literal('parallel')],
    { description: 'Review strategy' },
  ),
  perspectives: Type.Array(
    Type.Union(REVIEW_PERSPECTIVES.map(p => Type.Literal(p))),
    { minItems: 1, description: `Review perspective names. Valid: ${REVIEW_PERSPECTIVES.join(', ')}` },
  ),
  maxRounds: Type.Integer({ minimum: 1, description: 'Number of review-fix-evaluate cycles' }),
  evaluatorStrictness: Type.Union(
    [Type.Literal('strict'), Type.Literal('standard'), Type.Literal('lenient')],
    { description: 'How strictly the evaluator judges fixes' },
  ),
}) satisfies { static: ReviewProfileConfig };

// ---------------------------------------------------------------------------
// Plan Set Submission schema
// ---------------------------------------------------------------------------

const planSetSubmissionPlanSchema = Type.Object({
  frontmatter: Type.Object({
    id: Type.String({ minLength: 1, description: 'Plan identifier (e.g., plan-01-auth)' }),
    name: Type.String({ minLength: 1, description: 'Human-readable plan name' }),
    migrations: Type.Optional(Type.Array(Type.Object({
      timestamp: Type.String({ pattern: '^\\d{14}$', description: 'Migration timestamp in YYYYMMDDHHmmss format' }),
      description: Type.String({ minLength: 1, description: 'Migration description' }),
    }), { description: 'Database migrations included in this plan' })),
    agents: planAgentsSchema,
  }),
  body: Type.String({ description: 'Plan markdown body' }),
});

const orchestrationPlanSchema = Type.Object({
  id: Type.String({ minLength: 1, description: 'Plan ID matching a submitted plan' }),
  dependsOn: Type.Array(Type.String(), { description: 'IDs of plans this plan depends on' }),
  build: Type.Optional(Type.Array(pipelineBuildStageSpecSchema, {
    description: "Per-plan build stage pipeline; if omitted, the composer's defaultBuild is used as a backfill",
  })),
  review: Type.Optional(Type.Object(pipelineReviewProfileConfigSchema.properties, {
    description: "Per-plan review configuration; if omitted, the composer's defaultReview is used as a backfill",
  })),
  buildRationale: Type.Optional(Type.String({
    description: "Why this plan's build stages differ from the default, or confirmation that the default is appropriate",
  })),
  reviewRationale: Type.Optional(Type.String({
    description: "Why this plan's review profile differs from the default, or confirmation that the default is appropriate",
  })),
});

export const planSetSubmissionSchema = Type.Object({
  description: Type.String({ minLength: 1, description: 'Plan set description' }),
  plans: Type.Array(planSetSubmissionPlanSchema, { minItems: 1, description: 'Plan files to write' }),
  planSetShapeRationale: Type.Optional(Type.String({
    description: 'Why the work is split into this number of plans and ordered this way (omit for single-plan submissions)',
  })),
  orchestration: Type.Object({
    validate: Type.Array(Type.String(), { description: 'Validation commands to run' }),
    plans: Type.Array(orchestrationPlanSchema, { minItems: 1, description: 'Orchestration plan entries' }),
  }, { description: 'Orchestration configuration' }),
});

export type PlanSetSubmission = Static<typeof planSetSubmissionSchema>;

/**
 * Post-parse validator for planSetSubmissionSchema.
 * Enforces cross-field constraints: duplicate IDs, dangling dependencies, cycles,
 * and orchestration/plan alignment.
 */
export function validatePlanSetSubmission(data: PlanSetSubmission): SafeParseResult<PlanSetSubmission> {
  const errors: ValueError[] = [];

  // Check for duplicate plan IDs
  const planIds = data.plans.map(p => p.frontmatter.id);
  const seen = new Set<string>();
  for (const id of planIds) {
    if (seen.has(id)) {
      errors.push({ path: '/plans', message: `Duplicate plan ID: "${id}"` });
    }
    seen.add(id);
  }

  const planIdSet = new Set(planIds);

  // Check for dangling dependsOn references (orchestration.yaml is the canonical source)
  for (let i = 0; i < data.orchestration.plans.length; i++) {
    for (const dep of data.orchestration.plans[i].dependsOn) {
      if (!planIdSet.has(dep)) {
        errors.push({
          path: `/orchestration/plans/${i}/dependsOn`,
          message: `Plan "${data.orchestration.plans[i].id}" depends on unknown plan "${dep}"`,
        });
      }
    }
  }

  // Check for dependency cycles using DFS (orchestration.yaml is the canonical source)
  const adjMap = new Map<string, string[]>();
  for (const orchPlan of data.orchestration.plans) {
    adjMap.set(orchPlan.id, orchPlan.dependsOn);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of planIds) color.set(id, WHITE);

  function hasCycle(node: string): boolean {
    color.set(node, GRAY);
    for (const dep of adjMap.get(node) ?? []) {
      if (!color.has(dep)) continue;
      if (color.get(dep) === GRAY) return true;
      if (color.get(dep) === WHITE && hasCycle(dep)) return true;
    }
    color.set(node, BLACK);
    return false;
  }

  for (const id of planIds) {
    if (color.get(id) === WHITE && hasCycle(id)) {
      errors.push({ path: '/plans', message: 'Dependency cycle detected among plans' });
      break;
    }
  }

  // Check orchestration plan IDs match submitted plan IDs (also detect duplicates)
  const orchIds = new Set(data.orchestration.plans.map(p => p.id));
  if (orchIds.size !== data.orchestration.plans.length) {
    errors.push({ path: '/orchestration/plans', message: 'Orchestration contains duplicate plan IDs' });
  }
  if (orchIds.size !== planIdSet.size || ![...orchIds].every(id => planIdSet.has(id))) {
    errors.push({
      path: '/orchestration/plans',
      message: `Orchestration plan IDs [${[...orchIds].join(', ')}] do not match submitted plan IDs [${[...planIdSet].join(', ')}]`,
    });
  }

  if (errors.length > 0) {
    const message = errors.map(e => `${e.path || '(root)'}: ${e.message}`).join('\n');
    return { success: false, error: { message, errors } };
  }
  return { success: true, data };
}

// ---------------------------------------------------------------------------
// Architecture Submission schema
// ---------------------------------------------------------------------------

const architectureModuleSchema = Type.Object({
  id: Type.String({ minLength: 1, description: 'Module identifier' }),
  description: Type.String({ minLength: 1, description: 'Module description' }),
  dependsOn: Type.Array(Type.String(), { description: 'IDs of modules this module depends on' }),
});

export const architectureSubmissionSchema = Type.Object({
  architecture: Type.String({ minLength: 1, description: 'Architecture document markdown content' }),
  modules: Type.Array(architectureModuleSchema, { minItems: 1, description: 'Modules in the architecture' }),
  index: Type.Object({
    name: Type.String({ minLength: 1, description: 'Plan set name' }),
    description: Type.String({ description: 'Plan set description' }),
    mode: Type.Literal('expedition', { description: 'Orchestration mode' }),
    validate: Type.Array(Type.String(), { description: 'Validation commands to run' }),
    modules: Type.Record(
      Type.String(),
      Type.Object({
        description: Type.String({ description: 'Module description' }),
        depends_on: Type.Array(Type.String(), { description: 'Module dependencies' }),
      }),
      { description: 'Module map for index.yaml' },
    ),
  }, { description: 'Index metadata for expedition plan set' }),
});

export type ArchitectureSubmission = Static<typeof architectureSubmissionSchema>;

/**
 * Post-parse validator for architectureSubmissionSchema.
 * Enforces cross-field constraints: duplicate module IDs, dangling dependencies, cycles.
 */
export function validateArchitectureSubmission(data: ArchitectureSubmission): SafeParseResult<ArchitectureSubmission> {
  const errors: ValueError[] = [];
  const moduleIds = new Set(data.modules.map(m => m.id));

  // Check for duplicate module IDs
  if (moduleIds.size !== data.modules.length) {
    errors.push({ path: '/modules', message: 'Architecture contains duplicate module IDs' });
  }

  // Check for dangling dependsOn references
  for (let i = 0; i < data.modules.length; i++) {
    for (const dep of data.modules[i].dependsOn) {
      if (!moduleIds.has(dep)) {
        errors.push({
          path: `/modules/${i}/dependsOn`,
          message: `Module "${data.modules[i].id}" depends on unknown module "${dep}"`,
        });
      }
    }
  }

  // Check for dependency cycles using DFS
  const moduleList = data.modules.map(m => m.id);
  const adjMap = new Map<string, string[]>();
  for (const mod of data.modules) {
    adjMap.set(mod.id, mod.dependsOn);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of moduleList) color.set(id, WHITE);

  function hasCycle(node: string): boolean {
    color.set(node, GRAY);
    for (const dep of adjMap.get(node) ?? []) {
      if (!color.has(dep)) continue;
      if (color.get(dep) === GRAY) return true;
      if (color.get(dep) === WHITE && hasCycle(dep)) return true;
    }
    color.set(node, BLACK);
    return false;
  }

  for (const id of moduleList) {
    if (color.get(id) === WHITE && hasCycle(id)) {
      errors.push({ path: '/modules', message: 'Dependency cycle detected among modules' });
      break;
    }
  }

  if (errors.length > 0) {
    const message = errors.map(e => `${e.path || '(root)'}: ${e.message}`).join('\n');
    return { success: false, error: { message, errors } };
  }
  return { success: true, data };
}

// ---------------------------------------------------------------------------
// Submission schema YAML getters
// ---------------------------------------------------------------------------

/** Schema YAML for plan set submissions (used by planner submission tool). */
export function getPlanSetSubmissionSchemaYaml(): string {
  return getSchemaYaml('plan-set-submission', planSetSubmissionSchema);
}

/** Schema YAML for architecture submissions (used by planner submission tool). */
export function getArchitectureSubmissionSchemaYaml(): string {
  return getSchemaYaml('architecture-submission', architectureSubmissionSchema);
}

// ---------------------------------------------------------------------------
// Plan Review Submission schemas
// ---------------------------------------------------------------------------

/**
 * Schema for a single fix applied by the plan-reviewer agent.
 * Discriminated union with three variants: replace_orchestration, replace_plan_file, replace_plan_body.
 */
export const planReviewFixSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('replace_orchestration', { description: 'Replace the entire orchestration.yaml content' }),
    description: Type.String({ minLength: 1, description: 'Plan set description' }),
    baseBranch: Type.String({ minLength: 1, description: 'Base git branch' }),
    validate: Type.Array(Type.String(), { description: 'Validation commands to run' }),
    plans: Type.Array(Type.Object({
      id: Type.String({ minLength: 1, description: 'Plan ID' }),
      name: Type.String({ minLength: 1, description: 'Human-readable plan name' }),
      dependsOn: Type.Array(Type.String(), { description: 'IDs of plans this plan depends on' }),
      branch: Type.String({ minLength: 1, description: 'Git branch name' }),
      build: Type.Optional(Type.Array(pipelineBuildStageSpecSchema, { description: 'Per-plan build stage pipeline' })),
      review: Type.Optional(Type.Object(pipelineReviewProfileConfigSchema.properties, { description: 'Per-plan review configuration' })),
      agents: planAgentsSchema,
    }), { minItems: 1, description: 'Orchestration plan entries' }),
  }, { description: 'Replace the orchestration.yaml content; pipeline is preserved from disk' }),
  Type.Object({
    kind: Type.Literal('replace_plan_file', { description: 'Replace an entire plan file (frontmatter + body)' }),
    planId: Type.String({ minLength: 1, description: 'Plan ID (e.g., plan-01-auth) — used to resolve the file path' }),
    frontmatter: Type.Object({
      id: Type.String({ minLength: 1, description: 'Plan identifier' }),
      name: Type.String({ minLength: 1, description: 'Human-readable plan name' }),
      branch: Type.String({ minLength: 1, description: 'Git branch name for this plan' }),
      migrations: Type.Optional(Type.Array(Type.Object({
        timestamp: Type.String({ pattern: '^\\d{14}$', description: 'Migration timestamp in YYYYMMDDHHmmss format' }),
        description: Type.String({ description: 'Migration description' }),
      }), { description: 'Database migrations included in this plan' })),
      agents: planAgentsSchema,
    }, { description: 'Plan file frontmatter' }),
    body: Type.String({ description: 'Plan markdown body' }),
  }, { description: 'Replace an entire plan .md file with new frontmatter and body' }),
  Type.Object({
    kind: Type.Literal('replace_plan_body', { description: 'Replace only the markdown body of a plan file, preserving frontmatter' }),
    planId: Type.String({ minLength: 1, description: 'Plan ID (e.g., plan-01-auth) — used to resolve the file path' }),
    body: Type.String({ description: 'New markdown body (frontmatter is preserved verbatim)' }),
  }, { description: 'Replace only the body of a plan .md file, leaving frontmatter byte-identical' }),
], { description: 'A single fix to apply to plan artifacts' });

export const planReviewSubmissionSchema = Type.Object({
  fixes: Type.Array(planReviewFixSchema, { description: 'Fixes to apply to plan artifacts; may be empty if no fixable issues were found' }),
});

export type PlanReviewSubmission = Static<typeof planReviewSubmissionSchema>;

/**
 * Schema for a single fix applied by the cohesion-reviewer agent.
 * Operates on module plan files in <planSet>/modules/.
 */
export const cohesionReviewFixSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('replace_plan_file', { description: 'Replace an entire module plan file (frontmatter + body)' }),
    planId: Type.String({ minLength: 1, description: 'Plan/module ID (e.g., auth) — used to resolve the file path under modules/' }),
    frontmatter: Type.Object({
      id: Type.String({ minLength: 1, description: 'Plan identifier' }),
      name: Type.String({ minLength: 1, description: 'Human-readable plan name' }),
      branch: Type.String({ minLength: 1, description: 'Git branch name for this plan' }),
      migrations: Type.Optional(Type.Array(Type.Object({
        timestamp: Type.String({ pattern: '^\\d{14}$', description: 'Migration timestamp in YYYYMMDDHHmmss format' }),
        description: Type.String({ description: 'Migration description' }),
      }), { description: 'Database migrations included in this plan' })),
      agents: planAgentsSchema,
    }, { description: 'Plan file frontmatter' }),
    body: Type.String({ description: 'Plan markdown body' }),
  }, { description: 'Replace an entire module plan .md file with new frontmatter and body' }),
  Type.Object({
    kind: Type.Literal('replace_plan_body', { description: 'Replace only the markdown body of a module plan file, preserving frontmatter' }),
    planId: Type.String({ minLength: 1, description: 'Plan/module ID — used to resolve the file path under modules/' }),
    body: Type.String({ description: 'New markdown body (frontmatter is preserved verbatim)' }),
  }, { description: 'Replace only the body of a module plan .md file, leaving frontmatter byte-identical' }),
], { description: 'A single fix to apply to module plan artifacts' });

export const cohesionReviewSubmissionSchema = Type.Object({
  fixes: Type.Array(cohesionReviewFixSchema, { description: 'Fixes to apply to module plan artifacts; may be empty if no fixable issues were found' }),
});

export type CohesionReviewSubmission = Static<typeof cohesionReviewSubmissionSchema>;

/**
 * Schema for a single fix applied by the architecture-reviewer agent.
 * Operates on the architecture.md file in <planSet>/.
 */
export const architectureReviewFixSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('replace_architecture', { description: 'Replace the entire architecture.md content' }),
    content: Type.String({ minLength: 1, description: 'New architecture.md markdown content' }),
  }, { description: 'Replace the entire architecture.md file' }),
], { description: 'A single fix to apply to architecture artifacts' });

export const architectureReviewSubmissionSchema = Type.Object({
  fixes: Type.Array(architectureReviewFixSchema, { description: 'Fixes to apply to architecture artifacts; may be empty if no fixable issues were found' }),
});

export type ArchitectureReviewSubmission = Static<typeof architectureReviewSubmissionSchema>;

/** Schema YAML for plan-reviewer fix submissions. */
export function getPlanReviewSubmissionSchemaYaml(): string {
  return getSchemaYaml('plan-review-submission', planReviewSubmissionSchema);
}

/** Schema YAML for cohesion-reviewer fix submissions. */
export function getCohesionReviewSubmissionSchemaYaml(): string {
  return getSchemaYaml('cohesion-review-submission', cohesionReviewSubmissionSchema);
}

/** Schema YAML for architecture-reviewer fix submissions. */
export function getArchitectureReviewSubmissionSchemaYaml(): string {
  return getSchemaYaml('architecture-review-submission', architectureReviewSubmissionSchema);
}

// ---------------------------------------------------------------------------
// Pipeline Composition schema
// ---------------------------------------------------------------------------

export const pipelineCompositionSchema = Type.Object({
  scope: Type.Union(
    [Type.Literal('errand'), Type.Literal('excursion'), Type.Literal('expedition')],
    { description: 'Orchestration scope: errand for trivial tasks, excursion for most work, expedition for 4+ independent subsystems' },
  ),
  compile: Type.Array(Type.String(), { description: 'Ordered list of compile stage names from the stage catalog' }),
  defaultBuild: Type.Array(pipelineBuildStageSpecSchema, {
    description: 'Default build stage pipeline - each entry is a stage name or array of parallel stage names',
  }),
  defaultReview: Type.Object(pipelineReviewProfileConfigSchema.properties, {
    description: 'Default review configuration for build plans',
  }),
  rationale: Type.String({ minLength: 1, description: 'Explanation of why this pipeline composition was chosen' }),
});

export type PipelineComposition = Static<typeof pipelineCompositionSchema>;

/** Schema YAML for pipeline composition (used by pipeline-composer agent). */
export function getPipelineCompositionSchemaYaml(): string {
  return getSchemaYaml('pipeline-composition', pipelineCompositionSchema);
}

// ---------------------------------------------------------------------------
// Convenience re-export of safeParseWithSchema for engine-internal consumers
// ---------------------------------------------------------------------------
export { safeParseWithSchema };
