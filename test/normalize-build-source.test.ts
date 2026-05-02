/**
 * Tests for the normalizeBuildSource boundary helper in @eforge-build/input.
 *
 * Covers:
 *  - isSessionPlanPath matcher: only `.eforge/session-plans/*.md` paths match
 *  - Pass-through for non-session-plan content
 *  - Conversion for session-plan paths
 */
import { describe, it, expect } from 'vitest';
import { normalizeBuildSource } from '@eforge-build/input';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidSessionPlan(topic = 'My Feature'): string {
  return `---
session: 2026-04-01-my-feature
topic: "${topic}"
status: planning
planning_type: feature
planning_depth: focused
required_dimensions:
  - scope
  - acceptance-criteria
optional_dimensions: []
skipped_dimensions: []
open_questions: []
profile: null
---

# ${topic}

## Scope

Implement the feature.

## Acceptance Criteria

Feature works as expected.
`;
}

// ---------------------------------------------------------------------------
// Path matching — non-session-plan paths pass through unchanged
// ---------------------------------------------------------------------------

describe('normalizeBuildSource — non-session-plan paths', () => {
  it('passes through a plain markdown PRD unchanged', () => {
    const sourcePath = '/project/my-prd.md';
    const content = '# My PRD\n\nDo the thing.';

    const result = normalizeBuildSource({ sourcePath, content });

    expect(result.sourcePath).toBe(sourcePath);
    expect(result.content).toBe(content);
  });

  it('passes through a file in the eforge directory (not session-plans)', () => {
    const sourcePath = '/project/.eforge/config.yaml';
    const content = 'profile: excursion';

    const result = normalizeBuildSource({ sourcePath, content });

    expect(result.sourcePath).toBe(sourcePath);
    expect(result.content).toBe(content);
  });

  it('passes through a file in eforge/playbooks (not session-plans)', () => {
    const sourcePath = '/project/eforge/playbooks/my-playbook.md';
    const content = '---\nname: my-playbook\n---\n\n## Goal\n\nDo something.\n';

    const result = normalizeBuildSource({ sourcePath, content });

    expect(result.sourcePath).toBe(sourcePath);
    expect(result.content).toBe(content);
  });

  it('passes through a file in session-plans directory of a different path pattern', () => {
    // Must be exactly .eforge/session-plans, not a different path
    const sourcePath = '/project/session-plans/my-plan.md';
    const content = '# A plan';

    const result = normalizeBuildSource({ sourcePath, content });

    expect(result.sourcePath).toBe(sourcePath);
    expect(result.content).toBe(content);
  });

  it('passes through a non-md file under .eforge/session-plans', () => {
    const sourcePath = '/project/.eforge/session-plans/my-plan.yaml';
    const content = 'session: abc';

    const result = normalizeBuildSource({ sourcePath, content });

    expect(result.sourcePath).toBe(sourcePath);
    expect(result.content).toBe(content);
  });

  it('passes through a nested file under .eforge/session-plans subdirectory', () => {
    const sourcePath = '/project/.eforge/session-plans/archived/old-plan.md';
    const content = '# Old plan';

    const result = normalizeBuildSource({ sourcePath, content });

    expect(result.sourcePath).toBe(sourcePath);
    expect(result.content).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// Path matching — session-plan paths are converted
// ---------------------------------------------------------------------------

describe('normalizeBuildSource — session-plan paths', () => {
  it('converts a session plan at a standard path', () => {
    const sourcePath = '/project/.eforge/session-plans/2026-04-01-my-feature.md';
    const content = makeValidSessionPlan('My Feature');

    const result = normalizeBuildSource({ sourcePath, content });

    expect(result.sourcePath).toBe(sourcePath);
    expect(result.content).toContain('# My Feature');
    expect(result.content).toContain('Implement the feature.');
  });

  it('returns ordinary build source (not frontmatter) for a session-plan path', () => {
    const sourcePath = '/project/.eforge/session-plans/plan.md';
    const content = makeValidSessionPlan('Add Feature');

    const result = normalizeBuildSource({ sourcePath, content });

    // The result should NOT contain YAML frontmatter
    expect(result.content).not.toMatch(/^---/);
    expect(result.content).toMatch(/^# Add Feature/);
  });

  it('handles a deep nested project path with .eforge/session-plans', () => {
    const sourcePath = '/home/user/projects/my-app/.eforge/session-plans/2026-01-01-fix.md';
    const content = makeValidSessionPlan('Fix the bug');

    const result = normalizeBuildSource({ sourcePath, content });

    expect(result.content).toContain('# Fix the bug');
  });

  it('handles Windows-style paths (backslash separators)', () => {
    const sourcePath = 'C:\\Users\\user\\project\\.eforge\\session-plans\\plan.md';
    const content = makeValidSessionPlan('Windows Plan');

    const result = normalizeBuildSource({ sourcePath, content });

    expect(result.content).toContain('# Windows Plan');
  });

  it('throws when session-plan path has invalid frontmatter', () => {
    const sourcePath = '/project/.eforge/session-plans/bad-plan.md';
    const content = `---
topic: "Missing session id"
status: planning
---

# Bad plan
`;

    expect(() => normalizeBuildSource({ sourcePath, content })).toThrow();
  });

  it('result sourcePath is unchanged (not rewritten)', () => {
    const sourcePath = '/project/.eforge/session-plans/my-plan.md';
    const content = makeValidSessionPlan();

    const result = normalizeBuildSource({ sourcePath, content });

    expect(result.sourcePath).toBe(sourcePath);
  });
});
