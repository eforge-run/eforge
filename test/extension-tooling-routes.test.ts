/**
 * In-process daemon route tests for native extension tooling surfaces.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { openDatabase } from '@eforge-build/monitor/db';
import { startServer, type MonitorServer } from '@eforge-build/monitor/server';
import { API_ROUTES, writeLockfile, apiListExtensions, apiNewExtension, apiReloadExtensions, apiShowExtension, apiTestExtension, apiValidateExtensions, type EforgeEvent, type ExtensionListResponse, type ExtensionNewResponse, type ExtensionReloadResponse, type ExtensionShowResponse, type ExtensionTestResponse, type ExtensionValidateResponse } from '@eforge-build/client';
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

function replayEvent(type: 'config:warning' | 'plan:build:start', runId?: string): EforgeEvent {
  const timestamp = new Date().toISOString();
  if (type === 'config:warning') return { type, timestamp, ...(runId !== undefined && { runId }), message: 'warning', source: 'test' };
  return { type, timestamp, ...(runId !== undefined && { runId }), planId: 'plan-1' };
}

function insertReplayRun(db: ReturnType<typeof openDatabase>, opts: { runId: string; sessionId: string; cwd: string; events: EforgeEvent[]; startedAt?: string }): void {
  db.insertRun({ id: opts.runId, sessionId: opts.sessionId, planSet: 'set', command: 'build', status: 'completed', startedAt: opts.startedAt ?? new Date().toISOString(), cwd: opts.cwd });
  for (const event of opts.events) {
    db.insertEvent({ runId: opts.runId, type: event.type, data: JSON.stringify(event), timestamp: event.timestamp });
  }
}

function postExtensionTestRaw(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolveStatus, rejectStatus) => {
    const req = request({
      hostname: 'localhost',
      port,
      path: API_ROUTES.extensionTest,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      res.resume();
      res.on('end', () => resolveStatus(res.statusCode ?? 0));
    });
    req.on('error', rejectStatus);
    req.end(JSON.stringify({}));
  });
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
    expect(loaded).toMatchObject({ name: 'loaded', status: 'loaded', scope: 'project-local', source: 'auto', enabled: true });
    expect(loaded?.registrations.inputSources).toBe(1);
    expect(loaded?.shadows.some((shadow) => shadow.scope === 'project-team')).toBe(true);
    expect(data.extensions.find((entry) => entry.name === 'loaded' && entry.status === 'shadowed')).toMatchObject({ name: 'loaded', status: 'shadowed', scope: 'project-team', enabled: false });
    expect(data.extensions.find((entry) => entry.name === 'team')).toMatchObject({ name: 'team', status: 'skipped', scope: 'project-team', enabled: true });
    expect(data.extensions.find((entry) => entry.name === 'bad')).toMatchObject({ name: 'bad', status: 'error', scope: 'project-local', enabled: true });
    expect(data.extensions.find((entry) => entry.name === 'excluded')).toMatchObject({ name: 'excluded', status: 'excluded', scope: 'project-local', enabled: false });
    expect(data.extensions.every((entry) => typeof entry.enabled === 'boolean')).toBe(true);
    expect(data.diagnostics.some((diagnostic) => diagnostic.code === 'extension:invalid-export')).toBe(true);
    expect(data.diagnostics.some((diagnostic) => diagnostic.code === 'extension:untrusted')).toBe(true);
  });

  it('GET extensionList marks all discovered entries disabled when extensions are globally disabled', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    await writeFile(resolve(tmpDir, 'eforge', 'config.yaml'), [
      'extensions:',
      '  enabled: false',
      '  trustProjectExtensions: false',
    ].join('\n'), 'utf-8');
    const srv = await start(tmpDir);

    const res = await fetch(`http://localhost:${srv.port}${API_ROUTES.extensionList}`);
    expect(res.status).toBe(200);
    const data = await res.json() as ExtensionListResponse;

    expect(data.extensions.length).toBeGreaterThan(0);
    expect(data.extensions.every((entry) => entry.enabled === false)).toBe(true);
    expect(data.totals).toMatchObject({ eventHooks: 0, inputSources: 0, tools: 0 });
  });

  it('GET extensionList marks include-filtered auto entries disabled while selected entries stay enabled', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    await writeFile(resolve(tmpDir, 'eforge', 'config.yaml'), [
      'extensions:',
      '  trustProjectExtensions: false',
      '  include:',
      '    - loaded',
    ].join('\n'), 'utf-8');
    const srv = await start(tmpDir);

    const res = await fetch(`http://localhost:${srv.port}${API_ROUTES.extensionList}`);
    expect(res.status).toBe(200);
    const data = await res.json() as ExtensionListResponse;

    expect(data.extensions.find((entry) => entry.name === 'loaded' && entry.status === 'loaded')).toMatchObject({ enabled: true });
    expect(data.extensions.find((entry) => entry.name === 'bad')).toMatchObject({ status: 'excluded', enabled: false });
    expect(data.extensions.find((entry) => entry.name === 'excluded')).toMatchObject({ status: 'excluded', enabled: false });
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
    expect(data.extension.enabled).toBe(true);

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

    const created = await apiNewExtension({ cwd: tmpDir, body: { name: 'audit' } });
    expect(created.data).toMatchObject({ name: 'audit', template: 'event-logger', scope: 'project-local' });

    const reload = await apiReloadExtensions({ cwd: tmpDir });
    expect(reload.data.extensions.some((entry) => entry.name === 'audit')).toBe(true);

    await writeFile(
      resolve(tmpDir, '.eforge', 'extensions', 'replay.js'),
      'export default function extension(eforge) { eforge.onEvent("config:*", () => {}); }',
      'utf-8',
    );
    const fixture = resolve(tmpDir, 'fixture.json');
    await writeFile(fixture, JSON.stringify(replayEvent('config:warning')), 'utf-8');
    const tested = await apiTestExtension({ cwd: tmpDir, body: { name: 'replay', fixture } });
    expect(tested.data).toMatchObject({ valid: true, source: { kind: 'fixture', fixture: await realpath(fixture) }, replay: { inputEventCount: 1, filteredEventCount: 1 } });
    expect(tested.data.matches).toEqual([expect.objectContaining({ extensionName: 'replay', pattern: 'config:*' })]);
  });

  it('POST extensionTest supports static-only requests and rejects ambiguous request bodies', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    const extensionPath = resolve(tmpDir, '.eforge', 'extensions', 'static-only.js');
    await writeFile(
      extensionPath,
      'export default function extension(eforge) { eforge.registerInputSource({ name: "static-input", description: "static", fetch: async () => "ok" }); }',
      'utf-8',
    );
    const srv = await start(tmpDir);

    const staticOnly = await fetch(`http://localhost:${srv.port}${API_ROUTES.extensionTest}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'static-only' }),
    });
    expect(staticOnly.status).toBe(200);
    const data = await staticOnly.json() as ExtensionTestResponse;
    expect(data).toMatchObject({
      valid: true,
      source: { kind: 'none' },
      replay: { inputEventCount: 0, filteredEventCount: 0, emittedEventCount: 0, diagnosticEventCount: 0 },
      matches: [],
    });
    expect(data.deferredRegistrations).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'inputSources', count: 1 }),
    ]));

    for (const body of [
      { name: 'static-only', path: extensionPath },
      { name: 'static-only', fixture: 'events.json', run: 'latest' },
    ]) {
      const res = await fetch(`http://localhost:${srv.port}${API_ROUTES.extensionTest}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it('POST extensionTest honors the configured event hook timeout', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    await writeFile(resolve(tmpDir, '.eforge', 'config.yaml'), 'extensions:\n  eventHookTimeoutMs: 5\n', 'utf-8');
    await writeFile(
      resolve(tmpDir, '.eforge', 'extensions', 'timeout.js'),
      'export default function extension(eforge) { eforge.onEvent("config:warning", async () => { await new Promise(() => {}); }); }',
      'utf-8',
    );
    const fixture = resolve(tmpDir, 'timeout-fixture.json');
    await writeFile(fixture, JSON.stringify(replayEvent('config:warning')), 'utf-8');
    const srv = await start(tmpDir);

    const res = await fetch(`http://localhost:${srv.port}${API_ROUTES.extensionTest}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'timeout', fixture }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as ExtensionTestResponse;
    expect(data.valid).toBe(false);
    expect(data.emittedDiagnostics).toEqual([
      expect.objectContaining({ type: 'extension:event-handler:timeout', timeoutMs: 5 }),
    ]);
  });

  it('POST extensionTest replays fixture events, filters by event type, and reports invalid fixtures', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    const extensionPath = resolve(tmpDir, '.eforge', 'extensions', 'replay.js');
    await writeFile(
      extensionPath,
      'export default function extension(eforge) { eforge.onEvent("config:*", () => {}); eforge.onEvent("plan:build:*", () => {}); }',
      'utf-8',
    );
    const fixture = resolve(tmpDir, 'events.jsonl');
    await writeFile(fixture, `${JSON.stringify(replayEvent('config:warning'))}\n${JSON.stringify(replayEvent('plan:build:start'))}\n`, 'utf-8');
    const srv = await start(tmpDir);

    const res = await fetch(`http://localhost:${srv.port}${API_ROUTES.extensionTest}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'replay', fixture, event: 'plan:build:start' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as ExtensionTestResponse;
    expect(data.valid).toBe(true);
    expect(data.replay).toMatchObject({ inputEventCount: 2, filteredEventCount: 1 });
    expect(data.matches).toEqual([expect.objectContaining({ eventIndex: 1, eventType: 'plan:build:start', pattern: 'plan:build:*' })]);

    const pathScoped = await fetch(`http://localhost:${srv.port}${API_ROUTES.extensionTest}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: extensionPath, fixture, event: 'config:warning' }),
    });
    expect(pathScoped.status).toBe(200);
    const pathScopedData = await pathScoped.json() as ExtensionTestResponse;
    expect(pathScopedData.valid).toBe(true);
    expect(pathScopedData.matches).toEqual([expect.objectContaining({ eventIndex: 0, eventType: 'config:warning', extensionPath: await realpath(extensionPath) })]);

    const invalidFixture = resolve(tmpDir, 'bad.json');
    await writeFile(invalidFixture, JSON.stringify({ type: 'config:warning', timestamp: new Date().toISOString() }), 'utf-8');
    const bad = await fetch(`http://localhost:${srv.port}${API_ROUTES.extensionTest}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'replay', fixture: invalidFixture }),
    });
    expect(bad.status).toBe(200);
    const badData = await bad.json() as ExtensionTestResponse;
    expect(badData.valid).toBe(false);
    expect(badData.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'extension:invalid-fixture' })]));
  });

  it('POST extensionTest replays latest, run-id, and session-id monitor histories without persisting replay diagnostics', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    await writeFile(resolve(tmpDir, '.eforge', 'config.yaml'), 'extensions:\n  eventHookTimeoutMs: 5\n', 'utf-8');
    await writeFile(
      resolve(tmpDir, '.eforge', 'extensions', 'run-replay.js'),
      'export default function extension(eforge) { eforge.onEvent("config:warning", () => { throw new Error("dry-run failure"); }); eforge.onEvent("config:warning", async () => { await new Promise(() => {}); }); }',
      'utf-8',
    );
    const db = openDatabase(resolve(tmpDir, '.eforge', 'monitor.db'));
    insertReplayRun(db, { runId: 'run-old', sessionId: 'session-old', cwd: tmpDir, startedAt: '2026-01-01T00:00:00.000Z', events: [replayEvent('plan:build:start', 'run-old')] });
    insertReplayRun(db, { runId: 'run-new', sessionId: 'session-new', cwd: tmpDir, startedAt: '2026-01-02T00:00:00.000Z', events: [replayEvent('config:warning', 'run-new')] });
    db.insertEvent({
      runId: 'run-new',
      type: 'config:warning',
      data: JSON.stringify({ type: 'config:warning', timestamp: new Date().toISOString() }),
      timestamp: new Date().toISOString(),
    });
    server = await startServer(db, 0, { strictPort: true, cwd: tmpDir });

    for (const body of [{ run: 'latest' }, { run: 'run-new' }, { run: 'session-new' }]) {
      const before = db.getEventsBySession('session-new').length;
      const res = await fetch(`http://localhost:${server.port}${API_ROUTES.extensionTest}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'run-replay', ...body }),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as ExtensionTestResponse;
      expect(data.valid).toBe(false);
      expect(data.source).toMatchObject({ kind: 'run', sessionId: 'session-new' });
      expect(data.replay.inputEventCount).toBe(1);
      expect(data.emittedDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'extension:event-handler:failed', message: 'dry-run failure' }),
        expect.objectContaining({ type: 'extension:event-handler:timeout', timeoutMs: 5 }),
      ]));
      expect(db.getEventsBySession('session-new')).toHaveLength(before);
    }
  });

  it('POST extensionTest rejects invalid paths and cross-origin callers', async () => {
    const tmpDir = makeTempDir();
    const outsideDir = makeTempDir();
    await setupProject(tmpDir);
    const escapedExtensionTarget = resolve(outsideDir, 'outside-extension.js');
    const escapedFixtureTarget = resolve(outsideDir, 'outside-fixture.json');
    await writeFile(escapedExtensionTarget, 'export default function extension() {}', 'utf-8');
    await writeFile(escapedFixtureTarget, JSON.stringify(replayEvent('config:warning')), 'utf-8');
    await symlink(escapedExtensionTarget, resolve(tmpDir, 'escaped-extension.js'));
    await symlink(escapedFixtureTarget, resolve(tmpDir, 'escaped-fixture.json'));
    const srv = await start(tmpDir);

    const invalidPath = await fetch(`http://localhost:${srv.port}${API_ROUTES.extensionTest}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '../outside.js' }),
    });
    expect(invalidPath.status).toBe(400);

    const invalidFixture = await fetch(`http://localhost:${srv.port}${API_ROUTES.extensionTest}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fixture: '../outside.json' }),
    });
    expect(invalidFixture.status).toBe(400);

    const escapedPath = await fetch(`http://localhost:${srv.port}${API_ROUTES.extensionTest}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'escaped-extension.js' }),
    });
    expect(escapedPath.status).toBe(400);

    const escapedFixture = await fetch(`http://localhost:${srv.port}${API_ROUTES.extensionTest}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fixture: 'escaped-fixture.json' }),
    });
    expect(escapedFixture.status).toBe(400);

    const crossOrigin = await fetch(`http://localhost:${srv.port}${API_ROUTES.extensionTest}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify({}),
    });
    expect(crossOrigin.status).toBe(403);

    await expect(postExtensionTestRaw(srv.port, { Host: '192.0.2.1' })).resolves.toBe(403);
    await expect(postExtensionTestRaw(srv.port, { Host: '127.0.0.1.evil.example' })).resolves.toBe(403);
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

  it('POST extensionNew creates the default template in project-local scope', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    const srv = await start(tmpDir);

    const res = await fetch(`http://localhost:${srv.port}${API_ROUTES.extensionNew}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'audit' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as ExtensionNewResponse;
    expect(data).toMatchObject({ name: 'audit', template: 'event-logger', scope: 'project-local', overwritten: false });
    const content = await readFile(resolve(tmpDir, '.eforge', 'extensions', 'audit.ts'), 'utf-8');
    expect(content).toContain('defineEforgeExtension');
    expect(content).toContain('onEvent');
  });

  it('POST extensionNew returns 409 on conflict and leaves existing content unchanged', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    const srv = await start(tmpDir);
    const target = resolve(tmpDir, '.eforge', 'extensions', 'audit.ts');
    await writeFile(target, 'existing content', 'utf-8');

    const res = await fetch(`http://localhost:${srv.port}${API_ROUTES.extensionNew}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'audit' }),
    });

    expect(res.status).toBe(409);
    expect(await readFile(target, 'utf-8')).toBe('existing content');
  });

  it('POST extensionNew honors request scope, template, and force overwrite', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    const srv = await start(tmpDir);
    const target = resolve(tmpDir, 'eforge', 'extensions', 'team-audit.ts');
    await writeFile(target, 'existing content', 'utf-8');

    const res = await fetch(`http://localhost:${srv.port}${API_ROUTES.extensionNew}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'team-audit', scope: 'project', template: 'blank', force: true }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as ExtensionNewResponse;
    expect(data).toMatchObject({
      name: 'team-audit',
      requestScope: 'project',
      scope: 'project-team',
      template: 'blank',
      overwritten: true,
      path: target,
    });
    const content = await readFile(target, 'utf-8');
    expect(content).toContain('Register extension capabilities here');
    expect(content).not.toContain('onEvent');
  });

  it('POST extensionNew rejects invalid names and unknown templates', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    const srv = await start(tmpDir);

    for (const body of [
      { name: '../audit' },
      { name: '..' },
      { name: '' },
      { name: 'audit', template: 'missing' },
    ]) {
      const res = await fetch(`http://localhost:${srv.port}${API_ROUTES.extensionNew}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it('POST extensionReload returns fresh extension data and no-watcher metadata', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    const srv = await start(tmpDir);

    const res = await fetch(`http://localhost:${srv.port}${API_ROUTES.extensionReload}`, { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json() as ExtensionReloadResponse;
    expect(data.extensions.some((entry) => entry.name === 'loaded')).toBe(true);
    expect(Array.isArray(data.diagnostics)).toBe(true);
    expect(data.totals).toMatchObject({ inputSources: 1 });
    expect(data.watcher).toEqual({
      wasRunning: false,
      restarted: false,
      running: false,
      previousSessionId: null,
      sessionId: null,
      message: 'Extension discovery refreshed; no runtime watcher was restarted.',
    });
    expect(data).toMatchObject(data.watcher);
  });

  it('POST extensionReload reports active watcher restart metadata from daemon state', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    const db = openDatabase(resolve(tmpDir, '.eforge', 'monitor.db'));
    const onReloadExtensions = vi.fn(async () => ({
      wasRunning: true,
      restarted: true,
      running: true,
      previousSessionId: 'watcher-old',
      sessionId: 'watcher-new',
      message: 'restarted',
    }));
    server = await startServer(db, 0, {
      strictPort: true,
      cwd: tmpDir,
      daemonState: {
        autoBuild: true,
        autoBuildPaused: false,
        watcher: { running: true, pid: null, sessionId: 'watcher-old' },
        onReloadExtensions,
      },
    });

    const res = await fetch(`http://localhost:${server.port}${API_ROUTES.extensionReload}`, { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json() as ExtensionReloadResponse;
    expect(onReloadExtensions).toHaveBeenCalledOnce();
    expect(data.watcher).toEqual({
      wasRunning: true,
      restarted: true,
      running: true,
      previousSessionId: 'watcher-old',
      sessionId: 'watcher-new',
      message: 'restarted',
    });
    expect(data).toMatchObject(data.watcher);
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
