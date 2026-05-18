import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

const HASH_INCLUDED_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs']);
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git']);

/**
 * Compute a deterministic SHA-256 hash for a file-layout extension (single file).
 * Hashes the raw file content of the resolved entrypoint.
 */
export async function hashExtensionFile(entrypoint: string): Promise<string> {
  const content = await readFile(entrypoint);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Compute a deterministic SHA-256 hash for a directory-layout extension.
 *
 * Hashes a stable sorted manifest of relevant files within the extension directory:
 * - `package.json`
 * - Supported source files: `.ts`, `.mts`, `.js`, `.mjs`
 *
 * Excluded from the hash:
 * - `node_modules/`, `dist/`, `.git/`, and other generated or heavy directories
 *
 * The hash is computed by iterating over all included files in sorted path order,
 * contributing each file's relative path and content to the digest.
 */
export async function hashExtensionDirectory(dir: string, entrypoint?: string): Promise<string> {
  const root = resolve(dir);
  const manifest = await collectManifest(root, root);
  if (entrypoint !== undefined) {
    await addExplicitEntrypoint(root, entrypoint, manifest);
  }
  manifest.sort(([a], [b]) => a.localeCompare(b));
  const hash = createHash('sha256');
  for (const [relativePath, content] of manifest) {
    updateLengthPrefixed(hash, Buffer.from(relativePath, 'utf-8'));
    updateLengthPrefixed(hash, content);
  }
  return hash.digest('hex');
}

async function collectManifest(root: string, dir: string): Promise<Array<[string, Buffer]>> {
  const entries: Array<[string, Buffer]> = [];
  const items = await readdir(dir);
  for (const item of items) {
    const fullPath = resolve(dir, item);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(fullPath);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Extension directory contains unsupported symbolic link: ${normalizeManifestPath(root, fullPath)}`);
    }
    if (info.isDirectory()) {
      if (EXCLUDED_DIRS.has(item)) continue;
      const subEntries = await collectManifest(root, fullPath);
      entries.push(...subEntries);
    } else if (info.isFile()) {
      const ext = extname(item);
      const isPackageJson = item === 'package.json';
      if (!isPackageJson && !HASH_INCLUDED_EXTENSIONS.has(ext)) continue;
      // relativePath is relative to the extension directory root and normalized for cross-platform determinism.
      const relativePath = normalizeManifestPath(root, fullPath);
      const content = await readFile(fullPath);
      entries.push([relativePath, content]);
    }
  }
  return entries;
}

async function addExplicitEntrypoint(root: string, entrypoint: string, manifest: Array<[string, Buffer]>): Promise<void> {
  const resolvedEntrypoint = resolve(entrypoint);
  if (!isPathInside(resolvedEntrypoint, root)) return;
  const relativePath = normalizeManifestPath(root, resolvedEntrypoint);
  if (manifest.some(([existingPath]) => existingPath === relativePath)) return;
  if (!HASH_INCLUDED_EXTENSIONS.has(extname(resolvedEntrypoint))) return;
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(resolvedEntrypoint);
  } catch {
    return;
  }
  if (!info.isFile()) return;
  const content = await readFile(resolvedEntrypoint);
  manifest.push([relativePath, content]);
}

function updateLengthPrefixed(hash: ReturnType<typeof createHash>, value: Buffer): void {
  hash.update(String(value.byteLength));
  hash.update('\0');
  hash.update(value);
  hash.update('\0');
}

function normalizeManifestPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function isPathInside(path: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
