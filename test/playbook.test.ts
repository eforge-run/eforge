/**
 * Tests for the playbook module.
 *
 * Covers:
 *  - validatePlaybook: schema validation (valid/invalid frontmatter, body)
 *  - playbookToSessionPlan: output shape stability
 *  - listPlaybooks / loadPlaybook: round-trip via writePlaybook then loadPlaybook
 *  - writePlaybook: atomic write + directory creation
 *  - Scope mismatch warning in listPlaybooks
 */
import { describe, it, expect } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validatePlaybook,
  playbookToSessionPlan,
  writePlaybook,
  loadPlaybook,
  listPlaybooks,
  movePlaybook,
  PlaybookNotFoundError,
  type Playbook,
} from '@eforge-build/engine/playbook';
import {
  userSetDir,
  projectLocalSetDir,
  projectTeamSetDir,
} from '@eforge-build/engine/set-resolver';
import { useTempDir } from './test-tmpdir.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validPlaybookRaw(overrides: Partial<{
  name: string;
  description: string;
  scope: string;
  body: string;
}> = {}): string {
  const name = overrides.name ?? 'my-feature';
  const description = overrides.description ?? 'Add the my-feature capability';
  const scope = overrides.scope ?? 'project-team';
  const body = overrides.body ?? `## Goal

Implement the feature.

## Out of scope

No migrations.

## Acceptance criteria

- Feature works.

## Notes for the planner

Keep it simple.`;

  return `---
name: ${name}
description: ${description}
scope: ${scope}
---
${body}`;
}

function validPlaybook(): Playbook {
  return {
    name: 'my-feature',
    description: 'Add the my-feature capability',
    scope: 'project-team',
    goal: 'Implement the feature.',
    outOfScope: 'No migrations.',
    acceptanceCriteria: '- Feature works.',
    plannerNotes: 'Keep it simple.',
  };
}

// ---------------------------------------------------------------------------
// validatePlaybook
// ---------------------------------------------------------------------------

describe('validatePlaybook', () => {
  it('returns ok:true for a valid playbook', () => {
    const result = validatePlaybook(validPlaybookRaw());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    expect(result.playbook.name).toBe('my-feature');
    expect(result.playbook.description).toBe('Add the my-feature capability');
    expect(result.playbook.scope).toBe('project-team');
    expect(result.playbook.goal).toBeTruthy();
  });

  it('returns ok:false when name is missing', () => {
    const raw = `---
description: A description
scope: user
---

## Goal

Do something.
`;
    const result = validatePlaybook(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.errors.some((e) => e.includes('name'))).toBe(true);
  });

  it('returns ok:false when description is missing', () => {
    const raw = `---
name: my-feature
scope: user
---

## Goal

Do something.
`;
    const result = validatePlaybook(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.errors.some((e) => e.includes('description'))).toBe(true);
  });

  it('returns ok:false when scope is missing', () => {
    const raw = `---
name: my-feature
description: A feature
---

## Goal

Do something.
`;
    const result = validatePlaybook(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.errors.some((e) => e.includes('scope'))).toBe(true);
  });

  it('returns ok:false when scope is an invalid enum value', () => {
    const raw = `---
name: my-feature
description: A feature
scope: global
---

## Goal

Do something.
`;
    const result = validatePlaybook(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns ok:false when ## Goal section is missing', () => {
    const raw = `---
name: my-feature
description: A feature
scope: user
---

## Out of scope

Nothing.
`;
    const result = validatePlaybook(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.errors.some((e) => e.toLowerCase().includes('goal'))).toBe(true);
  });

  it('returns ok:false when name is not kebab-case', () => {
    const raw = `---
name: My Feature
description: A feature
scope: user
---

## Goal

Do something.
`;
    const result = validatePlaybook(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.errors.some((e) => e.toLowerCase().includes('kebab'))).toBe(true);
  });

  it('returns ok:true when optional sections are absent', () => {
    const raw = `---
name: lean-feature
description: Lean
scope: project-local
---

## Goal

Just the goal.
`;
    const result = validatePlaybook(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    expect(result.playbook.goal).toContain('Just the goal');
    expect(result.playbook.outOfScope).toBe('');
    expect(result.playbook.acceptanceCriteria).toBe('');
    expect(result.playbook.plannerNotes).toBe('');
  });

  it('parses optional postMerge field (agentRuntime is removed)', () => {
    const raw = `---
name: full-feature
description: Full
scope: project-team
postMerge:
  - pnpm build
  - pnpm test
---

## Goal

Do everything.
`;
    const result = validatePlaybook(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    expect(result.playbook.postMerge).toEqual(['pnpm build', 'pnpm test']);
  });
});

// ---------------------------------------------------------------------------
// playbookToSessionPlan
// ---------------------------------------------------------------------------

describe('playbookToSessionPlan', () => {
  it('returns an object with name and source fields', () => {
    const pb = validPlaybook();
    const result = playbookToSessionPlan(pb);
    expect(typeof result.name).toBe('string');
    expect(typeof result.source).toBe('string');
    expect(result.name).toBe(pb.name);
  });

  it('source contains the goal text', () => {
    const pb = validPlaybook();
    const result = playbookToSessionPlan(pb);
    expect(result.source).toContain(pb.goal);
  });

  it('source contains the description as a heading', () => {
    const pb = validPlaybook();
    const result = playbookToSessionPlan(pb);
    expect(result.source).toContain(pb.description);
  });

  it('source contains out-of-scope text when present', () => {
    const pb = validPlaybook();
    const result = playbookToSessionPlan(pb);
    expect(result.source).toContain(pb.outOfScope);
  });

  it('source contains acceptance criteria when present', () => {
    const pb = validPlaybook();
    const result = playbookToSessionPlan(pb);
    expect(result.source).toContain(pb.acceptanceCriteria);
  });

  it('source contains planner notes when present', () => {
    const pb = validPlaybook();
    const result = playbookToSessionPlan(pb);
    expect(result.source).toContain(pb.plannerNotes);
  });

  it('exposes individual section fields', () => {
    const pb = validPlaybook();
    const result = playbookToSessionPlan(pb);
    expect(result.goal).toBe(pb.goal);
    expect(result.outOfScope).toBe(pb.outOfScope);
    expect(result.acceptanceCriteria).toBe(pb.acceptanceCriteria);
    expect(result.plannerNotes).toBe(pb.plannerNotes);
  });

  it('omits empty optional sections from source', () => {
    const pb: Playbook = {
      ...validPlaybook(),
      outOfScope: '',
      acceptanceCriteria: '',
      plannerNotes: '',
    };
    const result = playbookToSessionPlan(pb);
    expect(result.source).not.toContain('Out of scope');
    expect(result.source).not.toContain('Acceptance criteria');
    expect(result.source).not.toContain('Notes for the planner');
  });

  it('source is stable across identical inputs', () => {
    const pb = validPlaybook();
    expect(playbookToSessionPlan(pb).source).toBe(playbookToSessionPlan(pb).source);
  });
});

// ---------------------------------------------------------------------------
// writePlaybook / loadPlaybook / listPlaybooks round-trip
// ---------------------------------------------------------------------------

describe('writePlaybook + loadPlaybook round-trip', () => {
  const makeTempDir = useTempDir('playbook-');

  function makeOpts(root: string) {
    const configDir = resolve(root, 'eforge');
    const cwd = root;
    // Override XDG for user-tier tests
    process.env.XDG_CONFIG_HOME = resolve(root, 'xdg-config');
    return { configDir, cwd };
  }

  it('writes to project-team tier and loads it back', async () => {
    const root = makeTempDir();
    const opts = makeOpts(root);
    const pb = validPlaybook();

    const { path } = await writePlaybook({ ...opts, scope: 'project-team', playbook: pb });
    expect(path).toContain('eforge');
    expect(path).toContain('playbooks');
    expect(path).toContain('my-feature.md');

    const loaded = await loadPlaybook({ ...opts, name: 'my-feature' });
    expect(loaded.playbook.name).toBe('my-feature');
    expect(loaded.playbook.goal).toContain('Implement the feature');
    expect(loaded.source).toBe('project-team');
  });

  it('writes to project-local tier and loads it back', async () => {
    const root = makeTempDir();
    const opts = makeOpts(root);
    const pb: Playbook = { ...validPlaybook(), scope: 'project-local' };

    await writePlaybook({ ...opts, scope: 'project-local', playbook: pb });
    const loaded = await loadPlaybook({ ...opts, name: 'my-feature' });
    expect(loaded.source).toBe('project-local');
  });

  it('writes to user tier and loads it back', async () => {
    const root = makeTempDir();
    const opts = makeOpts(root);
    const pb: Playbook = { ...validPlaybook(), scope: 'user' };

    await writePlaybook({ ...opts, scope: 'user', playbook: pb });
    const loaded = await loadPlaybook({ ...opts, name: 'my-feature' });
    expect(loaded.source).toBe('user');
  });

  it('creates the tier directory when it does not exist', async () => {
    const root = makeTempDir();
    const opts = makeOpts(root);
    const pb = validPlaybook();

    // Do NOT pre-create the directory
    await writePlaybook({ ...opts, scope: 'project-team', playbook: pb });
    const loaded = await loadPlaybook({ ...opts, name: 'my-feature' });
    expect(loaded.playbook.name).toBe('my-feature');
  });

  it('project-local wins over project-team when both exist', async () => {
    const root = makeTempDir();
    const opts = makeOpts(root);
    const pbProject: Playbook = { ...validPlaybook(), scope: 'project-team', goal: 'Project goal.' };
    const pbLocal: Playbook = { ...validPlaybook(), scope: 'project-local', goal: 'Local goal.' };

    await writePlaybook({ ...opts, scope: 'project-team', playbook: pbProject });
    await writePlaybook({ ...opts, scope: 'project-local', playbook: pbLocal });

    const loaded = await loadPlaybook({ ...opts, name: 'my-feature' });
    expect(loaded.source).toBe('project-local');
    expect(loaded.playbook.goal).toContain('Local goal');
    expect(loaded.shadows.some((s) => s.source === 'project-team')).toBe(true);
  });

  it('throws PlaybookNotFoundError when playbook does not exist', async () => {
    const root = makeTempDir();
    const opts = makeOpts(root);
    await expect(loadPlaybook({ ...opts, name: 'nonexistent' })).rejects.toThrow(PlaybookNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// listPlaybooks
// ---------------------------------------------------------------------------

describe('listPlaybooks', () => {
  const makeTempDir = useTempDir('playbook-list-');

  function makeOpts(root: string) {
    const configDir = resolve(root, 'eforge');
    const cwd = root;
    process.env.XDG_CONFIG_HOME = resolve(root, 'xdg-config');
    return { configDir, cwd };
  }

  it('returns empty list when no playbooks exist', async () => {
    const root = makeTempDir();
    const opts = makeOpts(root);
    const { playbooks, warnings } = await listPlaybooks(opts);
    expect(playbooks).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('returns three entries with correct source labels for distinct names', async () => {
    const root = makeTempDir();
    const opts = makeOpts(root);

    const pbLocal: Playbook = { ...validPlaybook(), name: 'local-pb', scope: 'project-local' };
    const pbProject: Playbook = { ...validPlaybook(), name: 'project-pb', scope: 'project-team' };
    const pbUser: Playbook = { ...validPlaybook(), name: 'user-pb', scope: 'user' };

    await writePlaybook({ ...opts, scope: 'project-local', playbook: pbLocal });
    await writePlaybook({ ...opts, scope: 'project-team', playbook: pbProject });
    await writePlaybook({ ...opts, scope: 'user', playbook: pbUser });

    const { playbooks, warnings } = await listPlaybooks(opts);
    expect(playbooks).toHaveLength(3);
    expect(warnings).toHaveLength(0);

    const byName = Object.fromEntries(playbooks.map((p) => [p.name, p]));
    expect(byName['local-pb'].source).toBe('project-local');
    expect(byName['project-pb'].source).toBe('project-team');
    expect(byName['user-pb'].source).toBe('user');
    expect(byName['local-pb'].shadows).toEqual([]);
    expect(byName['project-pb'].shadows).toEqual([]);
    expect(byName['user-pb'].shadows).toEqual([]);
  });

  it('returns one entry with full shadow chain when same name exists in all three tiers', async () => {
    const root = makeTempDir();
    const opts = makeOpts(root);

    const pbLocal: Playbook = { ...validPlaybook(), name: 'shared', scope: 'project-local' };
    const pbProject: Playbook = { ...validPlaybook(), name: 'shared', scope: 'project-team' };
    const pbUser: Playbook = { ...validPlaybook(), name: 'shared', scope: 'user' };

    // Write project-team and user with their own scope values
    await writePlaybook({ ...opts, scope: 'project-team', playbook: pbProject });
    await writePlaybook({ ...opts, scope: 'user', playbook: pbUser });
    // Write local last (it wins)
    await writePlaybook({ ...opts, scope: 'project-local', playbook: pbLocal });

    const { playbooks } = await listPlaybooks(opts);
    expect(playbooks).toHaveLength(1);
    expect(playbooks[0].name).toBe('shared');
    expect(playbooks[0].source).toBe('project-local');
    expect(playbooks[0].shadows).toHaveLength(2);
    expect(playbooks[0].shadows[0].source).toBe('project-team');
    expect(typeof playbooks[0].shadows[0].path).toBe('string');
    expect(playbooks[0].shadows[1].source).toBe('user');
    expect(typeof playbooks[0].shadows[1].path).toBe('string');
  });

  it('emits a warning when frontmatter scope does not match storage tier', async () => {
    const root = makeTempDir();
    const opts = makeOpts(root);

    // Write a playbook with scope: user but store it in the project-team dir
    const mismatchedPlaybook: Playbook = { ...validPlaybook(), name: 'mismatch', scope: 'user' };
    // Write it but force it into project-team dir manually
    const { configDir, cwd } = opts;
    const projectDir = projectTeamSetDir({ dirSegment: 'playbooks', fileExtension: 'md' }, configDir);
    await mkdir(projectDir, { recursive: true });

    // Use writePlaybook with project-team scope but frontmatter says user
    // We need to write the file directly with mismatched content
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      resolve(projectDir, 'mismatch.md'),
      `---
name: mismatch
description: A mismatched playbook
scope: user
---

## Goal

This has wrong scope in frontmatter.
`,
      'utf-8',
    );

    const { warnings } = await listPlaybooks(opts);
    expect(warnings.some((w) => w.includes('mismatch') && w.includes('scope'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// movePlaybook
// ---------------------------------------------------------------------------

describe('movePlaybook', () => {
  const makeTempDir = useTempDir('playbook-move-');

  function makeOpts(root: string) {
    const configDir = resolve(root, 'eforge');
    const cwd = root;
    process.env.XDG_CONFIG_HOME = resolve(root, 'xdg-config');
    return { configDir, cwd };
  }

  it('moves a playbook from project-team to project-local', async () => {
    const root = makeTempDir();
    const opts = makeOpts(root);
    const pb: Playbook = { ...validPlaybook(), scope: 'project-team' };

    await writePlaybook({ ...opts, scope: 'project-team', playbook: pb });

    const { path } = await movePlaybook({
      ...opts,
      name: 'my-feature',
      fromScope: 'project-team',
      toScope: 'project-local',
    });

    expect(path).toContain('.eforge');
    const loaded = await loadPlaybook({ ...opts, name: 'my-feature' });
    expect(loaded.source).toBe('project-local');
  });

  it('moves a playbook from project-local to project-team', async () => {
    const root = makeTempDir();
    const opts = makeOpts(root);
    const pb: Playbook = { ...validPlaybook(), scope: 'project-local' };

    await writePlaybook({ ...opts, scope: 'project-local', playbook: pb });

    await movePlaybook({
      ...opts,
      name: 'my-feature',
      fromScope: 'project-local',
      toScope: 'project-team',
    });

    const loaded = await loadPlaybook({ ...opts, name: 'my-feature' });
    expect(loaded.source).toBe('project-team');
  });
});
