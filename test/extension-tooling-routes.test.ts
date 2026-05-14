/**
 * In-process daemon route tests for native extension tooling surfaces.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '@eforge-build/monitor/db';
import { startServer, type MonitorServer } from '@eforge-build/monitor/server';
import { API_ROUTES, writeLockfile, apiListExtensions, apiShowExtension, apiValidateExtensions, type ExtensionListResponse, type ExtensionShowResponse, type ExtensionValidateResponse } from '@eforge-build/client';
import { createProgram } from '../packages/eforge/src/cli/index.js';
import { useTempDir } from './test-tmpdir.js';

const makeTempDir = useTempDir('eforge-extension-tooling-routes-');
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

let server: MonitorServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
});

async function setupProject(tmpDir: string): Promise<void> {
  process.env.XDG_CONFIG_HOME = resolve(tmpDir, 'xdg-config');
  await mkdir(process.env.XDG_CONFIG_HOME, { recursive: true });

  execFileSync('git', ['init', '-b', 'main'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'chore: initial commit'], { cwd: tmpDir });

  await mkdir(resolve(tmpDir, 'eforge', 'extensions'), { recursive: true });
  await mkdir(resolve(tmpDir, '.eforge', 'extensions'), { recursive: true });
  await writeFile(resolve(tmpDir, 'eforge', 'config.yaml'), [
    'extensions:',
    '  trustProjectExtensions: false',
    '  exclude:',
    '    - excluded',
  ].join('\n'), 'utf-8');

  await writeFile(
    resolve(tmpDir, '.eforge', 'extensions', 'loaded.js'),
    'export default function extension(eforge) { eforge.registerInputSource({ name: "loaded-input", description: "loaded", fetch: async () => "ok" }); }',
    'utf-8',
  );
  await writeFile(
    resolve(tmpDir, 'eforge', 'extensions', 'loaded.js'),
    'export default function extension(eforge) { eforge.registerTool({ name: "shadow-tool", description: "shadow", inputSchema: { type: "object", properties: {} }, handler: () => "ok" }); }',
    'utf-8',
  );
  await writeFile(
    resolve(tmpDir, 'eforge', 'extensions', 'team.js'),
    'export default function extension(eforge) { eforge.registerInputSource({ name: "team-input", description: "team", fetch: async () => "ok" }); }',
    'utf-8',
  );
  await writeFile(resolve(tmpDir, '.eforge', 'extensions', 'bad.js'), 'export default 42;', 'utf-8');
  await writeFile(
    resolve(tmpDir, '.eforge', 'extensions', 'excluded.js'),
    'export default function extension() {}',
    'utf-8',
  );
}

async function start(tmpDir: string): Promise<MonitorServer> {
  const db = openDatabase(resolve(tmpDir, '.eforge', 'monitor.db'));
  server = await startServer(db, 0, { strictPort: true, cwd: tmpDir });
  return server;
}

describe('extension tooling daemon routes', () => {
  it('GET extensionList returns loaded, excluded, untrusted, error, shadows, registration summaries, and diagnostics', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    const srv = await start(tmpDir);

    const res = await fetch(`http://localhost:${srv.port}${API_ROUTES.extensionList}`);
    expect(res.status).toBe(200);
    const data = await res.json() as ExtensionListResponse;

    const loaded = data.extensions.find((entry) => entry.name === 'loaded' && entry.status === 'loaded');
    expect(loaded).toMatchObject({ name: 'loaded', status: 'loaded', scope: 'project-local', source: 'auto' });
    expect(loaded?.registrations.inputSources).toBe(1);
    expect(loaded?.shadows.some((shadow) => shadow.scope === 'project-team')).toBe(true);
    expect(data.extensions.find((entry) => entry.name === 'loaded' && entry.status === 'shadowed')).toMatchObject({ name: 'loaded', status: 'shadowed', scope: 'project-team' });
    expect(data.extensions.find((entry) => entry.name === 'team')).toMatchObject({ name: 'team', status: 'skipped', scope: 'project-team' });
    expect(data.extensions.find((entry) => entry.name === 'bad')).toMatchObject({ name: 'bad', status: 'error', scope: 'project-local' });
    expect(data.extensions.find((entry) => entry.name === 'excluded')).toMatchObject({ name: 'excluded', status: 'excluded', scope: 'project-local' });
    expect(data.diagnostics.some((diagnostic) => diagnostic.code === 'extension:invalid-export')).toBe(true);
    expect(data.diagnostics.some((diagnostic) => diagnostic.code === 'extension:untrusted')).toBe(true);
  });

  it('GET extensionShow returns one entry and 404 for unknown names', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    const srv = await start(tmpDir);

    const res = await fetch(`http://localhost:${srv.port}${API_ROUTES.extensionShow}?name=loaded`);
    expect(res.status).toBe(200);
    const data = await res.json() as ExtensionShowResponse;
    expect(data.extension.name).toBe('loaded');
    expect(data.extension.status).toBe('loaded');

    const missing = await fetch(`http://localhost:${srv.port}${API_ROUTES.extensionShow}?name=missing`);
    expect(missing.status).toBe(404);
  });

  it('client extension helpers reach the daemon routes with typed response shapes', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    const srv = await start(tmpDir);
    writeLockfile(tmpDir, { pid: process.pid, port: srv.port, startedAt: new Date().toISOString() });

    const list = await apiListExtensions({ cwd: tmpDir });
    expect(list.port).toBe(srv.port);
    expect(list.data.extensions.some((entry) => entry.name === 'loaded')).toBe(true);
    expect(list.data.totals.inputSources).toBe(1);

    const show = await apiShowExtension({ cwd: tmpDir, name: 'loaded' });
    expect(show.data.extension).toMatchObject({ name: 'loaded', status: 'loaded' });

    const validate = await apiValidateExtensions({ cwd: tmpDir, name: 'bad' });
    expect(validate.data.valid).toBe(false);
    expect(validate.data.extensions).toEqual([
      expect.objectContaining({ name: 'bad', status: 'error' }),
    ]);
    expect(validate.data.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'extension:invalid-export' }),
    ]));
  });

  it('GET extensionValidate returns valid:false and error diagnostics when any extension has load errors', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    const srv = await start(tmpDir);

    const res = await fetch(`http://localhost:${srv.port}${API_ROUTES.extensionValidate}`);
    expect(res.status).toBe(200);
    const data = await res.json() as ExtensionValidateResponse;
    expect(data.valid).toBe(false);
    expect(data.extensions.some((entry) => entry.name === 'bad' && entry.status === 'error')).toBe(true);
    expect(data.diagnostics.some((diagnostic) => diagnostic.message.includes('Default export'))).toBe(true);
  });

  it('GET extensionValidate scopes validation and diagnostics to the requested extension name', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    const srv = await start(tmpDir);

    const res = await fetch(`http://localhost:${srv.port}${API_ROUTES.extensionValidate}?name=loaded`);
    expect(res.status).toBe(200);
    const data = await res.json() as ExtensionValidateResponse;
    expect(data.valid).toBe(true);
    expect(new Set(data.extensions.map((entry) => entry.name))).toEqual(new Set(['loaded']));
    expect(data.extensions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'loaded', status: 'loaded' }),
      expect.objectContaining({ name: 'loaded', status: 'shadowed' }),
    ]));
    expect(data.diagnostics).toEqual([]);
  });

  it('GET extensionValidate rejects path traversal in ad-hoc path validation', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    const srv = await start(tmpDir);

    const res = await fetch(`http://localhost:${srv.port}${API_ROUTES.extensionValidate}?path=${encodeURIComponent('../outside.js')}`);
    expect(res.status).toBe(400);
  });

  it('CLI extension validate exits with code 1 for an invalid ad-hoc extension path', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    const srv = await start(tmpDir);
    writeLockfile(tmpDir, { pid: process.pid, port: srv.port, startedAt: new Date().toISOString() });

    const previousCwd = process.cwd();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      process.chdir(tmpDir);
      const program = createProgram(undefined, 'test');
      await expect(program.parseAsync([
        'node',
        'eforge',
        'extension',
        'validate',
        resolve(tmpDir, '.eforge', 'extensions', 'bad.js'),
        '--json',
      ])).rejects.toThrow('process.exit:1');
      expect(exitSpy).toHaveBeenCalledWith(1);
      const output = logSpy.mock.calls.map(([message]) => String(message)).join('\n');
      const data = JSON.parse(output) as ExtensionValidateResponse;
      expect(data.valid).toBe(false);
      expect(data.extensions).toEqual([
        expect.objectContaining({ name: 'bad', status: 'error' }),
      ]);
    } finally {
      process.chdir(previousCwd);
      exitSpy.mockRestore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
