/**
 * Tests for the generic set-artifact resolver.
 *
 * All tests are fixtures-free: each test builds a fresh temp directory tree
 * using the `useTempDir` helper and writes files programmatically.
 */
import { describe, it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  listSetArtifacts,
  loadSetArtifact,
  projectLocalSetDir,
  projectTeamSetDir,
  userSetDir,
  type SetKind,
} from '@eforge-build/engine/set-resolver';
import { useTempDir } from './test-tmpdir.js';

// ---------------------------------------------------------------------------
// Test kind descriptor (use .txt so tests don't conflict with real yaml/md)
// ---------------------------------------------------------------------------

const KIND: SetKind = { dirSegment: 'widgets', fileExtension: 'txt' };

// ---------------------------------------------------------------------------
// Temp dir builder helpers
// ---------------------------------------------------------------------------

describe('set-resolver', () => {
  const makeTempDir = useTempDir('set-resolver-');

  async function makeTree(root: string): Promise<{
    configDir: string;
    cwd: string;
    localDir: string;
    projectDir: string;
    userDir: string;
  }> {
    // configDir = <root>/eforge  (project-team tier)
    // cwd       = <root>         (project root, .eforge/ lives here)
    // userDir   = <root>/user    (simulate user dir via env var override)
    const configDir = resolve(root, 'eforge');
    const cwd = root;

    // Compute real dir paths using the helpers
    const localDir = projectLocalSetDir(KIND, cwd);
    const projectDir = projectTeamSetDir(KIND, configDir);

    // For the user tier we need to override XDG_CONFIG_HOME so userSetDir()
    // resolves inside our temp tree. Set env before calling the helpers.
    process.env.XDG_CONFIG_HOME = resolve(root, 'xdg-config');
    const userDir = userSetDir(KIND);

    await mkdir(localDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await mkdir(userDir, { recursive: true });

    return { configDir, cwd, localDir, projectDir, userDir };
  }

  async function writeArtifact(dir: string, name: string, content = 'content'): Promise<string> {
    const p = resolve(dir, `${name}.txt`);
    await writeFile(p, content, 'utf-8');
    return p;
  }

  // ---------------------------------------------------------------------------
  // listSetArtifacts
  // ---------------------------------------------------------------------------

  describe('listSetArtifacts', () => {
    it('returns an empty list when all tiers are empty', async () => {
      const root = makeTempDir();
      const { configDir, cwd } = await makeTree(root);
      const result = await listSetArtifacts(KIND, { configDir, cwd });
      expect(result).toEqual([]);
    });

    it('returns one entry from the user tier', async () => {
      const root = makeTempDir();
      const { configDir, cwd, userDir } = await makeTree(root);
      await writeArtifact(userDir, 'alpha');

      const result = await listSetArtifacts(KIND, { configDir, cwd });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('alpha');
      expect(result[0].source).toBe('user');
      expect(result[0].shadows).toEqual([]);
    });

    it('returns one entry from the project-team tier', async () => {
      const root = makeTempDir();
      const { configDir, cwd, projectDir } = await makeTree(root);
      await writeArtifact(projectDir, 'beta');

      const result = await listSetArtifacts(KIND, { configDir, cwd });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('beta');
      expect(result[0].source).toBe('project-team');
      expect(result[0].shadows).toEqual([]);
    });

    it('returns one entry from the project-local tier', async () => {
      const root = makeTempDir();
      const { configDir, cwd, localDir } = await makeTree(root);
      await writeArtifact(localDir, 'gamma');

      const result = await listSetArtifacts(KIND, { configDir, cwd });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('gamma');
      expect(result[0].source).toBe('project-local');
      expect(result[0].shadows).toEqual([]);
    });

    it('returns three entries with correct source labels for distinct names', async () => {
      const root = makeTempDir();
      const { configDir, cwd, localDir, projectDir, userDir } = await makeTree(root);
      await writeArtifact(localDir, 'local-only');
      await writeArtifact(projectDir, 'project-only');
      await writeArtifact(userDir, 'user-only');

      const result = await listSetArtifacts(KIND, { configDir, cwd });
      expect(result).toHaveLength(3);

      const byName = Object.fromEntries(result.map((e) => [e.name, e]));
      expect(byName['local-only'].source).toBe('project-local');
      expect(byName['local-only'].shadows).toEqual([]);
      expect(byName['project-only'].source).toBe('project-team');
      expect(byName['project-only'].shadows).toEqual([]);
      expect(byName['user-only'].source).toBe('user');
      expect(byName['user-only'].shadows).toEqual([]);
    });

    it('returns one entry when the same name exists in all three tiers', async () => {
      const root = makeTempDir();
      const { configDir, cwd, localDir, projectDir, userDir } = await makeTree(root);
      await writeArtifact(localDir, 'shared', 'local-content');
      await writeArtifact(projectDir, 'shared', 'project-content');
      await writeArtifact(userDir, 'shared', 'user-content');

      const result = await listSetArtifacts(KIND, { configDir, cwd });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('shared');
      expect(result[0].source).toBe('project-local');
      // Full shadow chain (not just immediate parent)
      expect(result[0].shadows).toEqual(['project-team', 'user']);
    });

    it('project-local shadows project-team only (user absent)', async () => {
      const root = makeTempDir();
      const { configDir, cwd, localDir, projectDir } = await makeTree(root);
      await writeArtifact(localDir, 'widget');
      await writeArtifact(projectDir, 'widget');

      const result = await listSetArtifacts(KIND, { configDir, cwd });
      expect(result).toHaveLength(1);
      expect(result[0].source).toBe('project-local');
      expect(result[0].shadows).toEqual(['project-team']);
    });

    it('project-team shadows user only (local absent)', async () => {
      const root = makeTempDir();
      const { configDir, cwd, projectDir, userDir } = await makeTree(root);
      await writeArtifact(projectDir, 'widget');
      await writeArtifact(userDir, 'widget');

      const result = await listSetArtifacts(KIND, { configDir, cwd });
      expect(result).toHaveLength(1);
      expect(result[0].source).toBe('project-team');
      expect(result[0].shadows).toEqual(['user']);
    });

    it('project-local shadows user (project-team absent)', async () => {
      const root = makeTempDir();
      const { configDir, cwd, localDir, userDir } = await makeTree(root);
      await writeArtifact(localDir, 'widget');
      await writeArtifact(userDir, 'widget');

      const result = await listSetArtifacts(KIND, { configDir, cwd });
      expect(result).toHaveLength(1);
      expect(result[0].source).toBe('project-local');
      expect(result[0].shadows).toEqual(['user']);
    });

    it('handles partial overlap: unique names plus a shadowed name', async () => {
      const root = makeTempDir();
      const { configDir, cwd, localDir, projectDir, userDir } = await makeTree(root);
      // 'shared' exists in all tiers → 1 entry
      await writeArtifact(localDir, 'shared');
      await writeArtifact(projectDir, 'shared');
      await writeArtifact(userDir, 'shared');
      // 'only-user' exists in user only → 1 entry
      await writeArtifact(userDir, 'only-user');
      // 'only-project' exists in project-team only → 1 entry
      await writeArtifact(projectDir, 'only-project');

      const result = await listSetArtifacts(KIND, { configDir, cwd });
      expect(result).toHaveLength(3);
      const byName = Object.fromEntries(result.map((e) => [e.name, e]));

      expect(byName['shared'].source).toBe('project-local');
      expect(byName['shared'].shadows).toEqual(['project-team', 'user']);

      expect(byName['only-user'].source).toBe('user');
      expect(byName['only-user'].shadows).toEqual([]);

      expect(byName['only-project'].source).toBe('project-team');
      expect(byName['only-project'].shadows).toEqual([]);
    });

    it('ignores files that do not match the kind extension', async () => {
      const root = makeTempDir();
      const { configDir, cwd, projectDir } = await makeTree(root);
      // Write a .yaml file in the widgets dir — should be ignored (extension is .txt)
      await writeFile(resolve(projectDir, 'ignored.yaml'), 'content', 'utf-8');
      await writeArtifact(projectDir, 'included');

      const result = await listSetArtifacts(KIND, { configDir, cwd });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('included');
    });

    it('returns entries sorted alphabetically within each tier', async () => {
      const root = makeTempDir();
      const { configDir, cwd, userDir } = await makeTree(root);
      await writeArtifact(userDir, 'zebra');
      await writeArtifact(userDir, 'alpha');
      await writeArtifact(userDir, 'mango');

      const result = await listSetArtifacts(KIND, { configDir, cwd });
      expect(result.map((e) => e.name)).toEqual(['alpha', 'mango', 'zebra']);
    });
  });

  // ---------------------------------------------------------------------------
  // loadSetArtifact
  // ---------------------------------------------------------------------------

  describe('loadSetArtifact', () => {
    it('returns null when no tier has the artifact', async () => {
      const root = makeTempDir();
      const { configDir, cwd } = await makeTree(root);
      const result = await loadSetArtifact(KIND, 'missing', { configDir, cwd });
      expect(result).toBeNull();
    });

    it('returns the user-tier path when only user has it', async () => {
      const root = makeTempDir();
      const { configDir, cwd, userDir } = await makeTree(root);
      const p = await writeArtifact(userDir, 'alpha');

      const result = await loadSetArtifact(KIND, 'alpha', { configDir, cwd });
      expect(result).not.toBeNull();
      expect(result!.source).toBe('user');
      expect(result!.path).toBe(p);
    });

    it('returns the project-team path when project-team has it and local does not', async () => {
      const root = makeTempDir();
      const { configDir, cwd, projectDir } = await makeTree(root);
      const p = await writeArtifact(projectDir, 'beta');

      const result = await loadSetArtifact(KIND, 'beta', { configDir, cwd });
      expect(result!.source).toBe('project-team');
      expect(result!.path).toBe(p);
    });

    it('returns project-local when all three tiers have the artifact', async () => {
      const root = makeTempDir();
      const { configDir, cwd, localDir, projectDir, userDir } = await makeTree(root);
      await writeArtifact(userDir, 'shared');
      await writeArtifact(projectDir, 'shared');
      const localPath = await writeArtifact(localDir, 'shared');

      const result = await loadSetArtifact(KIND, 'shared', { configDir, cwd });
      expect(result!.source).toBe('project-local');
      expect(result!.path).toBe(localPath);
    });

    it('returns project-local over project-team when local is present', async () => {
      const root = makeTempDir();
      const { configDir, cwd, localDir, projectDir } = await makeTree(root);
      await writeArtifact(projectDir, 'widget');
      const localPath = await writeArtifact(localDir, 'widget');

      const result = await loadSetArtifact(KIND, 'widget', { configDir, cwd });
      expect(result!.source).toBe('project-local');
      expect(result!.path).toBe(localPath);
    });

    it('returns project-team over user when project-team is present', async () => {
      const root = makeTempDir();
      const { configDir, cwd, projectDir, userDir } = await makeTree(root);
      await writeArtifact(userDir, 'widget');
      const projectPath = await writeArtifact(projectDir, 'widget');

      const result = await loadSetArtifact(KIND, 'widget', { configDir, cwd });
      expect(result!.source).toBe('project-team');
      expect(result!.path).toBe(projectPath);
    });
  });
});
