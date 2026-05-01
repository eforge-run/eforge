/**
 * Tier resolution tests for resolveAgentConfig.
 *
 * Each tier (planning/implementation/review/evaluation) is a self-contained
 * recipe (harness + model + effort + tuning). A role picks a tier, the tier
 * carries everything else.
 *
 * Provenance is `tier|role|plan` for each tunable field.
 */
import { describe, it, expect } from 'vitest';
import { resolveAgentConfig } from '@eforge-build/engine/pipeline';
import { resolveConfig, DEFAULT_CONFIG, agentTierSchema } from '@eforge-build/engine/config';
import { AGENT_ROLE_TIERS } from '@eforge-build/engine/pipeline/agent-config';
import type { AgentRole } from '@eforge-build/engine/events';

const FULL_TIERS = {
  planning: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
  implementation: { harness: 'claude-sdk' as const, model: 'claude-sonnet-4-6', effort: 'medium' as const },
  review: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
  evaluation: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
} as const;

// All 24 agent roles
const ALL_ROLES: AgentRole[] = [
  'planner', 'builder', 'reviewer', 'review-fixer', 'evaluator', 'module-planner',
  'plan-reviewer', 'plan-evaluator', 'architecture-reviewer', 'architecture-evaluator',
  'cohesion-reviewer', 'cohesion-evaluator', 'validation-fixer', 'merge-conflict-resolver',
  'staleness-assessor', 'formatter', 'doc-author', 'doc-syncer', 'test-writer', 'tester',
  'prd-validator', 'dependency-detector', 'pipeline-composer', 'gap-closer', 'recovery-analyst',
];

// ---------------------------------------------------------------------------
// Tier recipe drives effort/model/harness for every role in that tier
// ---------------------------------------------------------------------------

describe('tier recipes drive role configuration', () => {
  const config = resolveConfig({
    agents: {
      tiers: {
        ...FULL_TIERS,
        planning: { ...FULL_TIERS.planning, effort: 'xhigh' },
        implementation: { ...FULL_TIERS.implementation, effort: 'low' },
      },
    },
  });

  it('planning tier roles pick up xhigh effort from tier recipe', () => {
    const planner = resolveAgentConfig('planner', config);
    expect(planner.effort).toBe('xhigh');
    expect(planner.effortSource).toBe('tier');
    expect(planner.tier).toBe('planning');
    expect(planner.tierSource).toBe('tier');
  });

  it('implementation tier roles pick up low effort from tier recipe', () => {
    const builder = resolveAgentConfig('builder', config);
    expect(builder.effort).toBe('low');
    expect(builder.effortSource).toBe('tier');
  });

  it('review tier roles pick up high effort from tier recipe', () => {
    const reviewer = resolveAgentConfig('reviewer', config);
    expect(reviewer.effort).toBe('high');
    expect(reviewer.effortSource).toBe('tier');
  });
});

// ---------------------------------------------------------------------------
// Role override beats tier
// ---------------------------------------------------------------------------

describe('role override beats tier (precedence: plan > role > tier)', () => {
  const config = resolveConfig({
    agents: {
      tiers: { ...FULL_TIERS, review: { ...FULL_TIERS.review, effort: 'medium' } },
      roles: {
        reviewer: { effort: 'xhigh' },
      },
    },
  });

  it('reviewer uses role override (xhigh), not tier (medium)', () => {
    const reviewer = resolveAgentConfig('reviewer', config);
    expect(reviewer.effort).toBe('xhigh');
    expect(reviewer.effortSource).toBe('role');
  });

  it('architecture-reviewer (same review tier, no role override) uses tier effort (medium)', () => {
    const archReviewer = resolveAgentConfig('architecture-reviewer', config);
    expect(archReviewer.effort).toBe('medium');
    expect(archReviewer.effortSource).toBe('tier');
  });
});

// ---------------------------------------------------------------------------
// Plan-file override beats role override beats tier
// ---------------------------------------------------------------------------

describe('plan override beats role override beats tier', () => {
  const config = resolveConfig({
    agents: {
      tiers: FULL_TIERS,
      roles: {
        builder: { effort: 'high' },
      },
    },
  });

  it('plan override wins for effort', () => {
    const result = resolveAgentConfig('builder', config, {
      agents: { builder: { effort: 'xhigh' } },
    });
    expect(result.effort).toBe('xhigh');
    expect(result.effortSource).toBe('plan');
  });

  it('without plan override, role override wins', () => {
    const result = resolveAgentConfig('builder', config);
    expect(result.effort).toBe('high');
    expect(result.effortSource).toBe('role');
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_CONFIG sweep across all 25 roles
// ---------------------------------------------------------------------------

describe('DEFAULT_CONFIG default tier recipes apply to all roles', () => {
  const expectedModelForTier: Record<string, string> = {
    planning: 'claude-opus-4-7',
    implementation: 'claude-sonnet-4-6',
    review: 'claude-opus-4-7',
    evaluation: 'claude-opus-4-7',
  };

  it('every role resolves to a tier and gets that tier\'s model', () => {
    for (const role of ALL_ROLES) {
      const result = resolveAgentConfig(role, DEFAULT_CONFIG);
      const tier = AGENT_ROLE_TIERS[role];
      expect(result.tier, `${role} tier`).toBe(tier);
      expect(result.model.id, `${role} model.id`).toBe(expectedModelForTier[tier]);
    }
  });

  it('every role has effort defined', () => {
    for (const role of ALL_ROLES) {
      const result = resolveAgentConfig(role, DEFAULT_CONFIG);
      expect(result.effort, `${role} effort`).toBeDefined();
      expect(['low', 'medium', 'high', 'xhigh', 'max']).toContain(result.effort);
    }
  });

  it('all roles have non-undefined tier and tierSource', () => {
    for (const role of ALL_ROLES) {
      const result = resolveAgentConfig(role, DEFAULT_CONFIG);
      expect(result.tier, `${role} tier`).toBeDefined();
      expect(result.tierSource).toBe('tier');
    }
  });
});

// ---------------------------------------------------------------------------
// Role tier reassignment via agents.roles[role].tier
// ---------------------------------------------------------------------------

describe('role tier reassignment via agents.roles[role].tier', () => {
  const config = resolveConfig({
    agents: {
      tiers: { ...FULL_TIERS, review: { ...FULL_TIERS.review, effort: 'xhigh' } },
      roles: {
        tester: { tier: 'review' as const },
      },
    },
  });

  it('tester moved to review tier picks up review tier effort (xhigh)', () => {
    const tester = resolveAgentConfig('tester', config);
    expect(tester.effort).toBe('xhigh');
    expect(tester.effortSource).toBe('tier');
    expect(tester.tier).toBe('review');
    expect(tester.tierSource).toBe('role');
  });

  it('builder stays in implementation tier', () => {
    const builder = resolveAgentConfig('builder', config);
    expect(builder.tier).toBe('implementation');
    expect(builder.tierSource).toBe('tier');
  });
});

// ---------------------------------------------------------------------------
// New role-to-tier mapping per the schema simplification
// ---------------------------------------------------------------------------

describe('AGENT_ROLE_TIERS new mapping after schema simplification', () => {
  it('merge-conflict-resolver is in planning tier', () => {
    expect(AGENT_ROLE_TIERS['merge-conflict-resolver']).toBe('planning');
  });
  it('doc-author is in implementation tier', () => {
    expect(AGENT_ROLE_TIERS['doc-author']).toBe('implementation');
  });
  it('doc-syncer is in implementation tier', () => {
    expect(AGENT_ROLE_TIERS['doc-syncer']).toBe('implementation');
  });
  it('gap-closer is in planning tier', () => {
    expect(AGENT_ROLE_TIERS['gap-closer']).toBe('planning');
  });
  it('dependency-detector is in implementation tier', () => {
    expect(AGENT_ROLE_TIERS['dependency-detector']).toBe('implementation');
  });
  it('prd-validator is in implementation tier', () => {
    expect(AGENT_ROLE_TIERS['prd-validator']).toBe('implementation');
  });
  it('staleness-assessor is in implementation tier', () => {
    expect(AGENT_ROLE_TIERS['staleness-assessor']).toBe('implementation');
  });

  it('all 25 roles are mapped', () => {
    expect(Object.keys(AGENT_ROLE_TIERS)).toHaveLength(25);
    for (const role of ALL_ROLES) {
      expect(AGENT_ROLE_TIERS[role]).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// agentTierSchema validation
// ---------------------------------------------------------------------------

describe('agentTierSchema', () => {
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
