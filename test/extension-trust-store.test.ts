import { describe, it, expect } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  readTrustStore,
  writeTrustStore,
  upsertTrustRecord,
  removeTrustRecord,
  getTrustRecord,
  getTrustStorePath,
  TRUST_STORE_FILENAME,
  type ExtensionTrustStore,
} from '@eforge-build/engine/extensions';
import { useTempDir } from './test-tmpdir.js';

describe('extension trust store', () => {
  const makeTempDir = useTempDir('extension-trust-store-');

  it('returns an empty store when the file does not exist', async () => {
    const root = makeTempDir();
    const store = await readTrustStore(resolve(root, '.eforge'));
    expect(store.version).toBe(1);
    expect(store.records).toEqual([]);
  });

  it('returns an empty store for a missing parent directory', async () => {
    const root = makeTempDir();
    const store = await readTrustStore(resolve(root, 'missing', '.eforge'));
    expect(store.records).toEqual([]);
  });

  it('returns an empty store when the file contains malformed JSON', async () => {
    const root = makeTempDir();
    const eforgeDir = resolve(root, '.eforge');
    await mkdir(eforgeDir, { recursive: true });
    await writeFile(resolve(eforgeDir, TRUST_STORE_FILENAME), 'not-json{broken', 'utf-8');
    const store = await readTrustStore(eforgeDir);
    expect(store.records).toEqual([]);
  });

  it('returns an empty store when the file contains valid JSON but wrong shape', async () => {
    const root = makeTempDir();
    const eforgeDir = resolve(root, '.eforge');
    await mkdir(eforgeDir, { recursive: true });
    await writeFile(resolve(eforgeDir, TRUST_STORE_FILENAME), JSON.stringify([1, 2, 3]), 'utf-8');
    const store = await readTrustStore(eforgeDir);
    expect(store.records).toEqual([]);
  });

  it('returns an empty store when version is missing', async () => {
    const root = makeTempDir();
    const eforgeDir = resolve(root, '.eforge');
    await mkdir(eforgeDir, { recursive: true });
    await writeFile(resolve(eforgeDir, TRUST_STORE_FILENAME), JSON.stringify({ records: [] }), 'utf-8');
    const store = await readTrustStore(eforgeDir);
    expect(store.records).toEqual([]);
  });

  it('returns an empty store when the version is unsupported', async () => {
    const root = makeTempDir();
    const eforgeDir = resolve(root, '.eforge');
    await mkdir(eforgeDir, { recursive: true });
    await writeFile(resolve(eforgeDir, TRUST_STORE_FILENAME), JSON.stringify({ version: 999, records: [{ name: 'alpha', hash: 'aaaa', trustedAt: '2025-01-01T00:00:00.000Z' }] }), 'utf-8');
    const store = await readTrustStore(eforgeDir);
    expect(store).toEqual({ version: 1, records: [] });
  });

  it('silently drops malformed records while preserving valid ones', async () => {
    const root = makeTempDir();
    const eforgeDir = resolve(root, '.eforge');
    await mkdir(eforgeDir, { recursive: true });
    const raw: ExtensionTrustStore = {
      version: 1,
      records: [
        { name: 'good', hash: 'abc123', trustedAt: '2025-01-01T00:00:00.000Z' },
        { name: 42 as unknown as string, hash: 'xyz', trustedAt: '2025-01-01T00:00:00.000Z' }, // invalid name
        { name: 'bad-hash', hash: 42 as unknown as string, trustedAt: '2025-01-01T00:00:00.000Z' }, // invalid hash
        { name: 'good2', hash: 'def456', trustedAt: '2025-01-01T00:00:00.000Z' },
      ] as unknown as ExtensionTrustStore['records'],
    };
    await writeFile(resolve(eforgeDir, TRUST_STORE_FILENAME), JSON.stringify(raw), 'utf-8');
    const store = await readTrustStore(eforgeDir);
    expect(store.records.map((r) => r.name)).toEqual(['good', 'good2']);
  });

  it('round-trips a trust store through write/read', async () => {
    const root = makeTempDir();
    const eforgeDir = resolve(root, '.eforge');
    const store: ExtensionTrustStore = {
      version: 1,
      records: [
        { name: 'alpha', hash: 'aaaa', trustedAt: '2025-01-01T00:00:00.000Z', trustedBy: 'eforge-cli' },
        { name: 'beta', hash: 'bbbb', trustedAt: '2025-02-01T00:00:00.000Z' },
      ],
    };
    await writeTrustStore(eforgeDir, store);
    const read = await readTrustStore(eforgeDir);
    expect(read.records).toEqual(store.records);
  });

  it('writes deterministic pretty-printed JSON for the same store input', async () => {
    const root = makeTempDir();
    const eforgeDir = resolve(root, '.eforge');
    const store: ExtensionTrustStore = {
      version: 1,
      records: [{ name: 'alpha', hash: 'aaaa', trustedAt: '2025-01-01T00:00:00.000Z' }],
    };

    await writeTrustStore(eforgeDir, store);
    const firstWrite = await readFile(resolve(eforgeDir, TRUST_STORE_FILENAME), 'utf-8');
    await writeTrustStore(eforgeDir, store);
    const secondWrite = await readFile(resolve(eforgeDir, TRUST_STORE_FILENAME), 'utf-8');

    expect(secondWrite).toBe(firstWrite);
    expect(firstWrite).toBe(`${JSON.stringify(store, null, 2)}\n`);
  });

  it('creates the .eforge parent directory when writing if it does not exist', async () => {
    const root = makeTempDir();
    const eforgeDir = resolve(root, '.eforge');
    // Do NOT create eforgeDir ahead of time
    await writeTrustStore(eforgeDir, { version: 1, records: [] });
    const read = await readTrustStore(eforgeDir);
    expect(read.records).toEqual([]);
  });

  it('getTrustStorePath returns the correct file path', () => {
    const eforgeDir = '/some/project/.eforge';
    expect(getTrustStorePath(eforgeDir)).toBe(`/some/project/.eforge/${TRUST_STORE_FILENAME}`);
  });

  describe('getTrustRecord', () => {
    it('returns the matching record by name', async () => {
      const root = makeTempDir();
      const eforgeDir = resolve(root, '.eforge');
      const store: ExtensionTrustStore = {
        version: 1,
        records: [
          { name: 'alpha', hash: 'aaaa', trustedAt: '2025-01-01T00:00:00.000Z' },
          { name: 'beta', hash: 'bbbb', trustedAt: '2025-02-01T00:00:00.000Z' },
        ],
      };
      await writeTrustStore(eforgeDir, store);
      const read = await readTrustStore(eforgeDir);
      expect(getTrustRecord(read, 'alpha')).toMatchObject({ name: 'alpha', hash: 'aaaa' });
      expect(getTrustRecord(read, 'beta')).toMatchObject({ name: 'beta', hash: 'bbbb' });
      expect(getTrustRecord(read, 'nonexistent')).toBeUndefined();
    });
  });

  describe('upsertTrustRecord', () => {
    it('inserts a new record when none exists', async () => {
      const root = makeTempDir();
      const eforgeDir = resolve(root, '.eforge');
      await upsertTrustRecord(eforgeDir, 'my-ext', 'hash123');
      const store = await readTrustStore(eforgeDir);
      expect(store.records).toHaveLength(1);
      expect(store.records[0]).toMatchObject({ name: 'my-ext', hash: 'hash123' });
      expect(typeof store.records[0]!.trustedAt).toBe('string');
    });

    it('updates an existing record when name matches', async () => {
      const root = makeTempDir();
      const eforgeDir = resolve(root, '.eforge');
      await upsertTrustRecord(eforgeDir, 'my-ext', 'hash-old');
      await upsertTrustRecord(eforgeDir, 'my-ext', 'hash-new', 'cli-user');
      const store = await readTrustStore(eforgeDir);
      expect(store.records).toHaveLength(1);
      expect(store.records[0]).toMatchObject({ name: 'my-ext', hash: 'hash-new', trustedBy: 'cli-user' });
    });

    it('includes trustedBy when provided', async () => {
      const root = makeTempDir();
      const eforgeDir = resolve(root, '.eforge');
      await upsertTrustRecord(eforgeDir, 'my-ext', 'hash123', 'eforge-cli');
      const store = await readTrustStore(eforgeDir);
      expect(store.records[0]!.trustedBy).toBe('eforge-cli');
    });

    it('sorts records alphabetically by name', async () => {
      const root = makeTempDir();
      const eforgeDir = resolve(root, '.eforge');
      await upsertTrustRecord(eforgeDir, 'zeta', 'hash-z');
      await upsertTrustRecord(eforgeDir, 'alpha', 'hash-a');
      await upsertTrustRecord(eforgeDir, 'mu', 'hash-m');
      const store = await readTrustStore(eforgeDir);
      expect(store.records.map((r) => r.name)).toEqual(['alpha', 'mu', 'zeta']);
    });
  });

  describe('removeTrustRecord', () => {
    it('removes an existing record by name', async () => {
      const root = makeTempDir();
      const eforgeDir = resolve(root, '.eforge');
      await upsertTrustRecord(eforgeDir, 'alpha', 'hash-a');
      await upsertTrustRecord(eforgeDir, 'beta', 'hash-b');
      await removeTrustRecord(eforgeDir, 'alpha');
      const store = await readTrustStore(eforgeDir);
      expect(store.records.map((r) => r.name)).toEqual(['beta']);
    });

    it('does nothing when no record with that name exists', async () => {
      const root = makeTempDir();
      const eforgeDir = resolve(root, '.eforge');
      await upsertTrustRecord(eforgeDir, 'alpha', 'hash-a');
      await removeTrustRecord(eforgeDir, 'nonexistent');
      const store = await readTrustStore(eforgeDir);
      expect(store.records).toHaveLength(1);
    });

    it('does nothing on a missing store file', async () => {
      const root = makeTempDir();
      const eforgeDir = resolve(root, '.eforge');
      await expect(removeTrustRecord(eforgeDir, 'anything')).resolves.not.toThrow();
    });
  });
});
