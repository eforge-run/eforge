import { describe, it, expect } from 'vitest';
import {
  planSetSubmissionSchema,
  architectureSubmissionSchema,
  validatePlanSetSubmission,
} from '@eforge-build/engine/schemas';
import { safeParseWithSchema } from '@eforge-build/client';

function makePlan(overrides: Record<string, unknown> = {}) {
  return {
    frontmatter: {
      id: 'plan-01-auth',
      name: 'Auth Plan',
      ...overrides,
    },
    body: '# Auth Plan\n\nImplement auth.',
  };
}

function makeValidPayload(overrides: Record<string, unknown> = {}) {
  return {
    description: 'A plan set',
    plans: [
      makePlan(),
      makePlan({ id: 'plan-02-api', name: 'API Plan' }),
    ],
    orchestration: {
      validate: [],
      plans: [
        { id: 'plan-01-auth', dependsOn: [] },
        { id: 'plan-02-api', dependsOn: ['plan-01-auth'] },
      ],
    },
    ...overrides,
  };
}

describe('planSetSubmissionSchema', () => {
  it('accepts a valid payload', () => {
    const parseResult = safeParseWithSchema(planSetSubmissionSchema, makeValidPayload());
    expect(parseResult.success).toBe(true);
    if (parseResult.success) {
      const result = validatePlanSetSubmission(parseResult.data);
      expect(result.success).toBe(true);
    }
  });

  it('rejects duplicate plan IDs', () => {
    const payload = makeValidPayload({
      plans: [
        makePlan({ id: 'plan-01-dup' }),
        makePlan({ id: 'plan-01-dup', name: 'Dup Plan' }),
      ],
      orchestration: {
        validate: [],
        plans: [
          { id: 'plan-01-dup', dependsOn: [] },
        ],
      },
    });
    const parseResult = safeParseWithSchema(planSetSubmissionSchema, payload);
    // Schema-level parse may succeed (duplicate IDs are a cross-field constraint)
    // Post-parse validator catches it
    if (parseResult.success) {
      const result = validatePlanSetSubmission(parseResult.data);
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map(i => i.message);
        expect(messages.some(m => m.includes('Duplicate plan ID'))).toBe(true);
      }
    } else {
      // If schema-level parse also fails (e.g. due to other constraints), that's acceptable
      expect(parseResult.success).toBe(false);
    }
  });

  it('rejects dangling dependsOn references', () => {
    const payload = makeValidPayload({
      plans: [
        makePlan({ id: 'plan-01-a' }),
      ],
      orchestration: {
        validate: [],
        plans: [
          { id: 'plan-01-a', dependsOn: ['plan-99-nonexistent'] },
        ],
      },
    });
    const parseResult = safeParseWithSchema(planSetSubmissionSchema, payload);
    if (parseResult.success) {
      const result = validatePlanSetSubmission(parseResult.data);
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map(i => i.message);
        expect(messages.some(m => m.includes('unknown plan'))).toBe(true);
      }
    } else {
      expect(parseResult.success).toBe(false);
    }
  });

  it('rejects dependency cycles (A depends on B, B depends on A)', () => {
    const payload = makeValidPayload({
      plans: [
        makePlan({ id: 'plan-a' }),
        makePlan({ id: 'plan-b', name: 'B' }),
      ],
      orchestration: {
        validate: [],
        plans: [
          { id: 'plan-a', dependsOn: ['plan-b'] },
          { id: 'plan-b', dependsOn: ['plan-a'] },
        ],
      },
    });
    const parseResult = safeParseWithSchema(planSetSubmissionSchema, payload);
    if (parseResult.success) {
      const result = validatePlanSetSubmission(parseResult.data);
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map(i => i.message);
        expect(messages.some(m => m.includes('cycle'))).toBe(true);
      }
    } else {
      expect(parseResult.success).toBe(false);
    }
  });

  it('rejects when orchestration plan IDs do not match submitted plan IDs', () => {
    const payload = makeValidPayload({
      plans: [makePlan({ id: 'plan-01-auth' })],
      orchestration: {
        validate: [],
        plans: [
          { id: 'plan-99-wrong', dependsOn: [] },
        ],
      },
    });
    const parseResult = safeParseWithSchema(planSetSubmissionSchema, payload);
    if (parseResult.success) {
      const result = validatePlanSetSubmission(parseResult.data);
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map(i => i.message);
        expect(messages.some(m => m.includes('do not match'))).toBe(true);
      }
    } else {
      expect(parseResult.success).toBe(false);
    }
  });

  it('rejects invalid migration timestamps', () => {
    const payload = makeValidPayload({
      plans: [
        makePlan({
          id: 'plan-01-mig',
          migrations: [{ timestamp: 'not-a-timestamp', description: 'bad migration' }],
        }),
      ],
      orchestration: {
        validate: [],
        plans: [
          { id: 'plan-01-mig', dependsOn: [] },
        ],
      },
    });
    const result = safeParseWithSchema(planSetSubmissionSchema, payload);
    expect(result.success).toBe(false);
  });

  it('accepts valid migration timestamps (14 digits)', () => {
    const payload = makeValidPayload({
      plans: [
        makePlan({
          id: 'plan-01-mig',
          migrations: [{ timestamp: '20260415120000', description: 'add table' }],
        }),
      ],
      orchestration: {
        validate: [],
        plans: [
          { id: 'plan-01-mig', dependsOn: [] },
        ],
      },
    });
    const result = safeParseWithSchema(planSetSubmissionSchema, payload);
    expect(result.success).toBe(true);
  });

  it('accepts plan frontmatter with extra fields (TypeBox does not strip unknowns)', () => {
    // TypeBox does not strip unknown fields from objects (unlike Zod's default behavior).
    // A planner that emits dependsOn in plan frontmatter is accepted; the extra field
    // is benign since orchestration.yaml is the canonical dependency source.
    const payload = {
      description: 'A plan set',
      plans: [{
        frontmatter: {
          id: 'plan-01-auth',
          name: 'Auth Plan',
          dependsOn: ['plan-02-api'],  // extra field — TypeBox allows it
        },
        body: '# Auth Plan',
      }],
      orchestration: {
        validate: [],
        plans: [
          { id: 'plan-01-auth', dependsOn: [] },
        ],
      },
    };
    const result = safeParseWithSchema(planSetSubmissionSchema, payload);
    expect(result.success).toBe(true);
    // Note: TypeBox does not strip unknown fields (unlike Zod's default behavior).
    // The dependsOn extra field remains in result.data.plans[0].frontmatter.
  });
});

describe('architectureSubmissionSchema', () => {
  it('accepts a valid payload', () => {
    const result = safeParseWithSchema(architectureSubmissionSchema, {
      architecture: '# Architecture\n\nDesign doc.',
      modules: [
        { id: 'mod-auth', description: 'Auth module', dependsOn: [] },
        { id: 'mod-api', description: 'API module', dependsOn: ['mod-auth'] },
      ],
      index: {
        name: 'my-plan',
        description: 'A plan set',
        mode: 'expedition',
        validate: [],
        modules: {
          'mod-auth': { description: 'Auth module', depends_on: [] },
          'mod-api': { description: 'API module', depends_on: ['mod-auth'] },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('validates architecture as non-empty string', () => {
    const result = safeParseWithSchema(architectureSubmissionSchema, {
      architecture: '',
      modules: [{ id: 'mod-a', description: 'A', dependsOn: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('validates modules as a non-empty array', () => {
    const result = safeParseWithSchema(architectureSubmissionSchema, {
      architecture: '# Arch',
      modules: [],
    });
    expect(result.success).toBe(false);
  });

  it('requires module id, description, and dependsOn', () => {
    const result = safeParseWithSchema(architectureSubmissionSchema, {
      architecture: '# Arch',
      modules: [{ id: '', description: 'test', dependsOn: [] }],
    });
    expect(result.success).toBe(false);
  });
});
