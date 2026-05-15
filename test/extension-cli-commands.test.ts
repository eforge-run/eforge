/**
 * CLI command tests for native extension management commands.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '@eforge-build/monitor/db';
import { startServer, type MonitorServer } from '@eforge-build/monitor/server';
import { writeLockfile, type EforgeEvent, type ExtensionListResponse, type ExtensionNewResponse, type ExtensionReloadResponse, type ExtensionShowResponse, type ExtensionTestResponse } from '@eforge-build/client';
import { createProgram } from '../packages/eforge/src/cli/index.js';
import { useTempDir } from './test-tmpdir.js';

const makeTempDir = useTempDir('eforge-extension-cli-');
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
  await mkdir(resolve(tmpDir, '.eforge', 'extensions'), { recursive: true });
  await writeFile(resolve(tmpDir, '.eforge', 'extensions', 'loaded.js'), 'export default function extension() {}', 'utf-8');
}

async function start(tmpDir: string): Promise<MonitorServer> {
  const db = openDatabase(resolve(tmpDir, '.eforge', 'monitor.db'));
  server = await startServer(db, 0, { strictPort: true, cwd: tmpDir });
  writeLockfile(tmpDir, { pid: process.pid, port: server.port, startedAt: new Date().toISOString() });
  return server;
}

function replayEvent(type: 'config:warning' | 'plan:build:start', runId?: string): EforgeEvent {
  const timestamp = new Date().toISOString();
  if (type === 'config:warning') return { type, timestamp, ...(runId !== undefined && { runId }), message: 'warning', source: 'test' };
  return { type, timestamp, ...(runId !== undefined && { runId }), planId: 'plan-1' };
}

async function runCli(tmpDir: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const previousCwd = process.cwd();
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as never);
  try {
    process.chdir(tmpDir);
    const program = createProgram(undefined, 'test');
    await program.parseAsync(['node', 'eforge', ...args]);
    return {
      stdout: logSpy.mock.calls.map(([message]) => String(message)).join('\n'),
      stderr: [
        ...errorSpy.mock.calls.map(([message]) => String(message)),
        ...stderrSpy.mock.calls.map(([message]) => String(message)),
      ].join('\n'),
    };
  } catch (err) {
    const output = {
      stdout: logSpy.mock.calls.map(([message]) => String(message)).join('\n'),
      stderr: [
        ...errorSpy.mock.calls.map(([message]) => String(message)),
        ...stderrSpy.mock.calls.map(([message]) => String(message)),
      ].join('\n'),
    };
    Object.assign(err as object, output);
    throw err;
  } finally {
    process.chdir(previousCwd);
    logSpy.mockRestore();
    errorSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

describe('extension CLI commands', () => {
  it('registers extension list/show/validate/test/new/reload subcommands', () => {
    const program = createProgram(undefined, 'test');
    const extension = program.commands.find((command) => command.name() === 'extension');
    expect(extension?.commands.map((command) => command.name()).sort()).toEqual(['list', 'new', 'reload', 'show', 'test', 'validate']);
  });

  it('extension test --fixture --json prints the raw ExtensionTestResponse', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    await writeFile(
      resolve(tmpDir, '.eforge', 'extensions', 'loaded.js'),
      'export default function extension(eforge) { eforge.onEvent("config:*", () => {}); }',
      'utf-8',
    );
    const fixture = resolve(tmpDir, 'events.json');
    await writeFile(fixture, JSON.stringify(replayEvent('config:warning')), 'utf-8');
    await start(tmpDir);

    const { stdout } = await runCli(tmpDir, ['extension', 'test', 'loaded', '--fixture', 'events.json', '--json']);
    const data = JSON.parse(stdout) as ExtensionTestResponse;
    expect(data.valid).toBe(true);
    expect(data.source).toMatchObject({ kind: 'fixture', fixture: await realpath(fixture) });
    expect(data.matches).toEqual([expect.objectContaining({ extensionName: 'loaded', pattern: 'config:*' })]);
  });

  it('extension test non-JSON output summarizes replay matches and deferred registrations', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    await writeFile(
      resolve(tmpDir, '.eforge', 'extensions', 'loaded.js'),
      'export default function extension(eforge) { eforge.onEvent("config:*", () => {}); eforge.registerInputSource({ name: "static-input", description: "static", fetch: async () => "ok" }); }',
      'utf-8',
    );
    const fixture = resolve(tmpDir, 'events.json');
    await writeFile(fixture, JSON.stringify(replayEvent('config:warning')), 'utf-8');
    await start(tmpDir);

    const { stdout } = await runCli(tmpDir, ['extension', 'test', 'loaded', '--fixture', fixture]);
    expect(stdout).toContain('Extensions test passed');
    expect(stdout).toContain('Source:                fixture');
    expect(stdout).toContain('Replayed events:       1');
    expect(stdout).toContain('Matches:               1');
    expect(stdout).toContain('Emitted diagnostics:   0');
    expect(stdout).toContain('Deferred registrations:');
    expect(stdout).toContain('inputSources: 1');
  });

  it('extension test treats path-like nameOrPath arguments as ad-hoc extension paths', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    const extensionPath = resolve(tmpDir, 'adhoc.js');
    await writeFile(
      extensionPath,
      'export default function extension(eforge) { eforge.onEvent("config:*", () => {}); }',
      'utf-8',
    );
    const fixture = resolve(tmpDir, 'events.json');
    await writeFile(fixture, JSON.stringify(replayEvent('config:warning')), 'utf-8');
    await start(tmpDir);

    const { stdout } = await runCli(tmpDir, ['extension', 'test', 'adhoc.js', '--fixture', 'events.json', '--json']);
    const data = JSON.parse(stdout) as ExtensionTestResponse;
    expect(data.valid).toBe(true);
    expect(data.extensions).toEqual([expect.objectContaining({ name: 'adhoc', path: await realpath(extensionPath) })]);
    expect(data.matches).toEqual([expect.objectContaining({ extensionName: 'adhoc', extensionPath: await realpath(extensionPath) })]);
  });

  it('extension test non-JSON output includes emitted diagnostic details and exits 1 for handler failures', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    await writeFile(
      resolve(tmpDir, '.eforge', 'extensions', 'loaded.js'),
      'export default function extension(eforge) { eforge.onEvent("config:*", () => { throw new Error("boom"); }); }',
      'utf-8',
    );
    const fixture = resolve(tmpDir, 'events.json');
    await writeFile(fixture, JSON.stringify(replayEvent('config:warning')), 'utf-8');
    await start(tmpDir);

    try {
      await runCli(tmpDir, ['extension', 'test', 'loaded', '--fixture', fixture]);
      throw new Error('Expected extension test to exit with code 1');
    } catch (err) {
      expect(err).toMatchObject({
        message: 'process.exit:1',
        stdout: expect.stringContaining('Emitted diagnostics:   1'),
        stderr: expect.stringContaining('Extensions test failed'),
      });
      expect((err as { stdout?: string }).stdout).toContain('Emitted diagnostic details:');
      expect((err as { stdout?: string }).stdout).toContain('extension:event-handler:failed');
      expect((err as { stdout?: string }).stdout).toContain('boom');
    }
  });

  it('extension test --run latest --event replays monitor events through the daemon helper', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    await writeFile(
      resolve(tmpDir, '.eforge', 'extensions', 'loaded.js'),
      'export default function extension(eforge) { eforge.onEvent("config:*", () => {}); }',
      'utf-8',
    );
    const db = openDatabase(resolve(tmpDir, '.eforge', 'monitor.db'));
    const event = replayEvent('config:warning', 'run-new');
    db.insertRun({ id: 'run-new', sessionId: 'session-new', planSet: 'set', command: 'build', status: 'completed', startedAt: new Date().toISOString(), cwd: tmpDir });
    db.insertEvent({ runId: 'run-new', type: event.type, data: JSON.stringify(event), timestamp: event.timestamp });
    server = await startServer(db, 0, { strictPort: true, cwd: tmpDir });
    writeLockfile(tmpDir, { pid: process.pid, port: server.port, startedAt: new Date().toISOString() });

    const { stdout } = await runCli(tmpDir, ['extension', 'test', 'loaded', '--run', 'latest', '--event', 'config:warning', '--json']);
    const data = JSON.parse(stdout) as ExtensionTestResponse;
    expect(data.source).toMatchObject({ kind: 'run', run: 'latest', sessionId: 'session-new', event: 'config:warning' });
    expect(data.replay).toMatchObject({ inputEventCount: 1, filteredEventCount: 1 });
    expect(data.matches).toEqual([expect.objectContaining({ extensionName: 'loaded', eventType: 'config:warning' })]);
  });

  it('extension test exits with code 1 when the daemon reports invalid output', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    await start(tmpDir);
    const invalidFixture = resolve(tmpDir, 'bad.json');
    await writeFile(invalidFixture, JSON.stringify({ type: 'config:warning', timestamp: new Date().toISOString() }), 'utf-8');

    await expect(runCli(tmpDir, ['extension', 'test', 'loaded', '--fixture', invalidFixture])).rejects.toMatchObject({
      message: 'process.exit:1',
      stderr: expect.stringContaining('Extensions test failed'),
    });
  });

  it('extension test no-match replay exits successfully when valid', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    await writeFile(
      resolve(tmpDir, '.eforge', 'extensions', 'loaded.js'),
      'export default function extension(eforge) { eforge.onEvent("config:*", () => {}); }',
      'utf-8',
    );
    const fixture = resolve(tmpDir, 'events.json');
    await writeFile(fixture, JSON.stringify(replayEvent('plan:build:start')), 'utf-8');
    await start(tmpDir);

    const { stdout } = await runCli(tmpDir, ['extension', 'test', 'loaded', '--fixture', fixture]);
    expect(stdout).toContain('Matches:               0');
    expect(stdout).toContain('No event hooks matched the replay input.');
  });

  it('extension new --json creates the default local event-logger template', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    await start(tmpDir);

    const { stdout } = await runCli(tmpDir, ['extension', 'new', 'audit', '--json']);
    const data = JSON.parse(stdout) as ExtensionNewResponse;
    expect(data).toMatchObject({ name: 'audit', template: 'event-logger', requestScope: 'local', scope: 'project-local', overwritten: false });
    expect(data.path).toBe(resolve(tmpDir, '.eforge', 'extensions', 'audit.ts'));
    const content = await readFile(data.path, 'utf-8');
    expect(content).toContain('defineEforgeExtension');
    expect(content).toContain('onEvent');
  });

  it('extension new --json honors scope, template, and force options', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    await start(tmpDir);
    const target = resolve(tmpDir, 'eforge', 'extensions', 'team-audit.ts');
    await mkdir(resolve(tmpDir, 'eforge', 'extensions'), { recursive: true });
    await writeFile(target, 'existing content', 'utf-8');

    const { stdout } = await runCli(tmpDir, [
      'extension',
      'new',
      'team-audit',
      '--scope',
      'project',
      '--template',
      'blank',
      '--force',
      '--json',
    ]);

    const data = JSON.parse(stdout) as ExtensionNewResponse;
    expect(data).toMatchObject({
      name: 'team-audit',
      template: 'blank',
      requestScope: 'project',
      scope: 'project-team',
      overwritten: true,
      path: target,
    });
    const content = await readFile(target, 'utf-8');
    expect(content).toContain('Register extension capabilities here');
    expect(content).not.toContain('onEvent');
  });

  it('extension new refuses to overwrite without --force and leaves content unchanged', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    await start(tmpDir);
    const target = resolve(tmpDir, '.eforge', 'extensions', 'audit.ts');
    await writeFile(target, 'existing content', 'utf-8');

    await expect(runCli(tmpDir, ['extension', 'new', 'audit'])).rejects.toThrow('process.exit:1');
    expect(await readFile(target, 'utf-8')).toBe('existing content');
  });

  it('extension new rejects unsupported CLI scopes before contacting the daemon', async () => {
    const tmpDir = makeTempDir();

    await expect(runCli(tmpDir, ['extension', 'new', 'audit', '--scope', 'team'])).rejects.toMatchObject({
      message: 'process.exit:1',
      stderr: expect.stringContaining('Error: --scope must be one of: local, project, user'),
    });
  });

  it('extension new non-JSON output includes scaffold details and next steps', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    await start(tmpDir);

    const { stdout } = await runCli(tmpDir, ['extension', 'new', 'audit']);
    expect(stdout).toContain('audit');
    expect(stdout).toContain(resolve(tmpDir, '.eforge', 'extensions', 'audit.ts'));
    expect(stdout).toContain('project-local');
    expect(stdout).toContain('event-logger');
    expect(stdout).toContain('Overwritten: no');
    expect(stdout).toContain('eforge extension validate audit');
    expect(stdout).toContain('eforge extension reload');
  });

  it('extension reload --json prints raw watcher metadata response', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    await start(tmpDir);

    const { stdout } = await runCli(tmpDir, ['extension', 'reload', '--json']);
    const data = JSON.parse(stdout) as ExtensionReloadResponse;
    expect(data.watcher).toMatchObject({ wasRunning: false, restarted: false, running: false });
    expect(data).toMatchObject(data.watcher);
  });

  it('extension reload non-JSON output includes watcher state and diagnostic counts', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    await start(tmpDir);

    const { stdout } = await runCli(tmpDir, ['extension', 'reload']);
    expect(stdout).toContain('Extensions reloaded');
    expect(stdout).toContain('Watcher was running: false');
    expect(stdout).toContain('Watcher restarted:   false');
    expect(stdout).toContain('Watcher running:     false');
    expect(stdout).toMatch(/Diagnostics:\s+\d+/);
  });

  it('list and show non-JSON render enabled values', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    await start(tmpDir);

    const list = await runCli(tmpDir, ['extension', 'list']);
    expect(list.stdout).toMatch(/name\s+status\s+enabled\s+scope\s+source\s+registrations\s+path/);
    expect(list.stdout).toMatch(/loaded\s+loaded\s+true\s+project-local\s+auto/);

    const show = await runCli(tmpDir, ['extension', 'show', 'loaded']);
    expect(show.stdout).toContain('Enabled:       true');
  });

  it('list and show non-JSON render disabled enabled values', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    await mkdir(resolve(tmpDir, 'eforge'), { recursive: true });
    await writeFile(resolve(tmpDir, 'eforge', 'config.yaml'), 'extensions:\n  enabled: false\n', 'utf-8');
    await start(tmpDir);

    const list = await runCli(tmpDir, ['extension', 'list']);
    expect(list.stdout).toMatch(/loaded\s+pending\s+false\s+project-local\s+auto/);

    const show = await runCli(tmpDir, ['extension', 'show', 'loaded']);
    expect(show.stdout).toContain('Enabled:       false');
  });

  it('JSON list/show include enabled in daemon responses', async () => {
    const tmpDir = makeTempDir();
    await setupProject(tmpDir);
    await start(tmpDir);

    const list = JSON.parse((await runCli(tmpDir, ['extension', 'list', '--json'])).stdout) as ExtensionListResponse;
    expect(list.extensions.every((entry) => typeof entry.enabled === 'boolean')).toBe(true);
    const show = JSON.parse((await runCli(tmpDir, ['extension', 'show', 'loaded', '--json'])).stdout) as ExtensionShowResponse;
    expect(show.extension.enabled).toBe(true);
  });
});
