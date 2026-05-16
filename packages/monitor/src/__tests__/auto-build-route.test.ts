/**
 * Tests for POST /api/auto-build daemon-mode mutations.
 *
 * Follows AGENTS.md conventions:
 * - No mocks. Real SQLite DB via openDatabase. Real HTTP via startServer.
 * - Constructs inputs inline.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_ROUTES } from '@eforge-build/client';
import type { EforgeEvent } from '@eforge-build/client';
import { openDatabase } from '../db.js';
import { startServer } from '../server.js';
import type { DaemonState, MonitorServer } from '../server.js';

function makeTmpCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eforge-auto-build-route-'));
  mkdirSync(join(dir, '.eforge'), { recursive: true });
  return dir;
}

const servers: MonitorServer[] = [];

afterEach(async () => {
  for (const server of servers) {
    try {
      await server.stop();
    } catch {
      // best-effort cleanup
    }
  }
  servers.length = 0;
});

describe('POST /api/auto-build', () => {
  it('manual disable kills the watcher, emits daemon:auto-build:disabled, and returns AutoBuildState', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const emitted: EforgeEvent[] = [];
    const callOrder: string[] = [];
    let killWatcherCalls = 0;

    const daemonState: DaemonState = {
      autoBuild: true,
      autoBuildPaused: true,
      watcher: {
        running: true,
        pid: 1234,
        sessionId: 'watcher-session',
      },
      onKillWatcher() {
        callOrder.push('kill-watcher');
        killWatcherCalls += 1;
        daemonState.watcher = { running: false, pid: null, sessionId: null };
      },
      onDaemonEvent(event) {
        callOrder.push('daemon-event');
        emitted.push(event);
      },
    };

    const server = await startServer(db, 0, { cwd, daemonState });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}${API_ROUTES.autoBuildSet}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      enabled: false,
      watcher: { running: false, pid: null, sessionId: null },
    });
    expect(daemonState.autoBuild).toBe(false);
    expect(daemonState.autoBuildPaused).toBe(true);
    expect(killWatcherCalls).toBe(1);
    expect(callOrder).toEqual(['kill-watcher', 'daemon-event']);
    expect(emitted).toHaveLength(1);
    const disabledEvent = emitted[0]!;
    expect(disabledEvent).toEqual({
      type: 'daemon:auto-build:disabled',
      timestamp: disabledEvent.timestamp,
    });
    expect(Number.isNaN(Date.parse(disabledEvent.timestamp))).toBe(false);

    db.close();
  });
});
