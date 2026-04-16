import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createAgentSession, createCodingTools, createReadOnlyTools } = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  createCodingTools: vi.fn(),
  createReadOnlyTools: vi.fn(),
}));

vi.mock('@mariozechner/pi-ai', () => ({
  getModel: vi.fn(() => ({
    id: 'gemma-4',
    name: 'gemma-4',
    api: 'openai-completions',
    provider: 'llama-cpp',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 2048,
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
import type { EforgeEvent } from '@eforge-build/engine/events';

type Listener = (event: unknown) => void;

interface SessionStats {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost: number;
}

interface SessionSpec {
  /** Sequence of events to dispatch inside session.prompt(). */
  events: unknown[];
  /** Session stats returned by getSessionStats(). */
  stats: SessionStats;
}

function installSession(spec: SessionSpec): { aborted: { value: boolean } } {
  const aborted = { value: false };
  createAgentSession.mockImplementationOnce(async () => {
    const listeners = new Set<Listener>();
    const session = {
      subscribe(listener: Listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSessionStats() { return spec.stats; },
      async prompt(_prompt: string) {
        for (const ev of spec.events) {
          if (aborted.value) break;
          for (const listener of Array.from(listeners)) listener(ev);
        }
      },
      abort() { aborted.value = true; },
      async bindExtensions(_options: unknown) {},
    };
    return { session };
  });
  return { aborted };
}

async function collect(iterable: AsyncIterable<EforgeEvent>): Promise<{ events: EforgeEvent[]; error: Error | null }> {
  const events: EforgeEvent[] = [];
  try {
    for await (const event of iterable) {
      events.push(event);
    }
    return { events, error: null };
  } catch (err) {
    return { events, error: err as Error };
  }
}

function makeBackend() {
  return new PiBackend({ bare: true });
}

beforeEach(() => {
  createAgentSession.mockReset();
  createCodingTools.mockReset();
  createReadOnlyTools.mockReset();
  createCodingTools.mockReturnValue([{ name: 'read' }]);
  createReadOnlyTools.mockReturnValue([{ name: 'read' }]);
});

describe('PiBackend fail-fast on unreachable backend', () => {
  it('throws with backend error message when turn_end carries stopReason=error', async () => {
    installSession({
      events: [
        { type: 'turn_end', message: { stopReason: 'error', errorMessage: 'connect ECONNREFUSED 127.0.0.1:8080' } },
        { type: 'agent_end', messages: [] },
      ],
      stats: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 },
    });

    const backend = makeBackend();
    const { events, error } = await collect(backend.run(
      {
        prompt: 'hi',
        cwd: process.cwd(),
        maxTurns: 1,
        tools: 'coding',
        model: { provider: 'llama-cpp', id: 'gemma-4' },
      },
      'builder',
    ));

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe('Backend error: connect ECONNREFUSED 127.0.0.1:8080');
    // The failing turn must not emit agent:usage
    const usageEvents = events.filter((e) => e.type === 'agent:usage');
    expect(usageEvents).toHaveLength(0);
  });

  it('uses fallback message when errorMessage is absent', async () => {
    installSession({
      events: [
        { type: 'turn_end', message: { stopReason: 'error' } },
        { type: 'agent_end', messages: [] },
      ],
      stats: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 },
    });

    const backend = makeBackend();
    const { error } = await collect(backend.run(
      {
        prompt: 'hi',
        cwd: process.cwd(),
        maxTurns: 1,
        tools: 'coding',
        model: { provider: 'llama-cpp', id: 'gemma-4' },
      },
      'builder',
    ));

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe('Backend returned an error response with no message');
  });

  it('zero-token backstop triggers when turn_end reports zero tokens and no error stopReason', async () => {
    installSession({
      events: [
        // turn_end with a plain stopReason (not 'error') — stats still say zero tokens
        { type: 'turn_end', message: { stopReason: 'stop' } },
        { type: 'agent_end', messages: [] },
      ],
      stats: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 },
    });

    const backend = makeBackend();
    const { events, error } = await collect(backend.run(
      {
        prompt: 'hi',
        cwd: process.cwd(),
        maxTurns: 1,
        tools: 'coding',
        model: { provider: 'llama-cpp', id: 'gemma-4' },
      },
      'builder',
    ));

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('zero token usage');
    // agent:result is emitted before the throw
    const resultEvent = events.find((e) => e.type === 'agent:result');
    expect(resultEvent).toBeDefined();
  });

  it('does NOT trigger either guard on a healthy turn_end with non-zero input tokens', async () => {
    installSession({
      events: [
        { type: 'turn_end', message: { stopReason: 'stop' } },
        { type: 'agent_end', messages: [] },
      ],
      stats: { tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }, cost: 0.01 },
    });

    const backend = makeBackend();
    const { events, error } = await collect(backend.run(
      {
        prompt: 'hi',
        cwd: process.cwd(),
        maxTurns: 1,
        tools: 'coding',
        model: { provider: 'llama-cpp', id: 'gemma-4' },
      },
      'builder',
    ));

    expect(error).toBeNull();
    // Usage event was emitted for the healthy turn
    const usageEvents = events.filter((e) => e.type === 'agent:usage');
    expect(usageEvents.length).toBeGreaterThan(0);
  });
});
