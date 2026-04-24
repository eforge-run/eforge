import { describe, it, expect } from 'vitest';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compilePattern, matchesPattern, withHooks } from '@eforge-build/engine/hooks';
import type { EforgeEvent } from '@eforge-build/engine/events';
import type { HookConfig } from '@eforge-build/engine/config';
import { collectEvents } from './test-events.js';

describe('compilePattern', () => {
  it('matches exact event type', () => {
    const regex = compilePattern('plan:build:start');
    expect(regex.test('plan:build:start')).toBe(true);
    expect(regex.test('plan:build:complete')).toBe(false);
  });

  it('wildcard matches any characters including colon', () => {
    const regex = compilePattern('plan:build:*');
    expect(regex.test('plan:build:start')).toBe(true);
    expect(regex.test('plan:build:implement:start')).toBe(true);
    expect(regex.test('planning:start')).toBe(false);
  });

  it('single star matches everything', () => {
    const regex = compilePattern('*');
    expect(regex.test('anything:here')).toBe(true);
    expect(regex.test('plan:build:implement:start')).toBe(true);
    expect(regex.test('')).toBe(true);
  });

  it('escapes regex-special characters', () => {
    const regex = compilePattern('foo.bar');
    expect(regex.test('foo.bar')).toBe(true);
    expect(regex.test('fooxbar')).toBe(false);
  });

  it('handles multiple wildcards', () => {
    const regex = compilePattern('*:start');
    expect(regex.test('plan:build:start')).toBe(true);
    expect(regex.test('planning:start')).toBe(true);
    expect(regex.test('plan:build:complete')).toBe(false);
  });
});

describe('matchesPattern', () => {
  it('plan:build:* matches plan:build:start', () => {
    expect(matchesPattern('plan:build:*', 'plan:build:start')).toBe(true);
  });

  it('plan:build:* does not match planning:start', () => {
    expect(matchesPattern('plan:build:*', 'planning:start')).toBe(false);
  });

  it('* matches anything', () => {
    expect(matchesPattern('*', 'anything:here')).toBe(true);
  });
});

describe('withHooks', () => {
  async function* asyncIterableFrom(events: EforgeEvent[]): AsyncGenerator<EforgeEvent> {
    for (const event of events) {
      yield event;
    }
  }

  const sampleEvents: EforgeEvent[] = [
    { type: 'phase:start', runId: '1', planSet: 'test', command: 'compile', timestamp: new Date().toISOString() },
    { type: 'planning:start', source: 'test.md' },
    { type: 'planning:complete', plans: [] },
    { type: 'phase:end', runId: '1', result: { status: 'completed', summary: 'done' }, timestamp: new Date().toISOString() },
  ];

  it('yields all events unchanged with empty hooks array', async () => {
    const events = await collectEvents(
      withHooks(asyncIterableFrom(sampleEvents), [], '/tmp'),
    );
    expect(events).toEqual(sampleEvents);
  });

  it('yields all events in order with hooks configured', async () => {
    const hooks: HookConfig[] = [
      { event: '*', command: 'true', timeout: 5000 },
    ];
    const events = await collectEvents(
      withHooks(asyncIterableFrom(sampleEvents), hooks, '/tmp'),
    );
    expect(events).toEqual(sampleEvents);
  });

  it('yields all events unchanged (identity) even when hooks match', async () => {
    const hooks: HookConfig[] = [
      { event: 'plan:*', command: 'true', timeout: 5000 },
      { event: 'phase:*', command: 'true', timeout: 5000 },
    ];
    const events = await collectEvents(
      withHooks(asyncIterableFrom(sampleEvents), hooks, '/tmp'),
    );
    expect(events).toEqual(sampleEvents);
  });

  it('passes EFORGE_CWD, EFORGE_GIT_REMOTE, and EFORGE_EVENT_TYPE env vars to hook', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'eforge-hook-test-'));
    const outFile = join(tmpDir, 'env-out.txt');

    try {
      const hooks: HookConfig[] = [
        {
          event: 'phase:start',
          command: `echo "CWD=$EFORGE_CWD" > "${outFile}" && echo "REMOTE=$EFORGE_GIT_REMOTE" >> "${outFile}" && echo "TYPE=$EFORGE_EVENT_TYPE" >> "${outFile}"`,
          timeout: 5000,
        },
      ];

      const events: EforgeEvent[] = [
        { type: 'phase:start', runId: '1', planSet: 'test', command: 'compile', timestamp: new Date().toISOString() },
      ];

      // Consume all events so hooks fire and drain
      await collectEvents(withHooks(asyncIterableFrom(events), hooks, tmpDir));

      const content = await readFile(outFile, 'utf-8');
      expect(content).toContain(`CWD=${tmpDir}`);
      expect(content).toContain('REMOTE=');
      expect(content).toContain('TYPE=phase:start');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('drain timeout derives from hook config, not a hardcoded value', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'eforge-hook-drain-'));
    const outFile = join(tmpDir, 'drain-proof.txt');

    try {
      // Hook with a short timeout (100ms) that writes a file after 50ms.
      // If the drain timeout is derived from hook config (100ms + 1000ms grace = 1100ms),
      // the file write at 50ms will complete well within the drain window.
      const hooks: HookConfig[] = [
        {
          event: 'phase:end',
          command: `sleep 0.05 && echo "drained" > "${outFile}"`,
          timeout: 100,
        },
      ];

      const events: EforgeEvent[] = [
        { type: 'phase:end', runId: '1', result: { status: 'completed', summary: 'done' }, timestamp: new Date().toISOString() },
      ];

      await collectEvents(withHooks(asyncIterableFrom(events), hooks, tmpDir));

      // The file should exist — proving the drain waited long enough for the hook to finish
      const content = await readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('drained');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('passes EFORGE_RUN_ID from phase:start to subsequent hooks', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'eforge-hook-test-'));
    const outFile = join(tmpDir, 'runid-out.txt');

    try {
      const hooks: HookConfig[] = [
        {
          event: 'planning:start',
          command: `echo "RUNID=$EFORGE_RUN_ID" > "${outFile}"`,
          timeout: 5000,
        },
      ];

      const events: EforgeEvent[] = [
        { type: 'phase:start', runId: 'test-run-42', planSet: 'test', command: 'compile', timestamp: new Date().toISOString() },
        { type: 'planning:start', source: 'test.md' },
      ];

      await collectEvents(withHooks(asyncIterableFrom(events), hooks, tmpDir));

      const content = await readFile(outFile, 'utf-8');
      expect(content).toContain('RUNID=test-run-42');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
