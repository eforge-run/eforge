/**
 * Static wiring tests for native extension tooling surfaces.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_ROUTES } from '@eforge-build/client';
import { createProgram } from '../packages/eforge/src/cli/index.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function readRepoFile(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), 'utf-8');
}

describe('extension tooling route constants and helpers', () => {
  it('declares extension route constants', () => {
    expect(API_ROUTES.extensionList).toBe('/api/extensions/list');
    expect(API_ROUTES.extensionShow).toBe('/api/extensions/show');
    expect(API_ROUTES.extensionValidate).toBe('/api/extensions/validate');
  });

  it('client helpers call shared extension route constants', () => {
    const source = readRepoFile('packages/client/src/api/extensions.ts');
    expect(source).toContain('API_ROUTES.extensionList');
    expect(source).toContain('API_ROUTES.extensionShow');
    expect(source).toContain('API_ROUTES.extensionValidate');
    expect(source).not.toContain("'/api/extensions/");
    expect(source).not.toContain('"/api/extensions/');
  });
});

describe('CLI extension command registration', () => {
  const source = readRepoFile('packages/eforge/src/cli/index.ts');

  it('registers eforge extension list/show/validate commands on the actual Commander program', () => {
    const program = createProgram(undefined, 'test');
    const extension = program.commands.find((command) => command.name() === 'extension');
    expect(extension).toBeDefined();
    expect(extension?.commands.map((command) => command.name()).sort()).toEqual(['list', 'show', 'validate']);
  });

  it('declares the required show and validate arguments', () => {
    expect(source).toContain(".command('show <name>')");
    expect(source).toContain(".command('validate [nameOrPath]')");
  });

  it('validate exits non-zero when the response is invalid', () => {
    expect(source).toContain('if (!data.valid) process.exit(1);');
  });
});

describe('native extension event runtime wiring', () => {
  const cliIndexSource = readRepoFile('packages/eforge/src/cli/index.ts');
  const runOrDelegateSource = readRepoFile('packages/eforge/src/cli/run-or-delegate.ts');
  const daemonSource = readRepoFile('packages/monitor/src/server-main.ts');

  it('CLI entrypoint imports and wires native event hooks before monitor recording', () => {
    expect(cliIndexSource).toContain("withNativeEventHooks, type NativeExtensionRegistry");
    expect(cliIndexSource).toContain('withNativeEventHooks(');
    expect(cliIndexSource).toContain('nativeExtensionRegistry');
    expect(cliIndexSource).toContain('eventHookTimeoutMs');
    const wrapBlock = cliIndexSource.slice(cliIndexSource.indexOf('function wrapEvents('), cliIndexSource.indexOf('async function consumeEvents'));
    expect(wrapBlock.indexOf('withSessionId(')).toBeLessThan(wrapBlock.indexOf('withRunId('));
    expect(wrapBlock.indexOf('withRunId(')).toBeLessThan(wrapBlock.indexOf('withNativeEventHooks('));
    expect(wrapBlock.indexOf('withNativeEventHooks(')).toBeLessThan(wrapBlock.indexOf('opts.monitor.wrapEvents('));
    expect(wrapBlock.indexOf('opts.monitor.wrapEvents(')).toBeLessThan(wrapBlock.indexOf('withHooks('));
  });

  it('run-or-delegate imports and wires native event hooks before monitor recording', () => {
    expect(runOrDelegateSource).toContain("withNativeEventHooks, type NativeExtensionRegistry");
    expect(runOrDelegateSource).toContain('withNativeEventHooks(');
    expect(runOrDelegateSource).toContain('nativeExtensionRegistry');
    expect(runOrDelegateSource).toContain('eventHookTimeoutMs');
    const wrapBlock = runOrDelegateSource.slice(runOrDelegateSource.indexOf('function wrapEvents('), runOrDelegateSource.indexOf('async function consumeEvents'));
    expect(wrapBlock.indexOf('withSessionId(')).toBeLessThan(wrapBlock.indexOf('withRunId('));
    expect(wrapBlock.indexOf('withRunId(')).toBeLessThan(wrapBlock.indexOf('withNativeEventHooks('));
    expect(wrapBlock.indexOf('withNativeEventHooks(')).toBeLessThan(wrapBlock.indexOf('opts.monitor.wrapEvents('));
    expect(wrapBlock.indexOf('opts.monitor.wrapEvents(')).toBeLessThan(wrapBlock.indexOf('withHooks('));
  });

  it('daemon watcher imports and wires native event hooks before SQLite recording', () => {
    expect(daemonSource).toContain("withNativeEventHooks, type NativeExtensionRegistry");
    expect(daemonSource).toContain('withNativeEventHooks(');
    expect(daemonSource).toContain('nativeExtensionRegistry');
    expect(daemonSource).toContain('eventHookTimeoutMs');
    const wrapBlock = daemonSource.slice(daemonSource.indexOf('export function wrapWatcherEvents('), daemonSource.indexOf('async function main'));
    expect(wrapBlock.indexOf('withNativeEventHooks(')).toBeLessThan(wrapBlock.indexOf('withRecording('));
    expect(wrapBlock.indexOf('withRecording(')).toBeLessThan(wrapBlock.indexOf('withHooks('));
  });
});

describe('extension runtime documentation', () => {
  const docsExtensions = readRepoFile('docs/extensions.md');
  const docsExtensionsApi = readRepoFile('docs/extensions-api.md');
  const sdkReadme = readRepoFile('packages/extension-sdk/README.md');
  const configDocs = readRepoFile('docs/config.md');
  const minimalEventLogger = readRepoFile('examples/extensions/minimal-event-logger.ts');
  const protectedPaths = readRepoFile('examples/extensions/protected-paths.ts');

  it('marks onEvent runtime execution as supported while non-event families remain deferred', () => {
    expect(docsExtensions).toContain('| `onEvent` - typed event subscriptions | Yes | Yes | Yes |');
    expect(docsExtensionsApi).toContain('| `onEvent` | Yes | Yes | Yes |');
    expect(sdkReadme).toContain('| `onEvent(pattern, handler)` | Subscribe to typed events (glob patterns) | Yes | Yes |');

    for (const source of [docsExtensions, docsExtensionsApi, sdkReadme]) {
      for (const capability of [
        'onAgentRun',
        'registerTool',
        'beforePlanMerge',
        'registerProfileRouter',
        'registerInputSource',
        'registerReviewerPerspective',
        'registerValidationProvider',
      ]) {
        const row = source.split('\n').find((line) => line.startsWith('|') && line.includes(capability));
        expect(row, `${capability} row`).toBeDefined();
        expect(row).toContain('Deferred');
      }
    }
  });

  it('documents event hook timeout semantics and example runtime notes', () => {
    expect(configDocs).toContain('eventHookTimeoutMs: 5000');
    expect(configDocs).toContain('Must be a positive integer');
    expect(minimalEventLogger).not.toContain('Event dispatch remains deferred');
    expect(minimalEventLogger).toContain('onEvent');
    expect(minimalEventLogger).toContain('dispatched at runtime');
    expect(protectedPaths).toContain('Policy enforcement before merge remains');
    expect(protectedPaths).toContain('deferred until the policy-gate runtime is implemented');
  });
});

describe('MCP/Pi eforge_extension parity', () => {
  const mcpSource = readRepoFile('packages/eforge/src/cli/mcp-proxy.ts');
  const piSource = readRepoFile('packages/pi-eforge/extensions/eforge/index.ts');

  it('MCP proxy registers eforge_extension and uses exported client helpers', () => {
    expect(mcpSource).toContain("name: 'eforge_extension'");
    expect(mcpSource).toContain("z.enum(['list', 'show', 'validate'])");
    expect(mcpSource).toContain('apiListExtensions');
    expect(mcpSource).toContain('apiShowExtension');
    expect(mcpSource).toContain('apiValidateExtensions');
    const blockStart = mcpSource.indexOf("name: 'eforge_extension'");
    const blockEnd = mcpSource.indexOf("name: 'eforge_models'", blockStart);
    expect(blockEnd).toBeGreaterThan(blockStart);
    const block = mcpSource.slice(blockStart, blockEnd);
    expect(block).not.toContain("'/api/");
    expect(block).not.toContain('"/api/');
  });

  it('Pi extension registers eforge_extension and uses exported client helpers', () => {
    expect(piSource).toContain('name: "eforge_extension"');
    expect(piSource).toContain('StringEnum(["list", "show", "validate"] as const');
    expect(piSource).toContain('apiListExtensions');
    expect(piSource).toContain('apiShowExtension');
    expect(piSource).toContain('apiValidateExtensions');
    const blockStart = piSource.indexOf('name: "eforge_extension"');
    const blockEnd = piSource.indexOf('name: "eforge_models"', blockStart);
    expect(blockEnd).toBeGreaterThan(blockStart);
    const block = piSource.slice(blockStart, blockEnd);
    expect(block).not.toContain("'/api/");
    expect(block).not.toContain('"/api/');
  });

  it('/eforge:config Pi overlay includes the resolved extensions config block', () => {
    const source = readRepoFile('packages/pi-eforge/extensions/eforge/config-command.ts');
    expect(source).toContain('## Extensions');
    expect(source).toContain('trustProjectExtensions');
  });
});
