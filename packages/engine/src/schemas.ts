/**
 * Zod schemas for all structured XML blocks emitted by eforge agents.
 * Leaf-level file — imports only zod/v4 and yaml, no engine imports.
 *
 * Pattern: define Zod schemas with `.describe()`, convert to YAML via
 * `z.toJSONSchema()`, inject into prompts. Matches getProfileSchemaYaml()
 * in config.ts.
 */
import { z } from 'zod/v4';
import { stringify as stringifyYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

const severitySchema = z.enum(['critical', 'warning', 'suggestion'])
  .describe('Issue severity: critical = must fix before merge, warning = should fix, suggestion = nice to have');

// ---------------------------------------------------------------------------
// Per-perspective category enums
// ---------------------------------------------------------------------------

/** General reviewer (single-reviewer mode) categories. */
const generalCategorySchema = z.enum([
  'bugs', 'security', 'error-handling', 'edge-cases',
  'types', 'dry', 'performance', 'maintainability',
]).describe('Review category for the general perspective');

/** Code quality specialist categories. */
const codeCategorySchema = z.enum([
  'bugs', 'error-handling', 'edge-cases',
  'types', 'dry', 'performance', 'maintainability',
]).describe('Review category for the code perspective');

/** Security specialist categories. */
const securityCategorySchema = z.enum([
  'injection', 'secrets', 'auth', 'unsafe-ops',
  'cryptography', 'dependencies', 'data-exposure',
]).describe('Review category for the security perspective');

/** API design specialist categories. */
const apiCategorySchema = z.enum([
  'rest-conventions', 'contracts', 'input-validation',
  'breaking-changes', 'error-responses', 'versioning',
]).describe('Review category for the api perspective');

/** Documentation specialist categories. */
const docsCategorySchema = z.enum([
  'code-examples', 'env-vars', 'stale-docs',
  'completeness', 'readme',
]).describe('Review category for the docs perspective');

/** Test quality specialist categories. */
const testCategorySchema = z.enum([
  'coverage-gaps', 'test-quality', 'test-isolation',
  'fixtures', 'assertions', 'flaky-patterns', 'test-design',
]).describe('Review category for the test perspective');

// ---------------------------------------------------------------------------
// TestIssue schemas
// ---------------------------------------------------------------------------

const testIssueCategorySchema = z.enum([
  'production-bug', 'missing-behavior', 'regression',
]).describe('Category of test-discovered issue');

const testIssueSeveritySchema = z.enum(['critical', 'warning'])
  .describe('Test issue severity: critical = failing test, warning = missing coverage');

export const testIssueSchema = z.object({
  severity: testIssueSeveritySchema,
  category: testIssueCategorySchema,
  file: z.string().describe('Production file with the bug'),
  testFile: z.string().describe('Test file that exposed the issue'),
  description: z.string().min(1).describe('Description of the issue'),
  testOutput: z.string().optional().describe('Relevant test failure output'),
  fix: z.string().optional().describe('Description of unstaged fix applied'),
});

/** Plan reviewer and cohesion reviewer categories. */
const planReviewCategorySchema = z.enum([
  'cohesion', 'completeness', 'correctness',
  'feasibility', 'dependency', 'scope',
]).describe('Review category for plan reviews');

// ---------------------------------------------------------------------------
// ReviewIssue schema
// ---------------------------------------------------------------------------

/** Base review issue schema with string category (union of all perspectives). */
export const reviewIssueSchema = z.object({
  severity: severitySchema,
  category: z.string().describe('Review category — allowed values depend on the review perspective'),
  file: z.string().describe('Relative file path from the repository root'),
  line: z.number().int().positive().optional().describe('Line number in the file (optional)'),
  description: z.string().min(1).describe('Description of the issue'),
  fix: z.string().optional().describe('Description of the fix applied, if any'),
});

// ---------------------------------------------------------------------------
// EvaluationVerdict schema
// ---------------------------------------------------------------------------

export const evaluationEvidenceSchema = z.object({
  staged: z.string().describe('What the staged/original code does'),
  fix: z.string().describe("What the reviewer's fix does"),
  rationale: z.string().describe('Why the verdict was chosen'),
  ifAccepted: z.string().describe('Consequence if the fix is accepted'),
  ifRejected: z.string().describe('Consequence if the fix is rejected'),
});

export const evaluationVerdictSchema = z.object({
  file: z.string().describe('File path being evaluated'),
  action: z.enum(['accept', 'reject', 'review']).describe('Verdict action'),
  reason: z.string().describe('Reason for the verdict'),
  evidence: evaluationEvidenceSchema.optional().describe('Structured evidence when the evaluator uses child elements'),
  hunk: z.number().int().positive().optional().describe('Hunk number for per-hunk evaluation (1-indexed)'),
});

// ---------------------------------------------------------------------------
// Clarification schema
// ---------------------------------------------------------------------------

export const clarificationQuestionSchema = z.object({
  id: z.string().describe('Unique question identifier'),
  question: z.string().describe('The question text'),
  context: z.string().optional().describe('Additional context for the question'),
  options: z.array(z.string()).optional().describe('Suggested answer options'),
  default: z.string().optional().describe('Default answer value'),
});

// ---------------------------------------------------------------------------
// Staleness schema
// ---------------------------------------------------------------------------

export const stalenessVerdictSchema = z.object({
  verdict: z.enum(['proceed', 'revise', 'obsolete']).describe('Staleness assessment verdict'),
  justification: z.string().min(1).describe('Reason for the verdict'),
  revision: z.string().optional().describe('Revised PRD content when verdict is revise'),
});

// ---------------------------------------------------------------------------
// Expedition module schema
// ---------------------------------------------------------------------------

export const expeditionModuleSchema = z.object({
  id: z.string().describe('Module identifier'),
  description: z.string().describe('Module description'),
  dependsOn: z.array(z.string()).describe('IDs of modules this module depends on'),
});

// ---------------------------------------------------------------------------
// Agent Tuning schema (effort/thinking overrides per agent role)
// ---------------------------------------------------------------------------

// Effort and thinking schemas duplicated from config.ts to keep schemas.ts leaf-level
const effortLevelForTuningSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
  .describe('Effort level for thinking depth. Set xhigh only for modules with significant ambiguity, novel API design, or large refactors. Omit to use the role default.');

const thinkingForTuningSchema = z.union([
  z.object({ type: z.literal('adaptive') }),
  z.object({ type: z.literal('enabled'), budgetTokens: z.number().int().positive().optional() }),
  z.object({ type: z.literal('disabled') }),
]).describe("Controls the agent's thinking/reasoning behavior");

export const agentTuningSchema = z.object({
  effort: effortLevelForTuningSchema.optional(),
  thinking: thinkingForTuningSchema.optional(),
  rationale: z.string().optional().describe('Why this tuning was chosen'),
}).describe('Per-agent effort/thinking tuning');

const planAgentsSchema = z.object({
  builder: agentTuningSchema.optional(),
  reviewer: agentTuningSchema.optional(),
  'review-fixer': agentTuningSchema.optional(),
  evaluator: agentTuningSchema.optional(),
  'doc-updater': agentTuningSchema.optional(),
  'test-writer': agentTuningSchema.optional(),
  tester: agentTuningSchema.optional(),
}).optional().describe('Per-agent tuning overrides for build-stage agents in this plan');

// ---------------------------------------------------------------------------
// PlanFile frontmatter schema
// ---------------------------------------------------------------------------

export const planFileFrontmatterSchema = z.object({
  id: z.string().describe('Plan identifier (e.g., plan-01-auth)'),
  name: z.string().describe('Human-readable plan name'),
  dependsOn: z.array(z.string()).describe('IDs of plans this plan depends on'),
  branch: z.string().describe('Git branch name for this plan'),
  migrations: z.array(z.object({
    timestamp: z.string().describe('Migration timestamp'),
    description: z.string().describe('Migration description'),
  })).optional().describe('Database migrations included in this plan'),
  agents: planAgentsSchema,
});

// ---------------------------------------------------------------------------
// Schema YAML generation with caching
// ---------------------------------------------------------------------------

const _schemaYamlCache = new Map<string, string>();

/**
 * Convert a Zod schema to a YAML string documenting all fields and their
 * descriptions. Uses z.toJSONSchema() and strips internal keys ($schema,
 * ~standard). Cached per key since schemas are static.
 */
export function getSchemaYaml(key: string, schema: z.ZodType): string {
  const cached = _schemaYamlCache.get(key);
  if (cached !== undefined) return cached;

  const jsonSchema = z.toJSONSchema(schema);

  function stripInternalKeys(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [k, value] of Object.entries(obj)) {
      if (k === '$schema' || k === '~standard') continue;
      if (Array.isArray(value)) {
        result[k] = value.map((item) =>
          item && typeof item === 'object' && !Array.isArray(item)
            ? stripInternalKeys(item as Record<string, unknown>)
            : item,
        );
      } else if (value && typeof value === 'object') {
        result[k] = stripInternalKeys(value as Record<string, unknown>);
      } else {
        result[k] = value;
      }
    }
    return result;
  }

  const cleaned = stripInternalKeys(jsonSchema as Record<string, unknown>);
  const yaml = stringifyYaml(cleaned);
  _schemaYamlCache.set(key, yaml);
  return yaml;
}

// ---------------------------------------------------------------------------
// Per-perspective ReviewIssue schema builders
// ---------------------------------------------------------------------------

function makeReviewIssueSchemaWithCategory(categorySchema: z.ZodType): z.ZodObject {
  return reviewIssueSchema.extend({
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

/** Schema YAML for clarification questions (used by planner). */
export function getClarificationSchemaYaml(): string {
  return getSchemaYaml('clarification-question', clarificationQuestionSchema);
}

/** Schema YAML for staleness verdicts (used by staleness-assessor). */
export function getStalenessSchemaYaml(): string {
  return getSchemaYaml('staleness-verdict', stalenessVerdictSchema);
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
// Plan Set Submission schema
// ---------------------------------------------------------------------------

const planSetSubmissionPlanSchema = z.object({
  frontmatter: z.object({
    id: z.string().min(1).describe('Plan identifier (e.g., plan-01-auth)'),
    name: z.string().min(1).describe('Human-readable plan name'),
    dependsOn: z.array(z.string()).describe('IDs of plans this plan depends on'),
    branch: z.string().min(1).describe('Git branch name for this plan'),
    migrations: z.array(z.object({
      timestamp: z.string().regex(/^\d{14}$/, 'Migration timestamp must be 14 digits (YYYYMMDDHHmmss)').describe('Migration timestamp in YYYYMMDDHHmmss format'),
      description: z.string().min(1).describe('Migration description'),
    })).optional().describe('Database migrations included in this plan'),
    agents: planAgentsSchema,
  }),
  body: z.string().describe('Plan markdown body'),
});

const orchestrationPlanSchema = z.object({
  id: z.string().min(1).describe('Plan ID matching a submitted plan'),
  name: z.string().min(1).describe('Human-readable plan name'),
  dependsOn: z.array(z.string()).describe('IDs of plans this plan depends on'),
  branch: z.string().min(1).describe('Git branch name'),
});

export const planSetSubmissionSchema = z.object({
  name: z.string().min(1).describe('Plan set name (kebab-case)'),
  description: z.string().min(1).describe('Plan set description'),
  mode: z.enum(['errand', 'excursion', 'expedition']).describe('Orchestration mode'),
  baseBranch: z.string().min(1).describe('Base git branch'),
  plans: z.array(planSetSubmissionPlanSchema).min(1).describe('Plan files to write'),
  orchestration: z.object({
    validate: z.array(z.string()).describe('Validation commands to run'),
    plans: z.array(orchestrationPlanSchema).min(1).describe('Orchestration plan entries'),
  }).describe('Orchestration configuration'),
}).superRefine((data, ctx) => {
  // Check for duplicate plan IDs
  const planIds = data.plans.map(p => p.frontmatter.id);
  const seen = new Set<string>();
  for (const id of planIds) {
    if (seen.has(id)) {
      ctx.addIssue({
        code: 'custom',
        message: `Duplicate plan ID: "${id}"`,
        path: ['plans'],
      });
    }
    seen.add(id);
  }

  const planIdSet = new Set(planIds);

  // Check for dangling dependsOn references
  for (let i = 0; i < data.plans.length; i++) {
    for (const dep of data.plans[i].frontmatter.dependsOn) {
      if (!planIdSet.has(dep)) {
        ctx.addIssue({
          code: 'custom',
          message: `Plan "${data.plans[i].frontmatter.id}" depends on unknown plan "${dep}"`,
          path: ['plans', i, 'frontmatter', 'dependsOn'],
        });
      }
    }
  }

  // Check for dependency cycles using DFS
  const adjMap = new Map<string, string[]>();
  for (const plan of data.plans) {
    adjMap.set(plan.frontmatter.id, plan.frontmatter.dependsOn);
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
      ctx.addIssue({
        code: 'custom',
        message: 'Dependency cycle detected among plans',
        path: ['plans'],
      });
      break;
    }
  }

  // Check orchestration plan IDs match submitted plan IDs (also detect duplicates)
  const orchIds = new Set(data.orchestration.plans.map(p => p.id));
  if (orchIds.size !== data.orchestration.plans.length) {
    ctx.addIssue({
      code: 'custom',
      message: `Orchestration contains duplicate plan IDs`,
      path: ['orchestration', 'plans'],
    });
  }
  if (orchIds.size !== planIdSet.size || ![...orchIds].every(id => planIdSet.has(id))) {
    ctx.addIssue({
      code: 'custom',
      message: `Orchestration plan IDs [${[...orchIds].join(', ')}] do not match submitted plan IDs [${[...planIdSet].join(', ')}]`,
      path: ['orchestration', 'plans'],
    });
  }
});

export type PlanSetSubmission = z.output<typeof planSetSubmissionSchema>;

// ---------------------------------------------------------------------------
// Architecture Submission schema
// ---------------------------------------------------------------------------

const architectureModuleSchema = z.object({
  id: z.string().min(1).describe('Module identifier'),
  description: z.string().min(1).describe('Module description'),
  dependsOn: z.array(z.string()).describe('IDs of modules this module depends on'),
});

export const architectureSubmissionSchema = z.object({
  architecture: z.string().min(1).describe('Architecture document markdown content'),
  modules: z.array(architectureModuleSchema).min(1).describe('Modules in the architecture'),
  index: z.object({
    name: z.string().min(1).describe('Plan set name'),
    description: z.string().describe('Plan set description'),
    mode: z.literal('expedition').describe('Orchestration mode'),
    validate: z.array(z.string()).describe('Validation commands to run'),
    modules: z.record(z.string(), z.object({
      description: z.string().describe('Module description'),
      depends_on: z.array(z.string()).describe('Module dependencies'),
    })).describe('Module map for index.yaml'),
  }).describe('Index metadata for expedition plan set'),
}).superRefine((data, ctx) => {
  const moduleIds = new Set(data.modules.map(m => m.id));

  // Check for duplicate module IDs
  if (moduleIds.size !== data.modules.length) {
    ctx.addIssue({
      code: 'custom',
      message: 'Architecture contains duplicate module IDs',
      path: ['modules'],
    });
  }

  // Check for dangling dependsOn references
  for (let i = 0; i < data.modules.length; i++) {
    for (const dep of data.modules[i].dependsOn) {
      if (!moduleIds.has(dep)) {
        ctx.addIssue({
          code: 'custom',
          message: `Module "${data.modules[i].id}" depends on unknown module "${dep}"`,
          path: ['modules', i, 'dependsOn'],
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
      ctx.addIssue({
        code: 'custom',
        message: 'Dependency cycle detected among modules',
        path: ['modules'],
      });
      break;
    }
  }
});

export type ArchitectureSubmission = z.output<typeof architectureSubmissionSchema>;

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
// Pipeline Composition schema
// ---------------------------------------------------------------------------

/**
 * Build stage spec for pipeline composition — mirrors buildStageSpecSchema from config.ts.
 * Duplicated here to keep schemas.ts as a leaf-level file (no engine imports).
 */
const pipelineBuildStageSpecSchema = z.union([
  z.string().describe('A single stage name'),
  z.array(z.string()).describe('Stage names to run in parallel'),
]).describe('A stage name or array of stage names to run in parallel');

/**
 * Review profile config for pipeline composition — mirrors reviewProfileConfigSchema from config.ts.
 * Duplicated here to keep schemas.ts as a leaf-level file (no engine imports).
 */
const pipelineReviewProfileConfigSchema = z.object({
  strategy: z.enum(['auto', 'single', 'parallel']).describe('Review strategy'),
  perspectives: z.array(z.string()).nonempty().describe('Review perspective names'),
  maxRounds: z.number().int().positive().describe('Number of review-fix-evaluate cycles'),
  autoAcceptBelow: z.enum(['suggestion', 'warning']).optional().describe('Auto-accept issues at or below this severity'),
  evaluatorStrictness: z.enum(['strict', 'standard', 'lenient']).describe('How strictly the evaluator judges fixes'),
});

export const pipelineCompositionSchema = z.object({
  scope: z.enum(['errand', 'excursion', 'expedition']).describe('Orchestration scope: errand for trivial tasks, excursion for most work, expedition for 4+ independent subsystems'),
  compile: z.array(z.string()).describe('Ordered list of compile stage names from the stage catalog'),
  defaultBuild: z.array(pipelineBuildStageSpecSchema).describe('Default build stage pipeline - each entry is a stage name or array of parallel stage names'),
  defaultReview: pipelineReviewProfileConfigSchema.describe('Default review configuration for build plans'),
  rationale: z.string().min(1).describe('Explanation of why this pipeline composition was chosen'),
});

export type PipelineComposition = z.output<typeof pipelineCompositionSchema>;

/** Schema YAML for pipeline composition (used by pipeline-composer agent). */
export function getPipelineCompositionSchemaYaml(): string {
  return getSchemaYaml('pipeline-composition', pipelineCompositionSchema);
}
