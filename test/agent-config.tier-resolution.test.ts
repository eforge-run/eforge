/**
 * Tier resolution tests for resolveAgentConfig.
 *
 * Verifies the six-tier resolution chain:
 *   1. Plan-file override
 *   2. User per-role override
 *   3. User per-tier (NEW)
 *   4. User global
 *   5. Built-in per-role defaults (exceptions only)
 *   6. Built-in per-tier defaults (NEW)
 */
import { describe, it, expect } from 'vitest';
import { resolveAgentConfig } from '@eforge-build/engine/pipeline';
import { resolveConfig, DEFAULT_CONFIG, agentTierSchema } from '@eforge-build/engine/config';
import {
  AGENT_ROLE_TIERS,
  BUILTIN_TIER_DEFAULTS,
} from '@eforge-build/engine/pipeline/agent-config';
import type { AgentRole } from '@eforge-build/engine/events';

/**
 * Minimal agentRuntimes config so resolveAgentConfig can resolve a harness.
 * Include this in every resolveConfig call that doesn't already specify agentRuntimes.
 */
const BASE_RUNTIMES = {
  agentRuntimes: { 'claude-sdk': { harness: 'claude-sdk' as const } },
  defaultAgentRuntime: 'claude-sdk',
} as const;

// All 24 agent roles
const ALL_ROLES: AgentRole[] = [
  'planner', 'builder', 'reviewer', 'review-fixer', 'evaluator', 'module-planner',
  'plan-reviewer', 'plan-evaluator', 'architecture-reviewer', 'architecture-evaluator',
  'cohesion-reviewer', 'cohesion-evaluator', 'validation-fixer', 'merge-conflict-resolver',
  'staleness-assessor', 'formatter', 'doc-updater', 'test-writer', 'tester',
  'prd-validator', 'dependency-detector', 'pipeline-composer', 'gap-closer', 'recovery-analyst',
];

// ---------------------------------------------------------------------------
// Test 1: tier-only config (no per-role override) → tier values applied
// ---------------------------------------------------------------------------

describe('tier-only config (no per-role override)', () => {
  const config = resolveConfig(
    {
      ...BASE_RUNTIMES,
      agents: {
        tiers: {
          planning: { effort: 'xhigh' },
          implementation: { effort: 'low' },
        },
      },
    },
    {},
  );

  it('planning tier roles pick up xhigh effort from tier config', () => {
    const planner = resolveAgentConfig('planner', config);
    expect(planner.effort).toBe('xhigh');
    expect(planner.effortSource).toBe('tier-config');
  });

  it('implementation tier roles pick up low effort from tier config (wins over builtin-role)', () => {
    // user per-tier (level 3) beats builtin-role (level 5)
    const builder = resolveAgentConfig('builder', config);
    expect(builder.effort).toBe('low');
    expect(builder.effortSource).toBe('tier-config');
  });

  it('unconfigured tier (review) uses builtin tier default', () => {
    const reviewer = resolveAgentConfig('reviewer', config);
    expect(reviewer.effort).toBe('high');
    expect(reviewer.effortSource).toBe('default');
  });
});

// ---------------------------------------------------------------------------
// Test 2: tier + role override → role override wins for that role only
// ---------------------------------------------------------------------------

describe('tier + role override (role wins for that role)', () => {
  const config = resolveConfig(
    {
      ...BASE_RUNTIMES,
      agents: {
        tiers: {
          planning: { effort: 'xhigh' },
        },
        roles: {
          planner: { effort: 'low' },
        },
      },
    },
    {},
  );

  it('planner has role override, uses low (not xhigh from tier)', () => {
    const planner = resolveAgentConfig('planner', config);
    expect(planner.effort).toBe('low');
    expect(planner.effortSource).toBe('role-config');
  });

  it('module-planner (same planning tier, no role override) uses xhigh from tier', () => {
    const modulePlanner = resolveAgentConfig('module-planner', config);
    expect(modulePlanner.effort).toBe('xhigh');
    expect(modulePlanner.effortSource).toBe('tier-config');
  });
});

// ---------------------------------------------------------------------------
// Test 3: role override beats tier (precedence verification)
// ---------------------------------------------------------------------------

describe('precedence: role-config > tier-config > global-config', () => {
  const config = resolveConfig(
    {
      ...BASE_RUNTIMES,
      agents: {
        effort: 'low',                    // global (level 4)
        tiers: {
          review: { effort: 'medium' },   // tier (level 3)
        },
        roles: {
          reviewer: { effort: 'xhigh' },  // role (level 2)
        },
      },
    },
    {},
  );

  it('reviewer uses role-config effort (xhigh), not tier or global', () => {
    const reviewer = resolveAgentConfig('reviewer', config);
    expect(reviewer.effort).toBe('xhigh');
    expect(reviewer.effortSource).toBe('role-config');
  });

  it('architecture-reviewer (same review tier, no role override) uses tier effort (medium)', () => {
    const archReviewer = resolveAgentConfig('architecture-reviewer', config);
    expect(archReviewer.effort).toBe('medium');
    expect(archReviewer.effortSource).toBe('tier-config');
  });

  it('evaluator (different tier, no role or tier override) uses global effort (low)', () => {
    const evaluator = resolveAgentConfig('evaluator', config);
    expect(evaluator.effort).toBe('low');
    expect(evaluator.effortSource).toBe('global-config');
  });
});

// ---------------------------------------------------------------------------
// Test 4: tier beats global
// ---------------------------------------------------------------------------

describe('tier beats global', () => {
  const config = resolveConfig(
    {
      ...BASE_RUNTIMES,
      agents: {
        effort: 'low',                        // global (level 4)
        tiers: {
          evaluation: { effort: 'xhigh' },   // tier (level 3)
        },
      },
    },
    {},
  );

  it('evaluator picks up xhigh from tier, not low from global', () => {
    const evaluator = resolveAgentConfig('evaluator', config);
    expect(evaluator.effort).toBe('xhigh');
    expect(evaluator.effortSource).toBe('tier-config');
  });

  it('planner (unconfigured tier) falls back to global low', () => {
    const planner = resolveAgentConfig('planner', config);
    expect(planner.effort).toBe('low');
    expect(planner.effortSource).toBe('global-config');
  });
});

// ---------------------------------------------------------------------------
// Test 5: built-in tier default applied when nothing else set
// ---------------------------------------------------------------------------

describe('built-in tier defaults applied with no user config', () => {
  it('planner (planning tier) gets effort=high from builtin tier default', () => {
    const planner = resolveAgentConfig('planner', DEFAULT_CONFIG);
    expect(planner.effort).toBe('high');
    expect(planner.effortSource).toBe('default');
    expect(planner.tier).toBe('planning');
  });

  it('builder (implementation tier) gets effort=high from per-role exception overriding tier default', () => {
    // builtin-role (level 5) has effort=high; builtin-tier (level 6) has effort=medium
    // When no user config is set, level 5 wins over level 6
    const builder = resolveAgentConfig('builder', DEFAULT_CONFIG);
    expect(builder.effort).toBe('high');
    expect(builder.effortSource).toBe('default');
    expect(builder.tier).toBe('implementation');
  });

  it('reviewer (review tier) gets effort=high from builtin tier default', () => {
    const reviewer = resolveAgentConfig('reviewer', DEFAULT_CONFIG);
    expect(reviewer.effort).toBe('high');
    expect(reviewer.effortSource).toBe('default');
    expect(reviewer.tier).toBe('review');
  });

  it('evaluator (evaluation tier) gets effort=high from builtin tier default', () => {
    const evaluator = resolveAgentConfig('evaluator', DEFAULT_CONFIG);
    expect(evaluator.effort).toBe('high');
    expect(evaluator.effortSource).toBe('default');
    expect(evaluator.tier).toBe('evaluation');
  });

  it('tester (implementation tier) gets effort=medium from builtin tier default', () => {
    const tester = resolveAgentConfig('tester', DEFAULT_CONFIG);
    expect(tester.effort).toBe('medium');
    expect(tester.effortSource).toBe('default');
  });
});

// ---------------------------------------------------------------------------
// Test 6: role moved to a different tier via agents.roles[role].tier
// ---------------------------------------------------------------------------

describe('role tier reassignment via agents.roles[role].tier', () => {
  const config = resolveConfig(
    {
      ...BASE_RUNTIMES,
      agents: {
        tiers: {
          review: { effort: 'xhigh' },
          implementation: { effort: 'low' },
        },
        roles: {
          tester: { tier: 'review' as const },
        },
      },
    },
    {},
  );

  it('tester moved to review tier picks up review tier effort (xhigh)', () => {
    const tester = resolveAgentConfig('tester', config);
    expect(tester.effort).toBe('xhigh');
    expect(tester.effortSource).toBe('tier-config');
    expect(tester.tier).toBe('review');
    expect(tester.tierSource).toBe('role-config');
  });

  it('builder stays in implementation tier', () => {
    const builder = resolveAgentConfig('builder', config);
    expect(builder.tier).toBe('implementation');
    expect(builder.tierSource).toBe('role-default');
    // tier-config (low) wins over builtin-role (high)
    expect(builder.effort).toBe('low');
  });
});

// ---------------------------------------------------------------------------
// Test 7: backward-compat sweep (no user tiers config)
// ---------------------------------------------------------------------------

describe('backward-compat sweep (no user tiers, all 24 roles covered)', () => {
  // Expected modelClass → model ID mapping via DEFAULT_CONFIG (claude-sdk harness)
  const modelIdForClass: Record<string, string> = {
    max: 'claude-opus-4-7',
    balanced: 'claude-sonnet-4-6',
    fast: 'claude-haiku-4-5',
  };

  // Expected effective model class for all 24 roles.
  // Matches old AGENT_MODEL_CLASSES table exactly.
  const expectedModelClass: Record<AgentRole, string> = {
    planner: 'max',
    'architecture-reviewer': 'max',
    'architecture-evaluator': 'max',
    'cohesion-reviewer': 'max',
    'cohesion-evaluator': 'max',
    'module-planner': 'max',
    'plan-reviewer': 'max',
    'plan-evaluator': 'max',
    builder: 'balanced',
    reviewer: 'max',
    'review-fixer': 'balanced',
    evaluator: 'max',
    'validation-fixer': 'balanced',
    'merge-conflict-resolver': 'max',
    'doc-updater': 'max',
    'test-writer': 'balanced',
    tester: 'balanced',
    formatter: 'max',
    'staleness-assessor': 'balanced',
    'prd-validator': 'balanced',
    'dependency-detector': 'balanced',
    'pipeline-composer': 'max',
    'gap-closer': 'max',
    'recovery-analyst': 'balanced',
  };

  // Expected maxTurns for all roles. Matches old AGENT_ROLE_DEFAULTS + global default (30).
  const expectedMaxTurns: Record<AgentRole, number> = {
    builder: 80,
    tester: 40,
    'module-planner': 20,
    'doc-updater': 20,
    'test-writer': 30,
    'gap-closer': 20,
    planner: 30,
    reviewer: 30,
    'review-fixer': 30,
    evaluator: 30,
    'plan-reviewer': 30,
    'plan-evaluator': 30,
    'architecture-reviewer': 30,
    'architecture-evaluator': 30,
    'cohesion-reviewer': 30,
    'cohesion-evaluator': 30,
    'validation-fixer': 30,
    'merge-conflict-resolver': 30,
    formatter: 30,
    'staleness-assessor': 30,
    'prd-validator': 30,
    'dependency-detector': 30,
    'pipeline-composer': 30,
    'recovery-analyst': 30,
  };

  it('covers all 24 roles', () => {
    expect(ALL_ROLES).toHaveLength(24);
    expect(Object.keys(expectedModelClass)).toHaveLength(24);
    expect(Object.keys(expectedMaxTurns)).toHaveLength(24);
  });

  it('every role resolves expected modelClass (matches old AGENT_MODEL_CLASSES)', () => {
    for (const role of ALL_ROLES) {
      const result = resolveAgentConfig(role, DEFAULT_CONFIG);
      const expectedId = modelIdForClass[expectedModelClass[role]];
      expect(result.model?.id, `${role} model`).toBe(expectedId);
    }
  });

  it('every role resolves expected maxTurns', () => {
    for (const role of ALL_ROLES) {
      const result = resolveAgentConfig(role, DEFAULT_CONFIG);
      expect(result.maxTurns, `${role} maxTurns`).toBe(expectedMaxTurns[role]);
    }
  });

  it('every role resolves a defined effort from tier defaults', () => {
    for (const role of ALL_ROLES) {
      const result = resolveAgentConfig(role, DEFAULT_CONFIG);
      expect(result.effort, `${role} effort`).toBeDefined();
      expect(['low', 'medium', 'high', 'xhigh', 'max']).toContain(result.effort);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 8: tier and tierSource fields present on every ResolvedAgentConfig
// ---------------------------------------------------------------------------

describe('tier and tierSource always present on ResolvedAgentConfig', () => {
  it('all 24 roles have non-undefined tier', () => {
    for (const role of ALL_ROLES) {
      const result = resolveAgentConfig(role, DEFAULT_CONFIG);
      expect(result.tier, `${role} tier`).toBeDefined();
      expect(['planning', 'implementation', 'review', 'evaluation']).toContain(result.tier);
    }
  });

  it('all 24 roles have non-undefined tierSource', () => {
    for (const role of ALL_ROLES) {
      const result = resolveAgentConfig(role, DEFAULT_CONFIG);
      expect(result.tierSource, `${role} tierSource`).toBeDefined();
      expect(['role-config', 'role-default']).toContain(result.tierSource);
    }
  });

  it('all roles use role-default tierSource when no user tier override', () => {
    for (const role of ALL_ROLES) {
      const result = resolveAgentConfig(role, DEFAULT_CONFIG);
      expect(result.tierSource, `${role} tierSource`).toBe('role-default');
    }
  });

  it('role moved to different tier uses role-config tierSource', () => {
    const config = resolveConfig(
      {
        ...BASE_RUNTIMES,
        agents: {
          roles: {
            tester: { tier: 'review' as const },
          },
        },
      },
      {},
    );
    const tester = resolveAgentConfig('tester', config);
    expect(tester.tier).toBe('review');
    expect(tester.tierSource).toBe('role-config');
  });
});

// ---------------------------------------------------------------------------
// Additional: source PRD example config verification
// ---------------------------------------------------------------------------

describe('source PRD example config', () => {
  // Config matching the PRD's example:
  // planning: high effort, review: high, evaluation: low, implementation: medium
  // builder.maxTurns: 80 (stays from per-role exception)
  // tester.tier: review
  const config = resolveConfig(
    {
      ...BASE_RUNTIMES,
      agents: {
        tiers: {
          planning: { effort: 'high' },
          review: { effort: 'high' },
          evaluation: { effort: 'low' },
          implementation: { effort: 'medium' },
        },
        roles: {
          tester: { tier: 'review' as const },
        },
      },
    },
    {},
  );

  it('planner (planning tier): effort=high from tier-config, model=max', () => {
    const planner = resolveAgentConfig('planner', config);
    expect(planner.effort).toBe('high');
    expect(planner.effortSource).toBe('tier-config');
    expect(planner.model?.id).toBe('claude-opus-4-7');
  });

  it('builder (implementation tier): effort=medium from tier-config (beats per-role high), modelClass=balanced, maxTurns=80', () => {
    const builder = resolveAgentConfig('builder', config);
    // user tier-config (level 3) beats builtin-role (level 5)
    expect(builder.effort).toBe('medium');
    expect(builder.effortSource).toBe('tier-config');
    expect(builder.model?.id).toBe('claude-sonnet-4-6');  // balanced
    expect(builder.maxTurns).toBe(80);  // per-role exception preserved
  });

  it('evaluator (evaluation tier): effort=low from tier-config, model=max', () => {
    const evaluator = resolveAgentConfig('evaluator', config);
    expect(evaluator.effort).toBe('low');
    expect(evaluator.effortSource).toBe('tier-config');
    expect(evaluator.model?.id).toBe('claude-opus-4-7');  // max
  });

  it('tester (moved to review tier): effort=high from tier-config, tierSource=role-config', () => {
    const tester = resolveAgentConfig('tester', config);
    expect(tester.effort).toBe('high');
    expect(tester.effortSource).toBe('tier-config');
    expect(tester.tier).toBe('review');
    expect(tester.tierSource).toBe('role-config');
  });
});

// ---------------------------------------------------------------------------
// Verify AGENT_ROLE_TIERS covers all 24 roles
// ---------------------------------------------------------------------------

describe('AGENT_ROLE_TIERS covers all roles', () => {
  it('has exactly 24 entries', () => {
    expect(Object.keys(AGENT_ROLE_TIERS)).toHaveLength(24);
  });

  it('all entries map to valid tier values', () => {
    for (const role of ALL_ROLES) {
      const tier = AGENT_ROLE_TIERS[role];
      expect(['planning', 'implementation', 'review', 'evaluation'], `${role} tier`).toContain(tier);
    }
  });
});

// ---------------------------------------------------------------------------
// Verify BUILTIN_TIER_DEFAULTS
// ---------------------------------------------------------------------------

describe('BUILTIN_TIER_DEFAULTS values', () => {
  it('planning: effort=high, modelClass=max', () => {
    expect(BUILTIN_TIER_DEFAULTS.planning.effort).toBe('high');
    expect(BUILTIN_TIER_DEFAULTS.planning.modelClass).toBe('max');
  });

  it('implementation: effort=medium, modelClass=balanced', () => {
    expect(BUILTIN_TIER_DEFAULTS.implementation.effort).toBe('medium');
    expect(BUILTIN_TIER_DEFAULTS.implementation.modelClass).toBe('balanced');
  });

  it('review: effort=high, modelClass=max', () => {
    expect(BUILTIN_TIER_DEFAULTS.review.effort).toBe('high');
    expect(BUILTIN_TIER_DEFAULTS.review.modelClass).toBe('max');
  });

  it('evaluation: effort=high, modelClass=max', () => {
    expect(BUILTIN_TIER_DEFAULTS.evaluation.effort).toBe('high');
    expect(BUILTIN_TIER_DEFAULTS.evaluation.modelClass).toBe('max');
  });
});

// ---------------------------------------------------------------------------
// Verify agentTierSchema rejects unknown tier names
// ---------------------------------------------------------------------------

describe('agentTierSchema validates tier names', () => {
  it('accepts all four valid tier names', () => {
    for (const tier of ['planning', 'implementation', 'review', 'evaluation'] as const) {
      const result = agentTierSchema.safeParse(tier);
      expect(result.success, `${tier} should be valid`).toBe(true);
    }
  });

  it('rejects unknown tier names', () => {
    for (const bad of ['planner', 'builder', 'unknown', 'max', '']) {
      const result = agentTierSchema.safeParse(bad);
      expect(result.success, `${bad} should be rejected`).toBe(false);
    }
  });
});
