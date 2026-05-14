/**
 * Extension SDK smoke tests.
 *
 * 1. Barrel surface check — every documented export is present.
 * 2. `matchesEventPattern` parity with shell-hook semantics.
 * 3. `compileEventPattern` produces an anchored RegExp.
 * 4. Example modules type-check by being imported.
 */

import { describe, it, expect } from 'vitest';
import * as sdk from '@eforge-build/extension-sdk';

// Import example default exports so TypeScript verifies they conform to the
// SDK factory contract. The factories are not invoked (no runtime wiring in
// this slice); the `void` references below exist solely to keep the imports
// from being elided by tree-shakers while keeping eslint/no-unused happy.
import minimalEventLogger from '../examples/extensions/minimal-event-logger.js';
import protectedPaths from '../examples/extensions/protected-paths.js';
const _factoryCheck1: sdk.EforgeExtensionFactory = minimalEventLogger;
const _factoryCheck2: sdk.EforgeExtensionFactory = protectedPaths;
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
