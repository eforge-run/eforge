/**
 * Unit tests for the open-session-plan helper (Pi extension variant).
 *
 * Uses stub spawn and platform injection to avoid launching real desktop apps.
 * The MCP proxy helper (packages/eforge/src/cli/open-session-plan.ts) is
 * structurally identical and is verified by parity in code review.
 */

import { describe, it, expect } from 'vitest';
import { openSessionPlanFile, type OpenSessionPlanOptions } from '../packages/pi-eforge/extensions/eforge/open-session-plan.js';
import { resolve } from 'node:path';

const CWD = '/home/user/project';
const VALID_PATH = resolve(CWD, '.eforge', 'session-plans', '2026-01-01-add-feature.md');

type SpawnArgs = { command: string; args: string[]; options: object };

function makeStubSpawn(throws?: Error): { calls: SpawnArgs[]; unrefCalled: boolean; spawn: OpenSessionPlanOptions['spawn'] } {
  const calls: SpawnArgs[] = [];
  let unrefCalled = false;
  const spawn: OpenSessionPlanOptions['spawn'] = (command, args, options) => {
    calls.push({ command, args, options });
    if (throws) throw throws;
    return {
      unref() {
        unrefCalled = true;
      },
    };
  };
  return { calls, get unrefCalled() { return unrefCalled; }, spawn };
}

describe('openSessionPlanFile', () => {
  it('darwin: spawns "open" with the path, returns ok:true', () => {
    const stub = makeStubSpawn();
    const result = openSessionPlanFile({
      path: VALID_PATH,
      cwd: CWD,
      platform: 'darwin',
      spawn: stub.spawn,
    });

    expect(result.attempted).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.command).toBe('open');
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].command).toBe('open');
    expect(stub.calls[0].args).toEqual([VALID_PATH]);
    expect((stub.calls[0].options as Record<string, unknown>).detached).toBe(true);
    expect((stub.calls[0].options as Record<string, unknown>).stdio).toBe('ignore');
  });

  it('linux: spawns "xdg-open" with the path, returns ok:true', () => {
    const stub = makeStubSpawn();
    const result = openSessionPlanFile({
      path: VALID_PATH,
      cwd: CWD,
      platform: 'linux',
      spawn: stub.spawn,
    });

    expect(result.attempted).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.command).toBe('xdg-open');
    expect(stub.calls[0].command).toBe('xdg-open');
    expect(stub.calls[0].args).toEqual([VALID_PATH]);
  });

  it('win32: spawns "cmd" with start and the path, returns ok:true', () => {
    const stub = makeStubSpawn();
    const result = openSessionPlanFile({
      path: VALID_PATH,
      cwd: CWD,
      platform: 'win32',
      spawn: stub.spawn,
    });

    expect(result.attempted).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.command).toBe('cmd');
    expect(stub.calls[0].command).toBe('cmd');
    expect(stub.calls[0].args).toEqual(['/c', 'start', '""', VALID_PATH]);
  });

  it('unsupported platform returns attempted:false, ok:false, error:unsupported-platform', () => {
    const stub = makeStubSpawn();
    const result = openSessionPlanFile({
      path: VALID_PATH,
      cwd: CWD,
      platform: 'freebsd' as NodeJS.Platform,
      spawn: stub.spawn,
    });

    expect(result.attempted).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('unsupported-platform');
    expect(stub.calls).toHaveLength(0);
  });

  it('path outside cwd/.eforge/session-plans/ returns attempted:false, ok:false, error:path-out-of-scope', () => {
    const stub = makeStubSpawn();
    const result = openSessionPlanFile({
      path: '/tmp/evil.md',
      cwd: CWD,
      platform: 'darwin',
      spawn: stub.spawn,
    });

    expect(result.attempted).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('path-out-of-scope');
    expect(stub.calls).toHaveLength(0);
  });

  it('path traversal attempt returns path-out-of-scope', () => {
    const stub = makeStubSpawn();
    const result = openSessionPlanFile({
      path: resolve(CWD, '.eforge', 'session-plans', '..', '..', 'eforge', 'config.yaml'),
      cwd: CWD,
      platform: 'darwin',
      spawn: stub.spawn,
    });

    expect(result.attempted).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('path-out-of-scope');
  });

  it('spawn throws: returns attempted:true, ok:false, error captured', () => {
    const err = new Error('ENOENT: xdg-open not found');
    const stub = makeStubSpawn(err);
    const result = openSessionPlanFile({
      path: VALID_PATH,
      cwd: CWD,
      platform: 'linux',
      spawn: stub.spawn,
    });

    expect(result.attempted).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.command).toBe('xdg-open');
    expect(result.error).toContain('ENOENT');
  });

  it('successful spawn calls unref() on the child', () => {
    const stub = makeStubSpawn();
    openSessionPlanFile({
      path: VALID_PATH,
      cwd: CWD,
      platform: 'darwin',
      spawn: stub.spawn,
    });

    expect(stub.unrefCalled).toBe(true);
  });
});
