/**
 * Extension SDK smoke tests.
 *
 * 1. Barrel surface check — every documented export is present.
 * 2. `matchesEventPattern` parity with shell-hook semantics.
 * 3. `compileEventPattern` produces an anchored RegExp.
 * 4. Example modules type-check by being imported.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sdk from '@eforge-build/extension-sdk';

// Import example default exports so TypeScript verifies they conform to the
// SDK factory contract. The `void` references below exist solely to keep the
// imports from being elided by tree-shakers while keeping eslint/no-unused happy.
import minimalEventLogger from '../examples/extensions/minimal-event-logger.js';
import protectedPaths from '../examples/extensions/protected-paths.js';
// --- eforge:region plan-02-runtime-and-integration ---
import profileRouter from '../examples/extensions/profile-router.js';
// --- eforge:endregion plan-02-runtime-and-integration ---
// --- eforge:region plan-01-extension-docs-examples-sync ---
import agentContext from '../examples/extensions/agent-context.js';
import slackWebhookNotifier from '../examples/extensions/slack-webhook-notifier.js';
// --- eforge:endregion plan-01-extension-docs-examples-sync ---

const EXTENSION_EXAMPLE_DIR = resolve(fileURLToPath(new URL('../examples/extensions', import.meta.url)));
const importedExampleFiles = [
  'agent-context.ts',
  'minimal-event-logger.ts',
  'profile-router.ts',
  'protected-paths.ts',
  'slack-webhook-notifier.ts',
].sort();

const _factoryCheck1: sdk.EforgeExtensionFactory = minimalEventLogger;
const _factoryCheck2: sdk.EforgeExtensionFactory = protectedPaths;
// --- eforge:region plan-02-runtime-and-integration ---
const _factoryCheck4: sdk.EforgeExtensionFactory = profileRouter;
void _factoryCheck4;
// --- eforge:endregion plan-02-runtime-and-integration ---
// --- eforge:region plan-01-extension-docs-examples-sync ---
const _factoryCheck5: sdk.EforgeExtensionFactory = agentContext;
const _factoryCheck6: sdk.EforgeExtensionFactory = slackWebhookNotifier;
void _factoryCheck5;
void _factoryCheck6;
// --- eforge:endregion plan-01-extension-docs-examples-sync ---
const _factoryCheck3: sdk.EforgeExtensionFactory = (api) => {
  api.registerTool({
    name: 'test:noop',
    description: 'No-op test tool',
    inputSchema: sdk.Type.Object({}),
    handler: () => 'ok',
  });
};
void _factoryCheck1;
void _factoryCheck2;
void _factoryCheck3;

// --- eforge:region plan-01-sdk-and-wire-contracts ---
// Type-check stub: selectBuildProfile with ProfileRouterContext
const _profileRouterStub: sdk.EforgeExtensionFactory = (api) => {
  api.registerProfileRouter({
    name: 'type-check-router',
    async selectBuildProfile(ctx: sdk.ProfileRouterContext) {
      // Exercise prdId, availableProfiles, and usage.profile(...)
      const _prdId: string = ctx.prdId;
      const _profiles: sdk.ProfileSummary[] = ctx.availableProfiles;
      const _firstProfile = ctx.availableProfiles[0]?.name ?? 'default';
      const _usage: sdk.ProfileUsageSummary = ctx.usage.profile(_firstProfile);
      const _nearLimit: boolean | undefined = _usage.nearLimit;
      void _prdId;
      void _profiles;
      void _nearLimit;
      if (_usage.cooldownActive) {
        return { profile: 'fallback', reason: 'cooldown active', confidence: 'high' };
      }
      return null;
    },
  });
};
void _profileRouterStub;
// --- eforge:endregion plan-01-sdk-and-wire-contracts ---

function captureSlackPlanErrorHandler(): sdk.EventHookHandler<'plan:error:set'> {
  let handler: sdk.EventHookHandler<'plan:error:set'> | undefined;
  const api = {
    onEvent(pattern: sdk.EventPattern, registered: sdk.EventHookHandler<'plan:error:set'>) {
      expect(pattern).toBe('plan:error:set');
      handler = registered;
    },
  } as unknown as sdk.EforgeExtensionAPI;

  slackWebhookNotifier(api);
  expect(handler).toBeDefined();
  return handler!;
}

function createEventContext(
  event: sdk.EventOfType<'plan:error:set'>,
  logs: { info: string[]; warn: string[] },
): sdk.EventHookContext {
  return {
    event,
    logger: {
      debug() {},
      info(message: string) {
        logs.info.push(message);
      },
      warn(message: string) {
        logs.warn.push(message);
      },
      error() {},
    },
    exec: {
      run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    },
  } as sdk.EventHookContext;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

// ---------------------------------------------------------------------------
// Example import and runtime-safety smoke checks
// ---------------------------------------------------------------------------

describe('extension examples', () => {
  it('imports every TypeScript example file', () => {
    const exampleFiles = readdirSync(EXTENSION_EXAMPLE_DIR)
      .filter((file) => file.endsWith('.ts'))
      .sort();
    expect(importedExampleFiles).toEqual(exampleFiles);
  });

  it('slack webhook notifier skips without credentials and does not call fetch', async () => {
    const envName = 'EFORGE_SLACK_WEBHOOK_URL';
    const originalWebhookUrl = process.env[envName];
    const originalFetch = globalThis.fetch;
    const logs = { info: [] as string[], warn: [] as string[] };
    let fetchCalled = false;

    try {
      delete process.env[envName];
      globalThis.fetch = (async () => {
        fetchCalled = true;
        throw new Error('fetch should not be called without a webhook URL');
      }) as typeof fetch;

      const event: sdk.EventOfType<'plan:error:set'> = {
        type: 'plan:error:set',
        planId: 'plan-a',
        error: 'build crashed',
      };
      const handler = captureSlackPlanErrorHandler();
      await handler(event, createEventContext(event, logs));

      expect(fetchCalled).toBe(false);
      expect(logs.info).toContain('EFORGE_SLACK_WEBHOOK_URL is unset; skipping Slack-compatible plan error notification');
      expect(logs.warn).toEqual([]);
    } finally {
      restoreEnv(envName, originalWebhookUrl);
      globalThis.fetch = originalFetch;
    }
  });

  it('slack webhook notifier posts only to the webhook URL from the environment', async () => {
    const envName = 'EFORGE_SLACK_WEBHOOK_URL';
    const originalWebhookUrl = process.env[envName];
    const originalFetch = globalThis.fetch;
    const webhookUrl = 'https://example.test/eforge-slack-webhook';
    const logs = { info: [] as string[], warn: [] as string[] };
    const fetchCalls: Array<{ input: Parameters<typeof fetch>[0]; init: Parameters<typeof fetch>[1] }> = [];

    try {
      process.env[envName] = webhookUrl;
      globalThis.fetch = (async (input, init) => {
        fetchCalls.push({ input, init });
        return { ok: true, status: 200 } as Response;
      }) as typeof fetch;

      const event: sdk.EventOfType<'plan:error:set'> = {
        type: 'plan:error:set',
        planId: 'plan-a',
        error: 'build crashed',
      };
      const handler = captureSlackPlanErrorHandler();
      await handler(event, createEventContext(event, logs));

      expect(fetchCalls).toHaveLength(1);
      expect(String(fetchCalls[0]?.input)).toBe(webhookUrl);
      expect(fetchCalls[0]?.init?.method).toBe('POST');
      expect(fetchCalls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
      expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({
        text: 'eforge plan plan-a failed: build crashed',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*:warning: eforge plan error*\n*Plan:* plan-a\n*Error:* build crashed',
            },
          },
        ],
      });
      expect(logs.info).toContain('Sent Slack-compatible plan error notification for plan-a');
      expect(logs.warn).toEqual([]);
    } finally {
      restoreEnv(envName, originalWebhookUrl);
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Type-level barrel surface check — references every documented type-only
// export so that accidental removal causes a compile error in this test file.
// ---------------------------------------------------------------------------

type _TypeExports = [
  sdk.EforgeExtensionAPI,
  sdk.EforgeExtensionFactory,
  sdk.EforgeExtensionContext,
  sdk.EventHookContext,
  sdk.EventHookHandler<'plan:build:complete'>,
  sdk.EventOfType<'plan:build:complete'>,
  sdk.EventPattern,
  sdk.PolicyDecision,
  sdk.PolicyGateContext,
  sdk.PolicyGateHandler,
  sdk.AgentRunContext,
  sdk.AgentRunHandler,
  sdk.AgentRunAugmentation,
  sdk.ExtensionTool,
  sdk.ProfileRouterSpec,
  sdk.ProfileRouterResult,
  sdk.ProfileRouterContext,
  sdk.ProfileSummary,
  sdk.ProfileUsageSummary,
  sdk.InputSourceAdapter,
  sdk.ReviewerPerspectiveSpec,
  sdk.ValidationProviderSpec,
  sdk.EforgeEvent,
  sdk.AgentRole,
  sdk.TSchema,
  sdk.TObject,
  sdk.Static<sdk.TObject>,
];
type _Unused = _TypeExports;

// ---------------------------------------------------------------------------
// 1. Barrel surface check
// ---------------------------------------------------------------------------

describe('SDK barrel surface', () => {
  it('exports defineEforgeExtension as a function', () => {
    expect(typeof sdk.defineEforgeExtension).toBe('function');
  });

  it('exports compileEventPattern as a function', () => {
    expect(typeof sdk.compileEventPattern).toBe('function');
  });

  it('exports matchesEventPattern as a function', () => {
    expect(typeof sdk.matchesEventPattern).toBe('function');
  });

  it('exports defineExtensionTool as a function', () => {
    expect(typeof sdk.defineExtensionTool).toBe('function');
  });

  it('exports EforgeEventSchema', () => {
    expect(sdk.EforgeEventSchema).toBeDefined();
  });

  it('exports safeParseEforgeEvent as a function', () => {
    expect(typeof sdk.safeParseEforgeEvent).toBe('function');
  });

  it('exports Type (TypeBox)', () => {
    expect(sdk.Type).toBeDefined();
    expect(typeof sdk.Type.Object).toBe('function');
    expect(typeof sdk.Type.String).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 2. matchesEventPattern — parity with engine shell-hook semantics
// ---------------------------------------------------------------------------

describe('matchesEventPattern', () => {
  it('exact match succeeds', () => {
    expect(sdk.matchesEventPattern('plan:build:complete', 'plan:build:complete')).toBe(true);
  });

  it('exact match does not match different type', () => {
    expect(sdk.matchesEventPattern('plan:build:complete', 'plan:build:failed')).toBe(false);
  });

  it('plan:build:* matches plan:build:complete', () => {
    expect(sdk.matchesEventPattern('plan:build:*', 'plan:build:complete')).toBe(true);
  });

  it('plan:build:* matches plan:build:failed', () => {
    expect(sdk.matchesEventPattern('plan:build:*', 'plan:build:failed')).toBe(true);
  });

  it('plan:build:* does not match plan:review:complete', () => {
    expect(sdk.matchesEventPattern('plan:build:*', 'plan:review:complete')).toBe(false);
  });

  it('*:complete matches plan:build:complete', () => {
    expect(sdk.matchesEventPattern('*:complete', 'plan:build:complete')).toBe(true);
  });

  it('*:complete matches plan:review:complete', () => {
    expect(sdk.matchesEventPattern('*:complete', 'plan:review:complete')).toBe(true);
  });

  it('*:complete does not match plan:build:failed', () => {
    expect(sdk.matchesEventPattern('*:complete', 'plan:build:failed')).toBe(false);
  });

  it('* matches any event type', () => {
    expect(sdk.matchesEventPattern('*', 'plan:build:complete')).toBe(true);
    expect(sdk.matchesEventPattern('*', 'plan:review:failed')).toBe(true);
    expect(sdk.matchesEventPattern('*', 'session:start')).toBe(true);
  });

  it('regex special characters in patterns are treated as literals (dot is literal)', () => {
    // A pattern with a literal dot should NOT match a colon in the same position.
    // 'plan.build:start' should not match 'plan:build:start' (dot is not a wildcard).
    expect(sdk.matchesEventPattern('plan.build:start', 'plan:build:start')).toBe(false);
    // But it should match literally.
    expect(sdk.matchesEventPattern('plan.build:start', 'plan.build:start')).toBe(true);
  });

  it('regex special characters in patterns are treated as literals (parens are literal)', () => {
    expect(sdk.matchesEventPattern('plan(build):start', 'planXbuildY:start')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. compileEventPattern — produces an anchored RegExp
// ---------------------------------------------------------------------------

describe('compileEventPattern', () => {
  it('returns a RegExp', () => {
    expect(sdk.compileEventPattern('plan:build:*')).toBeInstanceOf(RegExp);
  });

  it('returns an anchored RegExp (starts with ^ and ends with $)', () => {
    const re = sdk.compileEventPattern('plan:build:*');
    expect(re.source.startsWith('^')).toBe(true);
    expect(re.source.endsWith('$')).toBe(true);
  });

  it('anchors prevent partial matches', () => {
    const re = sdk.compileEventPattern('build:complete');
    // Should not match a string that contains 'build:complete' as a substring.
    expect(re.test('plan:build:complete')).toBe(false);
    expect(re.test('build:complete')).toBe(true);
  });

  it('* in pattern translates to .* in regex', () => {
    const re = sdk.compileEventPattern('plan:*:complete');
    expect(re.source).toContain('.*');
    expect(re.test('plan:build:complete')).toBe(true);
    expect(re.test('plan:review:complete')).toBe(true);
    expect(re.test('plan:build:failed')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. defineEforgeExtension identity helper
// ---------------------------------------------------------------------------

describe('defineEforgeExtension', () => {
  it('returns the same factory function', () => {
    const factory = (_api: sdk.EforgeExtensionAPI) => {};
    const result = sdk.defineEforgeExtension(factory);
    expect(result).toBe(factory);
  });
});

// ---------------------------------------------------------------------------
// 5. defineExtensionTool identity helper
// ---------------------------------------------------------------------------

describe('defineExtensionTool', () => {
  it('returns the same tool object', () => {
    const tool: sdk.ExtensionTool = {
      name: 'test:greet',
      description: 'Greet',
      inputSchema: sdk.Type.Object({ name: sdk.Type.String() }),
      handler: ({ name }: { name: string }) => `Hello, ${name}!`,
    };
    const result = sdk.defineExtensionTool(tool);
    expect(result).toBe(tool);
  });
});
