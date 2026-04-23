import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLockfile, writeLockfile, removeLockfile } from '@eforge-build/client';
import type { LockfileData } from '@eforge-build/client';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'eforge-lockfile-'));
}

describe('readLockfile', () => {
  it('returns null when .eforge/ is empty (no lockfile present)', () => {
    const tmpDir = makeTmpDir();
    try {
      mkdirSync(join(tmpDir, '.eforge'), { recursive: true });
      expect(readLockfile(tmpDir)).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('returns valid LockfileData when .eforge/daemon.lock is present and well-formed', () => {
    const tmpDir = makeTmpDir();
    try {
      const data: LockfileData = { pid: 12345, port: 4321, startedAt: '2024-01-01T00:00:00.000Z' };
      writeLockfile(tmpDir, data);
      const result = readLockfile(tmpDir);
      expect(result).not.toBeNull();
      expect(typeof result!.pid).toBe('number');
      expect(typeof result!.port).toBe('number');
      expect(typeof result!.startedAt).toBe('string');
      expect(result!.pid).toBe(12345);
      expect(result!.port).toBe(4321);
      expect(result!.startedAt).toBe('2024-01-01T00:00:00.000Z');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('returns null when only a legacy .eforge/monitor.lock exists (monitor.lock fallback removed)', () => {
    const tmpDir = makeTmpDir();
    try {
      mkdirSync(join(tmpDir, '.eforge'), { recursive: true });
      const legacyData: LockfileData = { pid: 99999, port: 9999, startedAt: '2024-01-01T00:00:00.000Z' };
      writeFileSync(
        join(tmpDir, '.eforge', 'monitor.lock'),
        JSON.stringify(legacyData, null, 2) + '\n',
        'utf-8',
      );
      // The fallback has been removed — reading should return null
      expect(readLockfile(tmpDir)).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});

describe('removeLockfile', () => {
  it('removes daemon.lock when present', () => {
    const tmpDir = makeTmpDir();
    try {
      const data: LockfileData = { pid: 1, port: 1234, startedAt: '2024-01-01T00:00:00.000Z' };
      writeLockfile(tmpDir, data);
      expect(readLockfile(tmpDir)).not.toBeNull();
      removeLockfile(tmpDir);
      expect(readLockfile(tmpDir)).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('is a no-op when no lockfile exists', () => {
    const tmpDir = makeTmpDir();
    try {
      // Should not throw
      expect(() => removeLockfile(tmpDir)).not.toThrow();
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});
