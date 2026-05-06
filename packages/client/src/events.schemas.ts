/**
 * Wire event schemas for the eforge daemon SSE stream.
 *
 * This file is the wire-protocol source of truth. `EforgeEvent` is derived
 * from `EforgeEventSchema` via `z.infer`, so TypeScript types and Zod
 * runtime validators are always in sync.
 *
 * Event types and schemas are co-located: every discriminant variant lives
 * here, alongside its schema. Do not define event shapes in other files.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ORCHESTRATION_MODES = ['errand', 'excursion', 'expedition'] as const;

// ---------------------------------------------------------------------------
// Supporting schemas
// ---------------------------------------------------------------------------

const AgentRoleSchema = z.enum([
  'planner',
  'builder',
  'reviewer',
  'review-fixer',
  'evaluator',
  'module-planner',
  'plan-reviewer',
  'plan-evaluator',
  'architecture-reviewer',
  'architecture-evaluator',
  'cohesion-reviewer',
  'cohesion-evaluator',
  'validation-fixer',
  'merge-conflict-resolver',
  'staleness-assessor',
  'formatter',
  'doc-author',
  'doc-syncer',
  'test-writer',
  'tester',
  'prd-validator',
  'dependency-detector',
  'pipeline-composer',
  'gap-closer',
  'recovery-analyst',
]);

const AgentTerminalSubtypeSchema = z.enum([
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
  'error_during_execution',
]);

export const REVIEW_PERSPECTIVES = ['code', 'security', 'api', 'docs', 'test', 'verify'] as const;
const ReviewPerspectiveSchema = z.enum(REVIEW_PERSPECTIVES);

const StalenessVerdictSchema = z.enum(['proceed', 'revise', 'obsolete']);

const RecoveryVerdictSchema = z.object({
  verdict: z.enum(['retry', 'split', 'abandon', 'manual']),
  confidence: z.enum(['low', 'medium', 'high']),
  rationale: z.string(),
  completedWork: z.array(z.string()),
  remainingWork: z.array(z.string()),
  risks: z.array(z.string()),
  suggestedSuccessorPrd: z.string().optional(),
  partial: z.boolean().optional(),
  recoveryError: z.string().optional(),
});

const ShardScopeSchema = z.object({
  id: z.string(),
  roots: z.array(z.string()).optional(),
  files: z.array(z.string()).optional(),
});

const BuildStageSpecSchema = z.union([z.string(), z.array(z.string())]);

const ReviewProfileConfigSchema = z.object({
  strategy: z.enum(['auto', 'single', 'parallel']),
  perspectives: z.array(ReviewPerspectiveSchema),
  maxRounds: z.number(),
  autoAcceptBelow: z.enum(['suggestion', 'warning']).optional(),
  evaluatorStrictness: z.enum(['strict', 'standard', 'lenient']),
});

const PipelineCompositionSchema = z.object({
  scope: z.enum(['errand', 'excursion', 'expedition']),
  compile: z.array(z.string()),
  defaultBuild: z.array(BuildStageSpecSchema),
  defaultReview: ReviewProfileConfigSchema,
  rationale: z.string(),
});

const PrdValidationGapSchema = z.object({
  requirement: z.string(),
  explanation: z.string(),
  complexity: z.enum(['trivial', 'moderate', 'significant']).optional(),
});

const ExpeditionModuleSchema = z.object({
  id: z.string(),
  description: z.string(),
  dependsOn: z.array(z.string()),
});

const EforgeResultSchema = z.object({
  status: z.enum(['completed', 'failed', 'skipped']),
  summary: z.string(),
});

const ClarificationQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  context: z.string().optional(),
  options: z.array(z.string()).optional(),
  default: z.string().optional(),
});

const ReviewIssueSchema = z.object({
  severity: z.enum(['critical', 'warning', 'suggestion']),
  category: z.string(),
  file: z.string(),
  line: z.number().optional(),
  description: z.string(),
  fix: z.string().optional(),
});

const TestIssueSchema = z.object({
  severity: z.enum(['critical', 'warning']),
  category: z.enum(['production-bug', 'missing-behavior', 'regression']),
  file: z.string(),
  testFile: z.string(),
  description: z.string(),
  testOutput: z.string().optional(),
  fix: z.string().optional(),
});

const PlanFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  dependsOn: z.array(z.string()),
  branch: z.string(),
  migrations: z
    .array(z.object({ timestamp: z.string(), description: z.string() }))
    .optional(),
  agents: z
    .record(
      z.string(),
      z.object({
        effort: z.string().optional(),
        thinking: z.union([z.boolean(), z.object({}).passthrough()]).optional(),
        rationale: z.string().optional(),
        tier: z.string().optional(),
        shards: z.array(ShardScopeSchema).optional(),
      }),
    )
    .optional(),
  body: z.string(),
  filePath: z.string(),
  warnings: z.array(z.string()).optional(),
});

const OrchestrationConfigSchema = z.object({
  name: z.string(),
  description: z.string(),
  created: z.string(),
  mode: z.enum(ORCHESTRATION_MODES),
  baseBranch: z.string(),
  pipeline: PipelineCompositionSchema,
  plans: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      dependsOn: z.array(z.string()),
      branch: z.string(),
      build: z.array(BuildStageSpecSchema),
      review: ReviewProfileConfigSchema,
      maxContinuations: z.number().optional(),
      agents: z
        .record(
          z.string(),
          z.object({
            effort: z.string().optional(),
            thinking: z.union([z.boolean(), z.object({}).passthrough()]).optional(),
            rationale: z.string().optional(),
            tier: z.string().optional(),
          }),
        )
        .optional(),
    }),
  ),
  validate: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
});

const PlanStateSchema = z.object({
  status: z.enum(['pending', 'running', 'completed', 'failed', 'blocked', 'merged']),
  worktreePath: z.string().optional(),
  branch: z.string(),
  dependsOn: z.array(z.string()),
  merged: z.boolean(),
  error: z.string().optional(),
});

const EforgeStateSchema = z.object({
  setName: z.string(),
  status: z.enum(['running', 'completed', 'failed']),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  baseBranch: z.string(),
  featureBranch: z.string().optional(),
  worktreeBase: z.string(),
  mergeWorktreePath: z.string().optional(),
  plans: z.record(z.string(), PlanStateSchema),
  completedPlans: z.array(z.string()),
});

const AgentResultDataSchema = z.object({
  durationMs: z.number(),
  durationApiMs: z.number(),
  numTurns: z.number(),
  totalCostUsd: z.number(),
  usage: z.object({
    input: z.number(),
    output: z.number(),
    total: z.number(),
    cacheRead: z.number(),
    cacheCreation: z.number(),
  }),
  modelUsage: z.record(
    z.string(),
    z.object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheReadInputTokens: z.number(),
      cacheCreationInputTokens: z.number(),
      costUSD: z.number(),
    }),
  ),
  resultText: z.string().optional(),
});

const ReconciliationReportSchema = z.object({
  valid: z.array(z.string()),
  missing: z.array(z.string()),
  corrupt: z.array(z.string()),
  cleared: z.array(z.string()),
});

const EforgeStatusSchema = z.object({
  running: z.boolean(),
  setName: z.string().optional(),
  plans: z.record(z.string(), PlanStateSchema.shape.status),
  completedPlans: z.array(z.string()),
});

const LandedCommitSchema = z.object({
  sha: z.string(),
  subject: z.string(),
  author: z.string(),
  date: z.string(),
});

const PlanSummaryEntrySchema = z.object({
  planId: z.string(),
  status: z.string(),
  mergedAt: z.string().optional(),
  error: z.string().optional(),
  terminalSubtype: z.string().optional(),
});

const FailingPlanEntrySchema = z.object({
  planId: z.string(),
  agentId: z.string().optional(),
  agentRole: z.string().optional(),
  errorMessage: z.string().optional(),
  terminalSubtype: z.string().optional(),
});

const BuildFailureSummarySchema = z.object({
  prdId: z.string(),
  setName: z.string(),
  featureBranch: z.string(),
  baseBranch: z.string(),
  plans: z.array(PlanSummaryEntrySchema),
  failingPlan: FailingPlanEntrySchema,
  landedCommits: z.array(LandedCommitSchema),
  diffStat: z.string(),
  modelsUsed: z.array(z.string()),
  failedAt: z.string(),
  partial: z.boolean().optional(),
  prdContent: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Queue event schemas
// ---------------------------------------------------------------------------

const QueueEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('queue:start'), prdCount: z.number(), dir: z.string() }),
  z.object({ type: z.literal('queue:prd:start'), prdId: z.string(), title: z.string() }),
  z.object({ type: z.literal('queue:prd:discovered'), prdId: z.string(), title: z.string() }),
  z.object({
    type: z.literal('queue:prd:stale'),
    verdict: StalenessVerdictSchema,
    justification: z.string(),
    revision: z.string().optional(),
  }),
  z.object({ type: z.literal('queue:prd:skip'), prdId: z.string(), reason: z.string() }),
  z.object({ type: z.literal('queue:prd:commit-failed'), prdId: z.string(), error: z.string() }),
  z.object({
    type: z.literal('queue:prd:complete'),
    prdId: z.string(),
    status: z.enum(['completed', 'failed', 'skipped']),
  }),
  z.object({ type: z.literal('queue:complete'), processed: z.number(), skipped: z.number() }),
]);

// ---------------------------------------------------------------------------
// Base schema (sessionId, runId, timestamp envelope)
// ---------------------------------------------------------------------------

const EventEnvelopeSchema = z.object({
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  timestamp: z.string(),
});

// ---------------------------------------------------------------------------
// All EforgeEvent discriminant variants as Zod schemas
// ---------------------------------------------------------------------------

const agentStartFields = {
  planId: z.string().optional(),
  agentId: z.string(),
  agent: AgentRoleSchema,
  model: z.string(),
  harness: z.enum(['claude-sdk', 'pi']),
  harnessSource: z.literal('tier'),
  tier: z.string(),
  tierSource: z.enum(['tier', 'role', 'plan']),
  effort: z.string().optional(),
  effortSource: z.enum(['tier', 'role', 'plan']).optional(),
  thinking: z.object({}).passthrough().optional(),
  thinkingSource: z.enum(['tier', 'role', 'plan']).optional(),
  effortClamped: z.boolean().optional(),
  effortOriginal: z.string().optional(),
  thinkingCoerced: z.boolean().optional(),
  thinkingOriginal: z.object({}).passthrough().optional(),
  perspective: z.string().optional(),
};

const EforgeEventVariantsSchema = z.discriminatedUnion('type', [
  // Session lifecycle
  z.object({ type: z.literal('session:start'), sessionId: z.string() }),
  z.object({ type: z.literal('session:end'), sessionId: z.string(), result: EforgeResultSchema }),
  z.object({
    type: z.literal('session:profile'),
    profileName: z.string().nullable(),
    source: z.enum(['local', 'project', 'user-local', 'missing', 'none']),
    scope: z.enum(['local', 'project', 'user']).nullable(),
    config: z.unknown().nullable(),
  }),

  // Phase lifecycle
  z.object({
    type: z.literal('phase:start'),
    runId: z.string(),
    planSet: z.string(),
    command: z.enum(['compile', 'build']),
  }),
  z.object({ type: z.literal('phase:end'), runId: z.string(), result: EforgeResultSchema }),

  // Config and plan warnings
  z.object({
    type: z.literal('config:warning'),
    message: z.string(),
    source: z.string(),
    details: z.string().optional(),
  }),
  z.object({
    type: z.literal('planning:warning'),
    planId: z.string().optional(),
    message: z.string(),
    source: z.string(),
    details: z.string().optional(),
  }),
  z.object({
    type: z.literal('planning:module:build-config:invalid'),
    moduleId: z.string(),
    reason: z.enum(['invalid-json', 'invalid-schema']),
    errors: z.array(z.string()),
  }),

  // Planning
  z.object({ type: z.literal('planning:start'), source: z.string(), label: z.string().optional() }),
  z.object({ type: z.literal('planning:skip'), reason: z.string() }),
  z.object({
    type: z.literal('planning:submission'),
    planCount: z.number(),
    totalBodySize: z.number(),
    hasMigrations: z.boolean(),
  }),
  z.object({ type: z.literal('planning:error'), reason: z.string() }),
  z.object({ type: z.literal('planning:clarification'), questions: z.array(ClarificationQuestionSchema) }),
  z.object({ type: z.literal('planning:clarification:answer'), answers: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal('planning:progress'), message: z.string() }),
  z.object({
    type: z.literal('planning:continuation'),
    attempt: z.number(),
    maxContinuations: z.number(),
    reason: z.enum(['max_turns', 'dropped_submission']).optional(),
  }),
  z.object({
    type: z.literal('planning:pipeline'),
    scope: z.string(),
    compile: z.array(z.string()),
    defaultBuild: z.array(BuildStageSpecSchema),
    defaultReview: ReviewProfileConfigSchema,
    rationale: z.string(),
  }),
  z.object({
    type: z.literal('planning:complete'),
    plans: z.array(PlanFileSchema),
    planConfigs: z
      .array(
        z.object({
          id: z.string(),
          build: z.array(BuildStageSpecSchema).optional(),
          review: ReviewProfileConfigSchema.optional(),
        }),
      )
      .optional(),
  }),

  // Planning review
  z.object({ type: z.literal('planning:review:start') }),
  z.object({ type: z.literal('planning:review:complete'), issues: z.array(ReviewIssueSchema) }),
  z.object({ type: z.literal('planning:evaluate:start') }),
  z.object({
    type: z.literal('planning:evaluate:continuation'),
    attempt: z.number(),
    maxContinuations: z.number(),
  }),
  z.object({
    type: z.literal('planning:evaluate:complete'),
    accepted: z.number(),
    rejected: z.number(),
    verdicts: z
      .array(
        z.object({
          file: z.string(),
          action: z.enum(['accept', 'reject', 'review']),
          reason: z.string(),
        }),
      )
      .optional(),
  }),

  // Architecture review
  z.object({ type: z.literal('planning:architecture:review:start') }),
  z.object({
    type: z.literal('planning:architecture:review:complete'),
    issues: z.array(ReviewIssueSchema),
  }),
  z.object({ type: z.literal('planning:architecture:evaluate:start') }),
  z.object({
    type: z.literal('planning:architecture:evaluate:continuation'),
    attempt: z.number(),
    maxContinuations: z.number(),
  }),
  z.object({
    type: z.literal('planning:architecture:evaluate:complete'),
    accepted: z.number(),
    rejected: z.number(),
    verdicts: z
      .array(
        z.object({
          file: z.string(),
          action: z.enum(['accept', 'reject', 'review']),
          reason: z.string(),
        }),
      )
      .optional(),
  }),

  // Cohesion review
  z.object({ type: z.literal('planning:cohesion:start') }),
  z.object({
    type: z.literal('planning:cohesion:complete'),
    issues: z.array(ReviewIssueSchema),
  }),
  z.object({ type: z.literal('planning:cohesion:evaluate:start') }),
  z.object({
    type: z.literal('planning:cohesion:evaluate:continuation'),
    attempt: z.number(),
    maxContinuations: z.number(),
  }),
  z.object({
    type: z.literal('planning:cohesion:evaluate:complete'),
    accepted: z.number(),
    rejected: z.number(),
    verdicts: z
      .array(
        z.object({
          file: z.string(),
          action: z.enum(['accept', 'reject', 'review']),
          reason: z.string(),
        }),
      )
      .optional(),
  }),

  // Building (per-plan)
  z.object({ type: z.literal('plan:build:start'), planId: z.string() }),
  z.object({ type: z.literal('plan:build:implement:start'), planId: z.string() }),
  z.object({ type: z.literal('plan:build:implement:progress'), planId: z.string(), message: z.string() }),
  z.object({
    type: z.literal('plan:build:implement:continuation'),
    planId: z.string(),
    attempt: z.number(),
    maxContinuations: z.number(),
    shardId: z.string().optional(),
  }),
  z.object({ type: z.literal('plan:build:implement:complete'), planId: z.string() }),
  z.object({
    type: z.literal('plan:build:files_changed'),
    planId: z.string(),
    files: z.array(z.string()),
    diffs: z
      .array(z.object({ path: z.string(), diff: z.string() }))
      .optional(),
    baseBranch: z.string().optional(),
  }),
  z.object({ type: z.literal('plan:build:review:start'), planId: z.string() }),
  z.object({
    type: z.literal('plan:build:review:complete'),
    planId: z.string(),
    issues: z.array(ReviewIssueSchema),
  }),
  z.object({
    type: z.literal('plan:build:review:parallel:start'),
    planId: z.string(),
    perspectives: z.array(ReviewPerspectiveSchema),
  }),
  z.object({
    type: z.literal('plan:build:review:parallel:perspective:start'),
    planId: z.string(),
    perspective: ReviewPerspectiveSchema,
  }),
  z.object({
    type: z.literal('plan:build:review:parallel:perspective:complete'),
    planId: z.string(),
    perspective: ReviewPerspectiveSchema,
    issues: z.array(ReviewIssueSchema),
  }),
  z.object({
    type: z.literal('plan:build:review:parallel:perspective:error'),
    planId: z.string(),
    perspective: z.string(),
    error: z.string(),
  }),
  z.object({
    type: z.literal('plan:build:review:fix:start'),
    planId: z.string(),
    issueCount: z.number(),
  }),
  z.object({ type: z.literal('plan:build:review:fix:complete'), planId: z.string() }),
  z.object({ type: z.literal('plan:build:evaluate:start'), planId: z.string() }),
  z.object({
    type: z.literal('plan:build:evaluate:continuation'),
    planId: z.string(),
    attempt: z.number(),
    maxContinuations: z.number(),
  }),
  z.object({
    type: z.literal('plan:build:evaluate:complete'),
    planId: z.string(),
    accepted: z.number(),
    rejected: z.number(),
    verdicts: z
      .array(
        z.object({
          file: z.string(),
          action: z.enum(['accept', 'reject', 'review']),
          reason: z.string(),
        }),
      )
      .optional(),
  }),
  z.object({ type: z.literal('plan:build:doc-author:start'), planId: z.string() }),
  z.object({
    type: z.literal('plan:build:doc-author:complete'),
    planId: z.string(),
    docsAuthored: z.number(),
  }),
  z.object({ type: z.literal('plan:build:doc-sync:start'), planId: z.string() }),
  z.object({
    type: z.literal('plan:build:doc-sync:complete'),
    planId: z.string(),
    docsSynced: z.number(),
  }),
  z.object({ type: z.literal('plan:build:test:write:start'), planId: z.string() }),
  z.object({
    type: z.literal('plan:build:test:write:complete'),
    planId: z.string(),
    testsWritten: z.number(),
  }),
  z.object({ type: z.literal('plan:build:test:start'), planId: z.string() }),
  z.object({
    type: z.literal('plan:build:test:complete'),
    planId: z.string(),
    passed: z.number(),
    failed: z.number(),
    testBugsFixed: z.number(),
    productionIssues: z.array(TestIssueSchema),
  }),
  z.object({ type: z.literal('plan:build:complete'), planId: z.string() }),
  z.object({
    type: z.literal('plan:build:failed'),
    planId: z.string(),
    error: z.string(),
    terminalSubtype: AgentTerminalSubtypeSchema.optional(),
  }),
  z.object({ type: z.literal('plan:build:progress'), planId: z.string(), message: z.string() }),

  // Plan lifecycle state events (new in plan-01-foundation)
  z.object({
    type: z.literal('plan:status:change'),
    planId: z.string(),
    status: PlanStateSchema.shape.status,
  }),
  z.object({
    type: z.literal('plan:error:set'),
    planId: z.string(),
    error: z.string(),
  }),
  z.object({
    type: z.literal('plan:error:clear'),
    planId: z.string(),
  }),

  // Orchestration
  z.object({ type: z.literal('schedule:start'), planIds: z.array(z.string()) }),
  z.object({ type: z.literal('plan:schedule:ready'), planId: z.string(), reason: z.string() }),
  z.object({ type: z.literal('plan:merge:start'), planId: z.string() }),
  z.object({ type: z.literal('plan:merge:complete'), planId: z.string(), commitSha: z.string().optional() }),
  z.object({ type: z.literal('plan:merge:resolve:start'), planId: z.string() }),
  z.object({ type: z.literal('plan:merge:resolve:complete'), planId: z.string(), resolved: z.boolean() }),
  z.object({
    type: z.literal('merge:finalize:start'),
    featureBranch: z.string(),
    baseBranch: z.string(),
  }),
  z.object({
    type: z.literal('merge:finalize:complete'),
    featureBranch: z.string(),
    baseBranch: z.string(),
    commitSha: z.string().optional(),
  }),
  z.object({
    type: z.literal('merge:finalize:skipped'),
    featureBranch: z.string(),
    baseBranch: z.string(),
    reason: z.string(),
  }),

  // Merge worktree lifecycle events (new in plan-01-foundation)
  z.object({
    type: z.literal('merge:worktree:set'),
    path: z.string(),
  }),
  z.object({
    type: z.literal('merge:worktree:clear'),
  }),

  // Expedition planning phases
  z.object({
    type: z.literal('expedition:architecture:complete'),
    modules: z.array(ExpeditionModuleSchema),
  }),
  z.object({
    type: z.literal('expedition:wave:start'),
    wave: z.number(),
    moduleIds: z.array(z.string()),
  }),
  z.object({ type: z.literal('expedition:wave:complete'), wave: z.number() }),
  z.object({ type: z.literal('expedition:module:start'), moduleId: z.string() }),
  z.object({ type: z.literal('expedition:module:complete'), moduleId: z.string() }),
  z.object({ type: z.literal('expedition:compile:start') }),
  z.object({
    type: z.literal('expedition:compile:complete'),
    plans: z.array(PlanFileSchema),
  }),

  // Agent lifecycle
  z.object({ type: z.literal('agent:start'), ...agentStartFields }),
  z.object({
    type: z.literal('agent:warning'),
    planId: z.string().optional(),
    agentId: z.string(),
    agent: AgentRoleSchema,
    code: z.string(),
    message: z.string(),
  }),
  z.object({
    type: z.literal('agent:stop'),
    planId: z.string().optional(),
    agentId: z.string(),
    agent: AgentRoleSchema,
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal('agent:usage'),
    planId: z.string().optional(),
    agentId: z.string(),
    agent: AgentRoleSchema,
    usage: z.object({
      input: z.number(),
      output: z.number(),
      total: z.number(),
      cacheRead: z.number(),
      cacheCreation: z.number(),
    }),
    costUsd: z.number(),
    numTurns: z.number(),
    final: z.boolean().optional(),
  }),

  // Agent-level (verbose streaming)
  z.object({
    type: z.literal('agent:message'),
    planId: z.string().optional(),
    agentId: z.string(),
    agent: AgentRoleSchema,
    content: z.string(),
  }),
  z.object({
    type: z.literal('agent:tool_use'),
    planId: z.string().optional(),
    agentId: z.string(),
    agent: AgentRoleSchema,
    tool: z.string(),
    toolUseId: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('agent:tool_result'),
    planId: z.string().optional(),
    agentId: z.string(),
    agent: AgentRoleSchema,
    tool: z.string(),
    toolUseId: z.string(),
    output: z.string(),
  }),
  z.object({
    type: z.literal('agent:result'),
    planId: z.string().optional(),
    agent: AgentRoleSchema,
    result: AgentResultDataSchema,
  }),

  // Generic retry notification
  z.object({
    type: z.literal('agent:retry'),
    agent: AgentRoleSchema,
    attempt: z.number(),
    maxAttempts: z.number(),
    subtype: AgentTerminalSubtypeSchema,
    label: z.string(),
    planId: z.string().optional(),
    shardId: z.string().optional(),
  }),

  // Validation (post-merge)
  z.object({ type: z.literal('validation:start'), commands: z.array(z.string()) }),
  z.object({ type: z.literal('validation:command:start'), command: z.string() }),
  z.object({
    type: z.literal('validation:command:complete'),
    command: z.string(),
    exitCode: z.number(),
    output: z.string(),
  }),
  z.object({
    type: z.literal('validation:command:timeout'),
    command: z.string(),
    timeoutMs: z.number(),
    pid: z.number(),
  }),
  z.object({ type: z.literal('validation:complete'), passed: z.boolean() }),
  z.object({
    type: z.literal('validation:fix:start'),
    attempt: z.number(),
    maxAttempts: z.number(),
  }),
  z.object({ type: z.literal('validation:fix:complete'), attempt: z.number() }),

  // PRD validation
  z.object({ type: z.literal('prd_validation:start') }),
  z.object({
    type: z.literal('prd_validation:complete'),
    passed: z.boolean(),
    gaps: z.array(PrdValidationGapSchema),
    completionPercent: z.number().optional(),
  }),

  // Gap closing
  z.object({
    type: z.literal('gap_close:start'),
    gapCount: z.number().optional(),
    completionPercent: z.number().optional(),
  }),
  z.object({
    type: z.literal('gap_close:plan_ready'),
    planBody: z.string(),
    gaps: z.array(PrdValidationGapSchema),
  }),
  z.object({ type: z.literal('gap_close:complete'), passed: z.boolean().optional() }),

  // Reconciliation
  z.object({ type: z.literal('reconciliation:start') }),
  z.object({
    type: z.literal('reconciliation:complete'),
    report: ReconciliationReportSchema,
  }),

  // Cleanup
  z.object({ type: z.literal('cleanup:start'), planSet: z.string() }),
  z.object({ type: z.literal('cleanup:complete'), planSet: z.string() }),

  // User interaction
  z.object({
    type: z.literal('approval:needed'),
    planId: z.string().optional(),
    action: z.string(),
    details: z.string(),
  }),
  z.object({ type: z.literal('approval:response'), approved: z.boolean() }),

  // Enqueue
  z.object({ type: z.literal('enqueue:start'), source: z.string() }),
  z.object({
    type: z.literal('enqueue:complete'),
    id: z.string(),
    filePath: z.string(),
    title: z.string(),
  }),
  z.object({ type: z.literal('enqueue:failed'), error: z.string() }),
  z.object({ type: z.literal('enqueue:commit-failed'), error: z.string() }),

  // Recovery analysis
  z.object({ type: z.literal('recovery:start'), prdId: z.string(), setName: z.string() }),
  z.object({
    type: z.literal('recovery:summary'),
    prdId: z.string(),
    summary: BuildFailureSummarySchema,
  }),
  z.object({
    type: z.literal('recovery:complete'),
    prdId: z.string(),
    verdict: RecoveryVerdictSchema,
    sidecarMdPath: z.string().optional(),
    sidecarJsonPath: z.string().optional(),
  }),
  z.object({
    type: z.literal('recovery:error'),
    prdId: z.string(),
    error: z.string(),
    rawOutput: z.string().optional(),
  }),

  // Recovery apply
  z.object({ type: z.literal('recovery:apply:start'), prdId: z.string() }),
  z.object({
    type: z.literal('recovery:apply:complete'),
    prdId: z.string(),
    verdict: z.enum(['retry', 'split', 'abandon', 'manual']),
    successorPrdId: z.string().optional(),
    noAction: z.boolean(),
  }),
  z.object({ type: z.literal('recovery:apply:error'), prdId: z.string(), message: z.string() }),

  // Daemon internal
  z.object({ type: z.literal('daemon:auto-build:paused'), reason: z.string() }),

  // Daemon lifecycle
  z.object({
    type: z.literal('daemon:lifecycle:starting'),
    pid: z.number(),
    port: z.number(),
    version: z.string(),
    mode: z.string(),
  }),
  z.object({
    type: z.literal('daemon:lifecycle:ready'),
    pid: z.number(),
    port: z.number(),
    version: z.string(),
    mode: z.string(),
    recoveryDurationMs: z.number(),
  }),
  z.object({
    type: z.literal('daemon:lifecycle:shutdown:start'),
    signal: z.string(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal('daemon:lifecycle:shutdown:complete'),
    durationMs: z.number(),
  }),
  z.object({
    type: z.literal('daemon:heartbeat'),
    uptime: z.number(),
    queueDepth: z.number(),
    runningBuilds: z.number(),
    autoBuild: z.object({ enabled: z.boolean(), paused: z.boolean() }),
    subscribers: z.number(),
  }),

  // Daemon scheduler
  z.object({
    type: z.literal('daemon:scheduler:dequeued'),
    prdId: z.string(),
    queueDepth: z.number(),
    capacityRemaining: z.number(),
  }),
  z.object({
    type: z.literal('daemon:scheduler:capacity-blocked'),
    queueDepth: z.number(),
    runningCount: z.number(),
    limit: z.number(),
  }),
  z.object({
    type: z.literal('daemon:scheduler:dependency-blocked'),
    prdId: z.string(),
    blockedBy: z.array(z.string()),
  }),

  // Daemon auto-build extensions
  z.object({ type: z.literal('daemon:auto-build:enabled') }),
  z.object({ type: z.literal('daemon:auto-build:resumed') }),
  z.object({
    type: z.literal('daemon:auto-build:triggered'),
    trigger: z.string(),
    prdsEnqueued: z.number(),
  }),

  // Daemon recovery
  z.object({ type: z.literal('daemon:recovery:start') }),
  z.object({
    type: z.literal('daemon:recovery:run-marked-failed'),
    runId: z.string(),
    planSet: z.string(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal('daemon:recovery:lock-removed'),
    path: z.string(),
    pid: z.number(),
  }),
  z.object({
    type: z.literal('daemon:recovery:complete'),
    runsFailed: z.number(),
    locksRemoved: z.number(),
    durationMs: z.number(),
  }),

  // Daemon orphan reaping
  z.object({
    type: z.literal('daemon:orphan:reaped'),
    runId: z.string(),
    sessionId: z.string(),
    planSet: z.string(),
    pid: z.number(),
  }),

  // Daemon errors and warnings
  z.object({
    type: z.literal('daemon:warning'),
    source: z.string(),
    message: z.string(),
    details: z.string().optional(),
  }),
  z.object({
    type: z.literal('daemon:error'),
    source: z.string(),
    message: z.string(),
    stack: z.string().optional(),
  }),

  // Queue events
  ...QueueEventSchema.options,
]);

// ---------------------------------------------------------------------------
// Root schema: envelope + discriminated variant
// ---------------------------------------------------------------------------

export const EforgeEventSchema = EventEnvelopeSchema.and(EforgeEventVariantsSchema);

// ---------------------------------------------------------------------------
// Derived types — single source of truth
// ---------------------------------------------------------------------------

export type EforgeEvent = z.infer<typeof EforgeEventSchema>;
export type AgentRole = z.infer<typeof AgentRoleSchema>;
export type AgentTerminalSubtype = z.infer<typeof AgentTerminalSubtypeSchema>;
export type ReviewPerspective = z.infer<typeof ReviewPerspectiveSchema>;
export type StalenessVerdict = z.infer<typeof StalenessVerdictSchema>;
export type RecoveryVerdict = z.infer<typeof RecoveryVerdictSchema>;
export type ShardScope = z.infer<typeof ShardScopeSchema>;
export type PipelineComposition = z.infer<typeof PipelineCompositionSchema>;
export type PrdValidationGap = z.infer<typeof PrdValidationGapSchema>;
export type ExpeditionModule = z.infer<typeof ExpeditionModuleSchema>;
export type EforgeResult = z.infer<typeof EforgeResultSchema>;
export type ClarificationQuestion = z.infer<typeof ClarificationQuestionSchema>;
export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;
export type TestIssue = z.infer<typeof TestIssueSchema>;
export type PlanFile = z.infer<typeof PlanFileSchema>;
export type OrchestrationConfig = z.infer<typeof OrchestrationConfigSchema>;
export type PlanState = z.infer<typeof PlanStateSchema>;
export type EforgeState = z.infer<typeof EforgeStateSchema>;
export type AgentResultData = z.infer<typeof AgentResultDataSchema>;
export type ReconciliationReport = z.infer<typeof ReconciliationReportSchema>;
export type EforgeStatus = z.infer<typeof EforgeStatusSchema>;
export type LandedCommit = z.infer<typeof LandedCommitSchema>;
export type PlanSummaryEntry = z.infer<typeof PlanSummaryEntrySchema>;
export type FailingPlanEntry = z.infer<typeof FailingPlanEntrySchema>;
export type BuildFailureSummary = z.infer<typeof BuildFailureSummarySchema>;
export type QueueEvent = z.infer<typeof QueueEventSchema>;

// ---------------------------------------------------------------------------
// Re-export constants and utilities
// ---------------------------------------------------------------------------

export const SEVERITY_ORDER: Record<ReviewIssue['severity'], number> = {
  critical: 0,
  warning: 1,
  suggestion: 2,
};

/** Agent event types that runners always yield (not gated on verbose). */
export function isAlwaysYieldedAgentEvent(event: EforgeEvent): boolean {
  return (
    event.type === 'agent:start' ||
    event.type === 'agent:warning' ||
    event.type === 'agent:stop' ||
    event.type === 'agent:result' ||
    event.type === 'agent:usage' ||
    event.type === 'agent:tool_use' ||
    event.type === 'agent:tool_result'
  );
}
