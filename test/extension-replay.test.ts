import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getScopeDirectory, type ScopeResolverOpts } from '@eforge-build/scopes';
import {
  parseExtensionEventFixtureFile,
  replayNativeExtensionEvents,
  type NativeExtensionLoaderOptions,
} from '@eforge-build/engine/extensions';
import type { EforgeEvent } from '@eforge-build/client';
import { useTempDir } from './test-tmpdir.js';

const makeTempDir = useTempDir('extension-replay-');
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

const timestamp = '2026-01-01T00:00:00.000Z';

function event(type: 'config:warning'): EforgeEvent;
function event(type: 'plan:build:start'): EforgeEvent;
function event(type: 'phase:start'): EforgeEvent;
function event(type: 'session:profile'): EforgeEvent;
function event(type: 'config:warning' | 'plan:build:start' | 'phase:start' | 'session:profile'): EforgeEvent {
  if (type === 'config:warning') return { type, timestamp, message: 'warn', source: 'test' };
  if (type === 'plan:build:start') return { type, timestamp, planId: 'plan-1' };
  if (type === 'phase:start') return { type, timestamp, runId: 'run-1', planSet: 'set', command: 'build' };
  return { type, timestamp, profileName: null, source: 'none', scope: null, config: null };
}

async function makeTree(root: string): Promise<ScopeResolverOpts> {
  process.env.XDG_CONFIG_HOME = resolve(root, 'xdg-config');
  const opts = { cwd: root, configDir: resolve(root, 'eforge') };
  await mkdir(resolve(getScopeDirectory('project-local', opts), 'extensions'), { recursive: true });
  await writeFile(resolve(root, 'package.json'), '{"type":"module"}\n', 'utf-8');
  return opts;
}

async function writeModule(path: string, body: string): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, body, 'utf-8');
}

function loaderOptions(opts: ScopeResolverOpts): NativeExtensionLoaderOptions {
  return { cwd: opts.cwd, configDir: opts.configDir, config: { enabled: true, trustProjectExtensions: false } };
}

describe('native extension replay harness', () => {
  afterEach(() => {
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  });

  it('parses JSON single-event, JSON array, and JSONL fixtures into canonical events', async () => {
    const root = makeTempDir();
    const single = resolve(root, 'single.json');
    const array = resolve(root, 'array.json');
    const jsonl = resolve(root, 'events.jsonl');
    await writeFile(single, JSON.stringify(event('config:warning')), 'utf-8');
    await writeFile(array, JSON.stringify([event('config:warning'), event('plan:build:start')]), 'utf-8');
    await writeFile(jsonl, `${JSON.stringify(event('config:warning'))}\n${JSON.stringify(event('phase:start'))}\n`, 'utf-8');

    await expect(parseExtensionEventFixtureFile(single)).resolves.toMatchObject({ valid: true, format: 'json', events: [expect.objectContaining({ type: 'config:warning' })] });
    await expect(parseExtensionEventFixtureFile(array)).resolves.toMatchObject({ valid: true, format: 'json-array', events: [expect.any(Object), expect.any(Object)] });
    await expect(parseExtensionEventFixtureFile(jsonl)).resolves.toMatchObject({ valid: true, format: 'jsonl', events: [expect.any(Object), expect.any(Object)] });
  });

  it('reports malformed JSON and schema-invalid events as invalid fixture diagnostics', async () => {
    const root = makeTempDir();
    const malformed = resolve(root, 'bad.json');
    const invalid = resolve(root, 'invalid.json');
    await writeFile(malformed, '[{"type":', 'utf-8');
    await writeFile(invalid, JSON.stringify({ type: 'config:warning', timestamp }), 'utf-8');

    await expect(parseExtensionEventFixtureFile(malformed)).resolves.toMatchObject({ valid: false, diagnostics: [expect.objectContaining({ code: 'extension:invalid-fixture' })] });
    await expect(parseExtensionEventFixtureFile(invalid)).resolves.toMatchObject({ valid: false, diagnostics: [expect.objectContaining({ message: expect.stringContaining('Invalid event') })] });
  });

  it('marks load/static diagnostics as invalid replay results', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    const extensionPath = resolve(getScopeDirectory('project-local', opts), 'extensions', 'invalid.js');
    await writeModule(extensionPath, 'export default 42;');

    const result = await replayNativeExtensionEvents({
      cwd: root,
      loaderOptions: loaderOptions(opts),
      name: 'invalid',
      events: [],
    });

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: 'extension:invalid-export',
      name: 'invalid',
      path: extensionPath,
    })]);
    expect(result.replay).toMatchObject({ inputEventCount: 0, filteredEventCount: 0, diagnosticEventCount: 0 });
  });

  it('summarizes exact and glob event-hook matches with extension metadata', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    const extensions = resolve(getScopeDirectory('project-local', opts), 'extensions');
    await writeModule(resolve(extensions, 'audit.js'), `
      export default function extension(eforge) {
        eforge.onEvent('config:warning', () => {});
        eforge.onEvent('plan:build:*', () => {});
      }
    `);

    const result = await replayNativeExtensionEvents({
      cwd: root,
      loaderOptions: loaderOptions(opts),
      events: [event('config:warning'), event('plan:build:start'), event('phase:start')],
      source: { kind: 'none' },
    });

    expect(result.valid).toBe(true);
    expect(result.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventIndex: 0, eventType: 'config:warning', extensionName: 'audit', pattern: 'config:warning', extensionPath: resolve(extensions, 'audit.js') }),
      expect.objectContaining({ eventIndex: 1, eventType: 'plan:build:start', extensionName: 'audit', pattern: 'plan:build:*', extensionPath: resolve(extensions, 'audit.js') }),
    ]));
  });

  it('loads only the selected extension name before computing static diagnostics', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    const extensions = resolve(getScopeDirectory('project-local', opts), 'extensions');
    await writeModule(resolve(extensions, 'alpha.js'), `
      export default function extension(eforge) {
        eforge.registerTool({ name: 'shared-tool', description: 'alpha', inputSchema: { type: 'object', properties: {} }, handler: () => 'ok' });
      }
    `);
    await writeModule(resolve(extensions, 'target.js'), `
      export default function extension(eforge) {
        eforge.registerTool({ name: 'shared-tool', description: 'target', inputSchema: { type: 'object', properties: {} }, handler: () => 'ok' });
      }
    `);

    const result = await replayNativeExtensionEvents({
      cwd: root,
      loaderOptions: loaderOptions(opts),
      name: 'target',
      events: [],
    });

    expect(result.valid).toBe(true);
    expect(result.extensions.map((extension) => extension.name)).toEqual(['target']);
    expect(result.diagnostics).toEqual([]);
  });

  it('loads ad-hoc extension paths relative to the loader cwd', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    await writeModule(resolve(root, 'relative-extension.js'), `
      export default function extension(eforge) {
        eforge.onEvent('config:warning', () => {});
      }
    `);

    const result = await replayNativeExtensionEvents({
      cwd: root,
      loaderOptions: loaderOptions(opts),
      path: 'relative-extension.js',
      events: [event('config:warning')],
    });

    expect(result.valid).toBe(true);
    expect(result.extensions).toEqual([expect.objectContaining({ name: 'relative-extension' })]);
    expect(result.matches).toEqual([expect.objectContaining({ extensionName: 'relative-extension' })]);
  });

  it('filters replayed events by event type before invoking hooks', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    await writeModule(resolve(getScopeDirectory('project-local', opts), 'extensions', 'filter.js'), `
      export default function extension(eforge) {
        eforge.onEvent('config:warning', () => { throw new Error('filtered-out'); });
        eforge.onEvent('plan:build:start', () => {});
      }
    `);

    const result = await replayNativeExtensionEvents({
      cwd: root,
      loaderOptions: loaderOptions(opts),
      events: [event('config:warning'), event('plan:build:start')],
      eventType: 'plan:build:start',
    });

    expect(result.valid).toBe(true);
    expect(result.replay).toMatchObject({ inputEventCount: 2, filteredEventCount: 1 });
    expect(result.emittedDiagnostics).toEqual([]);
    expect(result.matches).toEqual([expect.objectContaining({ eventIndex: 1, eventType: 'plan:build:start' })]);
  });

  it('marks handler failures and timeouts as emitted diagnostics', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    const extensions = resolve(getScopeDirectory('project-local', opts), 'extensions');
    await writeModule(resolve(extensions, 'bad.js'), `
      export default function extension(eforge) {
        eforge.onEvent('config:warning', () => { throw new Error('boom'); });
        eforge.onEvent('plan:build:start', async () => { await new Promise(() => {}); });
      }
    `);

    const result = await replayNativeExtensionEvents({
      cwd: root,
      loaderOptions: loaderOptions(opts),
      events: [event('config:warning'), event('plan:build:start')],
      timeoutMs: 5,
    });

    expect(result.valid).toBe(false);
    expect(result.emittedDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'extension:event-handler:failed', message: 'boom' }),
      expect.objectContaining({ type: 'extension:event-handler:timeout', timeoutMs: 5 }),
    ]));
  });

  it('treats zero matching hooks as valid and summarizes deferred registration families without invoking them', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    await writeModule(resolve(getScopeDirectory('project-local', opts), 'extensions', 'deferred.js'), `
      export default function extension(eforge) {
        eforge.onAgentRun(() => { throw new Error('agent run should not be replayed'); });
        eforge.beforePlanMerge(() => { throw new Error('policy gate should not be replayed'); });
        eforge.registerProfileRouter({ name: 'router', resolve: () => { throw new Error('profile router should not be replayed'); } });
        eforge.registerInputSource({ name: 'input', description: 'input', fetch: async () => { throw new Error('input source should not be replayed'); } });
        eforge.registerReviewerPerspective({ key: 'review', label: 'Review', promptFragment: 'Review this' });
        eforge.registerValidationProvider({ name: 'validator', description: 'validator', validate: () => { throw new Error('validation provider should not be replayed'); } });
        eforge.registerTool({ name: 'tool', description: 'tool', inputSchema: { type: 'object', properties: {} }, handler: () => { throw new Error('tool should not be replayed'); } });
      }
    `);

    const result = await replayNativeExtensionEvents({ cwd: root, loaderOptions: loaderOptions(opts), events: [event('phase:start')] });

    expect(result.valid).toBe(true);
    expect(result.matches).toEqual([]);
    expect(Object.fromEntries(result.deferredRegistrations.map((entry) => [entry.family, entry.count]))).toMatchObject({
      agentRunHooks: 1,
      policyGates: 1,
      profileRouters: 1,
      inputSources: 1,
      reviewerPerspectives: 1,
      validationProviders: 1,
      tools: 1,
    });
  });
});
