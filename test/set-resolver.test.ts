/**
 * Tests for named-set resolution and directory helpers — redirected from the
 * engine's former set-resolver module to @eforge-build/scopes.
 *
 * All tests are fixtures-free: each test builds a fresh temp directory tree
 * using the `useTempDir` helper and writes files programmatically.
 */
import { describe, it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  listNamedSet,
  resolveNamedSet,
  getScopeDirectory,
  type ScopeResolverOpts,
} from '@eforge-build/scopes';
import { useTempDir } from './test-tmpdir.js';

// ---------------------------------------------------------------------------
// Test directory name (use .txt so tests don't conflict with real yaml/md)
// ---------------------------------------------------------------------------

const DIRECTORY = 'widgets';
const EXTENSION = 'txt';

// ---------------------------------------------------------------------------
// Temp dir builder helpers
// ---------------------------------------------------------------------------

describe('set-resolver', () => {
  const makeTempDir = useTempDir('set-resolver-');

  async function makeTree(root: string): Promise<{
    opts: ScopeResolverOpts;
    localDir: string;
    projectDir: string;
    userDir: string;
  }> {
    // configDir = <root>/eforge  (project-team tier)
    // cwd       = <root>         (project root, .eforge/ lives here)
    const configDir = resolve(root, 'eforge');
    const cwd = root;

    // For the user tier we need to override XDG_CONFIG_HOME so user dir
    // resolves inside our temp tree. Set env before calling the helpers.
    process.env.XDG_CONFIG_HOME = resolve(root, 'xdg-config');

    const opts: ScopeResolverOpts = { cwd, configDir };

    const localDir = resolve(getScopeDirectory('project-local', opts), DIRECTORY);
    const projectDir = resolve(getScopeDirectory('project-team', opts), DIRECTORY);
    const userDir = resolve(getScopeDirectory('user', opts), DIRECTORY);

    await mkdir(localDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await mkdir(userDir, { recursive: true });

    return { opts, localDir, projectDir, userDir };
  }

  async function writeArtifact(dir: string, name: string, content = 'content'): Promise<string> {
    const p = resolve(dir, `${name}.${EXTENSION}`);
    await writeFile(p, content, 'utf-8');
    return p;
  }

  // ---------------------------------------------------------------------------
  // listNamedSet (was listSetArtifacts)
  // ---------------------------------------------------------------------------

  describe('listNamedSet', () => {
    it('returns an empty list when all tiers are empty', async () => {
      const root = makeTempDir();
      const { opts } = await makeTree(root);
      const result = await listNamedSet(DIRECTORY, { ...opts, extension: EXTENSION });
      expect(result).toEqual([]);
    });

    it('returns one entry from the user tier', async () => {
      const root = makeTempDir();
      const { opts, userDir } = await makeTree(root);
      await writeArtifact(userDir, 'alpha');

      const result = await listNamedSet(DIRECTORY, { ...opts, extension: EXTENSION });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('alpha');
      expect(result[0].scope).toBe('user');
      expect(result[0].shadows).toEqual([]);
    });

    it('returns one entry from the project-team tier', async () => {
      const root = makeTempDir();
      const { opts, projectDir } = await makeTree(root);
      await writeArtifact(projectDir, 'beta');

      const result = await listNamedSet(DIRECTORY, { ...opts, extension: EXTENSION });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('beta');
      expect(result[0].scope).toBe('project-team');
      expect(result[0].shadows).toEqual([]);
    });

    it('returns one entry from the project-local tier', async () => {
      const root = makeTempDir();
      const { opts, localDir } = await makeTree(root);
      await writeArtifact(localDir, 'gamma');

      const result = await listNamedSet(DIRECTORY, { ...opts, extension: EXTENSION });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('gamma');
      expect(result[0].scope).toBe('project-local');
      expect(result[0].shadows).toEqual([]);
    });

    it('returns three entries with correct scope labels for distinct names', async () => {
      const root = makeTempDir();
      const { opts, localDir, projectDir, userDir } = await makeTree(root);
      await writeArtifact(localDir, 'local-only');
      await writeArtifact(projectDir, 'project-only');
      await writeArtifact(userDir, 'user-only');

      const result = await listNamedSet(DIRECTORY, { ...opts, extension: EXTENSION });
      expect(result).toHaveLength(3);

      const byName = Object.fromEntries(result.map((e) => [e.name, e]));
      expect(byName['local-only'].scope).toBe('project-local');
      expect(byName['local-only'].shadows).toEqual([]);
      expect(byName['project-only'].scope).toBe('project-team');
      expect(byName['project-only'].shadows).toEqual([]);
      expect(byName['user-only'].scope).toBe('user');
      expect(byName['user-only'].shadows).toEqual([]);
    });

    it('returns one entry when the same name exists in all three tiers', async () => {
      const root = makeTempDir();
      const { opts, localDir, projectDir, userDir } = await makeTree(root);
      await writeArtifact(localDir, 'shared', 'local-content');
      await writeArtifact(projectDir, 'shared', 'project-content');
      await writeArtifact(userDir, 'shared', 'user-content');

      const result = await listNamedSet(DIRECTORY, { ...opts, extension: EXTENSION });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('shared');
      expect(result[0].scope).toBe('project-local');
      // Full shadow chain (not just immediate parent)
      expect(result[0].shadows).toEqual(['project-team', 'user']);
    });

    it('project-local shadows project-team only (user absent)', async () => {
      const root = makeTempDir();
      const { opts, localDir, projectDir } = await makeTree(root);
      await writeArtifact(localDir, 'widget');
      await writeArtifact(projectDir, 'widget');

      const result = await listNamedSet(DIRECTORY, { ...opts, extension: EXTENSION });
      expect(result).toHaveLength(1);
      expect(result[0].scope).toBe('project-local');
      expect(result[0].shadows).toEqual(['project-team']);
    });

    it('project-team shadows user only (local absent)', async () => {
      const root = makeTempDir();
      const { opts, projectDir, userDir } = await makeTree(root);
      await writeArtifact(projectDir, 'widget');
      await writeArtifact(userDir, 'widget');

      const result = await listNamedSet(DIRECTORY, { ...opts, extension: EXTENSION });
      expect(result).toHaveLength(1);
      expect(result[0].scope).toBe('project-team');
      expect(result[0].shadows).toEqual(['user']);
    });

    it('project-local shadows user (project-team absent)', async () => {
      const root = makeTempDir();
      const { opts, localDir, userDir } = await makeTree(root);
      await writeArtifact(localDir, 'widget');
      await writeArtifact(userDir, 'widget');

      const result = await listNamedSet(DIRECTORY, { ...opts, extension: EXTENSION });
      expect(result).toHaveLength(1);
      expect(result[0].scope).toBe('project-local');
      expect(result[0].shadows).toEqual(['user']);
    });

    it('handles partial overlap: unique names plus a shadowed name', async () => {
      const root = makeTempDir();
      const { opts, localDir, projectDir, userDir } = await makeTree(root);
      // 'shared' exists in all tiers → 1 entry
      await writeArtifact(localDir, 'shared');
      await writeArtifact(projectDir, 'shared');
      await writeArtifact(userDir, 'shared');
      // 'only-user' exists in user only → 1 entry
      await writeArtifact(userDir, 'only-user');
      // 'only-project' exists in project-team only → 1 entry
      await writeArtifact(projectDir, 'only-project');

      const result = await listNamedSet(DIRECTORY, { ...opts, extension: EXTENSION });
      expect(result).toHaveLength(3);
      const byName = Object.fromEntries(result.map((e) => [e.name, e]));

      expect(byName['shared'].scope).toBe('project-local');
      expect(byName['shared'].shadows).toEqual(['project-team', 'user']);

      expect(byName['only-user'].scope).toBe('user');
      expect(byName['only-user'].shadows).toEqual([]);

      expect(byName['only-project'].scope).toBe('project-team');
      expect(byName['only-project'].shadows).toEqual([]);
    });

    it('ignores files that do not match the kind extension', async () => {
      const root = makeTempDir();
      const { opts, projectDir } = await makeTree(root);
      // Write a .yaml file in the widgets dir — should be ignored (extension is .txt)
      await writeFile(resolve(projectDir, 'ignored.yaml'), 'content', 'utf-8');
      await writeArtifact(projectDir, 'included');

      const result = await listNamedSet(DIRECTORY, { ...opts, extension: EXTENSION });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('included');
    });

    it('returns entries sorted alphabetically within each tier', async () => {
      const root = makeTempDir();
      const { opts, userDir } = await makeTree(root);
      await writeArtifact(userDir, 'zebra');
      await writeArtifact(userDir, 'alpha');
      await writeArtifact(userDir, 'mango');

      const result = await listNamedSet(DIRECTORY, { ...opts, extension: EXTENSION });
      expect(result.map((e) => e.name)).toEqual(['alpha', 'mango', 'zebra']);
    });
  });

  // ---------------------------------------------------------------------------
  // resolveNamedSet (was loadSetArtifact)
  // ---------------------------------------------------------------------------

  describe('resolveNamedSet', () => {
    it('returns undefined for missing name when no tier has the artifact', async () => {
      const root = makeTempDir();
      const { opts } = await makeTree(root);
      const map = await resolveNamedSet(DIRECTORY, { ...opts, extension: EXTENSION });
      expect(map.get('missing')).toBeUndefined();
    });

    it('returns the user-tier entry when only user has it', async () => {
      const root = makeTempDir();
      const { opts, userDir } = await makeTree(root);
      const p = await writeArtifact(userDir, 'alpha');

      const map = await resolveNamedSet(DIRECTORY, { ...opts, extension: EXTENSION });
      const entry = map.get('alpha');
      expect(entry).not.toBeUndefined();
      expect(entry!.scope).toBe('user');
      expect(entry!.path).toBe(p);
    });

    it('returns the project-team entry when project-team has it and local does not', async () => {
      const root = makeTempDir();
      const { opts, projectDir } = await makeTree(root);
      const p = await writeArtifact(projectDir, 'beta');

      const map = await resolveNamedSet(DIRECTORY, { ...opts, extension: EXTENSION });
      const entry = map.get('beta');
      expect(entry!.scope).toBe('project-team');
      expect(entry!.path).toBe(p);
    });

    it('returns project-local when all three tiers have the artifact', async () => {
      const root = makeTempDir();
      const { opts, localDir, projectDir, userDir } = await makeTree(root);
      await writeArtifact(userDir, 'shared');
      await writeArtifact(projectDir, 'shared');
      const localPath = await writeArtifact(localDir, 'shared');

      const map = await resolveNamedSet(DIRECTORY, { ...opts, extension: EXTENSION });
      const entry = map.get('shared');
      expect(entry!.scope).toBe('project-local');
      expect(entry!.path).toBe(localPath);
    });

    it('returns project-local over project-team when local is present', async () => {
      const root = makeTempDir();
      const { opts, localDir, projectDir } = await makeTree(root);
      await writeArtifact(projectDir, 'widget');
      const localPath = await writeArtifact(localDir, 'widget');

      const map = await resolveNamedSet(DIRECTORY, { ...opts, extension: EXTENSION });
      const entry = map.get('widget');
      expect(entry!.scope).toBe('project-local');
      expect(entry!.path).toBe(localPath);
    });

    it('returns project-team over user when project-team is present', async () => {
      const root = makeTempDir();
      const { opts, projectDir, userDir } = await makeTree(root);
      await writeArtifact(userDir, 'widget');
      const projectPath = await writeArtifact(projectDir, 'widget');

      const map = await resolveNamedSet(DIRECTORY, { ...opts, extension: EXTENSION });
      const entry = map.get('widget');
      expect(entry!.scope).toBe('project-team');
      expect(entry!.path).toBe(projectPath);
    });
  });
});
