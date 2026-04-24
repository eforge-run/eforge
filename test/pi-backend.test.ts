import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod/v4';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { CustomTool } from '@eforge-build/engine/harness';

const { createAgentSession, createCodingTools, createReadOnlyTools } = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  createCodingTools: vi.fn(),
  createReadOnlyTools: vi.fn(),
}));

vi.mock('@mariozechner/pi-ai', () => ({
  getModel: vi.fn(() => ({
    id: 'gpt-5.4',
    name: 'gpt-5.4',
    api: 'openai-completions',
    provider: 'openai-codex',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 16384,
  })),
}));

vi.mock('@mariozechner/pi-coding-agent', () => ({
  createAgentSession,
  createCodingTools,
  createReadOnlyTools,
  SessionManager: {
    inMemory: vi.fn(() => ({ kind: 'session-manager' })),
  },
  SettingsManager: {
    create: vi.fn(() => ({ kind: 'settings-manager' })),
  },
  ModelRegistry: class {
    private constructor(_authStorage: unknown) {}
    static create(authStorage: unknown) { return new (this as never)(authStorage); }
    async find(_provider: string, _id: string) { return undefined; }
  },
  AuthStorage: {
    create: vi.fn(() => ({
      setRuntimeApiKey: vi.fn(),
    })),
  },
  // Minimal DefaultResourceLoader stub: the PiHarness constructs one with
  // filter overrides to scrub pi-eforge resources, then calls reload(). The
  // overrides are never exercised here because we mock createAgentSession.
  DefaultResourceLoader: class {
    constructor(_options: unknown) {}
    async reload() {}
  },
  discoverAndLoadExtensions: vi.fn(async () => ({ extensions: [] })),
  getAgentDir: vi.fn(() => '/tmp/test-agent-dir'),
}));

import { PiHarness } from '@eforge-build/engine/harnesses/pi';
import type { PiConfig } from '@eforge-build/engine/config';

async function collectEvents<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

const PI_CONFIG: PiConfig = {
  thinkingLevel: 'medium',
  extensions: { autoDiscover: true },
  compaction: { enabled: true, threshold: 100_000 },
  retry: { maxRetries: 3, backoffMs: 1000 },
};

function makeBackend() {
  return new PiHarness({
    mcpServers: {
      eforge: { command: 'npx', args: ['-y', 'eforge', 'mcp-proxy'] } as never,
    },
    bare: true,
    piConfig: PI_CONFIG,
  });
}

function makeMcpTool(name: string, label = name): AgentTool {
  return {
    name,
    label: `MCP: eforge/${label}`,
    description: `${label} tool`,
    parameters: {} as never,
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  };
}

function setMcpTools(backend: PiHarness, tools: AgentTool[]): void {
  (backend as unknown as { mcpBridge: { getTools: () => Promise<AgentTool[]> } }).mcpBridge = {
    getTools: async () => tools,
  };
}

describe('PiHarness MCP tool wiring', () => {
  beforeEach(() => {
    createAgentSession.mockReset();
    createCodingTools.mockReset();
    createReadOnlyTools.mockReset();
    createCodingTools.mockReturnValue([{ name: 'read' }]);
    createReadOnlyTools.mockReturnValue([{ name: 'read' }]);
    createAgentSession.mockImplementation(async () => {
      const listeners = new Set<(event: { type: string; messages?: unknown[] }) => void>();
      const session = {
        subscribe(listener: (event: { type: string; messages?: unknown[] }) => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        getSessionStats() {
          return {
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            cost: 0,
          };
        },
        async prompt(_prompt: string) {
          for (const listener of listeners) {
            listener({ type: 'agent_end', messages: [] });
          }
        },
        abort() {},
        async bindExtensions(_options: unknown) {},
      };
      return { session };
    });
  });

  it('passes bridged MCP tools into createAgentSession as customTools', async () => {
    const backend = makeBackend();
    setMcpTools(backend, [makeMcpTool('mcp_eforge_status', 'status')]);

    await collectEvents(
      backend.run(
        {
          prompt: 'Check status',
          cwd: process.cwd(),
          maxTurns: 1,
          tools: 'coding',
          model: { provider: 'openai-codex', id: 'gpt-5.4' },
        },
        'builder',
      ),
    );

    expect(createAgentSession).toHaveBeenCalledOnce();
    const sessionOptions = createAgentSession.mock.calls[0]?.[0];
    expect(sessionOptions.customTools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'mcp_eforge_status' })]),
    );
  });

  it('applies allowedTools filtering to bridged MCP tools', async () => {
    const backend = makeBackend();
    setMcpTools(backend, [
      makeMcpTool('mcp_eforge_status', 'status'),
      makeMcpTool('mcp_eforge_build', 'build'),
    ]);

    await collectEvents(
      backend.run(
        {
          prompt: 'Check status',
          cwd: process.cwd(),
          maxTurns: 1,
          tools: 'coding',
          model: { provider: 'openai-codex', id: 'gpt-5.4' },
          allowedTools: ['mcp_eforge_status'],
        },
        'builder',
      ),
    );

    expect(createAgentSession).toHaveBeenCalledOnce();
    const sessionOptions = createAgentSession.mock.calls[0]?.[0];
    expect(sessionOptions.customTools).toEqual([
      expect.objectContaining({ name: 'mcp_eforge_status' }),
    ]);
  });

  it('applies disallowedTools filtering to bridged MCP tools', async () => {
    const backend = makeBackend();
    setMcpTools(backend, [
      makeMcpTool('mcp_eforge_status', 'status'),
      makeMcpTool('mcp_eforge_build', 'build'),
    ]);

    await collectEvents(
      backend.run(
        {
          prompt: 'Check status',
          cwd: process.cwd(),
          maxTurns: 1,
          tools: 'coding',
          model: { provider: 'openai-codex', id: 'gpt-5.4' },
          disallowedTools: ['mcp_eforge_build'],
        },
        'builder',
      ),
    );

    expect(createAgentSession).toHaveBeenCalledOnce();
    const sessionOptions = createAgentSession.mock.calls[0]?.[0];
    expect(sessionOptions.customTools).toEqual([
      expect.objectContaining({ name: 'mcp_eforge_status' }),
    ]);
  });

  it('filters built-in tools and bridged MCP tools independently in the same run', async () => {
    createCodingTools.mockReturnValue([
      { name: 'read' },
      { name: 'edit' },
    ]);

    const backend = makeBackend();
    setMcpTools(backend, [
      makeMcpTool('mcp_eforge_status', 'status'),
      makeMcpTool('mcp_eforge_build', 'build'),
    ]);

    await collectEvents(
      backend.run(
        {
          prompt: 'Check status',
          cwd: process.cwd(),
          maxTurns: 1,
          tools: 'coding',
          model: { provider: 'openai-codex', id: 'gpt-5.4' },
          disallowedTools: ['edit', 'mcp_eforge_build'],
        },
        'builder',
      ),
    );

    expect(createAgentSession).toHaveBeenCalledOnce();
    const sessionOptions = createAgentSession.mock.calls[0]?.[0];
    // `tools` is an allowlist that gates customTools too; both the surviving
    // built-in and the surviving bridged MCP tool must appear there.
    expect(sessionOptions.tools).toEqual(['read', 'mcp_eforge_status']);
    expect(sessionOptions.customTools).toEqual([
      expect.objectContaining({ name: 'mcp_eforge_status' }),
    ]);
  });

  it('normalizes usage so input includes cacheRead and cacheWrite', async () => {
    createAgentSession.mockImplementationOnce(async () => {
      const listeners = new Set<(event: { type: string; messages?: unknown[] }) => void>();
      const session = {
        subscribe(listener: (event: { type: string; messages?: unknown[] }) => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        getSessionStats() {
          return {
            tokens: { input: 1000, cacheRead: 5000, cacheWrite: 200, output: 500 },
            cost: 0.5,
          };
        },
        async prompt(_prompt: string) {
          for (const listener of listeners) {
            listener({ type: 'turn_end' });
            listener({ type: 'agent_end', messages: [] });
          }
        },
        abort() {},
        async bindExtensions(_options: unknown) {},
      };
      return { session };
    });

    const backend = makeBackend();
    setMcpTools(backend, []);

    const events = await collectEvents(
      backend.run(
        {
          prompt: 'Check status',
          cwd: process.cwd(),
          maxTurns: 1,
          tools: 'coding',
          model: { provider: 'openai-codex', id: 'gpt-5.4' },
        },
        'builder',
      ),
    );

    const resultEvent = events.find(
      (e): e is Extract<typeof e, { type: 'agent:result' }> =>
        (e as { type: string }).type === 'agent:result',
    );
    expect(resultEvent).toBeDefined();
    const usage = (resultEvent as { result: { usage: { input: number; output: number; total: number; cacheRead: number; cacheCreation: number } } }).result.usage;
    expect(usage.input).toBe(6200);
    expect(usage.cacheRead).toBe(5000);
    expect(usage.cacheCreation).toBe(200);
    expect(usage.total).toBe(6700);
  });

  it('translates bridged MCP tool execution events into Eforge tool events', async () => {
    createAgentSession.mockImplementationOnce(async () => {
      const listeners = new Set<(event: {
        type: string;
        toolName?: string;
        toolCallId?: string;
        args?: unknown;
        result?: unknown;
        messages?: unknown[];
      }) => void>();
      const session = {
        subscribe(
          listener: (event: {
            type: string;
            toolName?: string;
            toolCallId?: string;
            args?: unknown;
            result?: unknown;
            messages?: unknown[];
          }) => void,
        ) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        getSessionStats() {
          return {
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            cost: 0,
          };
        },
        async prompt(_prompt: string) {
          for (const listener of listeners) {
            listener({
              type: 'tool_execution_start',
              toolName: 'mcp_eforge_status',
              toolCallId: 'tool-1',
              args: { verbose: true },
            });
            listener({
              type: 'tool_execution_end',
              toolName: 'mcp_eforge_status',
              toolCallId: 'tool-1',
              result: { ok: true },
            });
            listener({ type: 'agent_end', messages: [] });
          }
        },
        abort() {},
        async bindExtensions(_options: unknown) {},
      };
      return { session };
    });

    const backend = makeBackend();
    setMcpTools(backend, [makeMcpTool('mcp_eforge_status', 'status')]);

    const events = await collectEvents(
      backend.run(
        {
          prompt: 'Check status',
          cwd: process.cwd(),
          maxTurns: 1,
          tools: 'coding',
          model: { provider: 'openai-codex', id: 'gpt-5.4' },
        },
        'builder',
      ),
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent:tool_use',
          tool: 'mcp_eforge_status',
          toolUseId: 'tool-1',
          input: { verbose: true },
        }),
        expect.objectContaining({
          type: 'agent:tool_result',
          tool: 'mcp_eforge_status',
          toolUseId: 'tool-1',
          output: JSON.stringify({ ok: true }),
        }),
      ]),
    );
  });
});

describe('PiHarness custom tool wiring', () => {
  beforeEach(() => {
    createAgentSession.mockReset();
    createCodingTools.mockReset();
    createReadOnlyTools.mockReset();
    createCodingTools.mockReturnValue([{ name: 'read' }]);
    createReadOnlyTools.mockReturnValue([{ name: 'read' }]);
    createAgentSession.mockImplementation(async () => {
      const listeners = new Set<(event: { type: string; messages?: unknown[] }) => void>();
      const session = {
        subscribe(listener: (event: { type: string; messages?: unknown[] }) => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        getSessionStats() {
          return {
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            cost: 0,
          };
        },
        async prompt(_prompt: string) {
          for (const listener of listeners) {
            listener({ type: 'agent_end', messages: [] });
          }
        },
        abort() {},
        async bindExtensions(_options: unknown) {},
      };
      return { session };
    });
  });

  /**
   * Minimal valid plan-set payload: schema-compliant so the handler returns
   * the success text rather than a validation error. Mirrors the shape the
   * Claude SDK / Pi would submit from the planner.
   */
  const validPlanSetInput = {
    name: 'my-plan',
    description: 'A test plan',
    mode: 'excursion' as const,
    baseBranch: 'main',
    plans: [{
      frontmatter: {
        id: 'feature',
        name: 'Add feature',
        dependsOn: [],
        branch: 'feature/add-feature',
      },
      body: '# Implementation\n\nDo the thing.',
    }],
    orchestration: {
      validate: [],
      plans: [{
        id: 'feature',
        name: 'Add feature',
        dependsOn: [],
        branch: 'feature/add-feature',
      }],
    },
  };

  function makeBarePlanSetCustomTool(): CustomTool {
    const inputSchema = z.object({
      name: z.string(),
      description: z.string(),
      mode: z.enum(['errand', 'excursion', 'expedition']),
      baseBranch: z.string(),
      plans: z.array(z.object({
        frontmatter: z.object({
          id: z.string(),
          name: z.string(),
          dependsOn: z.array(z.string()),
          branch: z.string(),
        }),
        body: z.string(),
      })),
      orchestration: z.object({
        validate: z.array(z.string()),
        plans: z.array(z.object({
          id: z.string(),
          name: z.string(),
          dependsOn: z.array(z.string()),
          branch: z.string(),
        })),
      }),
    });
    return {
      name: 'submit_plan_set',
      description: 'Submit a plan set.',
      inputSchema,
      handler: async () => 'Plan set submitted successfully.',
    };
  }

  it('registers bare CustomTool name as a Pi ToolDefinition with arity-5 execute', async () => {
    const backend = makeBackend();
    setMcpTools(backend, []);
    const customTool = makeBarePlanSetCustomTool();

    await collectEvents(
      backend.run(
        {
          prompt: 'Submit a plan',
          cwd: process.cwd(),
          maxTurns: 1,
          tools: 'coding',
          model: { provider: 'openai-codex', id: 'gpt-5.4' },
          customTools: [customTool],
        },
        'planner',
      ),
    );

    expect(createAgentSession).toHaveBeenCalledOnce();
    const sessionOptions = createAgentSession.mock.calls[0]?.[0];
    const registered = (sessionOptions.customTools as Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>)
      .find((t) => t.name === 'submit_plan_set');

    expect(registered).toBeDefined();
    expect(typeof registered!.execute).toBe('function');
    expect(registered!.execute.length).toBe(5);

    const result = (await registered!.execute('call-1', validPlanSetInput, undefined, undefined, undefined)) as {
      content: Array<{ type: string; text: string }>;
      details: Record<string, unknown>;
    };
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe('Plan set submitted successfully.');
  });

  it('effectiveCustomToolName is identity on PiHarness', () => {
    const backend = makeBackend();
    expect(backend.effectiveCustomToolName('submit_plan_set')).toBe('submit_plan_set');
    expect(backend.effectiveCustomToolName('submit_architecture')).toBe('submit_architecture');
  });

  it('keeps bridged MCP tools and planner custom tools separate and filters them independently', async () => {
    const backend = makeBackend();
    setMcpTools(backend, [
      makeMcpTool('mcp_eforge_status', 'status'),
      makeMcpTool('mcp_eforge_build', 'build'),
    ]);
    const customTool = makeBarePlanSetCustomTool();

    await collectEvents(
      backend.run(
        {
          prompt: 'Submit a plan',
          cwd: process.cwd(),
          maxTurns: 1,
          tools: 'coding',
          model: { provider: 'openai-codex', id: 'gpt-5.4' },
          customTools: [customTool],
          // Only block one bridged tool; the planner custom tool must survive
          // because filtering is applied per-source, not across a commingled
          // array.
          disallowedTools: ['mcp_eforge_build'],
        },
        'planner',
      ),
    );

    expect(createAgentSession).toHaveBeenCalledOnce();
    const sessionOptions = createAgentSession.mock.calls[0]?.[0];
    const names = (sessionOptions.customTools as Array<{ name: string }>).map((t) => t.name);

    expect(names).toContain('mcp_eforge_status');
    expect(names).not.toContain('mcp_eforge_build');
    expect(names).toContain('submit_plan_set');

    // The planner custom tool is a distinct object (not merged into the
    // bridged-tools array before being passed to the session).
    const bridged = (sessionOptions.customTools as Array<{ name: string }>).find((t) => t.name === 'mcp_eforge_status');
    const planner = (sessionOptions.customTools as Array<{ name: string }>).find((t) => t.name === 'submit_plan_set');
    expect(bridged).not.toBe(planner);
  });

  it('filters planner custom tools via disallowedTools independently of bridged tools', async () => {
    const backend = makeBackend();
    setMcpTools(backend, [makeMcpTool('mcp_eforge_status', 'status')]);
    const customTool = makeBarePlanSetCustomTool();

    await collectEvents(
      backend.run(
        {
          prompt: 'Submit a plan',
          cwd: process.cwd(),
          maxTurns: 1,
          tools: 'coding',
          model: { provider: 'openai-codex', id: 'gpt-5.4' },
          customTools: [customTool],
          disallowedTools: ['submit_plan_set'],
        },
        'planner',
      ),
    );

    expect(createAgentSession).toHaveBeenCalledOnce();
    const sessionOptions = createAgentSession.mock.calls[0]?.[0];
    const names = (sessionOptions.customTools as Array<{ name: string }>).map((t) => t.name);

    // Planner tool is blocked, bridged tool still passes through.
    expect(names).not.toContain('submit_plan_set');
    expect(names).toContain('mcp_eforge_status');
  });
});

/**
 * End-to-end wiring check: a real `runPlanner` call against a real
 * `PiHarness` (only `createAgentSession` is mocked) must result in
 * `submit_plan_set` being among the `customTools` the Pi session receives.
 *
 * This catches the class of regression where the planner submission tool
 * reaches the CustomTool array but gets stripped before `createAgentSession`
 * - e.g. because of upstream tool filtering, name-mapping drift, or a change
 * to how the planner wires custom tools. The symptom in production is the
 * model claiming `submit_plan_set` "isn't available in this environment"
 * because it genuinely isn't registered on Pi's session.
 */
describe('PiHarness + runPlanner integration: submission tool reaches Pi session', () => {
  beforeEach(() => {
    createAgentSession.mockReset();
    createCodingTools.mockReset();
    createReadOnlyTools.mockReset();
    createCodingTools.mockReturnValue([{ name: 'read' }, { name: 'bash' }, { name: 'write' }]);
    createReadOnlyTools.mockReturnValue([{ name: 'read' }]);
    createAgentSession.mockImplementation(async () => {
      const listeners = new Set<(event: { type: string; messages?: unknown[] }) => void>();
      const session = {
        subscribe(listener: (event: { type: string; messages?: unknown[] }) => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        getSessionStats() {
          return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
        },
        async prompt(_prompt: string) {
          for (const listener of listeners) {
            listener({ type: 'agent_end', messages: [] });
          }
        },
        abort() {},
        async bindExtensions(_options: unknown) {},
        state: { systemPrompt: '', tools: [] },
      };
      return { session };
    });
  });

  it.each([
    ['errand' as const, 'submit_plan_set'],
    ['excursion' as const, 'submit_plan_set'],
    ['expedition' as const, 'submit_architecture'],
  ])('scope=%s registers %s on the Pi session', async (scope, expectedTool) => {
    const { runPlanner } = await import('@eforge-build/engine/agents/planner');
    const { PlannerSubmissionError } = await import('@eforge-build/engine/harness');
    const backend = makeBackend();
    setMcpTools(backend, []);

    // The mocked Pi session emits agent_end without invoking the submission
    // tool, so runPlanner throws PlannerSubmissionError after createAgentSession
    // has already been called. We only care about the session wiring assertions
    // below, so swallow the expected throw while still draining events.
    await expect((async () => {
      for await (const _event of runPlanner('Add a widget feature to the app.', {
        cwd: process.cwd(),
        name: 'widgets',
        auto: true,
        scope,
        harness: backend,
        model: { provider: 'anthropic', id: 'claude-opus-4-7' },
      })) {
        // Drain events; we only care about the session wiring assertion below.
      }
    })()).rejects.toThrow(PlannerSubmissionError);

    expect(createAgentSession).toHaveBeenCalledOnce();
    const sessionOptions = createAgentSession.mock.calls[0]?.[0];
    const customTools = (sessionOptions.customTools ?? []) as Array<{ name: string }>;
    const names = customTools.map((t) => t.name);

    // Primary assertion: the submission tool for this scope is registered.
    expect(names).toContain(expectedTool);

    // pi-coding-agent's `tools` option doubles as an allowlist applied to
    // `customTools` in `AgentSession#_refreshToolRegistry`. If the submission
    // tool name is missing from that list, pi filters the tool out before the
    // model ever sees it, and the planner dies with "tool isn't available in
    // this environment". Make that invariant explicit here.
    const allowlist = (sessionOptions.tools ?? []) as string[];
    expect(allowlist).toContain(expectedTool);
  });
});
