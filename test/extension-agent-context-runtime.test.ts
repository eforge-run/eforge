/**
 * Tests for agent-context-runtime.ts (EXTEND_08A).
 *
 * Covers:
 *   - Prompt composition with provenance section
 *   - Ordering across multiple extensions
 *   - Role/tier/phase filtering inside handlers
 *   - Fail-open on handler throw
 *   - Fail-open on timeout
 *   - Unsupported-field diagnostic
 *   - Coexistence with config promptAppend
 *   - No raw prompt text in emitted events
 *   - StubHarness-driven wiring (registry decorator)
 */
import { describe, it, expect } from 'vitest';
import {
  executeAgentRunHooks,
  withAgentContextHooks,
} from '@eforge-build/engine/extensions';
import type { AgentRunRegistration, NativeExtensionRegistry } from '@eforge-build/engine/extensions';
import type { AgentRunOptions } from '@eforge-build/engine/harness';
import type { AgentRunContext, AgentRunAugmentation } from '@eforge-build/extension-sdk';
import { singletonRegistry } from '@eforge-build/engine/agent-runtime-registry';
import { StubHarness } from './stub-harness.js';
import { collectEvents, filterEvents } from './test-events.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

type AgentRunHandler = (ctx: AgentRunContext) => AgentRunAugmentation | Promise<AgentRunAugmentation | undefined> | undefined;

function makeHook(
  extensionName: string,
  handler: AgentRunHandler,
): AgentRunRegistration {
  return {
    kind: 'agentRunHook',
    extensionName,
    extensionPath: `/extensions/${extensionName}.js`,
    value: handler as never,
  };
}

function makeRegistry(agentRunHooks: AgentRunRegistration[]): Pick<NativeExtensionRegistry, 'agentRunHooks'> {
  return { agentRunHooks };
}

const BASE_OPTIONS: AgentRunOptions = {
  prompt: 'Base prompt content.',
  cwd: '/tmp',
  maxTurns: 5,
  tools: 'none',
};

const RUNTIME_OPTIONS = {
  profileName: 'default',
  cwd: '/tmp',
  timeoutMs: 1000,
};

// ---------------------------------------------------------------------------
// executeAgentRunHooks — prompt composition
// ---------------------------------------------------------------------------

describe('executeAgentRunHooks — prompt composition', () => {
  it('returns unmodified prompt when no hooks are registered', async () => {
    const result = await executeAgentRunHooks([], BASE_OPTIONS, 'builder', undefined, RUNTIME_OPTIONS);
    expect(result.finalPrompt).toBe(BASE_OPTIONS.prompt);
    expect(result.diagnostics).toHaveLength(0);
  });

  it('returns unmodified prompt when handler returns undefined', async () => {
    const result = await executeAgentRunHooks(
      [makeHook('noop', () => undefined)],
      BASE_OPTIONS,
      'builder',
      undefined,
      RUNTIME_OPTIONS,
    );
    expect(result.finalPrompt).toBe(BASE_OPTIONS.prompt);
    expect(result.diagnostics).toHaveLength(0);
  });

  it('appends a provenance section when handler returns promptAppend', async () => {
    const result = await executeAgentRunHooks(
      [makeHook('my-ext', () => ({ promptAppend: 'Extra context here.' }))],
      BASE_OPTIONS,
      'builder',
      undefined,
      RUNTIME_OPTIONS,
    );

    expect(result.finalPrompt).toContain(BASE_OPTIONS.prompt);
    expect(result.finalPrompt).toContain('## Native extension context');
    expect(result.finalPrompt).toContain('### my-ext');
    expect(result.finalPrompt).toContain('Extra context here.');
    // Original prompt must appear before the provenance section
    const baseIndex = result.finalPrompt.indexOf(BASE_OPTIONS.prompt);
    const sectionIndex = result.finalPrompt.indexOf('## Native extension context');
    expect(baseIndex).toBeLessThan(sectionIndex);
  });

  it('emits extension:agent-context:applied event when fragment is contributed', async () => {
    const result = await executeAgentRunHooks(
      [makeHook('my-ext', () => ({ promptAppend: 'X' }))],
      BASE_OPTIONS,
      'builder',
      'plan-01',
      RUNTIME_OPTIONS,
    );

    const applied = result.diagnostics.filter(d => d.type === 'extension:agent-context:applied');
    expect(applied).toHaveLength(1);
    expect(applied[0]!.extensionName).toBe('my-ext');
    expect(applied[0]!.role).toBe('builder');
    expect(applied[0]!.planId).toBe('plan-01');
    // Must NOT contain the fragment text itself
    const eventStr = JSON.stringify(applied[0]);
    expect(eventStr).not.toContain('Extra context here.');
  });
});

// ---------------------------------------------------------------------------
// executeAgentRunHooks — ordering
// ---------------------------------------------------------------------------

describe('executeAgentRunHooks — ordering across multiple extensions', () => {
  it('appends fragments in registry-iteration order', async () => {
    const result = await executeAgentRunHooks(
      [
        makeHook('ext-alpha', () => ({ promptAppend: 'Alpha content.' })),
        makeHook('ext-beta', () => ({ promptAppend: 'Beta content.' })),
      ],
      BASE_OPTIONS,
      'builder',
      undefined,
      RUNTIME_OPTIONS,
    );

    // Both section headers must appear
    expect(result.finalPrompt).toContain('### ext-alpha');
    expect(result.finalPrompt).toContain('### ext-beta');
    // Alpha before beta (registry order)
    const alphaIndex = result.finalPrompt.indexOf('### ext-alpha');
    const betaIndex = result.finalPrompt.indexOf('### ext-beta');
    expect(alphaIndex).toBeLessThan(betaIndex);
  });

  it('emits one applied event per contributing extension', async () => {
    const result = await executeAgentRunHooks(
      [
        makeHook('ext-alpha', () => ({ promptAppend: 'Alpha.' })),
        makeHook('ext-beta', () => ({ promptAppend: 'Beta.' })),
      ],
      BASE_OPTIONS,
      'builder',
      undefined,
      RUNTIME_OPTIONS,
    );

    const applied = result.diagnostics.filter(d => d.type === 'extension:agent-context:applied');
    expect(applied).toHaveLength(2);
    const names = applied.map(e => e.extensionName);
    expect(names).toContain('ext-alpha');
    expect(names).toContain('ext-beta');
  });
});

// ---------------------------------------------------------------------------
// executeAgentRunHooks — role/tier/phase filtering inside handlers
// ---------------------------------------------------------------------------

describe('executeAgentRunHooks — role/tier/phase filtering inside handlers', () => {
  it('handler can filter by role — returns nothing for non-matching role', async () => {
    const handler: AgentRunHandler = (ctx) => {
      if (ctx.role !== 'builder') return undefined;
      return { promptAppend: 'Builder-only context.' };
    };

    const builderResult = await executeAgentRunHooks(
      [makeHook('role-filter', handler)],
      BASE_OPTIONS,
      'builder',
      undefined,
      RUNTIME_OPTIONS,
    );
    const reviewerResult = await executeAgentRunHooks(
      [makeHook('role-filter', handler)],
      BASE_OPTIONS,
      'reviewer',
      undefined,
      RUNTIME_OPTIONS,
    );

    expect(builderResult.finalPrompt).toContain('Builder-only context.');
    expect(builderResult.diagnostics.some(d => d.type === 'extension:agent-context:applied')).toBe(true);

    expect(reviewerResult.finalPrompt).toBe(BASE_OPTIONS.prompt);
    expect(reviewerResult.diagnostics.some(d => d.type === 'extension:agent-context:applied')).toBe(false);
  });

  it('handler receives tier from options', async () => {
    const capturedTiers: string[] = [];
    const handler: AgentRunHandler = (ctx) => {
      capturedTiers.push(ctx.tier ?? 'none');
      return undefined;
    };

    const opts: AgentRunOptions = { ...BASE_OPTIONS, tier: 'implementation' };
    await executeAgentRunHooks([makeHook('tier-capture', handler)], opts, 'builder', undefined, RUNTIME_OPTIONS);
    expect(capturedTiers).toContain('implementation');
  });

  it('handler receives phase and stage from options', async () => {
    const captured: { phase?: string; stage?: string } = {};
    const handler: AgentRunHandler = (ctx) => {
      captured.phase = ctx.phase;
      captured.stage = ctx.stage;
      return undefined;
    };

    const opts: AgentRunOptions = { ...BASE_OPTIONS, phase: 'build', stage: 'implement' };
    await executeAgentRunHooks([makeHook('phase-capture', handler)], opts, 'builder', undefined, RUNTIME_OPTIONS);

    expect(captured.phase).toBe('build');
    expect(captured.stage).toBe('implement');
  });

  it('handler receives compile phase and stage', async () => {
    const captured: { phase?: string; stage?: string } = {};
    const handler: AgentRunHandler = (ctx) => {
      captured.phase = ctx.phase;
      captured.stage = ctx.stage;
      return undefined;
    };

    const opts: AgentRunOptions = { ...BASE_OPTIONS, phase: 'compile', stage: 'planner' };
    await executeAgentRunHooks([makeHook('compile-capture', handler)], opts, 'planner', undefined, RUNTIME_OPTIONS);

    expect(captured.phase).toBe('compile');
    expect(captured.stage).toBe('planner');
  });

  it('handler receives standalone phase with no stage', async () => {
    const captured: { phase?: string; stage?: string } = {};
    const handler: AgentRunHandler = (ctx) => {
      captured.phase = ctx.phase;
      captured.stage = ctx.stage;
      return undefined;
    };

    const opts: AgentRunOptions = { ...BASE_OPTIONS, phase: 'standalone' };
    await executeAgentRunHooks([makeHook('standalone-capture', handler)], opts, 'recovery-analyst', undefined, RUNTIME_OPTIONS);

    expect(captured.phase).toBe('standalone');
    expect(captured.stage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// executeAgentRunHooks — fail-open on handler throw
// ---------------------------------------------------------------------------

describe('executeAgentRunHooks — fail-open on handler throw', () => {
  it('emits failed diagnostic and does not modify prompt when handler throws', async () => {
    const result = await executeAgentRunHooks(
      [makeHook('error-ext', () => { throw new Error('Handler crashed'); })],
      BASE_OPTIONS,
      'builder',
      undefined,
      RUNTIME_OPTIONS,
    );

    // Prompt must be unmodified
    expect(result.finalPrompt).toBe(BASE_OPTIONS.prompt);

    // Must emit exactly one failed diagnostic
    const failed = result.diagnostics.filter(d => d.type === 'extension:agent-context:failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.extensionName).toBe('error-ext');
    expect(failed[0]!.message).toBe('Handler crashed');

    // No applied event should be emitted
    expect(result.diagnostics.some(d => d.type === 'extension:agent-context:applied')).toBe(false);
  });

  it('continues with next hook after one throws', async () => {
    const result = await executeAgentRunHooks(
      [
        makeHook('error-ext', () => { throw new Error('First fails'); }),
        makeHook('good-ext', () => ({ promptAppend: 'Second succeeds.' })),
      ],
      BASE_OPTIONS,
      'builder',
      undefined,
      RUNTIME_OPTIONS,
    );

    // Second hook's content must appear
    expect(result.finalPrompt).toContain('Second succeeds.');

    // Diagnostics must include failed for first and applied for second
    expect(result.diagnostics.some(d => d.type === 'extension:agent-context:failed')).toBe(true);
    expect(result.diagnostics.some(d => d.type === 'extension:agent-context:applied')).toBe(true);
  });

  it('failed event does not include prompt fragment text', async () => {
    const sensitivePrompt = 'SENSITIVE_CONTENT_DO_NOT_LEAK';
    const opts: AgentRunOptions = { ...BASE_OPTIONS, prompt: sensitivePrompt };

    const result = await executeAgentRunHooks(
      [makeHook('error-ext', () => { throw new Error('Fail'); })],
      opts,
      'builder',
      undefined,
      RUNTIME_OPTIONS,
    );

    const eventStr = JSON.stringify(result.diagnostics);
    expect(eventStr).not.toContain(sensitivePrompt);
  });
});

// ---------------------------------------------------------------------------
// executeAgentRunHooks — fail-open on timeout
// ---------------------------------------------------------------------------

describe('executeAgentRunHooks — fail-open on timeout', () => {
  it('emits timeout diagnostic and does not modify prompt when handler exceeds timeoutMs', async () => {
    const VERY_SHORT_TIMEOUT_MS = 50;

    const result = await executeAgentRunHooks(
      [makeHook('slow-ext', () => new Promise(() => { /* never resolves */ }))],
      BASE_OPTIONS,
      'builder',
      undefined,
      { ...RUNTIME_OPTIONS, timeoutMs: VERY_SHORT_TIMEOUT_MS },
    );

    // Prompt must be unmodified
    expect(result.finalPrompt).toBe(BASE_OPTIONS.prompt);

    // Must emit exactly one timeout diagnostic
    const timeouts = result.diagnostics.filter(d => d.type === 'extension:agent-context:timeout');
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]!.extensionName).toBe('slow-ext');
    expect(timeouts[0]!.timeoutMs).toBe(VERY_SHORT_TIMEOUT_MS);

    // No applied event
    expect(result.diagnostics.some(d => d.type === 'extension:agent-context:applied')).toBe(false);
  }, 3000);

  it('timeout event does not include prompt text', async () => {
    const sensitivePrompt = 'TIMEOUT_SENSITIVE_CONTENT';
    const opts: AgentRunOptions = { ...BASE_OPTIONS, prompt: sensitivePrompt };

    const result = await executeAgentRunHooks(
      [makeHook('slow-ext', () => new Promise(() => { /* never resolves */ }))],
      opts,
      'builder',
      undefined,
      { ...RUNTIME_OPTIONS, timeoutMs: 50 },
    );

    const eventStr = JSON.stringify(result.diagnostics);
    expect(eventStr).not.toContain(sensitivePrompt);
  }, 3000);
});

// ---------------------------------------------------------------------------
// executeAgentRunHooks — unsupported-field diagnostic
// ---------------------------------------------------------------------------

describe('executeAgentRunHooks — unsupported tool fields', () => {
  it('emits unsupported diagnostic when handler returns tools', async () => {
    const result = await executeAgentRunHooks(
      [makeHook('tool-ext', () => ({ tools: [{ name: 'my-tool' }] } as unknown as AgentRunAugmentation))],
      BASE_OPTIONS,
      'builder',
      undefined,
      RUNTIME_OPTIONS,
    );

    const unsupported = result.diagnostics.filter(d => d.type === 'extension:agent-context:unsupported');
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]!.fields).toContain('tools');
  });

  it('emits unsupported diagnostic when handler returns allowedTools', async () => {
    const result = await executeAgentRunHooks(
      [makeHook('tool-ext', () => ({ allowedTools: ['bash'] } as unknown as AgentRunAugmentation))],
      BASE_OPTIONS,
      'builder',
      undefined,
      RUNTIME_OPTIONS,
    );

    const unsupported = result.diagnostics.filter(d => d.type === 'extension:agent-context:unsupported');
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]!.fields).toContain('allowedTools');
  });

  it('emits unsupported diagnostic when handler returns disallowedTools', async () => {
    const result = await executeAgentRunHooks(
      [makeHook('tool-ext', () => ({ disallowedTools: ['bash'] } as unknown as AgentRunAugmentation))],
      BASE_OPTIONS,
      'builder',
      undefined,
      RUNTIME_OPTIONS,
    );

    const unsupported = result.diagnostics.filter(d => d.type === 'extension:agent-context:unsupported');
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]!.fields).toContain('disallowedTools');
  });

  it('emits unsupported diagnostic alongside applied when both promptAppend and tools are returned', async () => {
    const result = await executeAgentRunHooks(
      [makeHook('mixed-ext', () => ({
        promptAppend: 'Valid context.',
        tools: [{ name: 'my-tool' }],
      } as unknown as AgentRunAugmentation))],
      BASE_OPTIONS,
      'builder',
      undefined,
      RUNTIME_OPTIONS,
    );

    // Prompt IS augmented (promptAppend is applied)
    expect(result.finalPrompt).toContain('Valid context.');

    // Both applied and unsupported diagnostics emitted
    expect(result.diagnostics.some(d => d.type === 'extension:agent-context:applied')).toBe(true);
    expect(result.diagnostics.some(d => d.type === 'extension:agent-context:unsupported')).toBe(true);
  });

  it('does not mutate allowedTools or disallowedTools on options', async () => {
    const opts: AgentRunOptions = {
      ...BASE_OPTIONS,
      allowedTools: ['read'],
      disallowedTools: [],
    };
    const originalAllowed = [...(opts.allowedTools ?? [])];
    const originalDisallowed = [...(opts.disallowedTools ?? [])];

    await executeAgentRunHooks(
      [makeHook('tool-ext', () => ({
        allowedTools: ['bash', 'write'],
        disallowedTools: ['read'],
      } as unknown as AgentRunAugmentation))],
      opts,
      'builder',
      undefined,
      RUNTIME_OPTIONS,
    );

    expect(opts.allowedTools).toEqual(originalAllowed);
    expect(opts.disallowedTools).toEqual(originalDisallowed);
  });
});

// ---------------------------------------------------------------------------
// executeAgentRunHooks — promptAppend coexistence with config promptAppend
// ---------------------------------------------------------------------------

describe('executeAgentRunHooks — coexistence with resolved promptAppend', () => {
  it('extension provenance section appears after the base prompt (which already includes config promptAppend)', async () => {
    // Simulate: base prompt already includes resolved config promptAppend
    const baseWithConfigAppend = 'Original task.\n\n## Additional instructions\n\nConfig-appended content.';
    const opts: AgentRunOptions = { ...BASE_OPTIONS, prompt: baseWithConfigAppend };

    const result = await executeAgentRunHooks(
      [makeHook('my-ext', () => ({ promptAppend: 'Extension context.' }))],
      opts,
      'builder',
      undefined,
      RUNTIME_OPTIONS,
    );

    // Config append must appear before the extension provenance section
    const configIndex = result.finalPrompt.indexOf('Config-appended content.');
    const extensionSectionIndex = result.finalPrompt.indexOf('## Native extension context');
    expect(configIndex).toBeLessThan(extensionSectionIndex);
    expect(result.finalPrompt).toContain('Extension context.');
  });
});

// ---------------------------------------------------------------------------
// withAgentContextHooks — registry decorator
// ---------------------------------------------------------------------------

describe('withAgentContextHooks — registry decorator', () => {
  it('returns original registry unchanged when no hooks are registered', () => {
    const stub = new StubHarness([]);
    const innerRegistry = singletonRegistry(stub);
    const extRegistry = makeRegistry([]);

    const decorated = withAgentContextHooks(innerRegistry, {
      extensionRegistry: extRegistry as Pick<NativeExtensionRegistry, 'agentRunHooks'>,
      profileName: 'default',
      cwd: '/tmp',
      timeoutMs: 1000,
    });

    // Fast path: same registry reference returned
    expect(decorated).toBe(innerRegistry);
  });

  it('returns a wrapped registry when hooks are registered', () => {
    const stub = new StubHarness([]);
    const innerRegistry = singletonRegistry(stub);
    const extRegistry = makeRegistry([
      makeHook('my-ext', () => ({ promptAppend: 'X' })),
    ]);

    const decorated = withAgentContextHooks(innerRegistry, {
      extensionRegistry: extRegistry as Pick<NativeExtensionRegistry, 'agentRunHooks'>,
      profileName: 'default',
      cwd: '/tmp',
      timeoutMs: 1000,
    });

    // Wrapped registry is a different object
    expect(decorated).not.toBe(innerRegistry);
  });

  it('decorator appends extension context to prompt seen by inner harness', async () => {
    const stub = new StubHarness([{ text: 'Done.' }]);
    const innerRegistry = singletonRegistry(stub);
    const extRegistry = makeRegistry([
      makeHook('ctx-ext', () => ({ promptAppend: 'Extension content added here.' })),
    ]);

    const decorated = withAgentContextHooks(innerRegistry, {
      extensionRegistry: extRegistry as Pick<NativeExtensionRegistry, 'agentRunHooks'>,
      profileName: 'default',
      cwd: '/tmp',
      timeoutMs: 1000,
    });

    const harness = decorated.forRole('builder');
    await collectEvents(harness.run(
      { prompt: 'Original prompt.', cwd: '/tmp', maxTurns: 1, tools: 'none' },
      'builder',
    ));

    // Inner stub must have received the augmented prompt
    expect(stub.prompts).toHaveLength(1);
    expect(stub.prompts[0]).toContain('Original prompt.');
    expect(stub.prompts[0]).toContain('## Native extension context');
    expect(stub.prompts[0]).toContain('### ctx-ext');
    expect(stub.prompts[0]).toContain('Extension content added here.');
  });

  it('decorator emits extension:agent-context:applied event in stream', async () => {
    const stub = new StubHarness([{ text: 'Done.' }]);
    const innerRegistry = singletonRegistry(stub);
    const extRegistry = makeRegistry([
      makeHook('stream-ext', () => ({ promptAppend: 'Context text.' })),
    ]);

    const decorated = withAgentContextHooks(innerRegistry, {
      extensionRegistry: extRegistry as Pick<NativeExtensionRegistry, 'agentRunHooks'>,
      profileName: 'default',
      cwd: '/tmp',
      timeoutMs: 1000,
    });

    const harness = decorated.forRole('builder');
    const events = await collectEvents(harness.run(
      { prompt: 'Test prompt.', cwd: '/tmp', maxTurns: 1, tools: 'none' },
      'builder',
      'plan-wiring-01',
    ));

    const applied = filterEvents(events, 'extension:agent-context:applied');
    expect(applied).toHaveLength(1);
    expect(applied[0]!.extensionName).toBe('stream-ext');
    expect(applied[0]!.planId).toBe('plan-wiring-01');
  });

  it('emits diagnostics BEFORE inner harness events', async () => {
    const stub = new StubHarness([{ text: 'Done.' }]);
    const innerRegistry = singletonRegistry(stub);
    const extRegistry = makeRegistry([
      makeHook('ordering-ext', () => ({ promptAppend: 'X.' })),
    ]);

    const decorated = withAgentContextHooks(innerRegistry, {
      extensionRegistry: extRegistry as Pick<NativeExtensionRegistry, 'agentRunHooks'>,
      profileName: 'default',
      cwd: '/tmp',
      timeoutMs: 1000,
    });

    const harness = decorated.forRole('builder');
    const events = await collectEvents(harness.run(
      { prompt: 'Test.', cwd: '/tmp', maxTurns: 1, tools: 'none' },
      'builder',
    ));

    const appliedIndex = events.findIndex(e => e.type === 'extension:agent-context:applied');
    const agentStartIndex = events.findIndex(e => e.type === 'agent:start');
    expect(appliedIndex).toBeGreaterThanOrEqual(0);
    expect(agentStartIndex).toBeGreaterThanOrEqual(0);
    expect(appliedIndex).toBeLessThan(agentStartIndex);
  });

  it('options fields allowedTools/disallowedTools/customTools are not mutated by decorator', async () => {
    const stub = new StubHarness([{ text: 'Done.' }]);
    const innerRegistry = singletonRegistry(stub);
    const extRegistry = makeRegistry([
      makeHook('mutate-check-ext', () => ({
        allowedTools: ['bash'],
        disallowedTools: ['write'],
      } as unknown as AgentRunAugmentation)),
    ]);

    const decorated = withAgentContextHooks(innerRegistry, {
      extensionRegistry: extRegistry as Pick<NativeExtensionRegistry, 'agentRunHooks'>,
      profileName: 'default',
      cwd: '/tmp',
      timeoutMs: 1000,
    });

    const originalOpts: AgentRunOptions = {
      prompt: 'Test.',
      cwd: '/tmp',
      maxTurns: 1,
      tools: 'none',
      allowedTools: ['read'],
      disallowedTools: [],
    };

    const harness = decorated.forRole('builder');
    await collectEvents(harness.run(originalOpts, 'builder'));

    // allowedTools and disallowedTools on the original options must be unchanged
    expect(stub.calls[0]!.allowedTools).toEqual(['read']);
    expect(stub.calls[0]!.disallowedTools).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Event content safety: no prompt text in events
// ---------------------------------------------------------------------------

describe('event content safety — no prompt text in diagnostic events', () => {
  it('applied event does not contain the fragment text or the base prompt', async () => {
    const fragmentText = 'UNIQUE_FRAGMENT_XYZ_123';
    const basePromptText = 'UNIQUE_BASE_PROMPT_ABC';

    const result = await executeAgentRunHooks(
      [makeHook('safety-ext', () => ({ promptAppend: fragmentText }))],
      { ...BASE_OPTIONS, prompt: basePromptText },
      'builder',
      undefined,
      RUNTIME_OPTIONS,
    );

    for (const event of result.diagnostics) {
      const eventStr = JSON.stringify(event);
      expect(eventStr).not.toContain(fragmentText);
      expect(eventStr).not.toContain(basePromptText);
    }
  });
});
