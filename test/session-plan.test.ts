/**
 * Tests for the session-plan module in @eforge-build/input.
 *
 * Covers:
 *  - parseSessionPlan / serializeSessionPlan: round-trip fidelity
 *  - selectDimensions: type+depth → dimension set derivation and frontmatter override
 *  - checkReadiness: substantive content vs. placeholder vs. skipped rules
 *  - migrateBooleanDimensions: legacy boolean shape → new required_dimensions shape
 *  - sessionPlanToBuildSource: PRD-style output formatting
 */
import { describe, it, expect } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  parseSessionPlan,
  serializeSessionPlan,
  selectDimensions,
  checkReadiness,
  migrateBooleanDimensions,
  sessionPlanToBuildSource,
  listActiveSessionPlans,
  type SessionPlan,
} from '@eforge-build/input';
import { useTempDir } from './test-tmpdir.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlanRaw(overrides: Partial<{
  session: string;
  topic: string;
  status: string;
  planning_type: string;
  planning_depth: string;
  required_dimensions: string[];
  optional_dimensions: string[];
  skipped_dimensions: Array<{ name: string; reason: string }>;
  body: string;
}> = {}): string {
  const session = overrides.session ?? '2026-04-01-test-plan';
  const topic = overrides.topic ?? 'Test Plan';
  const status = overrides.status ?? 'planning';
  const planning_type = overrides.planning_type ?? 'feature';
  const planning_depth = overrides.planning_depth ?? 'focused';
  const required = overrides.required_dimensions ?? ['scope', 'acceptance-criteria'];
  const optional = overrides.optional_dimensions ?? [];
  const skipped = overrides.skipped_dimensions ?? [];
  const body = overrides.body ?? `\n# ${topic}\n\n## Scope\n\nAdd the dark mode feature.\n\n## Acceptance Criteria\n\nDark mode toggles correctly.\n`;

  const skippedYaml = skipped.length > 0
    ? `skipped_dimensions:\n${skipped.map(s => `  - name: ${s.name}\n    reason: ${s.reason}`).join('\n')}\n`
    : 'skipped_dimensions: []\n';

  const requiredYaml = `required_dimensions:\n${required.map(d => `  - ${d}`).join('\n')}\n`;
  const optionalYaml = optional.length > 0
    ? `optional_dimensions:\n${optional.map(d => `  - ${d}`).join('\n')}\n`
    : 'optional_dimensions: []\n';

  return `---
session: ${session}
topic: "${topic}"
status: ${status}
planning_type: ${planning_type}
planning_depth: ${planning_depth}
${requiredYaml}${optionalYaml}${skippedYaml}open_questions: []
profile: null
---
${body}`;
}

// ---------------------------------------------------------------------------
// parseSessionPlan / serializeSessionPlan
// ---------------------------------------------------------------------------

describe('parseSessionPlan', () => {
  it('parses a valid session plan', () => {
    const raw = makePlanRaw();
    const plan = parseSessionPlan(raw);

    expect(plan.session).toBe('2026-04-01-test-plan');
    expect(plan.topic).toBe('Test Plan');
    expect(plan.status).toBe('planning');
    expect(plan.planning_type).toBe('feature');
    expect(plan.planning_depth).toBe('focused');
    expect(plan.required_dimensions).toContain('scope');
    expect(plan.required_dimensions).toContain('acceptance-criteria');
  });

  it('populates sections from body ## headings', () => {
    const raw = makePlanRaw();
    const plan = parseSessionPlan(raw);

    expect(plan.sections.has('scope')).toBe(true);
    expect(plan.sections.get('scope')).toContain('dark mode');
    expect(plan.sections.has('acceptance criteria')).toBe(true);
  });

  it('parses skipped_dimensions as objects', () => {
    const raw = makePlanRaw({
      skipped_dimensions: [{ name: 'risks', reason: 'low-risk change' }],
    });
    const plan = parseSessionPlan(raw);

    expect(plan.skipped_dimensions).toHaveLength(1);
    expect(plan.skipped_dimensions[0].name).toBe('risks');
    expect(plan.skipped_dimensions[0].reason).toBe('low-risk change');
  });

  it('defaults missing array fields to empty arrays', () => {
    const raw = `---
session: minimal-plan
topic: "Minimal"
status: planning
planning_type: refactor
planning_depth: focused
---

# Minimal
`;
    const plan = parseSessionPlan(raw);
    expect(plan.required_dimensions).toEqual([]);
    expect(plan.optional_dimensions).toEqual([]);
    expect(plan.skipped_dimensions).toEqual([]);
    expect(plan.open_questions).toEqual([]);
    expect(plan.profile).toBeNull();
  });

  it('throws on missing required frontmatter fields', () => {
    const raw = `---
topic: "Missing session id"
status: planning
---
`;
    expect(() => parseSessionPlan(raw)).toThrow();
  });

  it('throws on invalid status value', () => {
    const raw = `---
session: bad-status
topic: "Bad"
status: in-progress
planning_type: feature
planning_depth: focused
---
`;
    expect(() => parseSessionPlan(raw)).toThrow();
  });
});

describe('serializeSessionPlan', () => {
  it('round-trips a parsed plan', () => {
    const raw = makePlanRaw();
    const plan = parseSessionPlan(raw);
    const serialized = serializeSessionPlan(plan);
    const reparsed = parseSessionPlan(serialized);

    expect(reparsed.session).toBe(plan.session);
    expect(reparsed.topic).toBe(plan.topic);
    expect(reparsed.status).toBe(plan.status);
    expect(reparsed.planning_type).toBe(plan.planning_type);
    expect(reparsed.required_dimensions).toEqual(plan.required_dimensions);
    expect(reparsed.skipped_dimensions).toEqual(plan.skipped_dimensions);
  });

  it('serialized output contains frontmatter delimiters', () => {
    const plan = parseSessionPlan(makePlanRaw());
    const serialized = serializeSessionPlan(plan);

    expect(serialized).toMatch(/^---\n/);
    expect(serialized).toContain('---\n');
  });

  it('preserves body content after serialization', () => {
    const body = '\n# Test Plan\n\n## Scope\n\nDo the thing.\n\n## Acceptance Criteria\n\nIt works.\n';
    const plan = parseSessionPlan(makePlanRaw({ body }));
    const serialized = serializeSessionPlan(plan);

    expect(serialized).toContain('Do the thing.');
    expect(serialized).toContain('It works.');
  });
});

// ---------------------------------------------------------------------------
// selectDimensions
// ---------------------------------------------------------------------------

describe('selectDimensions', () => {
  it('returns frontmatter dimensions when explicitly set', () => {
    const plan = parseSessionPlan(makePlanRaw({
      required_dimensions: ['scope', 'code-impact', 'acceptance-criteria'],
      optional_dimensions: ['risks'],
    }));
    const dims = selectDimensions(plan);

    expect(dims.required).toEqual(['scope', 'code-impact', 'acceptance-criteria']);
    expect(dims.optional).toEqual(['risks']);
  });

  it('derives dimensions from planning_type when required_dimensions is empty', () => {
    const raw = `---
session: derived-plan
topic: "Derived"
status: planning
planning_type: refactor
planning_depth: focused
required_dimensions: []
optional_dimensions: []
skipped_dimensions: []
open_questions: []
profile: null
---

# Derived
`;
    const plan = parseSessionPlan(raw);
    const dims = selectDimensions(plan);

    expect(dims.required).toContain('scope');
    expect(dims.required).toContain('code-impact');
    expect(dims.required).toContain('acceptance-criteria');
  });

  it('trims required dimensions for quick depth', () => {
    const raw = `---
session: quick-plan
topic: "Quick"
status: planning
planning_type: feature
planning_depth: quick
required_dimensions: []
optional_dimensions: []
skipped_dimensions: []
open_questions: []
profile: null
---

# Quick
`;
    const plan = parseSessionPlan(raw);
    const dims = selectDimensions(plan);

    // Quick depth: at most problem-statement/scope + 1 type-specific + acceptance-criteria
    expect(dims.required.length).toBeLessThanOrEqual(3);
    expect(dims.required).toContain('acceptance-criteria');
  });

  it('includes optional dimensions for deep depth', () => {
    const raw = `---
session: deep-plan
topic: "Deep"
status: planning
planning_type: feature
planning_depth: deep
required_dimensions: []
optional_dimensions: []
skipped_dimensions: []
open_questions: []
profile: null
---

# Deep
`;
    const plan = parseSessionPlan(raw);
    const dims = selectDimensions(plan);

    // Deep: all required + all optional
    expect(dims.optional.length).toBeGreaterThan(0);
    expect(dims.optional).toContain('risks');
  });

  it('includes skipped dimension names', () => {
    const plan = parseSessionPlan(makePlanRaw({
      skipped_dimensions: [{ name: 'risks', reason: 'low-risk' }],
    }));
    const dims = selectDimensions(plan);

    expect(dims.skipped).toContain('risks');
  });

  it('returns all required dimensions for unknown type', () => {
    const raw = `---
session: unknown-plan
topic: "Unknown"
status: planning
planning_type: unknown
planning_depth: focused
required_dimensions: []
optional_dimensions: []
skipped_dimensions: []
open_questions: []
profile: null
---

# Unknown
`;
    const plan = parseSessionPlan(raw);
    const dims = selectDimensions(plan);

    expect(dims.required).toContain('scope');
    expect(dims.required).toContain('code-impact');
    expect(dims.required).toContain('architecture-impact');
    expect(dims.required).toContain('design-decisions');
    expect(dims.required).toContain('documentation-impact');
    expect(dims.required).toContain('risks');
    expect(dims.required).toContain('acceptance-criteria');
  });
});

// ---------------------------------------------------------------------------
// checkReadiness
// ---------------------------------------------------------------------------

describe('checkReadiness', () => {
  it('returns ready:true when all required dimensions have substantive content', () => {
    const plan = parseSessionPlan(makePlanRaw({
      required_dimensions: ['scope', 'acceptance-criteria'],
      body: '\n# Test Plan\n\n## Scope\n\nThis is real content about scope.\n\n## Acceptance Criteria\n\nThe feature works as expected.\n',
    }));
    const result = checkReadiness(plan);

    expect(result.ready).toBe(true);
    expect(result.missingDimensions).toHaveLength(0);
  });

  it('returns ready:false when a required dimension has no section', () => {
    const plan = parseSessionPlan(makePlanRaw({
      required_dimensions: ['scope', 'code-impact', 'acceptance-criteria'],
      body: '\n# Test Plan\n\n## Scope\n\nThis is real content.\n\n## Acceptance Criteria\n\nWorks.\n',
    }));
    const result = checkReadiness(plan);

    expect(result.ready).toBe(false);
    expect(result.missingDimensions).toContain('code-impact');
  });

  it('returns ready:false when a dimension section contains only placeholder content', () => {
    const plan = parseSessionPlan(makePlanRaw({
      required_dimensions: ['scope'],
      body: '\n# Test Plan\n\n## Scope\n\nTBD\n',
    }));
    const result = checkReadiness(plan);

    expect(result.ready).toBe(false);
    expect(result.missingDimensions).toContain('scope');
  });

  it('treats N/A as a placeholder (not substantive)', () => {
    const plan = parseSessionPlan(makePlanRaw({
      required_dimensions: ['scope'],
      body: '\n# Test Plan\n\n## Scope\n\nN/A\n',
    }));
    const result = checkReadiness(plan);

    expect(result.ready).toBe(false);
  });

  it('counts a dimension as covered when it appears in skipped_dimensions', () => {
    const plan = parseSessionPlan(makePlanRaw({
      required_dimensions: ['scope', 'risks'],
      skipped_dimensions: [{ name: 'risks', reason: 'low-risk trivial change' }],
      body: '\n# Test Plan\n\n## Scope\n\nAdd the feature.\n',
    }));
    const result = checkReadiness(plan);

    expect(result.ready).toBe(true);
    expect(result.missingDimensions).not.toContain('risks');
  });

  it('returns ready:false when section content is only blank lines', () => {
    const plan = parseSessionPlan(makePlanRaw({
      required_dimensions: ['scope'],
      body: '\n# Test Plan\n\n## Scope\n\n\n\n',
    }));
    const result = checkReadiness(plan);

    expect(result.ready).toBe(false);
  });

  it('handles case-insensitive dimension heading matching', () => {
    // 'acceptance-criteria' dimension should match '## Acceptance Criteria' heading
    const plan = parseSessionPlan(makePlanRaw({
      required_dimensions: ['acceptance-criteria'],
      body: '\n# Test Plan\n\n## Acceptance Criteria\n\nAll tests pass.\n',
    }));
    const result = checkReadiness(plan);

    expect(result.ready).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// migrateBooleanDimensions
// ---------------------------------------------------------------------------

describe('migrateBooleanDimensions', () => {
  it('returns plan unchanged when no legacy dimensions field', () => {
    const plan = parseSessionPlan(makePlanRaw());
    const migrated = migrateBooleanDimensions(plan);

    expect(migrated).toBe(plan); // Same reference — no migration
  });

  it('migrates legacy boolean dimensions to required_dimensions', () => {
    // Simulate a legacy plan by injecting the dimensions field
    const raw = `---
session: legacy-plan
topic: "Legacy"
status: planning
planning_type: unknown
planning_depth: focused
dimensions:
  scope: true
  code-impact: false
  architecture-impact: false
  design-decisions: true
  documentation-impact: false
  risks: false
  acceptance-criteria: false
required_dimensions: []
optional_dimensions: []
skipped_dimensions: []
open_questions: []
profile: null
---

# Legacy

## Scope

Old scope content.

## Design Decisions

Old design decisions content.
`;
    const plan = parseSessionPlan(raw);
    const migrated = migrateBooleanDimensions(plan);

    // After migration, all legacy dims should be in required_dimensions
    expect(migrated.planning_type).toBe('unknown');
    expect(migrated.required_dimensions).toContain('scope');
    expect(migrated.required_dimensions).toContain('code-impact');
    expect(migrated.required_dimensions).toContain('architecture-impact');
    expect(migrated.required_dimensions).toContain('design-decisions');
    expect(migrated.required_dimensions).toContain('documentation-impact');
    expect(migrated.required_dimensions).toContain('risks');
    expect(migrated.required_dimensions).toContain('acceptance-criteria');
    expect(migrated.optional_dimensions).toEqual([]);
  });

  it('readiness check correctly identifies missing dims after migration', () => {
    const raw = `---
session: legacy-readiness
topic: "Legacy Readiness"
status: planning
planning_type: unknown
planning_depth: focused
dimensions:
  scope: true
  code-impact: false
  architecture-impact: false
  design-decisions: false
  documentation-impact: false
  risks: false
  acceptance-criteria: false
required_dimensions: []
optional_dimensions: []
skipped_dimensions: []
open_questions: []
profile: null
---

# Legacy Readiness

## Scope

Scope has content.
`;
    const plan = parseSessionPlan(raw);
    const migrated = migrateBooleanDimensions(plan);
    const result = checkReadiness(migrated);

    // scope has content (covered); others do not
    expect(result.ready).toBe(false);
    expect(result.missingDimensions).not.toContain('scope');
    expect(result.missingDimensions).toContain('code-impact');
  });
});

// ---------------------------------------------------------------------------
// sessionPlanToBuildSource
// ---------------------------------------------------------------------------

describe('sessionPlanToBuildSource', () => {
  it('uses the topic as the top-level heading', () => {
    const plan = parseSessionPlan(makePlanRaw({ topic: 'Add dark mode' }));
    const source = sessionPlanToBuildSource(plan);

    expect(source).toMatch(/^# Add dark mode/);
  });

  it('strips a leading "# {topic}" heading from the body to avoid duplication', () => {
    const plan = parseSessionPlan(makePlanRaw({
      topic: 'Add dark mode',
      body: '\n# Add dark mode\n\n## Scope\n\nDo the thing.\n',
    }));
    const source = sessionPlanToBuildSource(plan);

    // Should have exactly one # heading (the injected one, not the duplicate)
    const h1Count = (source.match(/^# /mg) ?? []).length;
    expect(h1Count).toBe(1);
    expect(source).toContain('Do the thing.');
  });

  it('includes dimension section content', () => {
    const plan = parseSessionPlan(makePlanRaw({
      body: '\n# Test\n\n## Scope\n\nThe scope is X.\n\n## Acceptance Criteria\n\nMust pass tests.\n',
    }));
    const source = sessionPlanToBuildSource(plan);

    expect(source).toContain('The scope is X.');
    expect(source).toContain('Must pass tests.');
  });

  it('produces stable output for identical inputs', () => {
    const plan = parseSessionPlan(makePlanRaw());
    expect(sessionPlanToBuildSource(plan)).toBe(sessionPlanToBuildSource(plan));
  });
});

// ---------------------------------------------------------------------------
// listActiveSessionPlans
// ---------------------------------------------------------------------------

describe('listActiveSessionPlans', () => {
  const makeTempDir = useTempDir('session-plans-');

  it('returns empty list when directory does not exist', async () => {
    const cwd = makeTempDir();
    const entries = await listActiveSessionPlans({ cwd });
    expect(entries).toHaveLength(0);
  });

  it('returns active plans (planning and ready)', async () => {
    const cwd = makeTempDir();
    const dir = resolve(cwd, '.eforge', 'session-plans');
    await mkdir(dir, { recursive: true });

    const planningRaw = makePlanRaw({ session: '2026-01-01-plan-a', topic: 'Plan A', status: 'planning' });
    const readyRaw = makePlanRaw({ session: '2026-01-02-plan-b', topic: 'Plan B', status: 'ready' });
    const abandonedRaw = makePlanRaw({ session: '2026-01-03-plan-c', topic: 'Plan C', status: 'abandoned' });

    await writeFile(resolve(dir, '2026-01-01-plan-a.md'), planningRaw, 'utf-8');
    await writeFile(resolve(dir, '2026-01-02-plan-b.md'), readyRaw, 'utf-8');
    await writeFile(resolve(dir, '2026-01-03-plan-c.md'), abandonedRaw, 'utf-8');

    const entries = await listActiveSessionPlans({ cwd });

    expect(entries).toHaveLength(2);
    const sessions = entries.map((e) => e.session);
    expect(sessions).toContain('2026-01-01-plan-a');
    expect(sessions).toContain('2026-01-02-plan-b');
    expect(sessions).not.toContain('2026-01-03-plan-c');
  });

  it('sorts results by session id', async () => {
    const cwd = makeTempDir();
    const dir = resolve(cwd, '.eforge', 'session-plans');
    await mkdir(dir, { recursive: true });

    await writeFile(resolve(dir, 'bbb.md'), makePlanRaw({ session: 'bbb', topic: 'B' }), 'utf-8');
    await writeFile(resolve(dir, 'aaa.md'), makePlanRaw({ session: 'aaa', topic: 'A' }), 'utf-8');

    const entries = await listActiveSessionPlans({ cwd });
    expect(entries[0].session).toBe('aaa');
    expect(entries[1].session).toBe('bbb');
  });
});
