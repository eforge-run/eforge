/**
 * Tests for serveQueue's post-load dependsOn filter.
 *
 * Verifies that terminal items (failed, skipped) have no dependsOn in the
 * /api/queue response, and that live items (pending, running) retain only
 * dependsOn entries referencing other live items.
 *
 * Uses a real startServer instance against a temp queue directory.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { useTempDir } from './test-tmpdir.js';
import { openDatabase } from '@eforge-build/monitor/db';
import { startServer, type MonitorServer } from '@eforge-build/monitor/server';

const makeTempDir = useTempDir('eforge-serve-queue-filter-');

let server: MonitorServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

type QueueItem = {
  id: string;
  title: string;
  status: string;
  dependsOn?: string[];
};

async function setupQueue(tmpDir: string): Promise<void> {
  const queueDir = resolve(tmpDir, 'eforge', 'queue');
  const failedDir = resolve(queueDir, 'failed');
  await mkdir(queueDir, { recursive: true });
  await mkdir(failedDir, { recursive: true });

  // Pending item that depends on both an unknown ID and another live pending item
  await writeFile(
    resolve(queueDir, 'pending-with-deps.md'),
    [
      '---',
      'title: Pending With Deps',
      'created: 2024-01-01',
      'depends_on: ["unknown-id", "another-pending-id"]',
      '---',
      '',
      '# Pending With Deps',
    ].join('\n'),
    'utf-8',
  );

  // Another pending item (no deps) — referenced by the first pending item
  await writeFile(
    resolve(queueDir, 'another-pending-id.md'),
    [
      '---',
      'title: Another Pending',
      'created: 2024-01-01',
      '---',
      '',
      '# Another Pending',
    ].join('\n'),
    'utf-8',
  );

  // Failed item with a depends_on that should be stripped entirely
  await writeFile(
    resolve(failedDir, 'failed-item.md'),
    [
      '---',
      'title: Failed Item',
      'created: 2024-01-01',
      'depends_on: ["some-id"]',
      '---',
      '',
      '# Failed Item',
    ].join('\n'),
    'utf-8',
  );
}

describe('serveQueue dependsOn filter', () => {
  it('strips unknown deps from pending items and removes dependsOn from failed items', async () => {
    const tmpDir = makeTempDir();
    await setupQueue(tmpDir);

    const dbPath = resolve(tmpDir, 'monitor.db');
    server = await startServer(openDatabase(dbPath), 0, {
      strictPort: true,
      cwd: tmpDir,
    });

    const res = await fetch(`http://localhost:${server.port}/api/queue`);
    expect(res.status).toBe(200);

    const items = await res.json() as QueueItem[];

    // Pending item with deps: only 'another-pending-id' should remain (unknown-id dropped)
    const pendingWithDeps = items.find((i) => i.id === 'pending-with-deps');
    expect(pendingWithDeps).toBeDefined();
    expect(pendingWithDeps!.status).toBe('pending');
    expect(pendingWithDeps!.dependsOn).toEqual(['another-pending-id']);

    // Another pending item: no deps, dependsOn field absent
    const anotherPending = items.find((i) => i.id === 'another-pending-id');
    expect(anotherPending).toBeDefined();
    expect(anotherPending!.status).toBe('pending');
    expect(anotherPending!.dependsOn).toBeUndefined();

    // Failed item: dependsOn must not be present
    const failedItem = items.find((i) => i.id === 'failed-item');
    expect(failedItem).toBeDefined();
    expect(failedItem!.status).toBe('failed');
    expect(failedItem!.dependsOn).toBeUndefined();
  });

  it('drops dependsOn entirely from pending item when all deps are unknown', async () => {
    const tmpDir = makeTempDir();
    const queueDir = resolve(tmpDir, 'eforge', 'queue');
    await mkdir(queueDir, { recursive: true });

    // Pending item with only unknown deps
    await writeFile(
      resolve(queueDir, 'solo-pending.md'),
      [
        '---',
        'title: Solo Pending',
        'created: 2024-01-01',
        'depends_on: ["ghost-id"]',
        '---',
        '',
        '# Solo Pending',
      ].join('\n'),
      'utf-8',
    );

    const dbPath = resolve(tmpDir, 'monitor.db');
    server = await startServer(openDatabase(dbPath), 0, {
      strictPort: true,
      cwd: tmpDir,
    });

    const res = await fetch(`http://localhost:${server.port}/api/queue`);
    expect(res.status).toBe(200);

    const items = await res.json() as QueueItem[];
    const item = items.find((i) => i.id === 'solo-pending');
    expect(item).toBeDefined();
    expect(item!.dependsOn).toBeUndefined();
  });
});
