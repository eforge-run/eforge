/**
 * Integration test for the Pi `eforge_follow` tool.
 *
 * Exercises the tool's `execute()` function end-to-end against a stub daemon
 * that emits synthetic SSE events, asserting that:
 *   - `onUpdate(message)` is invoked for each high-signal event with the
 *     mapped human-readable string,
 *   - noisy event families (`agent:*`) and low-severity review issues are
 *     filtered,
 *   - the tool resolves with a `SessionSummary`-derived JSON payload once
 *     `session:end` arrives.
 *
 * The tool is exercised by calling the extension entrypoint with a stub
 * ExtensionAPI that captures the registered tool definitions, then invoking
 * the captured `eforge_follow.execute()` directly with a synthetic ctx.
 */
import { describe, it, expect } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { writeLockfile } from '@eforge-build/client';
import type { DaemonStreamEvent } from '@eforge-build/client';
import { useTempDir } from './test-tmpdir.js';

import eforgeExtension from '../packages/pi-eforge/extensions/eforge/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface CapturedTool {
  name: string;
  description: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((message: string) => void) | undefined,
    ctx: { cwd: string; hasUI: boolean; ui: unknown },
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

/**
 * Build a stub ExtensionAPI that captures `registerTool` calls and is a no-op
 * for everything else. Cast through `unknown` because the real ExtensionAPI
 * surface is large and we only need a narrow slice for this test.
 */
function makeStubPi(tools: Map<string, CapturedTool>): unknown {
  return {
    on: () => {},
    registerTool: (tool: {
      name: string;
      description: string;
      execute: CapturedTool['execute'];
    }) => {
      tools.set(tool.name, {
        name: tool.name,
        description: tool.description,
        execute: tool.execute,
      });
    },
    registerCommand: () => {},
    sendUserMessage: () => {},
  };
}

async function startSseServer(
  emit: (res: ServerResponse) => void,
): Promise<{
  server: Server;
  port: number;
  close: () => Promise<void>;
  requestCount: () => number;
}> {
  let requestCount = 0;
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    requestCount += 1;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    emit(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    server,
    port: addr.port,
    requestCount: () => requestCount,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function writeSse(res: ServerResponse, event: DaemonStreamEvent, id: number): void {
  res.write(`id: ${id}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function ts(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Pi eforge_follow tool', () => {
  const makeTempDir = useTempDir('eforge-pi-follow-');

  it('registers an eforge_follow tool', () => {
    const tools = new Map<string, CapturedTool>();
    // Cast via unknown per AGENTS.md "No mocks": we hand-craft the minimal
    // ExtensionAPI surface the extension uses at registration time.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eforgeExtension(makeStubPi(tools) as any);

    expect(tools.has('eforge_follow')).toBe(true);
    const follow = tools.get('eforge_follow')!;
    expect(follow.description).toMatch(/Follow a running eforge session/);
  });

  it('invokes onUpdate for each high-signal event and resolves with a summary', async () => {
    const cwd = makeTempDir();

    // Stub daemon emits: phase:start, phase:end, build:files_changed,
    // review:issue{high}, then session:end. Plus noise that must be filtered:
    // agent:tool_call and review:issue{low}.
    const sse = await startSseServer((res) => {
      writeSse(res, { type: 'phase:start', timestamp: ts(), phase: 'plan' }, 1);
      writeSse(res, { type: 'agent:tool_call', timestamp: ts(), agent: 'builder' }, 2);
      writeSse(res, { type: 'phase:end', timestamp: ts(), phase: 'plan' }, 3);
      writeSse(res, {
        type: 'plan:build:files_changed',
        timestamp: ts(),
        planId: 'plan-a',
        files: ['a.ts', 'b.ts', 'c.ts'],
      }, 4);
      writeSse(res, {
        type: 'review:issue',
        timestamp: ts(),
        severity: 'low',
        summary: 'Nit: rename var',
      }, 5);
      writeSse(res, {
        type: 'review:issue',
        timestamp: ts(),
        severity: 'high',
        summary: 'Missing error handling',
      }, 6);
      writeSse(res, {
        type: 'session:end',
        sessionId: 'sess-follow',
        timestamp: ts(),
        result: { status: 'completed', summary: 'ok' },
      }, 7);
      // Keep connection open briefly so the client drains buffered data.
      setTimeout(() => res.end(), 10);
    });

    // Write a lockfile so `subscribeToSession({ cwd })` resolves to our server.
    writeLockfile(cwd, {
      pid: process.pid,
      port: sse.port,
      startedAt: new Date().toISOString(),
    });

    try {
      const tools = new Map<string, CapturedTool>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eforgeExtension(makeStubPi(tools) as any);
      const follow = tools.get('eforge_follow');
      expect(follow).toBeTruthy();

      const updates: string[] = [];
      const onUpdate = (message: string): void => {
        updates.push(message);
      };

      const result = await follow!.execute(
        'call-1',
        { sessionId: 'sess-follow' },
        undefined,
        onUpdate,
        {
          cwd,
          hasUI: false,
          ui: {},
        },
      );

      // onUpdate must be invoked for exactly the 4 high-signal events -
      // phase:start, phase:end, build:files_changed, review:issue{high} -
      // in the order they arrived. agent:* and low-severity issues are filtered.
      expect(updates).toHaveLength(4);
      expect(updates[0]).toMatch(/^Phase:/);
      expect(updates[0]).toContain('plan');
      expect(updates[0]).toContain('starting');
      expect(updates[1]).toMatch(/^Phase:/);
      expect(updates[1]).toContain('plan');
      expect(updates[1]).toContain('complete');
      expect(updates[2]).toContain('Files changed:');
      expect(updates[2]).toContain('3');
      expect(updates[3]).toContain('(high)');
      expect(updates[3]).toContain('Missing error handling');

      // The tool resolves with a JSON payload containing the session summary.
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      const data = JSON.parse(result.content[0].text) as {
        status: string;
        sessionId: string;
        summary: string;
        filesChanged: number;
        phaseCounts?: { total?: number };
        issueCounts?: { errors?: number };
        eventCount: number;
        monitorUrl: string;
      };
      expect(data.status).toBe('completed');
      expect(data.sessionId).toBe('sess-follow');
      expect(data.summary).toBe('ok');
      expect(data.filesChanged).toBe(3);
      expect(data.phaseCounts?.total).toBe(1);
      expect(data.issueCounts?.errors).toBe(0);
      expect(data.eventCount).toBe(7);
      expect(data.monitorUrl).toContain(`:${sse.port}`);
    } finally {
      await sse.close();
    }
  });

  it('tolerates an onUpdate callback that throws without dropping the subscription', async () => {
    const cwd = makeTempDir();
    const sse = await startSseServer((res) => {
      writeSse(res, { type: 'phase:start', timestamp: ts(), phase: 'plan' }, 1);
      writeSse(res, { type: 'phase:end', timestamp: ts(), phase: 'plan' }, 2);
      writeSse(res, {
        type: 'session:end',
        sessionId: 'sess-throw',
        timestamp: ts(),
        result: { status: 'completed', summary: 'done' },
      }, 3);
      setTimeout(() => res.end(), 10);
    });

    writeLockfile(cwd, {
      pid: process.pid,
      port: sse.port,
      startedAt: new Date().toISOString(),
    });

    try {
      const tools = new Map<string, CapturedTool>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eforgeExtension(makeStubPi(tools) as any);
      const follow = tools.get('eforge_follow')!;

      let callCount = 0;
      const throwingOnUpdate = (_message: string): void => {
        callCount += 1;
        throw new Error('caller UI closed');
      };

      const result = await follow.execute(
        'call-2',
        { sessionId: 'sess-throw' },
        undefined,
        throwingOnUpdate,
        { cwd, hasUI: false, ui: {} },
      );

      // The callback was invoked for both phase events even though it threw.
      expect(callCount).toBe(2);
      const data = JSON.parse(result.content[0].text) as { status: string };
      expect(data.status).toBe('completed');
    } finally {
      await sse.close();
    }
  });

  it('returns an aborted status when the external AbortSignal fires', async () => {
    const cwd = makeTempDir();
    // Server emits a starting event then stays open indefinitely.
    const sse = await startSseServer((res) => {
      writeSse(res, { type: 'phase:start', timestamp: ts(), phase: 'plan' }, 1);
      // Intentionally do not end - the abort path is what we test.
    });

    writeLockfile(cwd, {
      pid: process.pid,
      port: sse.port,
      startedAt: new Date().toISOString(),
    });

    try {
      const tools = new Map<string, CapturedTool>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eforgeExtension(makeStubPi(tools) as any);
      const follow = tools.get('eforge_follow')!;

      const controller = new AbortController();
      let firstUpdateSeen = false;
      const onUpdate = (_message: string): void => {
        if (!firstUpdateSeen) {
          firstUpdateSeen = true;
          setTimeout(() => controller.abort(), 5);
        }
      };

      const result = await follow.execute(
        'call-3',
        { sessionId: 'sess-abort' },
        controller.signal,
        onUpdate,
        { cwd, hasUI: false, ui: {} },
      );

      const data = JSON.parse(result.content[0].text) as {
        status: string;
        sessionId: string;
      };
      expect(data.status).toBe('aborted');
      expect(data.sessionId).toBe('sess-abort');
    } finally {
      await sse.close();
    }
  }, 10_000);
});
