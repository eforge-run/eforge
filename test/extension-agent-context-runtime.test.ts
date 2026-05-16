/**
 * Tests for agent-context-runtime.ts.
 *
 * Covers:
 *   - Prompt composition with provenance section
 *   - Ordering across multiple extensions
 *   - Role/tier/phase filtering inside handlers
 *   - Fail-open on handler throw
 *   - Fail-open on timeout
 *   - Tool and availability augmentation
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
import type { AgentRunOptions, CustomTool } from '@eforge-build/engine/harness';
import { Type, type AgentRunContext, type AgentRunAugmentation } from '@eforge-build/extension-sdk';
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

function makeRegistry(agentRunHooks: AgentRunRegistration[]): Pick<NativeExtensionRegistry, 'agentRunHooks' | 'tools'> {
  return { agentRunHooks, tools: [] };
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

    // No applied event should be emitted, and failed hooks contribute no tools or availability.
    expect(result.diagnostics.some(d => d.type === 'extension:agent-context:applied')).toBe(false);
    expect(result.diagnostics.some(d => d.type === 'extension:agent-tools:applied')).toBe(false);
    expect(result.customTools).toBeUndefined();
    expect(result.allowedTools).toBeUndefined();
    expect(result.disallowedTools).toBeUndefined();
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

    // No applied event, and timed-out hooks contribute no tools or availability.
    expect(result.diagnostics.some(d => d.type === 'extension:agent-context:applied')).toBe(false);
    expect(result.diagnostics.some(d => d.type === 'extension:agent-tools:applied')).toBe(false);
    expect(result.customTools).toBeUndefined();
    expect(result.allowedTools).toBeUndefined();
    expect(result.disallowedTools).toBeUndefined();
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
// executeAgentRunHooks — tool and availability augmentation
// ---------------------------------------------------------------------------

describe('executeAgentRunHooks — tool and availability augmentation', () => {
  const makeTool = (name: string, handler: (input: unknown) => string | Promise<string> = () => 'ok') => ({
    name,
    description: `${name} tool`,
    inputSchema: Type.Object({}),
    handler,
  });

  it('injects returned extension tools and emits extension:agent-tools:applied', async () => {
    const result = await executeAgentRunHooks(
      [makeHook('tool-ext', () => ({ tools: [makeTool('inspect_context')] }))],
      BASE_OPTIONS,
      'builder',
      'plan-01',
      { ...RUNTIME_OPTIONS, effectiveCustomToolName: name => `mcp__eforge_engine__${name}` },
    );

    expect(result.customTools?.map(t => t.name)).toEqual(['inspect_context']);
    const events = result.diagnostics.filter(d => d.type === 'extension:agent-tools:applied');
    expect(events).toHaveLength(1);
    expect(events[0]!.toolNames).toEqual(['inspect_context']);
    expect(events[0]!.effectiveToolNames).toEqual(['mcp__eforge_engine__inspect_context']);
    expect(events[0]!.toolCount).toBe(1);
    expect(result.diagnostics.some(d => d.type === 'extension:agent-context:unsupported')).toBe(false);
  });

  it('keeps existing custom tools first and excludes duplicate extension names', async () => {
    const existingTool: CustomTool = {
      name: 'existing_tool',
      description: 'existing',
      inputSchema: Type.Object({}),
      handler: async () => 'existing',
    };
    const result = await executeAgentRunHooks(
      [makeHook('tool-ext', () => ({ tools: [makeTool('existing_tool'), makeTool('fresh_tool'), makeTool('fresh_tool')] }))],
      { ...BASE_OPTIONS, customTools: [existingTool] },
      'builder',
      undefined,
      RUNTIME_OPTIONS,
    );

    expect(result.customTools?.map(t => t.name)).toEqual(['existing_tool', 'fresh_tool']);
    const event = result.diagnostics.find(d => d.type === 'extension:agent-tools:applied');
    expect(event?.excludedToolNames).toEqual(['existing_tool', 'fresh_tool']);
  });

  it('excludes duplicate extension tool names across different extensions', async () => {
    const result = await executeAgentRunHooks(
      [
        makeHook('first-ext', () => ({ tools: [makeTool('shared_tool')] })),
        makeHook('second-ext', () => ({ tools: [makeTool('shared_tool'), makeTool('second_tool')] })),
      ],
      BASE_OPTIONS,
      'builder',
      undefined,
      RUNTIME_OPTIONS,
    );

    expect(result.customTools?.map(t => t.name)).toEqual(['shared_tool', 'second_tool']);
    const toolEvents = result.diagnostics.filter(d => d.type === 'extension:agent-tools:applied');
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0]).toMatchObject({
      extensionName: 'first-ext',
      toolNames: ['shared_tool'],
      excludedToolNames: [],
    });
    expect(toolEvents[1]).toMatchObject({
      extensionName: 'second-ext',
      toolNames: ['second_tool'],
      excludedToolNames: ['shared_tool'],
    });
  });

  it('merges allowlists with harness-effective custom tool names', async () => {
    const existingTool: CustomTool = {
      name: 'engine_tool',
      description: 'engine',
      inputSchema: Type.Object({}),
      handler: async () => 'engine',
    };
    const result = await executeAgentRunHooks(
      [makeHook('tool-ext', () => ({
        tools: [makeTool('extension_tool')],
        allowedTools: ['Read'],
      }))],
      { ...BASE_OPTIONS, allowedTools: ['Bash'], customTools: [existingTool] },
      'builder',
      undefined,
      { ...RUNTIME_OPTIONS, effectiveCustomToolName: name => `mcp__eforge_engine__${name}` },
    );

    expect(result.allowedTools).toEqual([
      'Bash',
      'Read',
      'mcp__eforge_engine__engine_tool',
      'mcp__eforge_engine__extension_tool',
    ]);
  });

  it('adds accepted extension tools to an existing allowlist without extension allowlist entries', async () => {
    const result = await executeAgentRunHooks(
      [makeHook('tool-ext', () => ({
        tools: [makeTool('extension_tool')],
      }))],
      { ...BASE_OPTIONS, allowedTools: ['Bash'] },
      'builder',
      undefined,
      { ...RUNTIME_OPTIONS, effectiveCustomToolName: name => `mcp__eforge_engine__${name}` },
    );

    expect(result.allowedTools).toEqual([
      'Bash',
      'mcp__eforge_engine__extension_tool',
    ]);
  });

  it('emits tool event for availability-only contributions without unsupported diagnostics', async () => {
    const result = await executeAgentRunHooks(
      [makeHook('availability-ext', () => ({
        allowedTools: ['Read'],
        disallowedTools: ['Write'],
      }))],
      BASE_OPTIONS,
      'builder',
      undefined,
      RUNTIME_OPTIONS,
    );

    expect(result.customTools).toBeUndefined();
    expect(result.allowedTools).toEqual(['Read']);
    expect(result.disallowedTools).toEqual(['Write']);
    const event = result.diagnostics.find(d => d.type === 'extension:agent-tools:applied');
    expect(event?.toolNames).toEqual([]);
    expect(event?.allowedToolsAdded).toEqual(['Read']);
    expect(event?.disallowedToolsAdded).toEqual(['Write']);
    expect(result.diagnostics.some(d => d.type === 'extension:agent-context:unsupported')).toBe(false);
  });

  it('removes denied names from the final allowlist when allow and deny contributions conflict', async () => {
    const result = await executeAgentRunHooks(
      [makeHook('availability-ext', () => ({
        allowedTools: ['Read', 'Write'],
        disallowedTools: ['Write'],
      }))],
      { ...BASE_OPTIONS, allowedTools: ['Bash'] },
      'builder',
      undefined,
      RUNTIME_OPTIONS,
    );

    expect(result.allowedTools).toEqual(['Bash', 'Read']);
    expect(result.disallowedTools).toEqual(['Write']);
  });

  it('records tool provenance, effective names, and project MCP metadata in tool events', async () => {
    let visibleName = '';
    const registeredTool = makeTool('registered_tool');
    const result = await executeAgentRunHooks(
      [makeHook('tool-ext', (ctx) => {
        visibleName = ctx.effectiveToolName('registered_tool');
        return {
          tools: [registeredTool, makeTool('inline_tool')],
          allowedTools: ['Read'],
          disallowedTools: ['Write'],
        };
      })],
      {
        ...BASE_OPTIONS,
        tier: 'implementation',
        phase: 'build',
        stage: 'implement',
        harness: 'claude-sdk',
        toolbelt: 'default',
        projectMcpSelection: 'toolbelt',
        projectMcpServerNames: ['filesystem', 'github'],
      },
      'builder',
      'plan-01',
      {
        ...RUNTIME_OPTIONS,
        effectiveCustomToolName: name => `mcp__eforge_engine__${name}`,
        registeredTools: [{
          kind: 'tool',
          extensionName: 'tool-ext',
          extensionPath: '/extensions/tool-ext.js',
          name: 'registered_tool',
          value: registeredTool as never,
        }],
      },
    );

    expect(visibleName).toBe('mcp__eforge_engine__registered_tool');
    const event = result.diagnostics.find(d => d.type === 'extension:agent-tools:applied');
    expect(event).toMatchObject({
      extensionName: 'tool-ext',
      role: 'builder',
      planId: 'plan-01',
      tier: 'implementation',
      phase: 'build',
      stage: 'implement',
      profile: 'default',
      harness: 'claude-sdk',
      toolbelt: 'default',
      projectMcpSelection: 'toolbelt',
      projectMcpServerNames: ['filesystem', 'github'],
      toolNames: ['registered_tool', 'inline_tool'],
      effectiveToolNames: ['mcp__eforge_engine__registered_tool', 'mcp__eforge_engine__inline_tool'],
      registeredToolNames: ['registered_tool'],
      inlineToolNames: ['inline_tool'],
      allowedToolsAdded: ['Read'],
      disallowedToolsAdded: ['Write'],
      toolCount: 2,
      allowedToolCount: 1,
      disallowedToolCount: 1,
      excludedToolCount: 0,
    });
  });

  it('applies deny-wins and excludes disallowed returned tools', async () => {
    const result = await executeAgentRunHooks(
      [makeHook('tool-ext', () => ({
        tools: [makeTool('blocked_tool'), makeTool('allowed_tool')],
        disallowedTools: ['blocked_tool'],
      }))],
      BASE_OPTIONS,
      'builder',
      undefined,
      RUNTIME_OPTIONS,
    );

    expect(result.customTools?.map(t => t.name)).toEqual(['allowed_tool']);
    expect(result.disallowedTools).toEqual(['blocked_tool']);
    const event = result.diagnostics.find(d => d.type === 'extension:agent-tools:applied');
    expect(event?.excludedToolNames).toContain('blocked_tool');
  });

  it('applies deny-wins when disallowedTools uses harness-effective names', async () => {
    const result = await executeAgentRunHooks(
      [makeHook('tool-ext', () => ({
        tools: [makeTool('blocked_tool'), makeTool('allowed_tool')],
        disallowedTools: ['mcp__eforge_engine__blocked_tool'],
      }))],
      BASE_OPTIONS,
      'builder',
      undefined,
      { ...RUNTIME_OPTIONS, effectiveCustomToolName: name => `mcp__eforge_engine__${name}` },
    );

    expect(result.customTools?.map(t => t.name)).toEqual(['allowed_tool']);
    expect(result.disallowedTools).toEqual(['mcp__eforge_engine__blocked_tool']);
    const event = result.diagnostics.find(d => d.type === 'extension:agent-tools:applied');
    expect(event).toMatchObject({
      toolNames: ['allowed_tool'],
      effectiveToolNames: ['mcp__eforge_engine__allowed_tool'],
      excludedToolNames: ['blocked_tool'],
    });
  });

  it('skips invalid returned tools without throwing', async () => {
    const result = await executeAgentRunHooks(
      [makeHook('tool-ext', () => ({ tools: [{ name: 'bad_tool' }] } as unknown as AgentRunAugmentation))],
      BASE_OPTIONS,
      'builder',
      undefined,
      RUNTIME_OPTIONS,
    );

    expect(result.customTools).toBeUndefined();
    const event = result.diagnostics.find(d => d.type === 'extension:agent-tools:applied');
    expect(event?.excludedToolNames).toContain('bad_tool');
  });

  it('does not mutate allowedTools, disallowedTools, or customTools on options', async () => {
    const existingTool = makeTool('engine_tool') as unknown as CustomTool;
    const opts: AgentRunOptions = {
      ...BASE_OPTIONS,
      allowedTools: ['read'],
      disallowedTools: [],
      customTools: [existingTool],
    };
    const originalAllowed = [...(opts.allowedTools ?? [])];
    const originalDisallowed = [...(opts.disallowedTools ?? [])];
    const originalCustomTools = [...(opts.customTools ?? [])];

    await executeAgentRunHooks(
      [makeHook('tool-ext', () => ({
        tools: [makeTool('extension_tool')],
        allowedTools: ['bash', 'write'],
        disallowedTools: ['read'],
      }))],
      opts,
      'builder',
      undefined,
      RUNTIME_OPTIONS,
    );

    expect(opts.allowedTools).toEqual(originalAllowed);
    expect(opts.disallowedTools).toEqual(originalDisallowed);
    expect(opts.customTools).toEqual(originalCustomTools);
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
      extensionRegistry: extRegistry as Pick<NativeExtensionRegistry, 'agentRunHooks' | 'tools'>,
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
      extensionRegistry: extRegistry as Pick<NativeExtensionRegistry, 'agentRunHooks' | 'tools'>,
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
      extensionRegistry: extRegistry as Pick<NativeExtensionRegistry, 'agentRunHooks' | 'tools'>,
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
      extensionRegistry: extRegistry as Pick<NativeExtensionRegistry, 'agentRunHooks' | 'tools'>,
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
      extensionRegistry: extRegistry as Pick<NativeExtensionRegistry, 'agentRunHooks' | 'tools'>,
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
      extensionRegistry: extRegistry as Pick<NativeExtensionRegistry, 'agentRunHooks' | 'tools'>,
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

    // Decorator delegates with merged options, but never mutates the original options or arrays.
    expect(stub.calls[0]).not.toBe(originalOpts);
    expect(stub.calls[0]!.allowedTools).toEqual(['read', 'bash']);
    expect(stub.calls[0]!.disallowedTools).toEqual(['write']);
    expect(originalOpts.allowedTools).toEqual(['read']);
    expect(originalOpts.disallowedTools).toEqual([]);
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
