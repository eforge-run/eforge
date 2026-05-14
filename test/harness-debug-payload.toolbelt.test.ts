/**
 * Tests that toolbelt observability fields flow correctly through:
 * 1. buildAgentStartEvent — agent:start events carry toolbelt summary fields when options carry them
 * 2. ClaudeSDKHarness debug payload — projectMcpServerNames and internalMcpServerNames are
 *    distinct fields; the old single mcpServerNames field is gone
 *
 * Note: Testing the debug payload from ClaudeSDKHarness.run() requires the onDebugPayload
 * callback which fires just before the SDK call. A pre-aborted AbortController prevents
 * the actual network call while still triggering the debug capture path.
 */

import { describe, it, expect } from 'vitest';
import { buildAgentStartEvent } from '@eforge-build/engine/harnesses/common';
import { ClaudeSDKHarness } from '@eforge-build/engine/harnesses/claude-sdk';
import type { HarnessDebugPayload } from '@eforge-build/engine/harness';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// buildAgentStartEvent — toolbelt fields on agent:start
// ---------------------------------------------------------------------------

describe('buildAgentStartEvent — toolbelt observability fields', () => {
  const baseOpts = {
    agentId: 'agent-1',
    agent: 'builder' as const,
    model: 'claude-sonnet-4-6',
    harness: 'claude-sdk' as const,
    harnessSource: 'tier' as const,
    tier: 'implementation',
    tierSource: 'tier' as const,
  };

  it('omits toolbelt fields when not provided', () => {
    const event = buildAgentStartEvent(baseOpts);

    expect('toolbelt' in event).toBe(false);
    expect('toolbeltSource' in event).toBe(false);
    expect('projectMcpSelection' in event).toBe(false);
    expect('projectMcpServerNames' in event).toBe(false);
  });

  it('includes all four toolbelt fields when toolbeltSource is default (omitted toolbelt)', () => {
    const event = buildAgentStartEvent({
      ...baseOpts,
      toolbeltSource: 'default',
      projectMcpSelection: 'all',
      projectMcpServerNames: ['figma', 'playwright', 'stripe'],
    });

    expect('toolbelt' in event).toBe(false); // toolbelt is undefined → omitted
    expect(event.toolbeltSource).toBe('default');
    expect(event.projectMcpSelection).toBe('all');
    expect(event.projectMcpServerNames).toEqual(['figma', 'playwright', 'stripe']);
  });

  it('includes toolbelt: null when toolbelt is none', () => {
    const event = buildAgentStartEvent({
      ...baseOpts,
      toolbelt: null,
      toolbeltSource: 'tier',
      projectMcpSelection: 'none',
      projectMcpServerNames: [],
    });

    expect(event.toolbelt).toBeNull();
    expect(event.toolbeltSource).toBe('tier');
    expect(event.projectMcpSelection).toBe('none');
    expect(event.projectMcpServerNames).toEqual([]);
  });

  it('includes toolbelt name when a named toolbelt is active', () => {
    const event = buildAgentStartEvent({
      ...baseOpts,
      toolbelt: 'browser-ui',
      toolbeltSource: 'tier',
      projectMcpSelection: 'toolbelt',
      projectMcpServerNames: ['playwright'],
    });

    expect(event.toolbelt).toBe('browser-ui');
    expect(event.toolbeltSource).toBe('tier');
    expect(event.projectMcpSelection).toBe('toolbelt');
    expect(event.projectMcpServerNames).toEqual(['playwright']);
  });

  it('does not emit toolbelt key when toolbelt is explicitly undefined', () => {
    const event = buildAgentStartEvent({
      ...baseOpts,
      toolbelt: undefined,
      toolbeltSource: 'default',
      projectMcpSelection: 'all',
      projectMcpServerNames: [],
    });

    // toolbelt: undefined → omitted (the "only include when defined" pattern)
    expect('toolbelt' in event).toBe(false);
    expect(event.toolbeltSource).toBe('default');
  });
});

// ---------------------------------------------------------------------------
// ClaudeSDKHarness debug payload — projectMcpServerNames and internalMcpServerNames
// ---------------------------------------------------------------------------

describe('ClaudeSDKHarness debug payload — restructured MCP server fields', () => {
  /**
   * Capture the debug payload from ClaudeSDKHarness.run() without triggering
   * a real SDK network call. Strategy:
   *  1. Fire a pre-aborted AbortController signal.
   *  2. The onDebugPayload callback fires before sdkQuery is called.
   *  3. After sdkQuery receives the aborted controller, it will throw quickly.
   *  4. We collect the captured payload from the callback.
   */
  async function captureDebugPayload(
    mcpServers: Record<string, McpServerConfig>,
    customToolCount = 0,
  ): Promise<HarnessDebugPayload | null> {
    const controller = new AbortController();
    controller.abort('test-abort'); // pre-abort to prevent real network call

    let captured: HarnessDebugPayload | null = null;
    const harness = new ClaudeSDKHarness({
      mcpServers,
      onDebugPayload: (payload) => {
        captured = payload;
      },
      bare: true,
    });

    const customTools = customToolCount > 0 ? Array.from({ length: customToolCount }, (_, i) => ({
      name: `submit_tool_${i}`,
      description: 'test tool',
      inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
      handler: async () => 'ok',
    })) : undefined;

    const gen = harness.run(
      {
        prompt: 'test prompt',
        cwd: '/tmp',
        maxTurns: 1,
        tools: 'coding',
        abortSignal: controller.signal,
        tier: 'implementation',
        tierSource: 'tier',
        harness: 'claude-sdk',
        harnessSource: 'tier',
        effort: 'medium',
        effortSource: 'tier',
        ...(customTools ? { customTools } : {}),
      },
      'builder',
      'plan-01',
    );

    // Drain the generator — it will throw due to abort but the debug payload was
    // already captured synchronously/asynchronously before the SDK call.
    try {
      for await (const _ of gen) {
        // Just drain events; we care about the captured payload
      }
    } catch {
      // Expected — abort causes the SDK call to fail
    }

    return captured;
  }

  it('extra contains projectMcpServerNames (not mcpServerNames) for project MCP servers', async () => {
    const mcpServers = {
      playwright: { type: 'stdio', command: 'playwright' } as McpServerConfig,
      figma: { type: 'stdio', command: 'figma' } as McpServerConfig,
    };

    const payload = await captureDebugPayload(mcpServers);

    // onDebugPayload is invoked synchronously inside the generator's try block
    // before sdkQuery is called, so the abort-controller cannot race past it.
    // Assert non-null so a regression in that ordering surfaces as a failure
    // rather than a silent pass.
    expect(payload).not.toBeNull();

    expect(payload!.extra).toBeDefined();
    // New field: projectMcpServerNames (sorted, project-only)
    expect(payload!.extra!['projectMcpServerNames']).toBeDefined();
    expect(Array.isArray(payload!.extra!['projectMcpServerNames'])).toBe(true);
    // Old field: mcpServerNames must be gone (replaced by the two distinct fields)
    expect(payload!.extra!['mcpServerNames']).toBeUndefined();
    // New field: internalMcpServerNames (engine-internal servers like eforge_engine)
    expect(payload!.extra!['internalMcpServerNames']).toBeDefined();
    expect(Array.isArray(payload!.extra!['internalMcpServerNames'])).toBe(true);
  });

  it('projectMcpServerNames contains only the project servers (sorted)', async () => {
    const mcpServers = {
      playwright: { type: 'stdio', command: 'playwright' } as McpServerConfig,
      figma: { type: 'stdio', command: 'figma' } as McpServerConfig,
    };

    const payload = await captureDebugPayload(mcpServers);
    expect(payload).not.toBeNull();

    const projectNames = payload!.extra!['projectMcpServerNames'] as string[];
    expect(projectNames).toEqual(['figma', 'playwright']); // sorted
  });

  it('internalMcpServerNames is empty when no custom tools are provided', async () => {
    const mcpServers = {
      playwright: { type: 'stdio', command: 'playwright' } as McpServerConfig,
    };

    const payload = await captureDebugPayload(mcpServers, 0);
    expect(payload).not.toBeNull();

    const internalNames = payload!.extra!['internalMcpServerNames'] as string[];
    expect(internalNames).toEqual([]);
  });

  it('internalMcpServerNames contains eforge_engine when custom tools are provided', async () => {
    const payload = await captureDebugPayload({}, 1); // 1 custom tool → eforge_engine server
    expect(payload).not.toBeNull();

    const internalNames = payload!.extra!['internalMcpServerNames'] as string[];
    expect(internalNames).toEqual(['eforge_engine']);
  });

  it('projectMcpServerNames is empty when no project MCP servers are configured', async () => {
    const payload = await captureDebugPayload({}); // no project servers
    expect(payload).not.toBeNull();

    const projectNames = payload!.extra!['projectMcpServerNames'] as string[];
    expect(projectNames).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// agent:start — toolbelt fields flow from AgentRunOptions through harness
// ---------------------------------------------------------------------------

describe('agent:start event carries toolbelt fields from run options', () => {
  it('agent:start includes toolbelt summary fields when set on options', async () => {
    // Use StubHarness-style direct testing of buildAgentStartEvent rather than
    // running a full harness (which would require the Claude SDK or Pi SDK).
    // The harness implementations delegate directly to buildAgentStartEvent,
    // so this tests the full data path.
    const event = buildAgentStartEvent({
      planId: 'plan-01',
      agentId: 'agent-1',
      agent: 'evaluator',
      model: 'claude-opus-4-7',
      harness: 'claude-sdk',
      harnessSource: 'tier',
      tier: 'evaluation',
      tierSource: 'tier',
      effort: 'high',
      effortSource: 'tier',
      toolbelt: 'browser-ui',
      toolbeltSource: 'tier',
      projectMcpSelection: 'toolbelt',
      projectMcpServerNames: ['playwright'],
    });

    expect(event.type).toBe('agent:start');
    expect(event.toolbelt).toBe('browser-ui');
    expect(event.toolbeltSource).toBe('tier');
    expect(event.projectMcpSelection).toBe('toolbelt');
    expect(event.projectMcpServerNames).toEqual(['playwright']);
  });

  it('agent:start includes projectMcpSelection=all when toolbelt is omitted (default)', () => {
    const event = buildAgentStartEvent({
      agentId: 'agent-2',
      agent: 'builder',
      model: 'claude-sonnet-4-6',
      harness: 'claude-sdk',
      harnessSource: 'tier',
      tier: 'implementation',
      tierSource: 'tier',
      toolbeltSource: 'default',
      projectMcpSelection: 'all',
      projectMcpServerNames: ['figma', 'playwright'],
    });

    expect('toolbelt' in event).toBe(false);
    expect(event.toolbeltSource).toBe('default');
    expect(event.projectMcpSelection).toBe('all');
    expect(event.projectMcpServerNames).toEqual(['figma', 'playwright']);
  });

  it('agent:start includes toolbelt=null and projectMcpSelection=none when toolbelt is none', () => {
    const event = buildAgentStartEvent({
      agentId: 'agent-3',
      agent: 'reviewer',
      model: 'claude-opus-4-7',
      harness: 'claude-sdk',
      harnessSource: 'tier',
      tier: 'review',
      tierSource: 'tier',
      toolbelt: null,
      toolbeltSource: 'tier',
      projectMcpSelection: 'none',
      projectMcpServerNames: [],
    });

    expect(event.toolbelt).toBeNull();
    expect(event.toolbeltSource).toBe('tier');
    expect(event.projectMcpSelection).toBe('none');
    expect(event.projectMcpServerNames).toEqual([]);
  });
});
