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
    expect(API_ROUTES.extensionNew).toBe('/api/extensions/new');
    expect(API_ROUTES.extensionReload).toBe('/api/extensions/reload');
  });

  it('client helpers call shared extension route constants', () => {
    const source = readRepoFile('packages/client/src/api/extensions.ts');
    expect(source).toContain('API_ROUTES.extensionList');
    expect(source).toContain('API_ROUTES.extensionShow');
    expect(source).toContain('API_ROUTES.extensionValidate');
    expect(source).toContain('API_ROUTES.extensionNew');
    expect(source).toContain('API_ROUTES.extensionReload');
    expect(source).not.toContain("'/api/extensions/");
    expect(source).not.toContain('"/api/extensions/');
    expect(source).toContain('apiNewExtension');
    expect(source).toContain('apiReloadExtensions');
  });
});

describe('CLI extension command registration', () => {
  const source = readRepoFile('packages/eforge/src/cli/index.ts');

  it('registers eforge extension list/show/validate/new/reload commands on the actual Commander program', () => {
    const program = createProgram(undefined, 'test');
    const extension = program.commands.find((command) => command.name() === 'extension');
    expect(extension).toBeDefined();
    expect(extension?.commands.map((command) => command.name()).sort()).toEqual(['list', 'new', 'reload', 'show', 'validate']);
  });

  it('declares the required show and validate arguments', () => {
    expect(source).toContain(".command('show <name>')");
    expect(source).toContain(".command('validate [nameOrPath]')");
    expect(source).toContain(".command('new <name>')");
    expect(source).toContain(".command('reload')");
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

  it('reloads the in-process watcher without using worker cancellation paths', () => {
    const reloadBlock = daemonSource.slice(
      daemonSource.indexOf('async function reloadExtensionsWatcher()'),
      daemonSource.indexOf('// Load config before starting server'),
    );
    expect(reloadBlock).toContain('await stopWatcher();');
    expect(reloadBlock).toContain('await startWatcher(');
    expect(reloadBlock).not.toContain('cancelWorker');
    expect(reloadBlock).not.toContain('process.kill');
  });
});

describe('extension runtime documentation', () => {
  const docsExtensions = readRepoFile('docs/extensions.md');
  const docsExtensionsApi = readRepoFile('docs/extensions-api.md');
  const sdkReadme = readRepoFile('packages/extension-sdk/README.md');
  const configDocs = readRepoFile('docs/config.md');
  const minimalEventLogger = readRepoFile('examples/extensions/minimal-event-logger.ts');
  const protectedPaths = readRepoFile('examples/extensions/protected-paths.ts');

  it('marks onEvent and onAgentRun runtime execution as supported while other families remain deferred', () => {
    expect(docsExtensions).toContain('| `onEvent` - typed event subscriptions | Yes | Yes | Yes |');
    expect(docsExtensionsApi).toContain('| `onEvent` | Yes | Yes | Yes |');
    expect(sdkReadme).toContain('| `onEvent(pattern, handler)` | Subscribe to typed events (glob patterns) | Yes | Yes |');

    // onAgentRun is now partially supported (promptAppend only)
    for (const source of [docsExtensions, docsExtensionsApi, sdkReadme]) {
      const onAgentRunRow = source.split('\n').find((line) => line.startsWith('| `onAgentRun'));
      expect(onAgentRunRow, 'onAgentRun row').toBeDefined();
      expect(onAgentRunRow).not.toContain('Deferred');
      expect(onAgentRunRow).toContain('Yes');
    }

    for (const source of [docsExtensions, docsExtensionsApi, sdkReadme]) {
      for (const capability of [
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

  it('documents extension management commands and deferred workflows', () => {
    expect(docsExtensions).toContain('eforge extension new <name>');
    expect(docsExtensions).toContain('eforge extension reload');
    expect(docsExtensions).toContain('local -> `.eforge/extensions/`');
    expect(docsExtensions).toContain('project -> `eforge/extensions/`');
    expect(docsExtensions).toContain('user -> `~/.config/eforge/extensions/`');
    expect(docsExtensions).toContain('$XDG_CONFIG_HOME/eforge/extensions/');
    expect(docsExtensions).toContain('Event replay testing is deferred');
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

  function mcpExtensionBlock(): string {
    const blockStart = mcpSource.indexOf("name: 'eforge_extension'");
    const blockEnd = mcpSource.indexOf("name: 'eforge_models'", blockStart);
    expect(blockEnd).toBeGreaterThan(blockStart);
    return mcpSource.slice(blockStart, blockEnd);
  }

  function piExtensionBlock(): string {
    const blockStart = piSource.indexOf('name: "eforge_extension"');
    const blockEnd = piSource.indexOf('name: "eforge_models"', blockStart);
    expect(blockEnd).toBeGreaterThan(blockStart);
    return piSource.slice(blockStart, blockEnd);
  }

  it('MCP proxy registers eforge_extension and uses exported client helpers', () => {
    expect(mcpSource).toContain("name: 'eforge_extension'");
    expect(mcpSource).toContain("z.enum(['list', 'show', 'validate', 'new', 'reload'])");
    expect(mcpSource).toContain('apiListExtensions');
    expect(mcpSource).toContain('apiShowExtension');
    expect(mcpSource).toContain('apiValidateExtensions');
    expect(mcpSource).toContain('apiNewExtension');
    expect(mcpSource).toContain('apiReloadExtensions');
    const block = mcpExtensionBlock();
    expect(block).not.toContain("'/api/");
    expect(block).not.toContain('"/api/');
  });

  it('Pi extension registers eforge_extension and uses exported client helpers', () => {
    expect(piSource).toContain('name: "eforge_extension"');
    expect(piSource).toContain('StringEnum(["list", "show", "validate", "new", "reload"] as const');
    expect(piSource).toContain('apiListExtensions');
    expect(piSource).toContain('apiShowExtension');
    expect(piSource).toContain('apiValidateExtensions');
    expect(piSource).toContain('apiNewExtension');
    expect(piSource).toContain('apiReloadExtensions');
    const block = piExtensionBlock();
    expect(block).not.toContain("'/api/");
    expect(block).not.toContain('"/api/');
  });

  it('keeps MCP and Pi action-specific parameter validation rules in sync', () => {
    const requiredMessages = [
      '"list" does not accept name, path, scope, template, or force',
      '"name" is required when action is "show"',
      '"show" does not accept path, scope, template, or force',
      '"validate" does not accept scope, template, or force',
      'Specify only one of "name" or "path" for validate',
      '"name" is required when action is "new"',
      '"path" is not supported when action is "new"',
      '"reload" does not accept name, path, scope, template, or force',
    ];

    for (const [surface, block] of [
      ['MCP', mcpExtensionBlock()],
      ['Pi', piExtensionBlock()],
    ] as const) {
      for (const message of requiredMessages) {
        expect(block, `${surface} validation message: ${message}`).toContain(message);
      }
    }
  });

  it('routes new and reload actions through the action-specific client helpers', () => {
    function expectInOrder(block: string, before: string, after: string): void {
      const beforeIndex = block.indexOf(before);
      const afterIndex = block.indexOf(after);
      expect(beforeIndex, `${before} should be present`).toBeGreaterThanOrEqual(0);
      expect(afterIndex, `${after} should be present`).toBeGreaterThanOrEqual(0);
      expect(beforeIndex).toBeLessThan(afterIndex);
    }

    const mcpBlock = mcpExtensionBlock();
    expectInOrder(mcpBlock, "if (action === 'new')", 'apiNewExtension');
    expectInOrder(mcpBlock, 'apiNewExtension', 'apiReloadExtensions');
    expectInOrder(mcpBlock, '"reload" does not accept', 'apiReloadExtensions');

    const piBlock = piExtensionBlock();
    expectInOrder(piBlock, 'if (params.action === "new")', 'apiNewExtension');
    expectInOrder(piBlock, 'apiNewExtension', 'apiReloadExtensions');
    expectInOrder(piBlock, '"reload" does not accept', 'apiReloadExtensions');
  });

  it('/eforge:config Pi overlay includes the resolved extensions config block', () => {
    const source = readRepoFile('packages/pi-eforge/extensions/eforge/config-command.ts');
    expect(source).toContain('## Extensions');
    expect(source).toContain('trustProjectExtensions');
  });
});
