/**
 * Integration tests for playbook HTTP routes.
 *
 * Drives the daemon in-process via `startServer` (consistent with the
 * serve-queue and daemon-recovery test patterns). Each test creates a real
 * temp directory with a minimal eforge project layout, exercises each of the
 * seven playbook routes, and asserts status codes, response shapes, and
 * engine-side persistence.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { useTempDir } from './test-tmpdir.js';
import { openDatabase } from '@eforge-build/monitor/db';
import { startServer, type MonitorServer } from '@eforge-build/monitor/server';
import { API_ROUTES } from '@eforge-build/client';

const makeTempDir = useTempDir('eforge-playbook-api-');

let server: MonitorServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set up a minimal eforge project with git and a config directory. */
async function setupProject(tmpDir: string): Promise<{ configDir: string }> {
  // Init git repo
  const gitOpts = { cwd: tmpDir };
  execFileSync('git', ['init', '-b', 'main'], gitOpts);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], gitOpts);
  execFileSync('git', ['config', 'user.name', 'Test'], gitOpts);
  execFileSync('git', ['commit', '--allow-empty', '-m', 'chore: initial commit'], gitOpts);

  // Create eforge config directory (so getConfigDir resolves it)
  const configDir = resolve(tmpDir, 'eforge');
  await mkdir(configDir, { recursive: true });
  await writeFile(resolve(configDir, 'config.yaml'), '', 'utf-8');

  return { configDir };
}

/** Build a valid raw playbook string. */
function validPlaybookRaw(opts: {
  name?: string;
  description?: string;
  scope?: string;
  goal?: string;
} = {}): string {
  const name = opts.name ?? 'my-feature';
  const description = opts.description ?? 'Add the my-feature capability';
  const scope = opts.scope ?? 'project-team';
  const goal = opts.goal ?? 'Implement the feature.';
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    `scope: ${scope}`,
    '---',
    '',
    '## Goal',
    '',
    goal,
  ].join('\n');
}

/** POST helper that sends JSON. */
async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Route: GET /api/playbook/list
// ---------------------------------------------------------------------------

describe('GET /api/playbook/list', () => {
  it('returns empty list when no playbooks exist', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);

    const db = openDatabase(resolve(tmpDir, 'monitor.db'));
    server = await startServer(db, 0, { strictPort: true, cwd: tmpDir });

    const res = await fetch(`http://localhost:${server.port}${API_ROUTES.playbookList}`);
    expect(res.status).toBe(200);

    const data = await res.json() as { playbooks: unknown[]; warnings: unknown[] };
    expect(Array.isArray(data.playbooks)).toBe(true);
    expect(data.playbooks).toHaveLength(0);
    expect(Array.isArray(data.warnings)).toBe(true);
  });

  it('returns playbooks with source and shadows fields when files exist at multiple tiers', async () => {
    const tmpDir = makeTempDir();
    const { configDir } = await setupProject(tmpDir);

    // Write project-team playbook
    const teamDir = resolve(configDir, 'playbooks');
    await mkdir(teamDir, { recursive: true });
    await writeFile(resolve(teamDir, 'my-feature.md'), validPlaybookRaw({ scope: 'project-team' }), 'utf-8');

    // Write project-local shadow
    const localDir = resolve(tmpDir, '.eforge', 'playbooks');
    await mkdir(localDir, { recursive: true });
    await writeFile(resolve(localDir, 'my-feature.md'), validPlaybookRaw({ scope: 'project-local' }), 'utf-8');

    const db = openDatabase(resolve(tmpDir, 'monitor.db'));
    server = await startServer(db, 0, { strictPort: true, cwd: tmpDir });

    const res = await fetch(`http://localhost:${server.port}${API_ROUTES.playbookList}`);
    expect(res.status).toBe(200);

    const data = await res.json() as {
      playbooks: Array<{ name: string; source: string; shadows: Array<{ source: string; path: string }> }>;
      warnings: string[];
    };

    expect(data.playbooks.length).toBeGreaterThanOrEqual(1);
    const entry = data.playbooks.find((p) => p.name === 'my-feature');
    expect(entry).toBeDefined();
    // project-local has highest precedence; source should be 'project-local'
    expect(entry!.source).toBe('project-local');
    // project-team is a shadow
    expect(entry!.shadows.length).toBeGreaterThanOrEqual(1);
    expect(entry!.shadows.some((s) => s.source === 'project-team')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Route: GET /api/playbook/show
// ---------------------------------------------------------------------------

describe('GET /api/playbook/show', () => {
  it('returns 400 when name param is missing', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);

    const db = openDatabase(resolve(tmpDir, 'monitor.db'));
    server = await startServer(db, 0, { strictPort: true, cwd: tmpDir });

    const res = await fetch(`http://localhost:${server.port}${API_ROUTES.playbookShow}`);
    expect(res.status).toBe(400);
  });

  it('returns 404 when playbook does not exist', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);

    const db = openDatabase(resolve(tmpDir, 'monitor.db'));
    server = await startServer(db, 0, { strictPort: true, cwd: tmpDir });

    const res = await fetch(`http://localhost:${server.port}${API_ROUTES.playbookShow}?name=nonexistent`);
    expect(res.status).toBe(404);
  });

  it('returns playbook frontmatter and body for an existing playbook', async () => {
    const tmpDir = makeTempDir();
    const { configDir } = await setupProject(tmpDir);

    const teamDir = resolve(configDir, 'playbooks');
    await mkdir(teamDir, { recursive: true });
    await writeFile(resolve(teamDir, 'my-feature.md'), validPlaybookRaw(), 'utf-8');

    const db = openDatabase(resolve(tmpDir, 'monitor.db'));
    server = await startServer(db, 0, { strictPort: true, cwd: tmpDir });

    const res = await fetch(`http://localhost:${server.port}${API_ROUTES.playbookShow}?name=my-feature`);
    expect(res.status).toBe(200);

    const data = await res.json() as {
      playbook: { name: string; description: string; scope: string; goal: string };
      source: string;
      shadows: unknown[];
    };
    expect(data.playbook.name).toBe('my-feature');
    expect(data.playbook.description).toBe('Add the my-feature capability');
    expect(data.playbook.scope).toBe('project-team');
    expect(data.playbook.goal).toContain('Implement the feature');
    expect(data.source).toBe('project-team');
    expect(Array.isArray(data.shadows)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Route: POST /api/playbook/save
// ---------------------------------------------------------------------------

describe('POST /api/playbook/save', () => {
  it('returns 400 with errors array when playbook frontmatter is invalid', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);

    const db = openDatabase(resolve(tmpDir, 'monitor.db'));
    server = await startServer(db, 0, { strictPort: true, cwd: tmpDir });

    const res = await post(`http://localhost:${server.port}${API_ROUTES.playbookSave}`, {
      scope: 'project-team',
      playbook: {
        frontmatter: { name: 'INVALID NAME', description: '', scope: 'project-team' },
        body: { goal: 'Do something.' },
      },
    });
    expect(res.status).toBe(400);

    const data = await res.json() as { error: string; errors: string[] };
    expect(data.error).toContain('validation');
    expect(Array.isArray(data.errors)).toBe(true);
    expect(data.errors.length).toBeGreaterThan(0);
  });

  it('returns 400 when the Goal section is missing', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);

    const db = openDatabase(resolve(tmpDir, 'monitor.db'));
    server = await startServer(db, 0, { strictPort: true, cwd: tmpDir });

    const res = await post(`http://localhost:${server.port}${API_ROUTES.playbookSave}`, {
      scope: 'project-team',
      playbook: {
        frontmatter: { name: 'my-feature', description: 'A feature', scope: 'project-team' },
        body: { goal: '' }, // empty goal → invalid
      },
    });
    expect(res.status).toBe(400);

    const data = await res.json() as { errors: string[] };
    expect(Array.isArray(data.errors)).toBe(true);
    expect(data.errors.some((e) => /goal/i.test(e))).toBe(true);
  });

  it('writes the playbook file and returns its path', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);

    const db = openDatabase(resolve(tmpDir, 'monitor.db'));
    server = await startServer(db, 0, { strictPort: true, cwd: tmpDir });

    const res = await post(`http://localhost:${server.port}${API_ROUTES.playbookSave}`, {
      scope: 'project-team',
      playbook: {
        frontmatter: { name: 'my-feature', description: 'Add the my-feature capability', scope: 'project-team' },
        body: { goal: 'Implement the feature.', outOfScope: '', acceptanceCriteria: '', plannerNotes: '' },
      },
    });
    expect(res.status).toBe(200);

    const data = await res.json() as { path: string };
    expect(typeof data.path).toBe('string');
    expect(data.path).toContain('my-feature.md');

    // Verify file was actually written
    await expect(access(data.path)).resolves.toBeUndefined();
    const content = await readFile(data.path, 'utf-8');
    expect(content).toContain('name: my-feature');
    expect(content).toContain('## Goal');
  });
});

// ---------------------------------------------------------------------------
// Route: POST /api/playbook/enqueue
// ---------------------------------------------------------------------------

describe('POST /api/playbook/enqueue', () => {
  it('returns 404 when the named playbook does not exist', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);

    const db = openDatabase(resolve(tmpDir, 'monitor.db'));
    server = await startServer(db, 0, { strictPort: true, cwd: tmpDir });

    const res = await post(`http://localhost:${server.port}${API_ROUTES.playbookEnqueue}`, {
      name: 'nonexistent',
    });
    expect(res.status).toBe(404);
  });

  it('creates a PRD in the queue dir and returns its id', async () => {
    const tmpDir = makeTempDir();
    const { configDir } = await setupProject(tmpDir);

    // Write a playbook to the team dir
    const teamDir = resolve(configDir, 'playbooks');
    await mkdir(teamDir, { recursive: true });
    await writeFile(resolve(teamDir, 'my-feature.md'), validPlaybookRaw(), 'utf-8');

    const db = openDatabase(resolve(tmpDir, 'monitor.db'));
    server = await startServer(db, 0, { strictPort: true, cwd: tmpDir });

    const res = await post(`http://localhost:${server.port}${API_ROUTES.playbookEnqueue}`, {
      name: 'my-feature',
    });
    expect(res.status).toBe(200);

    const data = await res.json() as { id: string };
    expect(typeof data.id).toBe('string');
    expect(data.id.length).toBeGreaterThan(0);

    // Verify the PRD file exists in the queue
    const queueFile = resolve(tmpDir, 'eforge', 'queue', `${data.id}.md`);
    await expect(access(queueFile)).resolves.toBeUndefined();
    const content = await readFile(queueFile, 'utf-8');
    expect(content).toContain('title:');

    // Verify the enqueue commit was created with the correct subject
    const commitSubject = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: tmpDir }).toString().trim();
    expect(commitSubject).toMatch(new RegExp(`^enqueue\\(${data.id}\\): `));

    // Verify the queue directory is clean (no untracked or modified files)
    const gitStatus = execFileSync('git', ['status', '--porcelain', 'eforge/queue/'], { cwd: tmpDir }).toString().trim();
    expect(gitStatus).toBe('');
  });

  it('persists dependsOn in PRD frontmatter when afterQueueId is provided', async () => {
    const tmpDir = makeTempDir();
    const { configDir } = await setupProject(tmpDir);

    const teamDir = resolve(configDir, 'playbooks');
    await mkdir(teamDir, { recursive: true });
    await writeFile(resolve(teamDir, 'my-feature.md'), validPlaybookRaw(), 'utf-8');
    await writeFile(resolve(teamDir, 'my-dependent.md'), validPlaybookRaw(), 'utf-8');

    const db = openDatabase(resolve(tmpDir, 'monitor.db'));
    server = await startServer(db, 0, { strictPort: true, cwd: tmpDir });

    // First enqueue the predecessor so it exists in the queue
    const predecessorRes = await post(`http://localhost:${server.port}${API_ROUTES.playbookEnqueue}`, {
      name: 'my-feature',
    });
    expect(predecessorRes.status).toBe(200);
    const { id: predecessorId } = await predecessorRes.json() as { id: string };

    // Now enqueue the dependent with afterQueueId pointing to the predecessor
    const res = await post(`http://localhost:${server.port}${API_ROUTES.playbookEnqueue}`, {
      name: 'my-dependent',
      afterQueueId: predecessorId,
    });
    expect(res.status).toBe(200);

    const data = await res.json() as { id: string };
    // When afterQueueId is provided, the PRD goes into waiting/ not queue root
    const queueFile = resolve(tmpDir, 'eforge', 'queue', 'waiting', `${data.id}.md`);
    const content = await readFile(queueFile, 'utf-8');

    // The PRD frontmatter should include depends_on
    expect(content).toContain('depends_on');
    expect(content).toContain(predecessorId);
  });

  it('enqueued PRD is visible via GET /api/queue', async () => {
    const tmpDir = makeTempDir();
    const { configDir } = await setupProject(tmpDir);

    const teamDir = resolve(configDir, 'playbooks');
    await mkdir(teamDir, { recursive: true });
    await writeFile(resolve(teamDir, 'my-feature.md'), validPlaybookRaw(), 'utf-8');

    const db = openDatabase(resolve(tmpDir, 'monitor.db'));
    server = await startServer(db, 0, { strictPort: true, cwd: tmpDir });

    const enqueueRes = await post(`http://localhost:${server.port}${API_ROUTES.playbookEnqueue}`, {
      name: 'my-feature',
    });
    expect(enqueueRes.status).toBe(200);

    const { id } = await enqueueRes.json() as { id: string };

    // The new PRD should appear in the queue listing
    const queueRes = await fetch(`http://localhost:${server.port}${API_ROUTES.queue}`);
    expect(queueRes.status).toBe(200);

    const items = await queueRes.json() as Array<{ id: string; status: string }>;
    const found = items.find((item) => item.id === id);
    expect(found).toBeDefined();
    expect(found!.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Route: POST /api/playbook/promote
// ---------------------------------------------------------------------------

describe('POST /api/playbook/promote', () => {
  it('moves a playbook from project-local to project-team and returns the new path', async () => {
    const tmpDir = makeTempDir();
    const { configDir } = await setupProject(tmpDir);

    // Write playbook to project-local tier
    const localDir = resolve(tmpDir, '.eforge', 'playbooks');
    await mkdir(localDir, { recursive: true });
    await writeFile(resolve(localDir, 'my-feature.md'), validPlaybookRaw({ scope: 'project-local' }), 'utf-8');

    const db = openDatabase(resolve(tmpDir, 'monitor.db'));
    server = await startServer(db, 0, { strictPort: true, cwd: tmpDir });

    const res = await post(`http://localhost:${server.port}${API_ROUTES.playbookPromote}`, { name: 'my-feature' });
    expect(res.status).toBe(200);

    const data = await res.json() as { path: string };
    expect(typeof data.path).toBe('string');

    // New path should be under eforge/playbooks (project-team)
    expect(data.path).toContain('eforge');
    expect(data.path).toContain('playbooks');
    expect(data.path).toContain('my-feature.md');

    // Verify the file exists at the new location
    await expect(access(data.path)).resolves.toBeUndefined();

    // Old location should no longer exist
    const oldPath = resolve(localDir, 'my-feature.md');
    await expect(access(oldPath)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Route: POST /api/playbook/demote
// ---------------------------------------------------------------------------

describe('POST /api/playbook/demote', () => {
  it('moves a playbook from project-team to project-local and returns the new path', async () => {
    const tmpDir = makeTempDir();
    const { configDir } = await setupProject(tmpDir);

    // Write playbook to project-team tier
    const teamDir = resolve(configDir, 'playbooks');
    await mkdir(teamDir, { recursive: true });
    await writeFile(resolve(teamDir, 'my-feature.md'), validPlaybookRaw({ scope: 'project-team' }), 'utf-8');

    const db = openDatabase(resolve(tmpDir, 'monitor.db'));
    server = await startServer(db, 0, { strictPort: true, cwd: tmpDir });

    const res = await post(`http://localhost:${server.port}${API_ROUTES.playbookDemote}`, { name: 'my-feature' });
    expect(res.status).toBe(200);

    const data = await res.json() as { path: string };
    expect(typeof data.path).toBe('string');

    // New path should be under .eforge/playbooks (project-local)
    expect(data.path).toContain('.eforge');
    expect(data.path).toContain('playbooks');
    expect(data.path).toContain('my-feature.md');

    // Verify the file exists at the new location
    await expect(access(data.path)).resolves.toBeUndefined();

    // Old location should no longer exist
    const oldPath = resolve(teamDir, 'my-feature.md');
    await expect(access(oldPath)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Route: POST /api/playbook/validate
// ---------------------------------------------------------------------------

describe('POST /api/playbook/validate', () => {
  it('returns ok:true for a valid raw playbook', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);

    const db = openDatabase(resolve(tmpDir, 'monitor.db'));
    server = await startServer(db, 0, { strictPort: true, cwd: tmpDir });

    const res = await post(`http://localhost:${server.port}${API_ROUTES.playbookValidate}`, {
      raw: validPlaybookRaw(),
    });
    expect(res.status).toBe(200);

    const data = await res.json() as { ok: boolean; errors?: string[] };
    expect(data.ok).toBe(true);
    expect(data.errors).toBeUndefined();
  });

  it('returns ok:false with errors for an invalid raw playbook', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);

    const db = openDatabase(resolve(tmpDir, 'monitor.db'));
    server = await startServer(db, 0, { strictPort: true, cwd: tmpDir });

    const invalidRaw = '---\nname: INVALID NAME\nscope: bad-scope\n---\n\n## Goal\n\nDo something.';

    const res = await post(`http://localhost:${server.port}${API_ROUTES.playbookValidate}`, {
      raw: invalidRaw,
    });
    expect(res.status).toBe(200);

    const data = await res.json() as { ok: boolean; errors: string[] };
    expect(data.ok).toBe(false);
    expect(Array.isArray(data.errors)).toBe(true);
    expect(data.errors.length).toBeGreaterThan(0);
  });

  it('returns ok:false when the ## Goal section is missing', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);

    const db = openDatabase(resolve(tmpDir, 'monitor.db'));
    server = await startServer(db, 0, { strictPort: true, cwd: tmpDir });

    const rawNoGoal = '---\nname: my-feature\ndescription: A feature\nscope: project-team\n---\n\n## Out of scope\n\nNothing.';

    const res = await post(`http://localhost:${server.port}${API_ROUTES.playbookValidate}`, {
      raw: rawNoGoal,
    });
    expect(res.status).toBe(200);

    const data = await res.json() as { ok: boolean; errors: string[] };
    expect(data.ok).toBe(false);
    expect(data.errors.some((e) => /goal/i.test(e))).toBe(true);
  });
});
