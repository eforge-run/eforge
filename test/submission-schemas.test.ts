import { describe, it, expect } from 'vitest';
import { planSetSubmissionSchema, architectureSubmissionSchema } from '@eforge-build/engine/schemas';

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
    const result = planSetSubmissionSchema.safeParse(makeValidPayload());
    expect(result.success).toBe(true);
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
    const result = planSetSubmissionSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message);
      expect(messages.some(m => m.includes('Duplicate plan ID'))).toBe(true);
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
    const result = planSetSubmissionSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message);
      expect(messages.some(m => m.includes('unknown plan'))).toBe(true);
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
    const result = planSetSubmissionSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message);
      expect(messages.some(m => m.includes('cycle'))).toBe(true);
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
    const result = planSetSubmissionSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message);
      expect(messages.some(m => m.includes('do not match'))).toBe(true);
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
    const result = planSetSubmissionSchema.safeParse(payload);
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
    const result = planSetSubmissionSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('strips dependsOn from plan frontmatter (orchestration.yaml is canonical source)', () => {
    // A planner that emits dependsOn in plan frontmatter has it stripped silently by Zod.
    // deps belong in orchestration.plans[].dependsOn only.
    const payload = {
      description: 'A plan set',
      plans: [{
        frontmatter: {
          id: 'plan-01-auth',
          name: 'Auth Plan',
          dependsOn: ['plan-02-api'],  // unknown field — Zod strips it
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
    const result = planSetSubmissionSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      // Zod strips unknown fields by default — dependsOn must not appear on frontmatter
      expect((result.data.plans[0].frontmatter as Record<string, unknown>).dependsOn).toBeUndefined();
    }
  });
});

describe('architectureSubmissionSchema', () => {
  it('accepts a valid payload', () => {
    const result = architectureSubmissionSchema.safeParse({
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
    const result = architectureSubmissionSchema.safeParse({
      architecture: '',
      modules: [{ id: 'mod-a', description: 'A', dependsOn: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('validates modules as a non-empty array', () => {
    const result = architectureSubmissionSchema.safeParse({
      architecture: '# Arch',
      modules: [],
    });
    expect(result.success).toBe(false);
  });

  it('requires module id, description, and dependsOn', () => {
    const result = architectureSubmissionSchema.safeParse({
      architecture: '# Arch',
      modules: [{ id: '', description: 'test', dependsOn: [] }],
    });
    expect(result.success).toBe(false);
  });
});
