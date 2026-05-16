/**
 * Wire event schemas for the eforge daemon SSE stream.
 *
 * This file is the wire-protocol source of truth. `EforgeEvent` is derived
 * from `EforgeEventSchema` via `Static<typeof EforgeEventSchema>`, so TypeScript
 * types and TypeBox runtime validators are always in sync.
 *
 * Event types and schemas are co-located: every discriminant variant lives
 * here, alongside its schema. Do not define event shapes in other files.
 */

import { Type, type Static } from '@sinclair/typebox';
import { safeParseWithSchema, parseWithSchema } from './schema-utils.js';
import type { SafeParseResult } from './schema-utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ORCHESTRATION_MODES = ['errand', 'excursion', 'expedition'] as const;

// ---------------------------------------------------------------------------
// Supporting schemas
// ---------------------------------------------------------------------------

const AgentRoleSchema = Type.Union([
  Type.Literal('planner'),
  Type.Literal('builder'),
  Type.Literal('reviewer'),
  Type.Literal('review-fixer'),
  Type.Literal('evaluator'),
  Type.Literal('module-planner'),
  Type.Literal('plan-reviewer'),
  Type.Literal('plan-evaluator'),
  Type.Literal('architecture-reviewer'),
  Type.Literal('architecture-evaluator'),
  Type.Literal('cohesion-reviewer'),
  Type.Literal('cohesion-evaluator'),
  Type.Literal('validation-fixer'),
  Type.Literal('merge-conflict-resolver'),
  Type.Literal('staleness-assessor'),
  Type.Literal('formatter'),
  Type.Literal('doc-author'),
  Type.Literal('doc-syncer'),
  Type.Literal('test-writer'),
  Type.Literal('tester'),
  Type.Literal('prd-validator'),
  Type.Literal('dependency-detector'),
  Type.Literal('pipeline-composer'),
  Type.Literal('gap-closer'),
  Type.Literal('recovery-analyst'),
]);

const AgentTerminalSubtypeSchema = Type.Union([
  Type.Literal('error_max_turns'),
  Type.Literal('error_max_budget_usd'),
  Type.Literal('error_max_structured_output_retries'),
  Type.Literal('error_during_execution'),
  // --- eforge:region plan-01-transport-resilience ---
  Type.Literal('error_transient_transport'),
  // --- eforge:endregion plan-01-transport-resilience ---
]);

export const REVIEW_PERSPECTIVES = ['code', 'security', 'api', 'docs', 'test', 'verify'] as const;
const ReviewPerspectiveSchema = Type.Union([
  Type.Literal('code'),
  Type.Literal('security'),
  Type.Literal('api'),
  Type.Literal('docs'),
  Type.Literal('test'),
  Type.Literal('verify'),
]);

const StalenessVerdictSchema = Type.Union([
  Type.Literal('proceed'),
  Type.Literal('revise'),
  Type.Literal('obsolete'),
]);

const RecoveryVerdictSchema = Type.Object({
  verdict: Type.Union([
    Type.Literal('retry'),
    Type.Literal('split'),
    Type.Literal('abandon'),
    Type.Literal('manual'),
  ]),
  confidence: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
  rationale: Type.String(),
  completedWork: Type.Array(Type.String()),
  remainingWork: Type.Array(Type.String()),
  risks: Type.Array(Type.String()),
  suggestedSuccessorPrd: Type.Optional(Type.String()),
  partial: Type.Optional(Type.Boolean()),
  recoveryError: Type.Optional(Type.String()),
});

const ShardScopeSchema = Type.Object({
  id: Type.String(),
  roots: Type.Optional(Type.Array(Type.String())),
  files: Type.Optional(Type.Array(Type.String())),
});

const BuildStageSpecSchema = Type.Union([Type.String(), Type.Array(Type.String())]);

// --- eforge:region plan-01-policy-gate-foundation ---
const PolicyGateKindSchema = Type.Union([
  Type.Literal('queue-dispatch'),
  Type.Literal('plan-merge'),
  Type.Literal('final-merge'),
]);

const PolicyGateMethodSchema = Type.Union([
  Type.Literal('beforeQueueDispatch'),
  Type.Literal('beforePlanMerge'),
  Type.Literal('beforeFinalMerge'),
]);

const PolicyGateFailurePolicySchema = Type.Union([
  Type.Literal('fail-open'),
  Type.Literal('fail-closed'),
]);

const PolicyGateAllowDecisionFields = {
  decision: Type.Literal('allow'),
  reason: Type.Optional(Type.String()),
};

const PolicyGateBlockDecisionFields = {
  decision: Type.Literal('block'),
  reason: Type.String({ minLength: 1 }),
};

const PolicyGateRequireApprovalDecisionFields = {
  decision: Type.Literal('require-approval'),
  reason: Type.String({ minLength: 1 }),
};

const PolicyGateBaseProvenanceFields = {
  extensionName: Type.String(),
  extensionPath: Type.String(),
  registrationIndex: Type.Integer({ minimum: 0 }),
  failurePolicy: PolicyGateFailurePolicySchema,
};

const QueueDispatchPolicyGateProvenanceFields = {
  gateKind: Type.Literal('queue-dispatch'),
  method: Type.Literal('beforeQueueDispatch'),
  ...PolicyGateBaseProvenanceFields,
  prdId: Type.String(),
  prdTitle: Type.Optional(Type.String()),
};

const PlanMergePolicyGateProvenanceFields = {
  gateKind: Type.Literal('plan-merge'),
  method: Type.Literal('beforePlanMerge'),
  ...PolicyGateBaseProvenanceFields,
  planId: Type.String(),
};

const FinalMergePolicyGateProvenanceFields = {
  gateKind: Type.Literal('final-merge'),
  method: Type.Literal('beforeFinalMerge'),
  ...PolicyGateBaseProvenanceFields,
  featureBranch: Type.String(),
  baseBranch: Type.String(),
  planIds: Type.Optional(Type.Array(Type.String())),
};
// --- eforge:endregion plan-01-policy-gate-foundation ---

const ReviewProfileConfigSchema = Type.Object({
  strategy: Type.Union([Type.Literal('auto'), Type.Literal('single'), Type.Literal('parallel')]),
  perspectives: Type.Array(ReviewPerspectiveSchema),
  maxRounds: Type.Number(),
  evaluatorStrictness: Type.Union([
    Type.Literal('strict'),
    Type.Literal('standard'),
    Type.Literal('lenient'),
  ]),
});

const PipelineCompositionSchema = Type.Object({
  scope: Type.Union([
    Type.Literal('errand'),
    Type.Literal('excursion'),
    Type.Literal('expedition'),
  ]),
  compile: Type.Array(Type.String()),
  defaultBuild: Type.Array(BuildStageSpecSchema),
  defaultReview: ReviewProfileConfigSchema,
  rationale: Type.String(),
});

const PrdValidationGapSchema = Type.Object({
  requirement: Type.String(),
  explanation: Type.String(),
  complexity: Type.Optional(
    Type.Union([
      Type.Literal('trivial'),
      Type.Literal('moderate'),
      Type.Literal('significant'),
    ]),
  ),
});

const ExpeditionModuleSchema = Type.Object({
  id: Type.String(),
  description: Type.String(),
  dependsOn: Type.Array(Type.String()),
});

const EforgeResultSchema = Type.Object({
  status: Type.Union([
    Type.Literal('completed'),
    Type.Literal('failed'),
    Type.Literal('skipped'),
  ]),
  summary: Type.String(),
});

const ClarificationQuestionSchema = Type.Object({
  id: Type.String(),
  question: Type.String(),
  context: Type.Optional(Type.String()),
  options: Type.Optional(Type.Array(Type.String())),
  default: Type.Optional(Type.String()),
});

const ReviewIssueSchema = Type.Object({
  severity: Type.Union([
    Type.Literal('critical'),
    Type.Literal('warning'),
    Type.Literal('suggestion'),
  ]),
  category: Type.String(),
  file: Type.String(),
  line: Type.Optional(Type.Number()),
  description: Type.String(),
  fix: Type.Optional(Type.String()),
});

const TestIssueSchema = Type.Object({
  severity: Type.Union([Type.Literal('critical'), Type.Literal('warning')]),
  category: Type.Union([
    Type.Literal('production-bug'),
    Type.Literal('missing-behavior'),
    Type.Literal('regression'),
  ]),
  file: Type.String(),
  testFile: Type.String(),
  description: Type.String(),
  testOutput: Type.Optional(Type.String()),
  fix: Type.Optional(Type.String()),
});

const PlanFileSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  dependsOn: Type.Array(Type.String()),
  branch: Type.String(),
  migrations: Type.Optional(
    Type.Array(
      Type.Object({ timestamp: Type.String(), description: Type.String() }),
    ),
  ),
  agents: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Object({
        effort: Type.Optional(Type.String()),
        thinking: Type.Optional(
          Type.Union([Type.Boolean(), Type.Record(Type.String(), Type.Unknown())]),
        ),
        rationale: Type.Optional(Type.String()),
        tier: Type.Optional(Type.String()),
        shards: Type.Optional(Type.Array(ShardScopeSchema)),
      }),
    ),
  ),
  body: Type.String(),
  filePath: Type.String(),
  warnings: Type.Optional(Type.Array(Type.String())),
});

const OrchestrationConfigSchema = Type.Object({
  name: Type.String(),
  description: Type.String(),
  created: Type.String(),
  mode: Type.Union([
    Type.Literal('errand'),
    Type.Literal('excursion'),
    Type.Literal('expedition'),
  ]),
  baseBranch: Type.String(),
  pipeline: PipelineCompositionSchema,
  plans: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Type.String(),
      dependsOn: Type.Array(Type.String()),
      branch: Type.String(),
      build: Type.Array(BuildStageSpecSchema),
      review: ReviewProfileConfigSchema,
      maxContinuations: Type.Optional(Type.Number()),
      agents: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Object({
            effort: Type.Optional(Type.String()),
            thinking: Type.Optional(
              Type.Union([Type.Boolean(), Type.Record(Type.String(), Type.Unknown())]),
            ),
            rationale: Type.Optional(Type.String()),
            tier: Type.Optional(Type.String()),
          }),
        ),
      ),
    }),
  ),
  validate: Type.Optional(Type.Array(Type.String())),
  warnings: Type.Optional(Type.Array(Type.String())),
});

const PlanStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('running'),
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('blocked'),
  Type.Literal('merged'),
]);

const PlanStateSchema = Type.Object({
  status: PlanStatusSchema,
  worktreePath: Type.Optional(Type.String()),
  branch: Type.String(),
  dependsOn: Type.Array(Type.String()),
  merged: Type.Boolean(),
  error: Type.Optional(Type.String()),
});

const EforgeStateSchema = Type.Object({
  setName: Type.String(),
  status: Type.Union([
    Type.Literal('running'),
    Type.Literal('completed'),
    Type.Literal('failed'),
  ]),
  startedAt: Type.String(),
  completedAt: Type.Optional(Type.String()),
  baseBranch: Type.String(),
  featureBranch: Type.Optional(Type.String()),
  worktreeBase: Type.String(),
  mergeWorktreePath: Type.Optional(Type.String()),
  plans: Type.Record(Type.String(), PlanStateSchema),
  completedPlans: Type.Array(Type.String()),
});

const AgentResultDataSchema = Type.Object({
  durationMs: Type.Number(),
  durationApiMs: Type.Number(),
  numTurns: Type.Number(),
  totalCostUsd: Type.Number(),
  usage: Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    total: Type.Number(),
    cacheRead: Type.Number(),
    cacheCreation: Type.Number(),
  }),
  modelUsage: Type.Record(
    Type.String(),
    Type.Object({
      inputTokens: Type.Number(),
      outputTokens: Type.Number(),
      cacheReadInputTokens: Type.Number(),
      cacheCreationInputTokens: Type.Number(),
      costUSD: Type.Number(),
    }),
  ),
  resultText: Type.Optional(Type.String()),
});

const ReconciliationReportSchema = Type.Object({
  valid: Type.Array(Type.String()),
  missing: Type.Array(Type.String()),
  corrupt: Type.Array(Type.String()),
  cleared: Type.Array(Type.String()),
});

const EforgeStatusSchema = Type.Object({
  running: Type.Boolean(),
  setName: Type.Optional(Type.String()),
  plans: Type.Record(Type.String(), PlanStatusSchema),
  completedPlans: Type.Array(Type.String()),
});

const LandedCommitSchema = Type.Object({
  sha: Type.String(),
  subject: Type.String(),
  author: Type.String(),
  date: Type.String(),
});

const PlanSummaryEntrySchema = Type.Object({
  planId: Type.String(),
  status: Type.String(),
  mergedAt: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  terminalSubtype: Type.Optional(Type.String()),
});

const FailingPlanEntrySchema = Type.Object({
  planId: Type.String(),
  agentId: Type.Optional(Type.String()),
  agentRole: Type.Optional(Type.String()),
  errorMessage: Type.Optional(Type.String()),
  terminalSubtype: Type.Optional(Type.String()),
});

const BuildFailureSummarySchema = Type.Object({
  prdId: Type.String(),
  setName: Type.String(),
  featureBranch: Type.String(),
  baseBranch: Type.String(),
  plans: Type.Array(PlanSummaryEntrySchema),
  failingPlan: FailingPlanEntrySchema,
  landedCommits: Type.Array(LandedCommitSchema),
  diffStat: Type.String(),
  modelsUsed: Type.Array(Type.String()),
  failedAt: Type.String(),
  partial: Type.Optional(Type.Boolean()),
  prdContent: Type.Optional(Type.String()),
});

// ---------------------------------------------------------------------------
// Queue event schemas
// ---------------------------------------------------------------------------

const queueEventVariants = [
  Type.Object({ type: Type.Literal('queue:start'), prdCount: Type.Number(), dir: Type.String() }),
  Type.Object({
    type: Type.Literal('queue:prd:start'),
    prdId: Type.String(),
    title: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('queue:prd:discovered'),
    prdId: Type.String(),
    title: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('queue:prd:stale'),
    prdId: Type.String(),
    title: Type.String(),
    verdict: StalenessVerdictSchema,
    justification: Type.String(),
    revision: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal('queue:prd:skip'),
    prdId: Type.String(),
    reason: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('queue:prd:commit-failed'),
    prdId: Type.String(),
    title: Type.String(),
    error: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('queue:prd:complete'),
    prdId: Type.String(),
    status: Type.Union([
      Type.Literal('completed'),
      Type.Literal('failed'),
      Type.Literal('skipped'),
    ]),
  }),
  Type.Object({
    type: Type.Literal('queue:complete'),
    processed: Type.Number(),
    skipped: Type.Number(),
  }),
] as const;

const QueueEventSchema = Type.Union([...queueEventVariants]);

// ---------------------------------------------------------------------------
// Base schema (sessionId, runId, timestamp envelope)
// ---------------------------------------------------------------------------

const EventEnvelopeSchema = Type.Object({
  sessionId: Type.Optional(Type.String()),
  runId: Type.Optional(Type.String()),
  timestamp: Type.String(),
});

// ---------------------------------------------------------------------------
// All EforgeEvent discriminant variants as TypeBox schemas
// ---------------------------------------------------------------------------

const agentStartFields = {
  planId: Type.Optional(Type.String()),
  agentId: Type.String(),
  agent: AgentRoleSchema,
  model: Type.String(),
  harness: Type.Union([Type.Literal('claude-sdk'), Type.Literal('pi')]),
  harnessSource: Type.Literal('tier'),
  tier: Type.String(),
  tierSource: Type.Union([
    Type.Literal('tier'),
    Type.Literal('role'),
    Type.Literal('plan'),
  ]),
  effort: Type.Optional(Type.String()),
  effortSource: Type.Optional(
    Type.Union([Type.Literal('tier'), Type.Literal('role'), Type.Literal('plan')]),
  ),
  thinking: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  thinkingSource: Type.Optional(
    Type.Union([Type.Literal('tier'), Type.Literal('role'), Type.Literal('plan')]),
  ),
  effortClamped: Type.Optional(Type.Boolean()),
  effortOriginal: Type.Optional(Type.String()),
  thinkingCoerced: Type.Optional(Type.Boolean()),
  thinkingOriginal: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  perspective: Type.Optional(Type.String()),
  /** The toolbelt name selected for this tier. Null when explicitly 'none', string when named. */
  toolbelt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /** Provenance of the toolbelt selection. */
  toolbeltSource: Type.Optional(Type.Union([
    Type.Literal('tier'),
    Type.Literal('role'),
    Type.Literal('plan'),
    Type.Literal('default'),
  ])),
  /** Which project MCP servers were selected for this tier. */
  projectMcpSelection: Type.Optional(Type.Union([
    Type.Literal('all'),
    Type.Literal('none'),
    Type.Literal('toolbelt'),
  ])),
  /** Sorted names of the project MCP servers passed to this tier's harness. */
  projectMcpServerNames: Type.Optional(Type.Array(Type.String())),
};

// ---------------------------------------------------------------------------
// Build-phase orchestrator decision schema
// ---------------------------------------------------------------------------

/**
 * Inner discriminated union for plan-phase (planner) decisions.
 * Consumed by the `planning:decision` event variant.
 */
export const PlanningDecisionSchema = Type.Union([
  // Scope / orchestration mode selection
  Type.Object({
    kind: Type.Literal('scope-selected'),
    rationale: Type.String(),
    scope: Type.Union([
      Type.Literal('errand'),
      Type.Literal('excursion'),
      Type.Literal('expedition'),
    ]),
    source: Type.Union([Type.Literal('pipeline-composer'), Type.Literal('planner')]),
  }),
  // Default build pipeline chosen for the plan set
  Type.Object({
    kind: Type.Literal('build-pipeline-chosen'),
    rationale: Type.String(),
    defaultBuild: Type.Array(BuildStageSpecSchema, { minItems: 1 }),
  }),
  // Default review profile chosen for the plan set
  Type.Object({
    kind: Type.Literal('review-profile-chosen'),
    rationale: Type.String(),
    strategy: Type.Union([
      Type.Literal('auto'),
      Type.Literal('single'),
      Type.Literal('parallel'),
    ]),
    perspectives: Type.Array(ReviewPerspectiveSchema, { minItems: 1 }),
    maxRounds: Type.Integer({ minimum: 1 }),
    evaluatorStrictness: Type.Union([
      Type.Literal('strict'),
      Type.Literal('standard'),
      Type.Literal('lenient'),
    ]),
  }),
  // Plan set shape: how many plans and why they are split that way
  Type.Object({
    kind: Type.Literal('plan-set-shape'),
    rationale: Type.String(),
    planCount: Type.Integer({ minimum: 1 }),
    planIds: Type.Array(Type.String(), { minItems: 1 }),
  }),
]);

export type PlanningDecision = Static<typeof PlanningDecisionSchema>;

export const PlanningDecisionEventSchema = Type.Object({
  type: Type.Literal('planning:decision'),
  planId: Type.Optional(Type.String()),
  decision: PlanningDecisionSchema,
});

export const BuildDecisionSchema = Type.Union([
  // Review strategy selection
  Type.Object({
    kind: Type.Literal('review-strategy'),
    rationale: Type.String(),
    strategy: Type.Union([Type.Literal('single'), Type.Literal('parallel')]),
    source: Type.Union([Type.Literal('config'), Type.Literal('auto-threshold')]),
    auto: Type.Optional(
      Type.Object({
        files: Type.Integer({ minimum: 0 }),
        lines: Type.Integer({ minimum: 0 }),
        threshold: Type.Object({
          files: Type.Integer({ minimum: 0 }),
          lines: Type.Integer({ minimum: 0 }),
        }),
      }),
    ),
  }),
  // Perspectives inferred for parallel review
  Type.Object({
    kind: Type.Literal('perspectives-inferred'),
    rationale: Type.String(),
    perspectives: Type.Array(ReviewPerspectiveSchema),
    categories: Type.Array(Type.String()),
    rules: Type.Array(Type.String()),
  }),
  // Review cycle terminated
  Type.Object({
    kind: Type.Literal('cycle-terminated'),
    rationale: Type.String(),
    round: Type.Integer({ minimum: 0 }),
    reason: Type.Union([Type.Literal('no-issues'), Type.Literal('max-rounds')]),
    issuesRemaining: Type.Integer({ minimum: 0 }),
    // --- eforge:region plan-02-build-evaluator-enforcement ---
    lastReviewIssueCount: Type.Optional(Type.Integer({ minimum: 0 })),
    finalEvaluationAccepted: Type.Optional(Type.Integer({ minimum: 0 })),
    finalEvaluationRejected: Type.Optional(Type.Integer({ minimum: 0 })),
    finalEvaluationRan: Type.Optional(Type.Boolean()),
    // --- eforge:endregion plan-02-build-evaluator-enforcement ---
  }),
  // Perspectives respawned for next review round
  Type.Object({
    kind: Type.Literal('perspectives-respawned'),
    rationale: Type.String(),
    round: Type.Integer({ minimum: 0 }),
    perspectives: Type.Array(ReviewPerspectiveSchema),
    dropped: Type.Array(ReviewPerspectiveSchema),
  }),
  // Evaluator strictness selection
  Type.Object({
    kind: Type.Literal('evaluator-strictness'),
    rationale: Type.String(),
    strictness: Type.Union([
      Type.Literal('strict'),
      Type.Literal('standard'),
      Type.Literal('lenient'),
    ]),
    source: Type.Union([Type.Literal('config'), Type.Literal('default')]),
  }),
  // Recovery verdict applied
  Type.Object({
    kind: Type.Literal('recovery-verdict'),
    rationale: Type.String(),
    verdict: Type.Union([
      Type.Literal('retry'),
      Type.Literal('split'),
      Type.Literal('abandon'),
      Type.Literal('manual'),
    ]),
    successorPrdId: Type.Optional(Type.String()),
  }),
  // Merge conflict resolution strategy
  Type.Object({
    kind: Type.Literal('merge-conflict-resolution'),
    rationale: Type.String(),
    strategy: Type.String(),
    files: Type.Array(Type.String()),
  }),
]);

export type BuildDecision = Static<typeof BuildDecisionSchema>;

const EforgeEventVariantsSchema = Type.Union([
  // Session lifecycle
  Type.Object({ type: Type.Literal('session:start'), sessionId: Type.String() }),
  Type.Object({
    type: Type.Literal('session:end'),
    sessionId: Type.String(),
    result: EforgeResultSchema,
  }),
  Type.Object({
    type: Type.Literal('session:profile'),
    profileName: Type.Union([Type.String(), Type.Null()]),
    source: Type.Union([
      Type.Literal('local'),
      Type.Literal('project'),
      Type.Literal('user-local'),
      Type.Literal('missing'),
      Type.Literal('none'),
      Type.Literal('override'),
    ]),
    scope: Type.Union([
      Type.Literal('local'),
      Type.Literal('project'),
      Type.Literal('user'),
      Type.Null(),
    ]),
    config: Type.Union([Type.Unknown(), Type.Null()]),
  }),

  // Phase lifecycle
  Type.Object({
    type: Type.Literal('phase:start'),
    runId: Type.String(),
    planSet: Type.String(),
    command: Type.Union([Type.Literal('compile'), Type.Literal('build')]),
  }),
  Type.Object({
    type: Type.Literal('phase:end'),
    runId: Type.String(),
    result: EforgeResultSchema,
  }),

  // Config and plan warnings
  Type.Object({
    type: Type.Literal('config:warning'),
    message: Type.String(),
    source: Type.String(),
    details: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal('planning:warning'),
    planId: Type.Optional(Type.String()),
    message: Type.String(),
    source: Type.String(),
    details: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal('planning:module:build-config:invalid'),
    moduleId: Type.String(),
    reason: Type.Union([Type.Literal('invalid-json'), Type.Literal('invalid-schema')]),
    errors: Type.Array(Type.String()),
  }),

  // --- eforge:region plan-01-native-event-runtime-foundation ---
  // Native extension event-hook diagnostics
  Type.Object({
    type: Type.Literal('extension:event-handler:failed'),
    extensionName: Type.String(),
    extensionPath: Type.String(),
    pattern: Type.String(),
    triggeringEventType: Type.String(),
    message: Type.String(),
    stack: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal('extension:event-handler:timeout'),
    extensionName: Type.String(),
    extensionPath: Type.String(),
    pattern: Type.String(),
    triggeringEventType: Type.String(),
    timeoutMs: Type.Number(),
  }),
  // --- eforge:endregion plan-01-native-event-runtime-foundation ---

  // --- eforge:region plan-01-agent-context-runtime ---
  // Native extension agent-context hook diagnostics and tool decisions
  Type.Object({
    type: Type.Literal('extension:agent-context:applied'),
    extensionName: Type.String(),
    extensionPath: Type.String(),
    role: AgentRoleSchema,
    tier: Type.Optional(Type.String()),
    phase: Type.Optional(Type.String()),
    stage: Type.Optional(Type.String()),
    profile: Type.String(),
    planId: Type.Optional(Type.String()),
    harness: Type.Optional(Type.Union([Type.Literal('claude-sdk'), Type.Literal('pi')])),
    toolbelt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    projectMcpSelection: Type.Optional(Type.Union([
      Type.Literal('all'),
      Type.Literal('none'),
      Type.Literal('toolbelt'),
    ])),
    promptCharCount: Type.Integer({ minimum: 0 }),
    fragmentCount: Type.Integer({ minimum: 0 }),
  }),
  Type.Object({
    type: Type.Literal('extension:agent-context:failed'),
    extensionName: Type.String(),
    extensionPath: Type.String(),
    role: AgentRoleSchema,
    tier: Type.Optional(Type.String()),
    phase: Type.Optional(Type.String()),
    stage: Type.Optional(Type.String()),
    profile: Type.String(),
    planId: Type.Optional(Type.String()),
    harness: Type.Optional(Type.Union([Type.Literal('claude-sdk'), Type.Literal('pi')])),
    toolbelt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    projectMcpSelection: Type.Optional(Type.Union([
      Type.Literal('all'),
      Type.Literal('none'),
      Type.Literal('toolbelt'),
    ])),
    message: Type.String(),
    stack: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal('extension:agent-context:timeout'),
    extensionName: Type.String(),
    extensionPath: Type.String(),
    role: AgentRoleSchema,
    tier: Type.Optional(Type.String()),
    phase: Type.Optional(Type.String()),
    stage: Type.Optional(Type.String()),
    profile: Type.String(),
    planId: Type.Optional(Type.String()),
    harness: Type.Optional(Type.Union([Type.Literal('claude-sdk'), Type.Literal('pi')])),
    toolbelt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    projectMcpSelection: Type.Optional(Type.Union([
      Type.Literal('all'),
      Type.Literal('none'),
      Type.Literal('toolbelt'),
    ])),
    timeoutMs: Type.Integer({ minimum: 0 }),
  }),
  Type.Object({
    type: Type.Literal('extension:agent-context:unsupported'),
    extensionName: Type.String(),
    extensionPath: Type.String(),
    role: AgentRoleSchema,
    tier: Type.Optional(Type.String()),
    phase: Type.Optional(Type.String()),
    stage: Type.Optional(Type.String()),
    profile: Type.String(),
    planId: Type.Optional(Type.String()),
    harness: Type.Optional(Type.Union([Type.Literal('claude-sdk'), Type.Literal('pi')])),
    toolbelt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    projectMcpSelection: Type.Optional(Type.Union([
      Type.Literal('all'),
      Type.Literal('none'),
      Type.Literal('toolbelt'),
    ])),
    fields: Type.Array(Type.Union([
      Type.Literal('tools'),
      Type.Literal('allowedTools'),
      Type.Literal('disallowedTools'),
    ]), { minItems: 1 }),
  }),
  Type.Object({
    type: Type.Literal('extension:agent-tools:applied'),
    extensionName: Type.String(),
    extensionPath: Type.String(),
    role: AgentRoleSchema,
    tier: Type.Optional(Type.String()),
    phase: Type.Optional(Type.String()),
    stage: Type.Optional(Type.String()),
    profile: Type.String(),
    planId: Type.Optional(Type.String()),
    harness: Type.Optional(Type.Union([Type.Literal('claude-sdk'), Type.Literal('pi')])),
    toolbelt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    projectMcpSelection: Type.Optional(Type.Union([
      Type.Literal('all'),
      Type.Literal('none'),
      Type.Literal('toolbelt'),
    ])),
    projectMcpServerNames: Type.Optional(Type.Array(Type.String())),
    toolNames: Type.Array(Type.String()),
    effectiveToolNames: Type.Array(Type.String()),
    registeredToolNames: Type.Array(Type.String()),
    inlineToolNames: Type.Array(Type.String()),
    allowedToolsAdded: Type.Array(Type.String()),
    disallowedToolsAdded: Type.Array(Type.String()),
    excludedToolNames: Type.Array(Type.String()),
    toolCount: Type.Integer({ minimum: 0 }),
    allowedToolCount: Type.Integer({ minimum: 0 }),
    disallowedToolCount: Type.Integer({ minimum: 0 }),
    excludedToolCount: Type.Integer({ minimum: 0 }),
  }),
  // --- eforge:endregion plan-01-agent-context-runtime ---

  // --- eforge:region plan-01-profile-router-events ---
  // Profile router dispatch diagnostics (EXTEND_09)
  Type.Object({
    type: Type.Literal('queue:profile:selected'),
    prdId: Type.String(),
    prdTitle: Type.Optional(Type.String()),
    profile: Type.String(),
    baseProfile: Type.Union([Type.String(), Type.Null()]),
    routerName: Type.String(),
    extensionName: Type.String(),
    extensionPath: Type.String(),
    reason: Type.Optional(Type.String()),
    confidence: Type.Optional(Type.Union([
      Type.Literal('low'),
      Type.Literal('medium'),
      Type.Literal('high'),
    ])),
  }),
  Type.Object({
    type: Type.Literal('queue:profile:router-failed'),
    prdId: Type.String(),
    routerName: Type.String(),
    extensionName: Type.String(),
    extensionPath: Type.String(),
    message: Type.String(),
    stack: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal('queue:profile:router-timeout'),
    prdId: Type.String(),
    routerName: Type.String(),
    extensionName: Type.String(),
    extensionPath: Type.String(),
    timeoutMs: Type.Integer({ minimum: 0 }),
  }),
  Type.Object({
    type: Type.Literal('queue:profile:invalid-selection'),
    prdId: Type.String(),
    routerName: Type.String(),
    extensionName: Type.String(),
    extensionPath: Type.String(),
    requestedProfile: Type.String(),
    reason: Type.Union([Type.Literal('not-found'), Type.Literal('load-error')]),
    message: Type.String(),
  }),
  // --- eforge:endregion plan-01-profile-router-events ---

  // --- eforge:region plan-01-policy-gate-foundation ---
  // Blocking policy-gate decisions and diagnostics
  Type.Union([
    Type.Object({
      type: Type.Literal('extension:policy:decision'),
      ...QueueDispatchPolicyGateProvenanceFields,
      ...PolicyGateAllowDecisionFields,
    }),
    Type.Object({
      type: Type.Literal('extension:policy:decision'),
      ...QueueDispatchPolicyGateProvenanceFields,
      ...PolicyGateBlockDecisionFields,
    }),
    Type.Object({
      type: Type.Literal('extension:policy:decision'),
      ...QueueDispatchPolicyGateProvenanceFields,
      ...PolicyGateRequireApprovalDecisionFields,
    }),
    Type.Object({
      type: Type.Literal('extension:policy:decision'),
      ...PlanMergePolicyGateProvenanceFields,
      ...PolicyGateAllowDecisionFields,
    }),
    Type.Object({
      type: Type.Literal('extension:policy:decision'),
      ...PlanMergePolicyGateProvenanceFields,
      ...PolicyGateBlockDecisionFields,
    }),
    Type.Object({
      type: Type.Literal('extension:policy:decision'),
      ...PlanMergePolicyGateProvenanceFields,
      ...PolicyGateRequireApprovalDecisionFields,
    }),
    Type.Object({
      type: Type.Literal('extension:policy:decision'),
      ...FinalMergePolicyGateProvenanceFields,
      ...PolicyGateAllowDecisionFields,
    }),
    Type.Object({
      type: Type.Literal('extension:policy:decision'),
      ...FinalMergePolicyGateProvenanceFields,
      ...PolicyGateBlockDecisionFields,
    }),
    Type.Object({
      type: Type.Literal('extension:policy:decision'),
      ...FinalMergePolicyGateProvenanceFields,
      ...PolicyGateRequireApprovalDecisionFields,
    }),
  ]),
  Type.Union([
    Type.Object({
      type: Type.Literal('extension:policy:failed'),
      ...QueueDispatchPolicyGateProvenanceFields,
      message: Type.String(),
      stack: Type.Optional(Type.String()),
    }),
    Type.Object({
      type: Type.Literal('extension:policy:failed'),
      ...PlanMergePolicyGateProvenanceFields,
      message: Type.String(),
      stack: Type.Optional(Type.String()),
    }),
    Type.Object({
      type: Type.Literal('extension:policy:failed'),
      ...FinalMergePolicyGateProvenanceFields,
      message: Type.String(),
      stack: Type.Optional(Type.String()),
    }),
  ]),
  Type.Union([
    Type.Object({
      type: Type.Literal('extension:policy:timeout'),
      ...QueueDispatchPolicyGateProvenanceFields,
      timeoutMs: Type.Integer({ minimum: 0 }),
    }),
    Type.Object({
      type: Type.Literal('extension:policy:timeout'),
      ...PlanMergePolicyGateProvenanceFields,
      timeoutMs: Type.Integer({ minimum: 0 }),
    }),
    Type.Object({
      type: Type.Literal('extension:policy:timeout'),
      ...FinalMergePolicyGateProvenanceFields,
      timeoutMs: Type.Integer({ minimum: 0 }),
    }),
  ]),
  // --- eforge:endregion plan-01-policy-gate-foundation ---

  // Planning
  Type.Object({
    type: Type.Literal('planning:start'),
    source: Type.String(),
    label: Type.Optional(Type.String()),
  }),
  Type.Object({ type: Type.Literal('planning:skip'), reason: Type.String() }),
  Type.Object({
    type: Type.Literal('planning:submission'),
    planCount: Type.Number(),
    totalBodySize: Type.Number(),
    hasMigrations: Type.Boolean(),
  }),
  Type.Object({ type: Type.Literal('planning:error'), reason: Type.String() }),
  Type.Object({
    type: Type.Literal('planning:clarification'),
    questions: Type.Array(ClarificationQuestionSchema),
  }),
  Type.Object({
    type: Type.Literal('planning:clarification:answer'),
    answers: Type.Record(Type.String(), Type.String()),
  }),
  Type.Object({
    type: Type.Literal('planning:progress'),
    message: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('planning:continuation'),
    attempt: Type.Number(),
    maxContinuations: Type.Number(),
    reason: Type.Optional(
      Type.Union([Type.Literal('max_turns'), Type.Literal('dropped_submission')]),
    ),
  }),
  Type.Object({
    type: Type.Literal('planning:pipeline'),
    scope: Type.String(),
    compile: Type.Array(Type.String()),
    defaultBuild: Type.Array(BuildStageSpecSchema),
    defaultReview: ReviewProfileConfigSchema,
    rationale: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('planning:complete'),
    plans: Type.Array(PlanFileSchema),
    planConfigs: Type.Optional(
      Type.Array(
        Type.Object({
          id: Type.String(),
          build: Type.Optional(Type.Array(BuildStageSpecSchema)),
          review: Type.Optional(ReviewProfileConfigSchema),
        }),
      ),
    ),
  }),

  // Planning review
  Type.Object({ type: Type.Literal('planning:review:start') }),
  Type.Object({
    type: Type.Literal('planning:review:complete'),
    issues: Type.Array(ReviewIssueSchema),
  }),
  Type.Object({ type: Type.Literal('planning:evaluate:start') }),
  Type.Object({
    type: Type.Literal('planning:evaluate:continuation'),
    attempt: Type.Number(),
    maxContinuations: Type.Number(),
  }),
  Type.Object({
    type: Type.Literal('planning:evaluate:complete'),
    accepted: Type.Number(),
    rejected: Type.Number(),
    verdicts: Type.Optional(
      Type.Array(
        Type.Object({
          file: Type.String(),
          action: Type.Union([
            Type.Literal('accept'),
            Type.Literal('reject'),
            Type.Literal('review'),
          ]),
          reason: Type.String(),
          hunk: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
      ),
    ),
  }),

  // Architecture review
  Type.Object({ type: Type.Literal('planning:architecture:review:start') }),
  Type.Object({
    type: Type.Literal('planning:architecture:review:complete'),
    issues: Type.Array(ReviewIssueSchema),
  }),
  Type.Object({ type: Type.Literal('planning:architecture:evaluate:start') }),
  Type.Object({
    type: Type.Literal('planning:architecture:evaluate:continuation'),
    attempt: Type.Number(),
    maxContinuations: Type.Number(),
  }),
  Type.Object({
    type: Type.Literal('planning:architecture:evaluate:complete'),
    accepted: Type.Number(),
    rejected: Type.Number(),
    verdicts: Type.Optional(
      Type.Array(
        Type.Object({
          file: Type.String(),
          action: Type.Union([
            Type.Literal('accept'),
            Type.Literal('reject'),
            Type.Literal('review'),
          ]),
          reason: Type.String(),
          hunk: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
      ),
    ),
  }),

  // Cohesion review
  Type.Object({ type: Type.Literal('planning:cohesion:start') }),
  Type.Object({
    type: Type.Literal('planning:cohesion:complete'),
    issues: Type.Array(ReviewIssueSchema),
  }),
  Type.Object({ type: Type.Literal('planning:cohesion:evaluate:start') }),
  Type.Object({
    type: Type.Literal('planning:cohesion:evaluate:continuation'),
    attempt: Type.Number(),
    maxContinuations: Type.Number(),
  }),
  Type.Object({
    type: Type.Literal('planning:cohesion:evaluate:complete'),
    accepted: Type.Number(),
    rejected: Type.Number(),
    verdicts: Type.Optional(
      Type.Array(
        Type.Object({
          file: Type.String(),
          action: Type.Union([
            Type.Literal('accept'),
            Type.Literal('reject'),
            Type.Literal('review'),
          ]),
          reason: Type.String(),
          hunk: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
      ),
    ),
  }),

  // Building (per-plan)
  Type.Object({ type: Type.Literal('plan:build:start'), planId: Type.String() }),
  Type.Object({ type: Type.Literal('plan:build:implement:start'), planId: Type.String() }),
  Type.Object({
    type: Type.Literal('plan:build:implement:progress'),
    planId: Type.String(),
    message: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('plan:build:implement:continuation'),
    planId: Type.String(),
    attempt: Type.Number(),
    maxContinuations: Type.Number(),
    shardId: Type.Optional(Type.String()),
  }),
  Type.Object({ type: Type.Literal('plan:build:implement:complete'), planId: Type.String() }),
  Type.Object({
    type: Type.Literal('plan:build:files_changed'),
    planId: Type.String(),
    files: Type.Array(Type.String()),
    diffs: Type.Optional(
      Type.Array(Type.Object({ path: Type.String(), diff: Type.String() })),
    ),
    baseBranch: Type.Optional(Type.String()),
  }),
  Type.Object({ type: Type.Literal('plan:build:review:start'), planId: Type.String() }),
  Type.Object({
    type: Type.Literal('plan:build:review:complete'),
    planId: Type.String(),
    issues: Type.Array(ReviewIssueSchema),
  }),
  Type.Object({
    type: Type.Literal('plan:build:review:parallel:start'),
    planId: Type.String(),
    perspectives: Type.Array(ReviewPerspectiveSchema),
  }),
  Type.Object({
    type: Type.Literal('plan:build:review:parallel:perspective:start'),
    planId: Type.String(),
    perspective: ReviewPerspectiveSchema,
  }),
  Type.Object({
    type: Type.Literal('plan:build:review:parallel:perspective:complete'),
    planId: Type.String(),
    perspective: ReviewPerspectiveSchema,
    issues: Type.Array(ReviewIssueSchema),
  }),
  Type.Object({
    type: Type.Literal('plan:build:review:parallel:perspective:error'),
    planId: Type.String(),
    perspective: Type.String(),
    error: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('plan:build:review:fix:start'),
    planId: Type.String(),
    issueCount: Type.Number(),
  }),
  Type.Object({ type: Type.Literal('plan:build:review:fix:complete'), planId: Type.String() }),
  Type.Object({ type: Type.Literal('plan:build:evaluate:start'), planId: Type.String() }),
  Type.Object({
    type: Type.Literal('plan:build:evaluate:continuation'),
    planId: Type.String(),
    attempt: Type.Number(),
    maxContinuations: Type.Number(),
  }),
  Type.Object({
    type: Type.Literal('plan:build:evaluate:complete'),
    planId: Type.String(),
    accepted: Type.Number(),
    rejected: Type.Number(),
    verdicts: Type.Optional(
      Type.Array(
        Type.Object({
          file: Type.String(),
          action: Type.Union([
            Type.Literal('accept'),
            Type.Literal('reject'),
            Type.Literal('review'),
          ]),
          reason: Type.String(),
          hunk: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
      ),
    ),
  }),
  Type.Object({ type: Type.Literal('plan:build:doc-author:start'), planId: Type.String() }),
  Type.Object({
    type: Type.Literal('plan:build:doc-author:complete'),
    planId: Type.String(),
    docsAuthored: Type.Number(),
  }),
  Type.Object({ type: Type.Literal('plan:build:doc-sync:start'), planId: Type.String() }),
  Type.Object({
    type: Type.Literal('plan:build:doc-sync:complete'),
    planId: Type.String(),
    docsSynced: Type.Number(),
  }),
  Type.Object({ type: Type.Literal('plan:build:test:write:start'), planId: Type.String() }),
  Type.Object({
    type: Type.Literal('plan:build:test:write:complete'),
    planId: Type.String(),
    testsWritten: Type.Number(),
  }),
  Type.Object({ type: Type.Literal('plan:build:test:start'), planId: Type.String() }),
  Type.Object({
    type: Type.Literal('plan:build:test:complete'),
    planId: Type.String(),
    passed: Type.Number(),
    failed: Type.Number(),
    testBugsFixed: Type.Number(),
    productionIssues: Type.Array(TestIssueSchema),
  }),
  Type.Object({ type: Type.Literal('plan:build:complete'), planId: Type.String() }),
  Type.Object({
    type: Type.Literal('plan:build:failed'),
    planId: Type.String(),
    error: Type.String(),
    terminalSubtype: Type.Optional(AgentTerminalSubtypeSchema),
  }),
  Type.Object({
    type: Type.Literal('plan:build:progress'),
    planId: Type.String(),
    message: Type.String(),
  }),

  // Plan lifecycle state events
  Type.Object({
    type: Type.Literal('plan:status:change'),
    planId: Type.String(),
    status: PlanStatusSchema,
  }),
  Type.Object({
    type: Type.Literal('plan:error:set'),
    planId: Type.String(),
    error: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('plan:error:clear'),
    planId: Type.String(),
  }),

  // Orchestration
  Type.Object({ type: Type.Literal('schedule:start'), planIds: Type.Array(Type.String()) }),
  Type.Object({
    type: Type.Literal('plan:schedule:ready'),
    planId: Type.String(),
    reason: Type.String(),
  }),
  Type.Object({ type: Type.Literal('plan:merge:start'), planId: Type.String() }),
  Type.Object({
    type: Type.Literal('plan:merge:complete'),
    planId: Type.String(),
    commitSha: Type.Optional(Type.String()),
  }),
  Type.Object({ type: Type.Literal('plan:merge:resolve:start'), planId: Type.String() }),
  Type.Object({
    type: Type.Literal('plan:merge:resolve:complete'),
    planId: Type.String(),
    resolved: Type.Boolean(),
  }),
  Type.Object({
    type: Type.Literal('merge:finalize:start'),
    featureBranch: Type.String(),
    baseBranch: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('merge:finalize:complete'),
    featureBranch: Type.String(),
    baseBranch: Type.String(),
    commitSha: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal('merge:finalize:skipped'),
    featureBranch: Type.String(),
    baseBranch: Type.String(),
    reason: Type.String(),
  }),

  // Merge worktree lifecycle events
  Type.Object({
    type: Type.Literal('merge:worktree:set'),
    path: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('merge:worktree:clear'),
  }),

  // Expedition planning phases
  Type.Object({
    type: Type.Literal('expedition:architecture:complete'),
    modules: Type.Array(ExpeditionModuleSchema),
  }),
  Type.Object({
    type: Type.Literal('expedition:wave:start'),
    wave: Type.Number(),
    moduleIds: Type.Array(Type.String()),
  }),
  Type.Object({ type: Type.Literal('expedition:wave:complete'), wave: Type.Number() }),
  Type.Object({ type: Type.Literal('expedition:module:start'), moduleId: Type.String() }),
  Type.Object({ type: Type.Literal('expedition:module:complete'), moduleId: Type.String() }),
  Type.Object({ type: Type.Literal('expedition:compile:start') }),
  Type.Object({
    type: Type.Literal('expedition:compile:complete'),
    plans: Type.Array(PlanFileSchema),
  }),

  // Agent lifecycle
  Type.Object({ type: Type.Literal('agent:start'), ...agentStartFields }),
  Type.Object({
    type: Type.Literal('agent:warning'),
    planId: Type.Optional(Type.String()),
    agentId: Type.String(),
    agent: AgentRoleSchema,
    code: Type.String(),
    message: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('agent:stop'),
    planId: Type.Optional(Type.String()),
    agentId: Type.String(),
    agent: AgentRoleSchema,
    error: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal('agent:usage'),
    planId: Type.Optional(Type.String()),
    agentId: Type.String(),
    agent: AgentRoleSchema,
    usage: Type.Object({
      input: Type.Number(),
      output: Type.Number(),
      total: Type.Number(),
      cacheRead: Type.Number(),
      cacheCreation: Type.Number(),
    }),
    costUsd: Type.Number(),
    numTurns: Type.Number(),
    final: Type.Optional(Type.Boolean()),
  }),

  // Agent-level (verbose streaming)
  Type.Object({
    type: Type.Literal('agent:message'),
    planId: Type.Optional(Type.String()),
    agentId: Type.String(),
    agent: AgentRoleSchema,
    content: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('agent:tool_use'),
    planId: Type.Optional(Type.String()),
    agentId: Type.String(),
    agent: AgentRoleSchema,
    tool: Type.String(),
    toolUseId: Type.String(),
    input: Type.Unknown(),
  }),
  Type.Object({
    type: Type.Literal('agent:tool_result'),
    planId: Type.Optional(Type.String()),
    agentId: Type.String(),
    agent: AgentRoleSchema,
    tool: Type.String(),
    toolUseId: Type.String(),
    output: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('agent:result'),
    planId: Type.Optional(Type.String()),
    agentId: Type.Optional(Type.String()),
    agent: AgentRoleSchema,
    result: AgentResultDataSchema,
  }),
  Type.Object({
    type: Type.Literal('agent:activity'),
    planId: Type.Optional(Type.String()),
    agentId: Type.String(),
    agent: AgentRoleSchema,
    files: Type.Optional(Type.Array(Type.Object({
      path: Type.String(),
      status: Type.Optional(Type.String()),
      additions: Type.Optional(Type.Number()),
      deletions: Type.Optional(Type.Number()),
      binary: Type.Optional(Type.Boolean()),
    }))),
    totals: Type.Optional(Type.Object({
      filesChanged: Type.Number(),
      additions: Type.Number(),
      deletions: Type.Number(),
    })),
    attribution: Type.Union([
      Type.Literal('exact'),
      Type.Literal('best_effort'),
      Type.Literal('unavailable'),
    ]),
    notes: Type.Optional(Type.Array(Type.String())),
  }),

  // Generic retry notification
  Type.Object({
    type: Type.Literal('agent:retry'),
    agent: AgentRoleSchema,
    attempt: Type.Number(),
    maxAttempts: Type.Number(),
    subtype: AgentTerminalSubtypeSchema,
    label: Type.String(),
    planId: Type.Optional(Type.String()),
    shardId: Type.Optional(Type.String()),
  }),

  // Validation (post-merge)
  Type.Object({ type: Type.Literal('validation:start'), commands: Type.Array(Type.String()) }),
  Type.Object({ type: Type.Literal('validation:command:start'), command: Type.String() }),
  Type.Object({
    type: Type.Literal('validation:command:complete'),
    command: Type.String(),
    exitCode: Type.Number(),
    output: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('validation:command:timeout'),
    command: Type.String(),
    timeoutMs: Type.Number(),
    pid: Type.Number(),
  }),
  Type.Object({ type: Type.Literal('validation:complete'), passed: Type.Boolean() }),
  Type.Object({
    type: Type.Literal('validation:fix:start'),
    attempt: Type.Number(),
    maxAttempts: Type.Number(),
  }),
  Type.Object({ type: Type.Literal('validation:fix:complete'), attempt: Type.Number() }),

  // PRD validation
  Type.Object({ type: Type.Literal('prd_validation:start') }),
  Type.Object({
    type: Type.Literal('prd_validation:complete'),
    passed: Type.Boolean(),
    gaps: Type.Array(PrdValidationGapSchema),
    completionPercent: Type.Optional(Type.Number()),
  }),

  // Gap closing
  Type.Object({
    type: Type.Literal('gap_close:start'),
    gapCount: Type.Optional(Type.Number()),
    completionPercent: Type.Optional(Type.Number()),
  }),
  Type.Object({
    type: Type.Literal('gap_close:plan_ready'),
    planBody: Type.String(),
    gaps: Type.Array(PrdValidationGapSchema),
  }),
  Type.Object({
    type: Type.Literal('gap_close:complete'),
    passed: Type.Optional(Type.Boolean()),
  }),

  // Reconciliation
  Type.Object({ type: Type.Literal('reconciliation:start') }),
  Type.Object({
    type: Type.Literal('reconciliation:complete'),
    report: ReconciliationReportSchema,
  }),

  // Cleanup
  Type.Object({ type: Type.Literal('cleanup:start'), planSet: Type.String() }),
  Type.Object({ type: Type.Literal('cleanup:complete'), planSet: Type.String() }),

  // User interaction
  Type.Object({
    type: Type.Literal('approval:needed'),
    planId: Type.Optional(Type.String()),
    action: Type.String(),
    details: Type.String(),
  }),
  Type.Object({ type: Type.Literal('approval:response'), approved: Type.Boolean() }),

  // Enqueue
  Type.Object({ type: Type.Literal('enqueue:start'), source: Type.String() }),
  Type.Object({
    type: Type.Literal('enqueue:complete'),
    id: Type.String(),
    filePath: Type.String(),
    title: Type.String(),
    planSet: Type.String(),
  }),
  Type.Object({ type: Type.Literal('enqueue:failed'), error: Type.String() }),
  Type.Object({ type: Type.Literal('enqueue:commit-failed'), error: Type.String() }),

  // Recovery analysis
  Type.Object({
    type: Type.Literal('recovery:start'),
    prdId: Type.String(),
    setName: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('recovery:summary'),
    prdId: Type.String(),
    summary: BuildFailureSummarySchema,
  }),
  Type.Object({
    type: Type.Literal('recovery:complete'),
    prdId: Type.String(),
    verdict: RecoveryVerdictSchema,
    sidecarMdPath: Type.Optional(Type.String()),
    sidecarJsonPath: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal('recovery:error'),
    prdId: Type.String(),
    error: Type.String(),
    rawOutput: Type.Optional(Type.String()),
  }),

  // Recovery apply
  Type.Object({ type: Type.Literal('recovery:apply:start'), prdId: Type.String() }),
  Type.Object({
    type: Type.Literal('recovery:apply:complete'),
    prdId: Type.String(),
    verdict: Type.Union([
      Type.Literal('retry'),
      Type.Literal('split'),
      Type.Literal('abandon'),
      Type.Literal('manual'),
    ]),
    successorPrdId: Type.Optional(Type.String()),
    noAction: Type.Boolean(),
  }),
  Type.Object({
    type: Type.Literal('recovery:apply:error'),
    prdId: Type.String(),
    message: Type.String(),
  }),

  // Daemon run-state upsert
  Type.Object({
    type: Type.Literal('daemon:run:upsert'),
    run: Type.Object({
      id: Type.String(),
      sessionId: Type.Optional(Type.String()),
      planSet: Type.String(),
      command: Type.String(),
      status: Type.String(),
      startedAt: Type.String(),
      completedAt: Type.Optional(Type.String()),
      cwd: Type.String(),
      pid: Type.Optional(Type.Number()),
    }),
  }),

  // Daemon internal
  Type.Object({
    type: Type.Literal('daemon:auto-build:paused'),
    reason: Type.String(),
  }),

  // Daemon lifecycle
  Type.Object({
    type: Type.Literal('daemon:lifecycle:starting'),
    pid: Type.Number(),
    port: Type.Number(),
    version: Type.String(),
    mode: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('daemon:lifecycle:ready'),
    pid: Type.Number(),
    port: Type.Number(),
    version: Type.String(),
    mode: Type.String(),
    recoveryDurationMs: Type.Number(),
  }),
  Type.Object({
    type: Type.Literal('daemon:lifecycle:shutdown:start'),
    signal: Type.String(),
    reason: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('daemon:lifecycle:shutdown:complete'),
    durationMs: Type.Number(),
  }),
  Type.Object({
    type: Type.Literal('daemon:heartbeat'),
    uptime: Type.Number(),
    queueDepth: Type.Number(),
    runningBuilds: Type.Number(),
    autoBuild: Type.Object({ enabled: Type.Boolean(), paused: Type.Boolean() }),
    subscribers: Type.Number(),
  }),

  // Daemon scheduler
  Type.Object({
    type: Type.Literal('daemon:scheduler:dequeued'),
    prdId: Type.String(),
    queueDepth: Type.Number(),
    capacityRemaining: Type.Number(),
  }),
  Type.Object({
    type: Type.Literal('daemon:scheduler:capacity-blocked'),
    queueDepth: Type.Number(),
    runningCount: Type.Number(),
    limit: Type.Number(),
  }),
  Type.Object({
    type: Type.Literal('daemon:scheduler:dependency-blocked'),
    prdId: Type.String(),
    blockedBy: Type.Array(Type.String()),
  }),
  Type.Object({ type: Type.Literal('daemon:scheduler:paused') }),
  Type.Object({ type: Type.Literal('daemon:scheduler:resumed') }),

  // Daemon auto-build extensions
  Type.Object({ type: Type.Literal('daemon:auto-build:enabled') }),
  Type.Object({ type: Type.Literal('daemon:auto-build:disabled') }),
  Type.Object({ type: Type.Literal('daemon:auto-build:resumed') }),
  Type.Object({
    type: Type.Literal('daemon:auto-build:triggered'),
    trigger: Type.String(),
    prdsEnqueued: Type.Number(),
  }),

  // Daemon recovery
  Type.Object({ type: Type.Literal('daemon:recovery:start') }),
  Type.Object({
    type: Type.Literal('daemon:recovery:run-marked-failed'),
    runId: Type.String(),
    planSet: Type.String(),
    reason: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('daemon:recovery:lock-removed'),
    path: Type.String(),
    pid: Type.Number(),
  }),
  Type.Object({
    type: Type.Literal('daemon:recovery:complete'),
    runsFailed: Type.Number(),
    locksRemoved: Type.Number(),
    durationMs: Type.Number(),
  }),

  // Daemon orphan reaping
  Type.Object({
    type: Type.Literal('daemon:orphan:reaped'),
    runId: Type.String(),
    sessionId: Type.String(),
    planSet: Type.String(),
    pid: Type.Number(),
  }),

  // Daemon errors and warnings
  Type.Object({
    type: Type.Literal('daemon:warning'),
    source: Type.String(),
    message: Type.String(),
    details: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal('daemon:error'),
    source: Type.String(),
    message: Type.String(),
    stack: Type.Optional(Type.String()),
  }),

  // Queue events
  ...queueEventVariants,

  // Build-phase orchestrator decision events
  Type.Object({
    type: Type.Literal('plan:build:decision'),
    planId: Type.String(),
    decision: BuildDecisionSchema,
  }),

  // Plan-phase (planner) decision events
  PlanningDecisionEventSchema,
]);

// ---------------------------------------------------------------------------
// Root schema: envelope + discriminated variant
// ---------------------------------------------------------------------------

export const EforgeEventSchema = Type.Intersect([EventEnvelopeSchema, EforgeEventVariantsSchema]);

// ---------------------------------------------------------------------------
// Derived types — single source of truth
// ---------------------------------------------------------------------------

export type EforgeEvent = Static<typeof EforgeEventSchema>;
export type DaemonRunUpsertEvent = Extract<EforgeEvent, { type: 'daemon:run:upsert' }>;
export type AgentRole = Static<typeof AgentRoleSchema>;
export type AgentTerminalSubtype = Static<typeof AgentTerminalSubtypeSchema>;
export type ReviewPerspective = Static<typeof ReviewPerspectiveSchema>;
export type StalenessVerdict = Static<typeof StalenessVerdictSchema>;
export type RecoveryVerdict = Static<typeof RecoveryVerdictSchema>;
export type ShardScope = Static<typeof ShardScopeSchema>;
export type PipelineComposition = Static<typeof PipelineCompositionSchema>;
export type PrdValidationGap = Static<typeof PrdValidationGapSchema>;
export type ExpeditionModule = Static<typeof ExpeditionModuleSchema>;
export type EforgeResult = Static<typeof EforgeResultSchema>;
export type ClarificationQuestion = Static<typeof ClarificationQuestionSchema>;
export type ReviewIssue = Static<typeof ReviewIssueSchema>;
export type TestIssue = Static<typeof TestIssueSchema>;
export type PlanFile = Static<typeof PlanFileSchema>;
export type OrchestrationConfig = Static<typeof OrchestrationConfigSchema>;
export type PlanState = Static<typeof PlanStateSchema>;
export type EforgeState = Static<typeof EforgeStateSchema>;
export type AgentResultData = Static<typeof AgentResultDataSchema>;
export type ReconciliationReport = Static<typeof ReconciliationReportSchema>;
export type EforgeStatus = Static<typeof EforgeStatusSchema>;
export type LandedCommit = Static<typeof LandedCommitSchema>;
export type PlanSummaryEntry = Static<typeof PlanSummaryEntrySchema>;
export type FailingPlanEntry = Static<typeof FailingPlanEntrySchema>;
export type BuildFailureSummary = Static<typeof BuildFailureSummarySchema>;
export type QueueEvent = Static<typeof QueueEventSchema>;
export type PlanningDecisionEvent = Static<typeof PlanningDecisionEventSchema>;

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
    event.type === 'agent:activity' ||
    event.type === 'agent:usage' ||
    event.type === 'agent:tool_use' ||
    event.type === 'agent:tool_result' ||
    event.type === 'extension:agent-context:applied' ||
    event.type === 'extension:agent-context:failed' ||
    event.type === 'extension:agent-context:timeout' ||
    event.type === 'extension:agent-context:unsupported' ||
    event.type === 'extension:agent-tools:applied'
  );
}

// ---------------------------------------------------------------------------
// SSE stream snapshot envelope schemas (stream:hello primitive)
// ---------------------------------------------------------------------------

/**
 * Shape of the `liveness` field inside `DaemonStreamSnapshot`.
 * Matches the JSON object that `buildHeartbeatPayload()` in server.ts produces.
 */
const DaemonStreamLivenessSchema = Type.Object({
  type: Type.Literal('daemon:heartbeat'),
  timestamp: Type.String(),
  uptime: Type.Number(),
  queueDepth: Type.Number(),
  runningBuilds: Type.Number(),
  autoBuild: Type.Object({
    enabled: Type.Boolean(),
    paused: Type.Boolean(),
  }),
  subscribers: Type.Number(),
});

/** Shape of a single item in `DaemonStreamSnapshot.recentActivity`. */
const DaemonRecentActivityItemSchema = Type.Object({
  id: Type.Number(),
  event: EforgeEventSchema,
});

/** Shape of a run record as returned by `GET /api/runs`. */
const DaemonRunRecordSchema = Type.Object({
  id: Type.String(),
  sessionId: Type.Optional(Type.String()),
  planSet: Type.String(),
  command: Type.String(),
  status: Type.String(),
  startedAt: Type.String(),
  completedAt: Type.Optional(Type.String()),
  cwd: Type.String(),
  pid: Type.Optional(Type.Number()),
});

/** Shape of a single queue item as returned by `GET /api/queue`. */
const DaemonQueueItemSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  status: Type.String(),
  priority: Type.Optional(Type.Number()),
  created: Type.Optional(Type.String()),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  recoveryVerdict: Type.Optional(
    Type.Object({
      verdict: Type.Union([
        Type.Literal('retry'),
        Type.Literal('split'),
        Type.Literal('abandon'),
        Type.Literal('manual'),
      ]),
      confidence: Type.Union([
        Type.Literal('low'),
        Type.Literal('medium'),
        Type.Literal('high'),
      ]),
    }),
  ),
});

/** Shape of a per-session metadata entry as returned by `GET /api/session-metadata`. */
const DaemonSessionMetadataItemSchema = Type.Object({
  planCount: Type.Union([Type.Number(), Type.Null()]),
  baseProfile: Type.Union([Type.String(), Type.Null()]),
});

/** Shape of the auto-build response as returned by `GET /api/auto-build`. */
const DaemonAutoBuildSchema = Type.Object({
  enabled: Type.Boolean(),
  watcher: Type.Object({
    running: Type.Boolean(),
    pid: Type.Union([Type.Number(), Type.Null()]),
    sessionId: Type.Union([Type.String(), Type.Null()]),
  }),
});

/**
 * Snapshot payload embedded in the `stream:hello` frame for the
 * `/api/daemon-events` SSE stream.
 *
 * `cursor` is the max daemon-wide event id at connect time; used as the
 * authoritative `Last-Event-ID` for reconnects.
 *
 * All other fields match the response shapes of existing REST endpoints
 * byte-for-byte so plan-02 consumers can feed them into existing reducers.
 */
export const DaemonStreamSnapshotSchema = Type.Object({
  cursor: Type.Number(),
  liveness: DaemonStreamLivenessSchema,
  recentActivity: Type.Array(DaemonRecentActivityItemSchema),
  runs: Type.Array(DaemonRunRecordSchema),
  queue: Type.Array(DaemonQueueItemSchema),
  sessionMetadata: Type.Record(Type.String(), DaemonSessionMetadataItemSchema),
  autoBuild: DaemonAutoBuildSchema,
});

/**
 * Snapshot payload embedded in the `stream:hello` frame for the
 * `/api/events/:sessionId` SSE stream.
 *
 * `cursor` is the max event id for the session at connect time.
 * `status` and `events` match the `RunState` shape from `GET /api/runs/:id/state`.
 */
export const SessionStreamSnapshotSchema = Type.Object({
  cursor: Type.Number(),
  status: Type.Union([
    Type.Literal('pending'),
    Type.Literal('running'),
    Type.Literal('completed'),
    Type.Literal('failed'),
  ]),
  events: Type.Array(
    Type.Object({
      id: Type.Number(),
      data: Type.String(),
    }),
  ),
});

export type DaemonStreamSnapshot = Static<typeof DaemonStreamSnapshotSchema>;
export type SessionStreamSnapshot = Static<typeof SessionStreamSnapshotSchema>;

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

/**
 * Safely parses an unknown value as an `EforgeEvent`.
 * Returns `{ success: true, data }` on success or `{ success: false, error }` on failure.
 */
export function safeParseEforgeEvent(value: unknown): SafeParseResult<EforgeEvent> {
  const result = safeParseWithSchema(EforgeEventSchema, value);
  if (!result.success) return result;

  if (
    result.data.type === 'extension:policy:decision' &&
    (result.data.decision === 'block' || result.data.decision === 'require-approval') &&
    (typeof result.data.reason !== 'string' || result.data.reason.trim().length === 0)
  ) {
    return {
      success: false,
      error: {
        message: '/reason: blocking policy decisions require a non-empty reason',
        errors: [{ path: '/reason', message: 'blocking policy decisions require a non-empty reason' }],
      },
    };
  }

  return result;
}

/**
 * Parses an unknown value as an `EforgeEvent`, throwing on failure.
 */
export function parseEforgeEvent(value: unknown): EforgeEvent {
  return parseWithSchema(EforgeEventSchema, value);
}

/**
 * Safely parses an unknown value as a `DaemonStreamSnapshot`.
 * Returns `{ success: true, data }` on success or `{ success: false, error }` on failure.
 */
export function safeParseDaemonStreamSnapshot(value: unknown): SafeParseResult<DaemonStreamSnapshot> {
  return safeParseWithSchema(DaemonStreamSnapshotSchema, value);
}

/**
 * Safely parses an unknown value as a `SessionStreamSnapshot`.
 * Returns `{ success: true, data }` on success or `{ success: false, error }` on failure.
 */
export function safeParseSessionStreamSnapshot(value: unknown): SafeParseResult<SessionStreamSnapshot> {
  return safeParseWithSchema(SessionStreamSnapshotSchema, value);
}
