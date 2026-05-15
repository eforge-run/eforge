/**
 * Direct tests for native extension scaffolding helper.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { scaffoldNativeExtension, ScaffoldNativeExtensionError, SUPPORTED_EXTENSION_SCAFFOLD_TEMPLATES } from '@eforge-build/engine/extensions/index';
import { useTempDir } from './test-tmpdir.js';

const makeTempDir = useTempDir('eforge-extension-scaffold-');
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
});

describe('scaffoldNativeExtension', () => {
  it('creates the default event-logger template in the local extension scope', async () => {
    const cwd = makeTempDir();

    const result = await scaffoldNativeExtension({ cwd, name: 'audit' });
    const content = await readFile(resolve(cwd, '.eforge', 'extensions', 'audit.ts'), 'utf-8');

    expect(result).toMatchObject({
      name: 'audit',
      template: 'event-logger',
      requestScope: 'local',
      scope: 'project-local',
      overwritten: false,
    });
    expect(result.path).toBe(resolve(cwd, '.eforge', 'extensions', 'audit.ts'));
    expect(content).toContain("import { defineEforgeExtension } from '@eforge-build/extension-sdk';");
    expect(content).toContain('defineEforgeExtension');
    expect(content).toContain('onEvent');
  });

  it('maps project and user scopes through the shared scope directory resolver', async () => {
    const cwd = makeTempDir();
    process.env.XDG_CONFIG_HOME = resolve(cwd, 'xdg-config');
    await mkdir(resolve(cwd, 'eforge'), { recursive: true });
    await writeFile(resolve(cwd, 'eforge', 'config.yaml'), 'extensions: {}\n', 'utf-8');

    const project = await scaffoldNativeExtension({ cwd, name: 'team-audit', scope: 'project', template: 'blank' });
    const user = await scaffoldNativeExtension({ cwd, name: 'user-audit', scope: 'user', template: 'blank' });

    expect(project.path).toBe(resolve(cwd, 'eforge', 'extensions', 'team-audit.ts'));
    expect(user.path).toBe(resolve(cwd, 'xdg-config', 'eforge', 'extensions', 'user-audit.ts'));
    expect(await readFile(project.path, 'utf-8')).toContain('Register extension capabilities here');
  });

  it('rejects unsafe or empty extension names', async () => {
    const cwd = makeTempDir();

    for (const name of ['', '../audit', '..', '.', 'nested/audit', 'nested\\audit', 'bad\0name']) {
      await expect(scaffoldNativeExtension({ cwd, name })).rejects.toMatchObject({
        name: 'ScaffoldNativeExtensionError',
        code: 'invalid-name',
      });
    }
  });

  it('reports supported templates for unknown templates', async () => {
    const cwd = makeTempDir();

    await expect(scaffoldNativeExtension({
      cwd,
      name: 'audit',
      template: 'missing' as never,
    })).rejects.toMatchObject({
      name: 'ScaffoldNativeExtensionError',
      code: 'unknown-template',
      message: expect.stringContaining(SUPPORTED_EXTENSION_SCAFFOLD_TEMPLATES.join(', ')),
    });
  });

  it('returns a conflict without force and leaves existing content unchanged', async () => {
    const cwd = makeTempDir();
    const existingPath = resolve(cwd, '.eforge', 'extensions', 'audit.ts');
    await mkdir(resolve(cwd, '.eforge', 'extensions'), { recursive: true });
    await writeFile(existingPath, 'existing content', 'utf-8');

    await expect(scaffoldNativeExtension({ cwd, name: 'audit' })).rejects.toBeInstanceOf(ScaffoldNativeExtensionError);
    await expect(scaffoldNativeExtension({ cwd, name: 'audit' })).rejects.toMatchObject({ code: 'conflict', status: 409 });
    expect(await readFile(existingPath, 'utf-8')).toBe('existing content');
  });

  it('overwrites existing content when force is true', async () => {
    const cwd = makeTempDir();
    const existingPath = resolve(cwd, '.eforge', 'extensions', 'audit.ts');
    await mkdir(resolve(cwd, '.eforge', 'extensions'), { recursive: true });
    await writeFile(existingPath, 'existing content', 'utf-8');

    const result = await scaffoldNativeExtension({ cwd, name: 'audit', template: 'blank', force: true });

    expect(result.overwritten).toBe(true);
    expect(await readFile(existingPath, 'utf-8')).toContain('defineEforgeExtension');
  });
});
