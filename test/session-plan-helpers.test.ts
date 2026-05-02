/**
 * Tests for the new session-plan mutation and I/O helpers in @eforge-build/input.
 *
 * Covers:
 *  - createSessionPlan: fresh plan creation
 *  - setSessionPlanSection: append and replace section in body
 *  - skipDimension / unskipDimension: skipped_dimensions management
 *  - setSessionPlanStatus: status update with metadata validation
 *  - setSessionPlanDimensions: dimension list derivation and overwrite
 *  - getReadinessDetail: covered/skipped/missing dimension arrays
 *  - resolveSessionPlanPath: path-traversal guard
 *  - loadSessionPlan / writeSessionPlan: disk I/O with path constraints
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  parseSessionPlan,
  serializeSessionPlan,
  createSessionPlan,
  setSessionPlanSection,
  skipDimension,
  unskipDimension,
  setSessionPlanStatus,
  setSessionPlanDimensions,
  getReadinessDetail,
  resolveSessionPlanPath,
  loadSessionPlan,
  writeSessionPlan,
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

  const requiredYaml = required.length > 0
    ? `required_dimensions:\n${required.map(d => `  - ${d}`).join('\n')}\n`
    : 'required_dimensions: []\n';
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
// createSessionPlan
// ---------------------------------------------------------------------------

describe('createSessionPlan', () => {
  it('creates a plan with planning status', () => {
    const plan = createSessionPlan({ session: '2026-05-01-test', topic: 'Test Feature' });
    expect(plan.status).toBe('planning');
    expect(plan.session).toBe('2026-05-01-test');
    expect(plan.topic).toBe('Test Feature');
  });

  it('uses provided planningType and planningDepth', () => {
    const plan = createSessionPlan({
      session: '2026-05-01-test',
      topic: 'Bug Fix',
      planningType: 'bugfix',
      planningDepth: 'quick',
    });
    expect(plan.planning_type).toBe('bugfix');
    expect(plan.planning_depth).toBe('quick');
  });

  it('defaults to unknown type and focused depth', () => {
    const plan = createSessionPlan({ session: 'test', topic: 'Test' });
    expect(plan.planning_type).toBe('unknown');
    expect(plan.planning_depth).toBe('focused');
  });

  it('initializes empty dimension arrays', () => {
    const plan = createSessionPlan({ session: 'test', topic: 'Test' });
    expect(plan.required_dimensions).toEqual([]);
    expect(plan.optional_dimensions).toEqual([]);
    expect(plan.skipped_dimensions).toEqual([]);
    expect(plan.open_questions).toEqual([]);
  });

  it('sets profile when provided', () => {
    const plan = createSessionPlan({ session: 'test', topic: 'Test', profile: 'expedition' });
    expect(plan.profile).toBe('expedition');
  });

  it('defaults profile to null', () => {
    const plan = createSessionPlan({ session: 'test', topic: 'Test' });
    expect(plan.profile).toBeNull();
  });

  it('includes topic as top-level heading in body', () => {
    const plan = createSessionPlan({ session: 'test', topic: 'My Topic' });
    expect(plan.body).toContain('# My Topic');
  });
});

// ---------------------------------------------------------------------------
// setSessionPlanSection
// ---------------------------------------------------------------------------

describe('setSessionPlanSection', () => {
  it('appends a new section when none exists', () => {
    const plan = parseSessionPlan(makePlanRaw({
      required_dimensions: ['scope'],
      body: '\n# Test Plan\n',
    }));
    const updated = setSessionPlanSection(plan, 'scope', 'Define the new feature.');

    expect(updated.body).toContain('## Scope');
    expect(updated.body).toContain('Define the new feature.');
  });

  it('replaces an existing section in place', () => {
    const plan = parseSessionPlan(makePlanRaw({
      required_dimensions: ['scope', 'acceptance-criteria'],
      body: '\n# Test Plan\n\n## Scope\n\nOld scope content.\n\n## Acceptance Criteria\n\nOriginal AC.\n',
    }));
    const updated = setSessionPlanSection(plan, 'scope', 'New scope content.');

    expect(updated.body).toContain('New scope content.');
    expect(updated.body).not.toContain('Old scope content.');
    // Other sections should be preserved
    expect(updated.body).toContain('## Acceptance Criteria');
    expect(updated.body).toContain('Original AC.');
  });

  it('replaces section without duplicating the heading', () => {
    const plan = parseSessionPlan(makePlanRaw({
      required_dimensions: ['scope'],
      body: '\n# Test Plan\n\n## Scope\n\nFirst content.\n',
    }));
    const updated = setSessionPlanSection(plan, 'scope', 'Second content.');
    const headingCount = (updated.body.match(/^## Scope/m) ?? []).length;
    expect(headingCount).toBe(1);
  });

  it('updates the sections map on the returned plan', () => {
    const plan = parseSessionPlan(makePlanRaw({
      required_dimensions: ['scope'],
      body: '\n# Test Plan\n\n## Scope\n\nOld.\n',
    }));
    const updated = setSessionPlanSection(plan, 'scope', 'Updated scope.');
    expect(updated.sections.get('scope')).toContain('Updated scope.');
  });

  it('converts kebab-case dimension name to Title Case heading', () => {
    const plan = parseSessionPlan(makePlanRaw({
      required_dimensions: ['acceptance-criteria'],
      body: '\n# Test Plan\n',
    }));
    const updated = setSessionPlanSection(plan, 'acceptance-criteria', 'All tests pass.');
    expect(updated.body).toContain('## Acceptance Criteria');
  });

  it('does not mutate the original plan', () => {
    const plan = parseSessionPlan(makePlanRaw({
      required_dimensions: ['scope'],
      body: '\n# Test Plan\n\n## Scope\n\nOriginal.\n',
    }));
    const originalBody = plan.body;
    setSessionPlanSection(plan, 'scope', 'Changed.');
    expect(plan.body).toBe(originalBody);
  });
});

// ---------------------------------------------------------------------------
// skipDimension / unskipDimension
// ---------------------------------------------------------------------------

describe('skipDimension', () => {
  it('adds a new entry to skipped_dimensions', () => {
    const plan = parseSessionPlan(makePlanRaw({ skipped_dimensions: [] }));
    const updated = skipDimension(plan, 'documentation-impact', 'no docs affected');

    expect(updated.skipped_dimensions).toHaveLength(1);
    expect(updated.skipped_dimensions[0].name).toBe('documentation-impact');
    expect(updated.skipped_dimensions[0].reason).toBe('no docs affected');
  });

  it('updates the reason when dimension is already skipped', () => {
    const plan = parseSessionPlan(makePlanRaw({
      skipped_dimensions: [{ name: 'risks', reason: 'old reason' }],
    }));
    const updated = skipDimension(plan, 'risks', 'new reason');

    expect(updated.skipped_dimensions).toHaveLength(1);
    expect(updated.skipped_dimensions[0].reason).toBe('new reason');
  });

  it('does not mutate the original plan', () => {
    const plan = parseSessionPlan(makePlanRaw({ skipped_dimensions: [] }));
    skipDimension(plan, 'risks', 'low-risk');
    expect(plan.skipped_dimensions).toHaveLength(0);
  });
});

describe('unskipDimension', () => {
  it('removes the entry from skipped_dimensions', () => {
    const plan = parseSessionPlan(makePlanRaw({
      skipped_dimensions: [{ name: 'documentation-impact', reason: 'no docs affected' }],
    }));
    const updated = unskipDimension(plan, 'documentation-impact');

    expect(updated.skipped_dimensions).toHaveLength(0);
  });

  it('is a no-op when dimension was not skipped', () => {
    const plan = parseSessionPlan(makePlanRaw({ skipped_dimensions: [] }));
    const updated = unskipDimension(plan, 'risks');

    expect(updated.skipped_dimensions).toHaveLength(0);
  });

  it('does not mutate the original plan', () => {
    const plan = parseSessionPlan(makePlanRaw({
      skipped_dimensions: [{ name: 'risks', reason: 'low risk' }],
    }));
    unskipDimension(plan, 'risks');
    expect(plan.skipped_dimensions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// setSessionPlanStatus
// ---------------------------------------------------------------------------

describe('setSessionPlanStatus', () => {
  it('updates status to ready', () => {
    const plan = parseSessionPlan(makePlanRaw({ status: 'planning' }));
    const updated = setSessionPlanStatus(plan, 'ready');
    expect(updated.status).toBe('ready');
  });

  it('updates status to abandoned', () => {
    const plan = parseSessionPlan(makePlanRaw({ status: 'planning' }));
    const updated = setSessionPlanStatus(plan, 'abandoned');
    expect(updated.status).toBe('abandoned');
  });

  it('sets status to submitted with eforge_session', () => {
    const plan = parseSessionPlan(makePlanRaw({ status: 'ready' }));
    const updated = setSessionPlanStatus(plan, 'submitted', { eforge_session: 'abc-123' });
    expect(updated.status).toBe('submitted');
    expect(updated.eforge_session).toBe('abc-123');
  });

  it('throws when setting submitted without eforge_session', () => {
    const plan = parseSessionPlan(makePlanRaw({ status: 'ready' }));
    expect(() => setSessionPlanStatus(plan, 'submitted')).toThrow();
    expect(() => setSessionPlanStatus(plan, 'submitted', {})).toThrow();
  });

  it('does not mutate the original plan', () => {
    const plan = parseSessionPlan(makePlanRaw({ status: 'planning' }));
    setSessionPlanStatus(plan, 'ready');
    expect(plan.status).toBe('planning');
  });
});

// ---------------------------------------------------------------------------
// setSessionPlanDimensions
// ---------------------------------------------------------------------------

describe('setSessionPlanDimensions', () => {
  it('writes dimension lists when required_dimensions is empty', () => {
    const plan = parseSessionPlan(makePlanRaw({
      planning_type: 'bugfix',
      planning_depth: 'focused',
      required_dimensions: [],
      optional_dimensions: [],
    }));
    const updated = setSessionPlanDimensions(plan, { planningType: 'bugfix', planningDepth: 'focused' });
    expect(updated.required_dimensions).toContain('problem-statement');
    expect(updated.required_dimensions).toContain('acceptance-criteria');
  });

  it('is a no-op on dimension lists when explicit lists exist and overwrite is not set', () => {
    const plan = parseSessionPlan(makePlanRaw({
      planning_type: 'feature',
      planning_depth: 'focused',
      required_dimensions: ['scope', 'acceptance-criteria'],
    }));
    const updated = setSessionPlanDimensions(plan, { planningType: 'bugfix', planningDepth: 'focused' });
    // Dimension lists unchanged
    expect(updated.required_dimensions).toEqual(['scope', 'acceptance-criteria']);
    // But planning_type updated
    expect(updated.planning_type).toBe('bugfix');
  });

  it('overwrites dimension lists when overwrite: true', () => {
    const plan = parseSessionPlan(makePlanRaw({
      planning_type: 'feature',
      planning_depth: 'focused',
      required_dimensions: ['scope'],
    }));
    const updated = setSessionPlanDimensions(plan, {
      planningType: 'bugfix',
      planningDepth: 'focused',
      overwrite: true,
    });
    expect(updated.required_dimensions).toContain('problem-statement');
    expect(updated.required_dimensions).not.toContain('scope');
  });

  it('does not mutate the original plan', () => {
    const plan = parseSessionPlan(makePlanRaw({
      required_dimensions: [],
    }));
    setSessionPlanDimensions(plan, { planningType: 'bugfix' });
    expect(plan.required_dimensions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getReadinessDetail
// ---------------------------------------------------------------------------

describe('getReadinessDetail', () => {
  it('returns covered dimensions for filled sections', () => {
    const plan = parseSessionPlan(makePlanRaw({
      required_dimensions: ['scope', 'acceptance-criteria'],
      body: '\n# Test Plan\n\n## Scope\n\nReal scope content.\n\n## Acceptance Criteria\n\nAll tests pass.\n',
    }));
    const detail = getReadinessDetail(plan);

    expect(detail.ready).toBe(true);
    expect(detail.coveredDimensions).toContain('scope');
    expect(detail.coveredDimensions).toContain('acceptance-criteria');
    expect(detail.missingDimensions).toHaveLength(0);
  });

  it('returns missing dimensions for unfilled required sections', () => {
    const plan = parseSessionPlan(makePlanRaw({
      required_dimensions: ['scope', 'code-impact', 'acceptance-criteria'],
      body: '\n# Test Plan\n\n## Scope\n\nReal scope.\n\n## Acceptance Criteria\n\nAC.\n',
    }));
    const detail = getReadinessDetail(plan);

    expect(detail.ready).toBe(false);
    expect(detail.missingDimensions).toContain('code-impact');
    expect(detail.coveredDimensions).toContain('scope');
    expect(detail.coveredDimensions).toContain('acceptance-criteria');
  });

  it('returns skipped dimensions in skippedDimensions array', () => {
    const plan = parseSessionPlan(makePlanRaw({
      required_dimensions: ['scope', 'risks'],
      skipped_dimensions: [{ name: 'risks', reason: 'low-risk change' }],
      body: '\n# Test Plan\n\n## Scope\n\nScope content.\n',
    }));
    const detail = getReadinessDetail(plan);

    expect(detail.ready).toBe(true);
    expect(detail.skippedDimensions).toContain('risks');
    expect(detail.missingDimensions).not.toContain('risks');
    expect(detail.coveredDimensions).not.toContain('risks');
  });

  it('returns all three arrays in addition to ready boolean', () => {
    const plan = parseSessionPlan(makePlanRaw({
      required_dimensions: ['scope'],
      body: '\n# Test Plan\n\n## Scope\n\nContent.\n',
    }));
    const detail = getReadinessDetail(plan);

    expect(detail).toHaveProperty('ready');
    expect(detail).toHaveProperty('missingDimensions');
    expect(detail).toHaveProperty('coveredDimensions');
    expect(detail).toHaveProperty('skippedDimensions');
  });
});

// ---------------------------------------------------------------------------
// resolveSessionPlanPath
// ---------------------------------------------------------------------------

describe('resolveSessionPlanPath', () => {
  it('resolves a valid session to the expected path', () => {
    const cwd = '/some/project';
    const filePath = resolveSessionPlanPath({ cwd, session: '2026-05-01-add-dark-mode' });
    expect(filePath).toBe('/some/project/.eforge/session-plans/2026-05-01-add-dark-mode.md');
  });

  it('throws on path traversal attempt with ../', () => {
    expect(() =>
      resolveSessionPlanPath({ cwd: '/some/project', session: '../etc/passwd' }),
    ).toThrow();
  });

  it('throws on path traversal with nested separators', () => {
    expect(() =>
      resolveSessionPlanPath({ cwd: '/some/project', session: 'foo/../../../etc/passwd' }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadSessionPlan / writeSessionPlan
// ---------------------------------------------------------------------------

describe('loadSessionPlan / writeSessionPlan', () => {
  const makeTempDir = useTempDir('session-plan-io-');

  it('writes and reads back a session plan', async () => {
    const cwd = makeTempDir();
    const plan = parseSessionPlan(makePlanRaw({ session: '2026-05-01-write-test', topic: 'Write Test' }));

    await writeSessionPlan({ cwd, plan });

    const loaded = await loadSessionPlan({ cwd, session: '2026-05-01-write-test' });
    expect(loaded.session).toBe('2026-05-01-write-test');
    expect(loaded.topic).toBe('Write Test');
  });

  it('writeSessionPlan creates the session-plans directory if missing', async () => {
    const cwd = makeTempDir();
    const plan = parseSessionPlan(makePlanRaw({ session: 'auto-mkdir-test', topic: 'Mkdir Test' }));

    // Directory doesn't exist yet
    await writeSessionPlan({ cwd, plan });

    const filePath = resolveSessionPlanPath({ cwd, session: 'auto-mkdir-test' });
    const raw = await readFile(filePath, 'utf-8');
    expect(raw).toContain('Mkdir Test');
  });

  it('writeSessionPlan uses plan.session when session is not specified', async () => {
    const cwd = makeTempDir();
    const plan = parseSessionPlan(makePlanRaw({ session: 'implicit-session', topic: 'Implicit' }));

    await writeSessionPlan({ cwd, plan });

    const loaded = await loadSessionPlan({ cwd, session: 'implicit-session' });
    expect(loaded.session).toBe('implicit-session');
  });

  it('writeSessionPlan throws when path escapes session-plans dir', async () => {
    const cwd = makeTempDir();
    const plan = parseSessionPlan(makePlanRaw());
    const evilPath = resolve(cwd, '..', 'evil.md');

    await expect(writeSessionPlan({ cwd, path: evilPath, plan })).rejects.toThrow();
  });

  it('writeSessionPlan respects explicit session override', async () => {
    const cwd = makeTempDir();
    const plan = parseSessionPlan(makePlanRaw({ session: 'original-session', topic: 'Override Test' }));

    await writeSessionPlan({ cwd, session: 'overridden-session', plan });

    const loaded = await loadSessionPlan({ cwd, session: 'overridden-session' });
    expect(loaded.topic).toBe('Override Test');
  });
});
