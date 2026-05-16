import { afterEach, describe, it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EforgeEngine } from '@eforge-build/engine/eforge';
import { getScopeDirectory, type ScopeResolverOpts } from '@eforge-build/scopes';
import { loadNativeExtensions, projectExtensionRegistry } from '@eforge-build/engine/extensions';
import { Type } from '@eforge-build/extension-sdk';
import { useTempDir } from './test-tmpdir.js';
import { StubHarness } from './stub-harness.js';

async function makeTree(root: string): Promise<ScopeResolverOpts> {
  process.env.XDG_CONFIG_HOME = resolve(root, 'xdg-config');
  const opts = { cwd: root, configDir: resolve(root, 'eforge') };
  await mkdir(resolve(getScopeDirectory('project-local', opts), 'extensions'), { recursive: true });
  await mkdir(resolve(getScopeDirectory('project-team', opts), 'extensions'), { recursive: true });
  await mkdir(resolve(getScopeDirectory('user', opts), 'extensions'), { recursive: true });
  await writeFile(resolve(root, 'package.json'), '{"type":"module"}\n', 'utf-8');
  return opts;
}

async function writeModule(path: string, body: string): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, body, 'utf-8');
}

describe('native extension loader', () => {
  const makeTempDir = useTempDir('native-extension-loader-');
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  afterEach(() => {
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
  });

  it('loads .js, .mjs, .ts, and .mts factories and records strategies', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    const extensions = resolve(getScopeDirectory('project-local', opts), 'extensions');
    const body = `export default function extension(eforge) { eforge.registerInputSource({ name: 'NAME', description: 'test', fetch: async () => 'ok' }); }`;
    await writeModule(resolve(extensions, 'plain.js'), body.replace('NAME', 'plain'));
    await writeModule(resolve(extensions, 'module.mjs'), body.replace('NAME', 'module'));
    await writeModule(resolve(extensions, 'typed.ts'), body.replace('NAME', 'typed'));
    await writeModule(resolve(extensions, 'typed-module.mts'), body.replace('NAME', 'typed-module'));

    const result = await loadNativeExtensions({ cwd: opts.cwd, configDir: opts.configDir, config: { enabled: true, trustProjectExtensions: false } });

    expect(result.registry.extensions.map((extension) => extension.name).sort()).toEqual(['module', 'plain', 'typed', 'typed-module']);
    expect(Object.fromEntries(result.registry.extensions.map((extension) => [extension.name, extension.strategy]))).toEqual({
      module: 'dynamic-import',
      plain: 'dynamic-import',
      typed: 'jiti',
      'typed-module': 'jiti',
    });
    expect(result.registry.inputSources.map((source) => source.name).sort()).toEqual(['module', 'plain', 'typed', 'typed-module']);
  });

  it('loads directory module factories through their resolved entrypoint', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    const extensionDir = resolve(getScopeDirectory('project-local', opts), 'extensions', 'dir-extension');
    await writeModule(resolve(extensionDir, 'src', 'entry.ts'), `export default function extension(eforge) { eforge.registerTool({ name: 'dir-tool', description: 'dir', inputSchema: { type: 'object', properties: {} }, handler: () => 'ok' }); }`);
    await writeModule(resolve(extensionDir, 'package.json'), JSON.stringify({ exports: './src/entry.ts' }));

    const result = await loadNativeExtensions({ cwd: opts.cwd, configDir: opts.configDir, config: { enabled: true, trustProjectExtensions: false } });

    expect(result.registry.candidates.find((candidate) => candidate.name === 'dir-extension')).toMatchObject({
      layout: 'directory',
      entrypoint: resolve(extensionDir, 'src', 'entry.ts'),
    });
    expect(result.registry.extensions.find((extension) => extension.name === 'dir-extension')).toMatchObject({
      strategy: 'jiti',
      entrypoint: resolve(extensionDir, 'src', 'entry.ts'),
    });
    expect(result.registry.tools.map((tool) => tool.name)).toEqual(['dir-tool']);
  });

  it('diagnoses invalid exports, factory errors, invalid registrations, and duplicate contributed names', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    const extensions = resolve(getScopeDirectory('project-local', opts), 'extensions');
    await writeModule(resolve(extensions, 'invalid.js'), 'export default 42;');
    await writeModule(resolve(extensions, 'throws.js'), 'export default function extension() { throw new Error("boom"); }');
    await writeModule(resolve(extensions, 'bad-registration.js'), 'export default function extension(eforge) { eforge.registerInputSource({ name: "bad" }); }');
    await writeModule(resolve(extensions, 'first.js'), 'export default function extension(eforge) { eforge.registerTool({ name: "dup", description: "one", inputSchema: { type: "object", properties: {} }, handler: () => "ok" }); }');
    await writeModule(resolve(extensions, 'second.js'), 'export default function extension(eforge) { eforge.registerTool({ name: "dup", description: "two", inputSchema: { type: "object", properties: {} }, handler: () => "ok" }); }');

    const result = await loadNativeExtensions({ cwd: opts.cwd, configDir: opts.configDir, config: { enabled: true, trustProjectExtensions: false } });

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'extension:invalid-export',
      name: 'invalid',
      path: resolve(extensions, 'invalid.js'),
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'extension:factory-error',
      name: 'throws',
      path: resolve(extensions, 'throws.js'),
      message: expect.stringContaining('boom'),
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'extension:invalid-registration',
      name: 'bad',
      path: resolve(extensions, 'bad-registration.js'),
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'extension:duplicate-registration',
      name: 'dup',
      path: resolve(extensions, 'second.js'),
    }));
  });

  it('rejects non-object and non-object-root tool input schemas during registration capture', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    const extensions = resolve(getScopeDirectory('project-local', opts), 'extensions');
    await writeModule(resolve(extensions, 'scalar-schema.js'), 'export default function extension(eforge) { eforge.registerTool({ name: "scalar-tool", description: "bad", inputSchema: "not-an-object", handler: () => "ok" }); }');
    await writeModule(resolve(extensions, 'string-schema.js'), 'export default function extension(eforge) { eforge.registerTool({ name: "bad-tool", description: "bad", inputSchema: { type: "string" }, handler: () => "ok" }); }');

    const result = await loadNativeExtensions({ cwd: opts.cwd, configDir: opts.configDir, config: { enabled: true, trustProjectExtensions: false } });

    expect(result.registry.tools).toEqual([]);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'extension:invalid-registration',
        name: 'scalar-tool',
        path: resolve(extensions, 'scalar-schema.js'),
        message: expect.stringContaining('inputSchema: object'),
      }),
      expect.objectContaining({
        code: 'extension:invalid-registration',
        name: 'bad-tool',
        path: resolve(extensions, 'string-schema.js'),
        message: expect.stringContaining('object-root schema'),
      }),
    ]));
  });

  it('skips untrusted project-team extensions and loads them when trusted', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    await writeModule(resolve(getScopeDirectory('project-team', opts), 'extensions', 'team.js'), 'export default function extension(eforge) { eforge.registerInputSource({ name: "team", description: "team", fetch: async () => "ok" }); }');

    const skipped = await loadNativeExtensions({ cwd: opts.cwd, configDir: opts.configDir, config: { enabled: true, trustProjectExtensions: false } });
    expect(skipped.registry.extensions).toHaveLength(0);
    expect(skipped.diagnostics.some((diagnostic) => diagnostic.code === 'extension:untrusted')).toBe(true);

    const loaded = await loadNativeExtensions({ cwd: opts.cwd, configDir: opts.configDir, config: { enabled: true, trustProjectExtensions: true } });
    expect(loaded.registry.extensions.map((extension) => extension.name)).toEqual(['team']);
  });

  it('diagnoses duplicate names for every named registration family', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    const extensions = resolve(getScopeDirectory('project-local', opts), 'extensions');
    const registrations = `
      eforge.registerProfileRouter({ name: 'shared', resolve: () => null });
      eforge.registerInputSource({ name: 'shared', description: 'input', fetch: async () => null });
      eforge.registerReviewerPerspective({ key: 'shared', label: 'Perspective', promptFragment: 'Review this' });
      eforge.registerValidationProvider({ name: 'shared', description: 'validator', validate: () => null });
      eforge.registerTool({ name: 'shared', description: 'tool', inputSchema: { type: 'object', properties: {} }, handler: () => 'ok' });
    `;
    await writeModule(resolve(extensions, 'first.js'), `export default function extension(eforge) { ${registrations} }`);
    await writeModule(resolve(extensions, 'second.js'), `export default function extension(eforge) { ${registrations} }`);

    const result = await loadNativeExtensions({ cwd: opts.cwd, configDir: opts.configDir, config: { enabled: true, trustProjectExtensions: false } });
    const duplicateMessages = result.diagnostics
      .filter((diagnostic) => diagnostic.code === 'extension:duplicate-registration')
      .map((diagnostic) => diagnostic.message);

    expect(duplicateMessages).toHaveLength(5);
    expect(duplicateMessages).toEqual(expect.arrayContaining([
      expect.stringContaining('Duplicate profile router name "shared"'),
      expect.stringContaining('Duplicate input source name "shared"'),
      expect.stringContaining('Duplicate reviewer perspective name "shared"'),
      expect.stringContaining('Duplicate validation provider name "shared"'),
      expect.stringContaining('Duplicate tool name "shared"'),
    ]));
  });

  it('captures all registration families', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    const extensionPath = resolve(getScopeDirectory('project-local', opts), 'extensions', 'capture.js');
    await writeModule(extensionPath, `
      export default function extension(eforge) {
        eforge.onEvent('*', () => {});
        eforge.onAgentRun(() => undefined);
        eforge.beforeQueueDispatch(() => ({ decision: 'allow' }));
        eforge.beforePlanMerge(() => ({ decision: 'allow' }));
        eforge.beforeFinalMerge(() => ({ decision: 'allow' }));
        eforge.registerProfileRouter({ name: 'router', resolve: () => null });
        eforge.registerInputSource({ name: 'input', description: 'input', fetch: async () => null });
        eforge.registerReviewerPerspective({ key: 'perspective', label: 'Perspective', promptFragment: 'Review this' });
        eforge.registerValidationProvider({ name: 'validator', description: 'validator', validate: () => null });
        eforge.registerTool({ name: 'tool', description: 'tool', inputSchema: ${JSON.stringify(Type.Object({}))}, handler: () => 'ok' });
      }
    `);

    const result = await loadNativeExtensions({ cwd: opts.cwd, configDir: opts.configDir, config: { enabled: true, trustProjectExtensions: false } });

    expect(result.registry.eventHooks).toEqual([expect.objectContaining({ extensionName: 'capture', value: expect.objectContaining({ pattern: '*' }) })]);
    expect(result.registry.agentRunHooks).toEqual([expect.objectContaining({ extensionName: 'capture' })]);
    expect(result.registry.policyGates).toEqual([
      expect.objectContaining({ extensionName: 'capture', extensionPath, gateKind: 'queue-dispatch', method: 'beforeQueueDispatch', registrationIndex: 0 }),
      expect.objectContaining({ extensionName: 'capture', extensionPath, gateKind: 'plan-merge', method: 'beforePlanMerge', registrationIndex: 1 }),
      expect.objectContaining({ extensionName: 'capture', extensionPath, gateKind: 'final-merge', method: 'beforeFinalMerge', registrationIndex: 2 }),
    ]);
    expect(result.registry.profileRouters).toEqual([expect.objectContaining({ name: 'router', extensionName: 'capture' })]);
    expect(result.registry.inputSources).toEqual([expect.objectContaining({ name: 'input', extensionName: 'capture' })]);
    expect(result.registry.reviewerPerspectives).toEqual([expect.objectContaining({ name: 'perspective', extensionName: 'capture' })]);
    expect(result.registry.validationProviders).toEqual([expect.objectContaining({ name: 'validator', extensionName: 'capture' })]);
    expect(result.registry.tools).toEqual([expect.objectContaining({ name: 'tool', extensionName: 'capture' })]);

    const projection = projectExtensionRegistry(result.registry);
    expect(projection.totals).toEqual({
      eventHooks: 1,
      agentRunHooks: 1,
      policyGates: 3,
      profileRouters: 1,
      inputSources: 1,
      reviewerPerspectives: 1,
      validationProviders: 1,
      tools: 1,
    });
    expect(projection.extensions).toEqual([expect.objectContaining({
      name: 'capture',
      registrations: projection.totals,
    })]);
  });

  it('diagnoses invalid handlers for all policy gate methods', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    await writeModule(resolve(getScopeDirectory('project-local', opts), 'extensions', 'invalid-policy.js'), `
      export default function extension(eforge) {
        eforge.beforeQueueDispatch(null);
        eforge.beforePlanMerge('nope');
        eforge.beforeFinalMerge({});
      }
    `);

    const result = await loadNativeExtensions({ cwd: opts.cwd, configDir: opts.configDir, config: { enabled: true, trustProjectExtensions: false } });

    expect(result.registry.policyGates).toHaveLength(0);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === 'extension:invalid-registration')).toEqual([
      expect.objectContaining({ message: expect.stringContaining('beforeQueueDispatch requires a handler function') }),
      expect.objectContaining({ message: expect.stringContaining('beforePlanMerge requires a handler function') }),
      expect.objectContaining({ message: expect.stringContaining('beforeFinalMerge requires a handler function') }),
    ]);
  });

  it('EforgeEngine.create applies extension config overrides before loading', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    await writeModule(resolve(getScopeDirectory('project-local', opts), 'extensions', 'disabled.js'), 'export default function extension(eforge) { eforge.registerInputSource({ name: "disabled", description: "disabled", fetch: async () => "ok" }); }');

    const engine = await EforgeEngine.create({
      cwd: root,
      agentRuntimes: new StubHarness([]),
      config: { extensions: { enabled: false, trustProjectExtensions: false } },
    });

    expect(engine.resolvedConfig.extensions.enabled).toBe(false);
    expect(engine.nativeExtensionRegistry.extensions).toEqual([]);
    expect(engine.nativeExtensionDiagnostics).toEqual([]);
  });

  it('EforgeEngine.create keeps loading when one extension fails', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    await writeFile(resolve(opts.configDir, 'config.yaml'), 'extensions:\n  trustProjectExtensions: false\n', 'utf-8');
    const extensions = resolve(getScopeDirectory('project-local', opts), 'extensions');
    await writeModule(resolve(extensions, 'good.js'), 'export default function extension(eforge) { eforge.registerInputSource({ name: "good", description: "good", fetch: async () => "ok" }); }');
    await writeModule(resolve(extensions, 'bad.js'), 'export default function extension() { throw new Error("bad"); }');

    const engine = await EforgeEngine.create({ cwd: root, agentRuntimes: new StubHarness([]) });

    expect(engine.nativeExtensionDiagnostics.some((diagnostic) => diagnostic.name === 'bad')).toBe(true);
    expect(engine.nativeExtensionRegistry.extensions.map((extension) => extension.name)).toEqual(['good']);
  });

  it('emits extension diagnostics as startup config warnings', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    await writeModule(resolve(getScopeDirectory('project-local', opts), 'extensions', 'bad.js'), 'export default 42;');

    const engine = await EforgeEngine.create({ cwd: root, agentRuntimes: new StubHarness([]) });
    const events = [];
    const generator = engine.build('missing-plan-set');
    for await (const event of generator) {
      events.push(event);
      if (events.length >= 2) break;
    }

    expect(events[0]?.type).toBe('session:profile');
    expect(events[1]).toMatchObject({
      type: 'config:warning',
      source: 'extensions',
      details: expect.stringContaining('extension:invalid-export'),
    });
  });

  // --- eforge:region plan-01-sdk-and-wire-contracts ---

  it('registers a selectBuildProfile-shaped profile router and preserves both callables', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    await writeModule(resolve(getScopeDirectory('project-local', opts), 'extensions', 'router-canonical.js'), `
      export default function extension(eforge) {
        eforge.registerProfileRouter({
          name: 'canonical-router',
          selectBuildProfile: (ctx) => null,
        });
      }
    `);

    const result = await loadNativeExtensions({ cwd: opts.cwd, configDir: opts.configDir, config: { enabled: true, trustProjectExtensions: false } });

    expect(result.registry.profileRouters).toHaveLength(1);
    const registration = result.registry.profileRouters[0]!;
    expect(registration.kind).toBe('profileRouter');
    expect(registration.extensionName).toBe('router-canonical');
    expect(registration.name).toBe('canonical-router');
    expect(typeof registration.value.selectBuildProfile).toBe('function');
    expect(result.diagnostics.filter((d) => d.code === 'extension:invalid-registration')).toHaveLength(0);
  });

  it('registers a deprecated resolve-shaped profile router without diagnostics', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    await writeModule(resolve(getScopeDirectory('project-local', opts), 'extensions', 'router-deprecated.js'), `
      export default function extension(eforge) {
        eforge.registerProfileRouter({
          name: 'deprecated-router',
          resolve: (ctx) => null,
        });
      }
    `);

    const result = await loadNativeExtensions({ cwd: opts.cwd, configDir: opts.configDir, config: { enabled: true, trustProjectExtensions: false } });

    expect(result.registry.profileRouters).toHaveLength(1);
    const registration = result.registry.profileRouters[0]!;
    expect(registration.kind).toBe('profileRouter');
    expect(registration.extensionName).toBe('router-deprecated');
    expect(registration.name).toBe('deprecated-router');
    expect(typeof registration.value.resolve).toBe('function');
    expect(result.diagnostics.filter((d) => d.code === 'extension:invalid-registration')).toHaveLength(0);
  });

  it('emits extension:invalid-registration diagnostic when profile router has neither callable', async () => {
    const root = makeTempDir();
    const opts = await makeTree(root);
    await writeModule(resolve(getScopeDirectory('project-local', opts), 'extensions', 'router-invalid.js'), `
      export default function extension(eforge) {
        eforge.registerProfileRouter({ name: 'invalid-router' });
      }
    `);

    const result = await loadNativeExtensions({ cwd: opts.cwd, configDir: opts.configDir, config: { enabled: true, trustProjectExtensions: false } });

    expect(result.registry.profileRouters).toHaveLength(0);
    const invalidDiagnostics = result.diagnostics.filter((d) => d.code === 'extension:invalid-registration');
    expect(invalidDiagnostics).toHaveLength(1);
    expect(invalidDiagnostics[0]!.message).toContain('selectBuildProfile');
  });

  // --- eforge:endregion plan-01-sdk-and-wire-contracts ---
});
