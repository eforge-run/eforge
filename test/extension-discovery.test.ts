import { afterEach, describe, it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getScopeDirectory, type ScopeResolverOpts } from '@eforge-build/scopes';
import { discoverNativeExtensions } from '@eforge-build/engine/extensions';
import { useTempDir } from './test-tmpdir.js';

async function makeTree(root: string): Promise<ScopeResolverOpts> {
  process.env.XDG_CONFIG_HOME = resolve(root, 'xdg-config');
  const opts = { cwd: root, configDir: resolve(root, 'eforge') };
  await mkdir(getScopeDirectory('user', opts), { recursive: true });
  await mkdir(getScopeDirectory('project-team', opts), { recursive: true });
  await mkdir(getScopeDirectory('project-local', opts), { recursive: true });
  return opts;
}

async function writeExtension(root: string, name: string, content = 'export default function extension() {}'): Promise<string> {
  const dir = resolve(root, 'extensions');
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, `${name}.js`);
  await writeFile(path, content, 'utf-8');
  return path;
}

describe('native extension discovery', () => {
  const makeTempDir = useTempDir('native-extension-discovery-');
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  afterEach(() => {
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
  });

  it('returns one winner per name with project-local > project-team > user precedence and shadows', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    await writeExtension(getScopeDirectory('user', opts), 'shared');
    await writeExtension(getScopeDirectory('project-team', opts), 'shared');
    await writeExtension(getScopeDirectory('project-local', opts), 'shared');

    const result = await discoverNativeExtensions({ cwd: opts.cwd, configDir: opts.configDir, config: { enabled: true, trustProjectExtensions: false } });
    const winner = result.candidates.find((candidate) => candidate.name === 'shared' && candidate.status === 'pending')!;

    expect(winner.scope).toBe('project-local');
    expect(winner.shadows.map((shadow) => shadow.scope)).toEqual(['project-team', 'user']);
  });

  it('applies include then exclude to auto-discovered entries but not explicit paths', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    await writeExtension(getScopeDirectory('project-local', opts), 'alpha');
    await writeExtension(getScopeDirectory('project-local', opts), 'beta');
    const explicitDir = resolve(root, 'manual');
    await mkdir(explicitDir, { recursive: true });
    const explicit = resolve(explicitDir, 'beta.js');
    await writeFile(explicit, 'export default function extension() {}', 'utf-8');

    const result = await discoverNativeExtensions({
      cwd: opts.cwd,
      configDir: opts.configDir,
      config: { enabled: true, trustProjectExtensions: false, include: ['alpha', 'beta'], exclude: ['beta'], paths: [explicit] },
    });

    expect(result.candidates.filter((candidate) => candidate.source === 'auto').map((candidate) => candidate.name)).toEqual(['alpha']);
    expect(result.candidates.find((candidate) => candidate.name === 'beta' && candidate.source === 'explicit')).toMatchObject({
      status: 'pending',
      path: explicit,
    });
  });

  it('reports duplicate explicit names without relying on auto-discovery collisions', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    const explicitDir = resolve(root, 'explicit');
    await mkdir(explicitDir, { recursive: true });
    const a = resolve(explicitDir, 'dup.js');
    const b = resolve(root, 'other', 'dup.js');
    await mkdir(resolve(root, 'other'), { recursive: true });
    await writeFile(a, 'export default function extension() {}', 'utf-8');
    await writeFile(b, 'export default function extension() {}', 'utf-8');

    const result = await discoverNativeExtensions({ cwd: opts.cwd, configDir: opts.configDir, config: { enabled: true, trustProjectExtensions: true, paths: [a, b] } });
    const duplicateDiagnostics = result.diagnostics.filter((diagnostic) => diagnostic.code === 'extension:duplicate-explicit-name');

    expect(duplicateDiagnostics.map((diagnostic) => diagnostic.path).sort()).toEqual([a, b].sort());
    expect(duplicateDiagnostics).toHaveLength(2);
    expect(result.candidates.filter((candidate) => candidate.source === 'explicit').map((candidate) => candidate.status)).toEqual(['error', 'error']);
  });

  it('reports explicit paths that collide with auto-discovered winners', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    await writeExtension(getScopeDirectory('project-local', opts), 'dup');
    const explicit = resolve(root, 'dup.js');
    await writeFile(explicit, 'export default function extension() {}', 'utf-8');

    const result = await discoverNativeExtensions({ cwd: opts.cwd, configDir: opts.configDir, config: { enabled: true, trustProjectExtensions: true, paths: [explicit] } });
    const collisionDiagnostic = result.diagnostics.find((diagnostic) => diagnostic.code === 'extension:duplicate-explicit-name');

    expect(collisionDiagnostic).toMatchObject({
      name: 'dup',
      path: explicit,
      message: expect.stringContaining('collides with an auto-discovered extension'),
    });
    expect(result.candidates.find((candidate) => candidate.name === 'dup' && candidate.source === 'explicit')).toMatchObject({ status: 'error' });
    expect(result.candidates.find((candidate) => candidate.name === 'dup' && candidate.source === 'auto')).toMatchObject({ status: 'pending' });
  });

  it('marks only project-team extensions untrusted unless project trust is enabled', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    await writeExtension(getScopeDirectory('user', opts), 'user-ext');
    await writeExtension(getScopeDirectory('project-team', opts), 'team');
    await writeExtension(getScopeDirectory('project-local', opts), 'local-ext');

    const untrusted = await discoverNativeExtensions({ cwd: opts.cwd, configDir: opts.configDir, config: { enabled: true, trustProjectExtensions: false } });
    expect(untrusted.candidates.find((candidate) => candidate.name === 'user-ext')?.trust).toBe('trusted');
    expect(untrusted.candidates.find((candidate) => candidate.name === 'team')?.trust).toBe('untrusted');
    expect(untrusted.candidates.find((candidate) => candidate.name === 'local-ext')?.trust).toBe('trusted');

    const trusted = await discoverNativeExtensions({ cwd: opts.cwd, configDir: opts.configDir, config: { enabled: true, trustProjectExtensions: true } });
    expect(trusted.candidates.find((candidate) => candidate.name === 'team')?.trust).toBe('trusted');
  });

  it('resolves directory modules from package exports, package main, and index files', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    const extensions = resolve(getScopeDirectory('project-local', opts), 'extensions');

    await mkdir(resolve(extensions, 'exported', 'src'), { recursive: true });
    await writeFile(resolve(extensions, 'exported', 'package.json'), JSON.stringify({ exports: { '.': { import: './src/entry.mjs' } } }), 'utf-8');
    await writeFile(resolve(extensions, 'exported', 'src', 'entry.mjs'), 'export default function extension() {}', 'utf-8');

    await mkdir(resolve(extensions, 'mained', 'lib'), { recursive: true });
    await writeFile(resolve(extensions, 'mained', 'package.json'), JSON.stringify({ main: './lib/main.js' }), 'utf-8');
    await writeFile(resolve(extensions, 'mained', 'lib', 'main.js'), 'export default function extension() {}', 'utf-8');

    await mkdir(resolve(extensions, 'indexed'), { recursive: true });
    await writeFile(resolve(extensions, 'indexed', 'index.ts'), 'export default function extension() {}', 'utf-8');

    const result = await discoverNativeExtensions({ cwd: opts.cwd, configDir: opts.configDir, config: { enabled: true, trustProjectExtensions: false } });

    expect(result.candidates.map((candidate) => [candidate.name, candidate.layout]).sort()).toEqual([
      ['exported', 'directory'],
      ['indexed', 'directory'],
      ['mained', 'directory'],
    ]);
    expect(result.candidates.find((candidate) => candidate.name === 'exported')?.entrypoint).toBe(resolve(extensions, 'exported', 'src', 'entry.mjs'));
    expect(result.candidates.find((candidate) => candidate.name === 'mained')?.entrypoint).toBe(resolve(extensions, 'mained', 'lib', 'main.js'));
    expect(result.candidates.find((candidate) => candidate.name === 'indexed')?.entrypoint).toBe(resolve(extensions, 'indexed', 'index.ts'));
  });

  it('diagnoses unsupported auto-discovered layouts', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    const unsupported = resolve(getScopeDirectory('project-local', opts), 'extensions', 'readme.txt');
    await mkdir(resolve(unsupported, '..'), { recursive: true });
    await writeFile(unsupported, 'nope', 'utf-8');

    const result = await discoverNativeExtensions({ cwd: opts.cwd, configDir: opts.configDir, config: { enabled: true, trustProjectExtensions: false } });

    expect(result.candidates).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning',
      code: 'extension:unsupported-layout',
      path: unsupported,
      source: 'auto',
    }));
  });

  it('diagnoses unsupported explicit layouts', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    const unsupported = resolve(root, 'readme.txt');
    await writeFile(unsupported, 'nope', 'utf-8');

    const result = await discoverNativeExtensions({ cwd: opts.cwd, configDir: opts.configDir, config: { enabled: true, trustProjectExtensions: false, paths: [unsupported] } });

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'extension:unsupported-explicit-layout',
      path: unsupported,
      source: 'explicit',
    }));
    expect(result.candidates).toContainEqual(expect.objectContaining({
      name: 'readme.txt',
      path: unsupported,
      status: 'error',
    }));
  });
});
