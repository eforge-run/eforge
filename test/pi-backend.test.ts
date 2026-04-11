import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentTool } from '@mariozechner/pi-agent-core';

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
  discoverAndLoadExtensions: vi.fn(async () => ({ extensions: [] })),
}));

import { PiBackend } from '@eforge-build/engine/backends/pi';
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
  return new PiBackend({
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

function setMcpTools(backend: PiBackend, tools: AgentTool[]): void {
  (backend as unknown as { mcpBridge: { getTools: () => Promise<AgentTool[]> } }).mcpBridge = {
    getTools: async () => tools,
  };
}

describe('PiBackend MCP tool wiring', () => {
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
    expect(sessionOptions.tools).toEqual([
      expect.objectContaining({ name: 'read' }),
    ]);
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
