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
    expect(API_ROUTES.extensionTest).toBe('/api/extensions/test');
    expect(API_ROUTES.extensionNew).toBe('/api/extensions/new');
    expect(API_ROUTES.extensionReload).toBe('/api/extensions/reload');
  });

  it('client helpers call shared extension route constants', () => {
    const source = readRepoFile('packages/client/src/api/extensions.ts');
    expect(source).toContain('API_ROUTES.extensionList');
    expect(source).toContain('API_ROUTES.extensionShow');
    expect(source).toContain('API_ROUTES.extensionValidate');
    expect(source).toContain('API_ROUTES.extensionTest');
    expect(source).toContain('API_ROUTES.extensionNew');
    expect(source).toContain('API_ROUTES.extensionReload');
    expect(source).not.toContain("'/api/extensions/");
    expect(source).not.toContain('"/api/extensions/');
    expect(source).toContain('apiNewExtension');
    expect(source).toContain('apiReloadExtensions');
    expect(source).toContain('apiTestExtension');
  });
});

describe('CLI extension command registration', () => {
  const source = readRepoFile('packages/eforge/src/cli/index.ts');

  it('registers eforge extension list/show/validate/test/new/reload commands on the actual Commander program', () => {
    const program = createProgram(undefined, 'test');
    const extension = program.commands.find((command) => command.name() === 'extension');
    expect(extension).toBeDefined();
    expect(extension?.commands.map((command) => command.name()).sort()).toEqual(['list', 'new', 'reload', 'show', 'test', 'validate']);
  });

  it('declares the required show and validate arguments', () => {
    expect(source).toContain(".command('show <name>')");
    expect(source).toContain(".command('validate [nameOrPath]')");
    expect(source).toContain(".command('test [nameOrPath]')");
    expect(source).toContain(".command('new <name>')");
    expect(source).toContain(".command('reload')");
  });

  it('validate and test exit non-zero when the response is invalid', () => {
    expect(source).toContain('if (!data.valid) process.exit(1);');
    expect(source).toContain('apiTestExtension({ cwd: process.cwd(), body })');
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
  const webExtensions = readRepoFile('web/content/docs/extensions.md');
  const webExtensionsApi = readRepoFile('web/content/docs/extensions-api.md');
  const sdkReadme = readRepoFile('packages/extension-sdk/README.md');
  const configDocs = readRepoFile('docs/config.md');
  const webConfigDocs = readRepoFile('web/content/docs/configuration.md');
  const examplesReadme = readRepoFile('examples/extensions/README.md');
  const minimalEventLogger = readRepoFile('examples/extensions/minimal-event-logger.ts');
  const slackWebhookNotifier = readRepoFile('examples/extensions/slack-webhook-notifier.ts');
  const protectedPaths = readRepoFile('examples/extensions/protected-paths.ts');
  const agentToolsExample = readRepoFile('examples/extensions/agent-tools.ts');
  const publicConfigSchema = JSON.parse(readRepoFile('web/public/schemas/config.schema.json')) as {
    properties?: { extensions?: { properties?: Record<string, unknown> } };
  };

  it('marks onEvent and onAgentRun runtime execution as supported while other families remain deferred', () => {
    expect(docsExtensions).toContain('| `onEvent` - typed event subscriptions | Yes | Yes | Yes |');
    expect(docsExtensionsApi).toContain('| `onEvent` | Yes | Yes | Yes |');
    expect(sdkReadme).toContain('| `onEvent(pattern, handler)` | Subscribe to typed events (glob patterns) | Yes | Yes |');

    // onAgentRun now supports prompt and per-run tool augmentation.
    for (const source of [docsExtensions, docsExtensionsApi, webExtensions, webExtensionsApi, sdkReadme]) {
      const onAgentRunRow = source.split('\n').find((line) => line.startsWith('| `onAgentRun'));
      expect(onAgentRunRow, 'onAgentRun row').toBeDefined();
      expect(onAgentRunRow).not.toContain('Deferred');
      expect(onAgentRunRow).toContain('Yes');

      const registerToolRow = source.split('\n').find((line) => line.startsWith('|') && line.includes('registerTool'));
      expect(registerToolRow, 'registerTool row').toBeDefined();
      expect(registerToolRow).not.toContain('Deferred');
      expect(registerToolRow).toContain('Provenance');
    }

    for (const source of [docsExtensions, docsExtensionsApi, webExtensions, webExtensionsApi, sdkReadme]) {
      for (const capability of [
        'beforeQueueDispatch',
        'beforePlanMerge',
        'beforeFinalMerge',
      ]) {
        const row = source.split('\n').find((line) => line.startsWith(`| \`${capability}`));
        expect(row, `${capability} support row`).toBeDefined();
        expect(row).not.toContain('Deferred');
        expect(row).toContain('Yes');
      }
    }

    for (const source of [docsExtensions, docsExtensionsApi, webExtensions, webExtensionsApi, sdkReadme]) {
      for (const capability of [
        'registerInputSource',
        'registerReviewerPerspective',
        'registerValidationProvider',
      ]) {
        const row = source.split('\n').find((line) => line.startsWith('|') && line.includes(capability));
        expect(row, `${capability} row`).toBeDefined();
        expect(row).toContain('Deferred');
      }
    }

    // registerProfileRouter: plan-02 shipped the runtime — all three sources now reflect pre-build dispatch.
    for (const source of [docsExtensions, docsExtensionsApi, webExtensions, webExtensionsApi, sdkReadme]) {
      const row = source.split('\n').find((line) => line.startsWith('|') && line.includes('registerProfileRouter'));
      expect(row, 'registerProfileRouter row').toBeDefined();
      expect(row).toContain('Yes (pre-build dispatch)');
    }

    for (const source of [configDocs, webConfigDocs]) {
      expect(source).toContain('pre-build `registerProfileRouter` dispatch');
      expect(source).not.toMatch(/profile routing[^.\n]*(?:deferred|future)|(?:deferred|future)[^.\n]*profile routing/i);
    }
  });

  it('keeps generated raw mirrors in sync with the public content docs', () => {
    expect(readRepoFile('web/public/docs/extensions.md')).toBe(webExtensions);
    expect(readRepoFile('web/public/docs/extensions-api.md')).toBe(webExtensionsApi);
    expect(readRepoFile('web/public/docs/configuration.md')).toBe(webConfigDocs);
  });

  it('documents extension management commands and replay workflows', () => {
    expect(docsExtensions).toContain('eforge extension new <name>');
    expect(docsExtensions).toContain('eforge extension test');
    expect(docsExtensions).toContain('--run latest');
    expect(docsExtensions).toContain('eforge extension reload');
    expect(docsExtensions).toContain('local -> `.eforge/extensions/`');
    expect(docsExtensions).toContain('project -> `eforge/extensions/`');
    expect(docsExtensions).toContain('user -> `~/.config/eforge/extensions/`');
    expect(docsExtensions).toContain('$XDG_CONFIG_HOME/eforge/extensions/');
    expect(docsExtensions).not.toContain('Event replay testing is deferred');
  });

  it('documents event hook and policy gate timeout/failure semantics plus example runtime notes', () => {
    for (const source of [configDocs, webConfigDocs, docsExtensions, webExtensions]) {
      expect(source).toContain('agentContextHookTimeoutMs');
      expect(source).toContain('policyGateTimeoutMs');
      expect(source).toContain('policyGateFailurePolicy');
      expect(source).toContain('fail-open');
      expect(source).toContain('fail-closed');
    }
    expect(configDocs).toContain('eventHookTimeoutMs: 5000');
    expect(configDocs).toContain('policyGateTimeoutMs: 5000');
    expect(configDocs).toContain('policyGateFailurePolicy: fail-closed');
    expect(configDocs).toContain('Must be a positive integer');
    expect(publicConfigSchema.properties?.extensions?.properties?.policyGateTimeoutMs).toMatchObject({
      type: 'integer',
      exclusiveMinimum: 0,
    });
    expect(publicConfigSchema.properties?.extensions?.properties?.policyGateFailurePolicy).toMatchObject({
      type: 'string',
      enum: ['fail-open', 'fail-closed'],
    });
    expect(minimalEventLogger).not.toContain('Event dispatch remains deferred');
    expect(minimalEventLogger).toContain('onEvent');
    expect(minimalEventLogger).toContain('dispatched at runtime');
    expect(slackWebhookNotifier).toContain("onEvent('plan:error:set'");
    expect(slackWebhookNotifier).toContain('EFORGE_SLACK_WEBHOOK_URL');
    expect(slackWebhookNotifier).not.toMatch(/hooks\.slack\.com\/services/i);
    expect(slackWebhookNotifier).not.toMatch(/\bxox[a-z]?-/i);
    expect(protectedPaths).toContain('beforeFinalMerge');
    expect(protectedPaths).toContain('require-approval` blocks');
    expect(protectedPaths).not.toContain('Policy enforcement before merge remains');
    expect(protectedPaths).not.toContain('deferred until the policy-gate runtime is implemented');
  });

  it('keeps non-shipped policy-gate capabilities explicitly deferred in public docs', () => {
    for (const source of [
      docsExtensions,
      docsExtensionsApi,
      webExtensions,
      webExtensionsApi,
      sdkReadme,
      configDocs,
      webConfigDocs,
      examplesReadme,
    ]) {
      expect(source).toContain('beforeEnqueue');
      expect(source).toContain('beforeValidation');
      expect(source).toContain('modify');
      expect(source).toMatch(/approval (?:workflow|workflows|UI|state)[^\n]*(?:deferred|future|no approval workflow)|(?:deferred|future|no approval workflow)[^\n]*approval (?:workflow|workflows|UI|state)/i);
      expect(source).toMatch(/beforeEnqueue[^\n]*(?:deferred|future)|(?:deferred|future)[^\n]*beforeEnqueue/i);
      expect(source).toMatch(/beforeValidation[^\n]*(?:deferred|future)|(?:deferred|future)[^\n]*beforeValidation/i);
      expect(source).toMatch(/modify[^\n]*(?:deferred|future)|(?:deferred|future)[^\n]*modify/i);
    }
  });

  it('documents examples, scaffold templates, and unavailable extension workflows accurately', () => {
    for (const example of [
      'minimal-event-logger.ts',
      'slack-webhook-notifier.ts',
      'agent-context.ts',
      'agent-tools.ts',
      'profile-router.ts',
      'protected-paths.ts',
    ]) {
      expect(examplesReadme).toContain(example);
    }

    for (const expected of [
      'Runtime-supported event dispatch and replay',
      'Runtime-supported prompt-context augmentation',
      'Runtime-supported per-run extension tool injection and availability tuning',
      'Runtime-supported pre-build dispatch',
      'Runtime-supported policy enforcement for plan/final merge protected paths',
      'pnpm test -- test/extension-sdk-example.test.ts',
      'pnpm test -- test/extension-tooling-wiring.test.ts',
      'pnpm docs:check',
      'eforge extension test ./examples/extensions/slack-webhook-notifier.ts --fixture events.json',
    ]) {
      expect(examplesReadme).toContain(expected);
    }

    expect(agentToolsExample).toContain('defineExtensionTool');
    expect(agentToolsExample).toContain('registerTool');
    expect(agentToolsExample).toContain('onAgentRun');
    expect(agentToolsExample).toContain('effectiveToolName');

    for (const source of [docsExtensions, webExtensions, sdkReadme]) {
      expect(source).toContain('event-logger');
      expect(source).toContain('blank');
    }

    for (const source of [docsExtensions, webExtensions]) {
      expect(source).toContain('slack-webhook-notifier.ts');
      expect(source).toContain('EFORGE_SLACK_WEBHOOK_URL');
      expect(source).toContain('extension enable`, `extension disable`, `extension promote`, and `extension demote` workflows are deferred');
    }

    for (const source of [
      docsExtensions,
      docsExtensionsApi,
      webExtensions,
      webExtensionsApi,
      sdkReadme,
      configDocs,
      webConfigDocs,
      examplesReadme,
    ]) {
      expect(source).not.toContain('/eforge:extend');
      expect(source).not.toMatch(/\beforge extension (enable|disable|promote|demote)(?:\s|`|$)/);
      expect(source).not.toMatch(/profile routing[^.\n]*(?:deferred|future)|(?:deferred|future)[^.\n]*profile routing/i);
    }
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
    expect(mcpSource).toContain("z.enum(['list', 'show', 'validate', 'test', 'new', 'reload'])");
    expect(mcpSource).toContain('apiListExtensions');
    expect(mcpSource).toContain('apiShowExtension');
    expect(mcpSource).toContain('apiValidateExtensions');
    expect(mcpSource).toContain('apiTestExtension');
    expect(mcpSource).toContain('apiNewExtension');
    expect(mcpSource).toContain('apiReloadExtensions');
    const block = mcpExtensionBlock();
    expect(block).not.toContain("'/api/");
    expect(block).not.toContain('"/api/');
  });

  it('Pi extension registers eforge_extension and uses exported client helpers', () => {
    expect(piSource).toContain('name: "eforge_extension"');
    expect(piSource).toContain('StringEnum(["list", "show", "validate", "test", "new", "reload"] as const');
    expect(piSource).toContain('apiListExtensions');
    expect(piSource).toContain('apiShowExtension');
    expect(piSource).toContain('apiValidateExtensions');
    expect(piSource).toContain('apiTestExtension');
    expect(piSource).toContain('apiNewExtension');
    expect(piSource).toContain('apiReloadExtensions');
    const block = piExtensionBlock();
    expect(block).not.toContain("'/api/");
    expect(block).not.toContain('"/api/');
  });

  it('keeps MCP and Pi action-specific parameter validation rules in sync', () => {
    const requiredMessages = [
      '"list" does not accept name, path, scope, template, or force',
      '"list" does not accept fixture, run, or event',
      '"name" is required when action is "show"',
      '"show" does not accept path, scope, template, or force',
      '"show" does not accept fixture, run, or event',
      '"validate" does not accept scope, template, or force',
      '"validate" does not accept fixture, run, or event',
      'Specify only one of "name" or "path" for validate',
      '"test" does not accept scope, template, or force',
      'Specify only one of "name" or "path" for test',
      '"name" is required when action is "new"',
      '"path" is not supported when action is "new"',
      '"new" does not accept fixture, run, or event',
      '"reload" does not accept name, path, scope, template, or force',
      '"reload" does not accept fixture, run, or event',
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

  it('routes test, new, and reload actions through the action-specific client helpers', () => {
    function expectInOrder(block: string, before: string, after: string): void {
      const beforeIndex = block.indexOf(before);
      const afterIndex = block.indexOf(after);
      expect(beforeIndex, `${before} should be present`).toBeGreaterThanOrEqual(0);
      expect(afterIndex, `${after} should be present`).toBeGreaterThanOrEqual(0);
      expect(beforeIndex).toBeLessThan(afterIndex);
    }

    const mcpBlock = mcpExtensionBlock();
    expectInOrder(mcpBlock, "if (action === 'test')", 'apiTestExtension');
    expectInOrder(mcpBlock, "if (action === 'new')", 'apiNewExtension');
    expectInOrder(mcpBlock, 'apiTestExtension', 'apiNewExtension');
    expectInOrder(mcpBlock, 'apiNewExtension', 'apiReloadExtensions');
    expectInOrder(mcpBlock, '"reload" does not accept', 'apiReloadExtensions');

    const piBlock = piExtensionBlock();
    expectInOrder(piBlock, 'if (params.action === "test")', 'apiTestExtension');
    expectInOrder(piBlock, 'if (params.action === "new")', 'apiNewExtension');
    expectInOrder(piBlock, 'apiTestExtension', 'apiNewExtension');
    expectInOrder(piBlock, 'apiNewExtension', 'apiReloadExtensions');
    expectInOrder(piBlock, '"reload" does not accept', 'apiReloadExtensions');
  });

  it('/eforge:config Pi overlay includes the resolved extensions config block', () => {
    const source = readRepoFile('packages/pi-eforge/extensions/eforge/config-command.ts');
    expect(source).toContain('## Extensions');
    expect(source).toContain('trustProjectExtensions');
  });
});
