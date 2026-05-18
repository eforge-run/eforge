import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const TRUST_STORE_FILENAME = 'extension-trust.json';
const TRUST_STORE_VERSION = 1;

/**
 * A single per-extension trust record stored in the local trust store.
 * Records are keyed by extension name within the project-team scope.
 */
export interface ExtensionTrustRecord {
  /** Extension name (unique identifier within project-team scope). */
  name: string;
  /** SHA-256 content hash at the time this trust record was created or updated. */
  hash: string;
  /** ISO-8601 timestamp when this record was created or last updated. */
  trustedAt: string;
  /** Optional annotation describing who or what trusted this extension. */
  trustedBy?: string;
}

/**
 * The versioned JSON document stored at `.eforge/extension-trust.json`.
 */
export interface ExtensionTrustStore {
  version: number;
  records: ExtensionTrustRecord[];
}

/**
 * Resolve the absolute path to the trust store file within the `.eforge/` directory.
 * @param eforgeDir - Path to the `.eforge/` directory (typically `resolve(cwd, '.eforge')`).
 */
export function getTrustStorePath(eforgeDir: string): string {
  return resolve(eforgeDir, TRUST_STORE_FILENAME);
}

/**
 * Read the trust store from disk.
 * Returns an empty store if the file does not exist or is malformed.
 * Malformed records within an otherwise parseable file are silently dropped.
 */
export async function readTrustStore(eforgeDir: string): Promise<ExtensionTrustStore> {
  const path = getTrustStorePath(eforgeDir);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return emptyStore();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyStore();
  }
  return validateStore(parsed) ?? emptyStore();
}

/**
 * Write the trust store to disk.
 * Creates the parent directory if it does not exist.
 */
export async function writeTrustStore(eforgeDir: string, store: ExtensionTrustStore): Promise<void> {
  const path = getTrustStorePath(eforgeDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2) + '\n', 'utf-8');
}

/**
 * Look up a trust record by extension name.
 * Returns `undefined` if no record exists for the given name.
 */
export function getTrustRecord(store: ExtensionTrustStore, name: string): ExtensionTrustRecord | undefined {
  return store.records.find((record) => record.name === name);
}

/**
 * Upsert a trust record for a project-team extension candidate.
 * Reads the existing store, inserts or replaces the record, sorts by name, then writes back.
 */
export async function upsertTrustRecord(
  eforgeDir: string,
  name: string,
  hash: string,
  trustedBy?: string,
): Promise<void> {
  const store = await readTrustStore(eforgeDir);
  const record: ExtensionTrustRecord = {
    name,
    hash,
    trustedAt: new Date().toISOString(),
    ...(trustedBy !== undefined && { trustedBy }),
  };
  const existingIndex = store.records.findIndex((r) => r.name === name);
  if (existingIndex >= 0) {
    store.records[existingIndex] = record;
  } else {
    store.records.push(record);
  }
  store.records.sort((a, b) => a.name.localeCompare(b.name));
  await writeTrustStore(eforgeDir, store);
}

/**
 * Remove a trust record by extension name.
 * Does nothing if no record with that name exists.
 */
export async function removeTrustRecord(eforgeDir: string, name: string): Promise<void> {
  const store = await readTrustStore(eforgeDir);
  const index = store.records.findIndex((r) => r.name === name);
  if (index < 0) return;
  store.records.splice(index, 1);
  await writeTrustStore(eforgeDir, store);
}

function emptyStore(): ExtensionTrustStore {
  return { version: TRUST_STORE_VERSION, records: [] };
}

function validateStore(value: unknown): ExtensionTrustStore | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (obj.version !== TRUST_STORE_VERSION) return null;
  if (!Array.isArray(obj.records)) return null;
  const records: ExtensionTrustRecord[] = [];
  for (const item of obj.records) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== 'string' || !rec.name) continue;
    if (typeof rec.hash !== 'string' || !rec.hash) continue;
    if (typeof rec.trustedAt !== 'string') continue;
    records.push({
      name: rec.name,
      hash: rec.hash,
      trustedAt: rec.trustedAt,
      ...(typeof rec.trustedBy === 'string' && { trustedBy: rec.trustedBy }),
    });
  }
  return { version: TRUST_STORE_VERSION, records };
}
