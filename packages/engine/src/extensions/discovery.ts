import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';

import { SCOPES, getScopeDirectory, type Scope, type ScopeResolverOpts } from '@eforge-build/scopes';

import { hashExtensionDirectory, hashExtensionFile } from './hash.js';
import { getTrustRecord, getTrustStorePath, readTrustStore, type ExtensionTrustStore } from './trust-store.js';
import type {
  NativeExtensionCandidate,
  NativeExtensionDiagnostic,
  NativeExtensionDiscoveryResult,
  NativeExtensionFormat,
  NativeExtensionLayout,
  NativeExtensionScope,
  NativeExtensionShadow,
  NativeExtensionTrust,
  NativeExtensionTrustState,
} from './types.js';

const EXTENSION_DIR = 'extensions';
const SUPPORTED_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs']);
const ENTRYPOINT_NAMES = ['index.ts', 'index.mts', 'index.js', 'index.mjs'];
const PRECEDENCE: readonly Scope[] = [...SCOPES].reverse();

interface ResolvedLayout {
  name: string;
  path: string;
  entrypoint: string;
  format: NativeExtensionFormat;
  layout: NativeExtensionLayout;
}

interface RawAutoCandidate extends ResolvedLayout {
  scope: Scope;
}

export async function discoverNativeExtensions(options: {
  cwd: string;
  configDir: string;
  config: {
    enabled: boolean;
    trustProjectExtensions: boolean;
    include?: string[];
    exclude?: string[];
    paths?: string[];
  };
}): Promise<NativeExtensionDiscoveryResult> {
  const diagnostics: NativeExtensionDiagnostic[] = [];
  if (!options.config.enabled) return { candidates: [], diagnostics };

  const scopeOpts: ScopeResolverOpts = { cwd: options.cwd, configDir: options.configDir };

  // Read the trust store once for the entire discovery call.
  const eforgeDir = resolve(options.cwd, '.eforge');
  const trustStorePath = getTrustStorePath(eforgeDir);
  const trustStore = await readTrustStore(eforgeDir);

  const autoCandidates: RawAutoCandidate[] = [];
  const shadowedCandidates: NativeExtensionCandidate[] = [];

  for (const scope of PRECEDENCE) {
    const scopeDir = getScopeDirectory(scope, scopeOpts);
    const extensionsDir = resolve(scopeDir, EXTENSION_DIR);
    for (const entry of await readDirectoryEntries(extensionsDir)) {
      const entryPath = resolve(extensionsDir, entry);
      const layout = await resolveExtensionLayout(entryPath);
      if (!layout) {
        diagnostics.push({
          severity: 'warning',
          code: 'extension:unsupported-layout',
          message: `Skipping unsupported extension layout at ${entryPath}`,
          path: entryPath,
          scope,
          source: 'auto',
        });
        continue;
      }
      if (!passesAutoFilters(layout.name, options.config.include, options.config.exclude)) continue;
      autoCandidates.push({ ...layout, scope });
    }
  }

  const winners: NativeExtensionCandidate[] = [];
  const byName = new Map<string, RawAutoCandidate[]>();
  for (const candidate of autoCandidates) {
    const entries = byName.get(candidate.name) ?? [];
    entries.push(candidate);
    byName.set(candidate.name, entries);
  }

  for (const [name, entries] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    entries.sort((a, b) => PRECEDENCE.indexOf(a.scope) - PRECEDENCE.indexOf(b.scope));
    const [winner, ...shadows] = entries;
    const shadowEntries: NativeExtensionShadow[] = shadows.map((shadow) => ({
      name: shadow.name,
      path: shadow.path,
      entrypoint: shadow.entrypoint,
      scope: shadow.scope,
      format: shadow.format,
      layout: shadow.layout,
    }));
    const winnerTrust = initialTrustForScope(winner.scope);
    winners.push({
      name,
      path: winner.path,
      entrypoint: winner.entrypoint,
      scope: winner.scope,
      source: 'auto',
      format: winner.format,
      layout: winner.layout,
      trust: winnerTrust,
      status: 'pending',
      shadows: shadowEntries,
      diagnostics: [],
    });
    for (const shadow of shadows) {
      const shadowTrust = initialTrustForScope(shadow.scope);
      shadowedCandidates.push({
        name: shadow.name,
        path: shadow.path,
        entrypoint: shadow.entrypoint,
        scope: shadow.scope,
        source: 'auto',
        format: shadow.format,
        layout: shadow.layout,
        trust: shadowTrust,
        status: 'shadowed',
        shadows: [],
        diagnostics: [],
      });
    }
  }

  const explicitCandidates: NativeExtensionCandidate[] = [];
  const autoWinnerNames = new Set(winners.map((candidate) => candidate.name));
  const explicitByName = new Map<string, NativeExtensionCandidate[]>();
  for (const configuredPath of options.config.paths ?? []) {
    const absolutePath = isAbsolute(configuredPath) ? configuredPath : resolve(options.cwd, configuredPath);
    const layout = await resolveExtensionLayout(absolutePath);
    if (!layout) {
      const diagnostic: NativeExtensionDiagnostic = {
        severity: 'error',
        code: 'extension:unsupported-explicit-layout',
        message: `Explicit extension path is not a supported extension module: ${absolutePath}`,
        path: absolutePath,
        source: 'explicit',
      };
      diagnostics.push(diagnostic);
      const explicitScope = scopeForPath(absolutePath, scopeOpts);
      explicitCandidates.push({
        name: basenameWithoutKnownExtension(absolutePath),
        path: absolutePath,
        scope: explicitScope,
        source: 'explicit',
        trust: initialTrustForScope(explicitScope),
        status: 'error',
        shadows: [],
        diagnostics: [diagnostic],
      });
      continue;
    }
    const scope = scopeForPath(layout.path, scopeOpts);
    const candidate: NativeExtensionCandidate = {
      name: layout.name,
      path: layout.path,
      entrypoint: layout.entrypoint,
      scope,
      source: 'explicit',
      format: layout.format,
      layout: layout.layout,
      trust: initialTrustForScope(scope),
      status: 'pending',
      shadows: [],
      diagnostics: [],
    };
    explicitCandidates.push(candidate);
    const sameName = explicitByName.get(candidate.name) ?? [];
    sameName.push(candidate);
    explicitByName.set(candidate.name, sameName);
  }

  for (const [name, candidates] of explicitByName.entries()) {
    if (candidates.length > 1 || autoWinnerNames.has(name)) {
      const message = autoWinnerNames.has(name)
        ? `Explicit extension "${name}" collides with an auto-discovered extension`
        : `Duplicate explicit extension name "${name}"`;
      for (const candidate of candidates) {
        const diagnostic: NativeExtensionDiagnostic = {
          severity: 'error',
          code: 'extension:duplicate-explicit-name',
          message,
          name,
          path: candidate.path,
          scope: candidate.scope,
          source: 'explicit',
        };
        candidate.status = 'error';
        candidate.diagnostics.push(diagnostic);
        diagnostics.push(diagnostic);
      }
    }
  }

  // Enrich all candidates with trust state and hash metadata.
  const allCandidates = [...winners, ...shadowedCandidates, ...explicitCandidates];
  await enrichCandidatesWithTrust(allCandidates, trustStore, trustStorePath);

  return {
    candidates: allCandidates,
    diagnostics,
  };
}

/**
 * Post-process candidates to assign trustState, trust, and hash metadata.
 *
 * - Project-team candidates: compute content hash, look up trust record, classify state.
 * - All other candidates (user, project-local, external): trustState = 'not-required', trust = 'trusted'.
 */
async function enrichCandidatesWithTrust(
  candidates: NativeExtensionCandidate[],
  trustStore: ExtensionTrustStore,
  trustStorePath: string,
): Promise<void> {
  for (const candidate of candidates) {
    if (candidate.scope !== 'project-team') {
      candidate.trustState = 'not-required';
      candidate.trust = 'trusted';
      continue;
    }

    // Compute content hash for the extension.
    let hash: string | undefined;
    try {
      if (candidate.layout === 'directory') {
        hash = await hashExtensionDirectory(candidate.path, candidate.entrypoint);
      } else if (candidate.entrypoint) {
        hash = await hashExtensionFile(candidate.entrypoint);
      }
    } catch {
      // If hashing fails, treat as untrusted.
    }

    const record = hash !== undefined ? getTrustRecord(trustStore, candidate.name) : undefined;
    let trustState: NativeExtensionTrustState;
    let trust: NativeExtensionTrust;

    if (hash === undefined || !record) {
      trustState = 'untrusted';
      trust = 'untrusted';
    } else if (record.hash === hash) {
      trustState = 'trusted';
      trust = 'trusted';
    } else {
      trustState = 'changed';
      trust = 'untrusted';
    }

    candidate.trustState = trustState;
    candidate.trust = trust;
    candidate.trustStorePath = trustStorePath;

    if (hash !== undefined) {
      candidate.currentHash = hash;
    }
    if (record) {
      candidate.trustedHash = record.hash;
      candidate.trustedAt = record.trustedAt;
      if (record.trustedBy !== undefined) {
        candidate.trustedBy = record.trustedBy;
      }
    }
  }
}

async function resolveExtensionLayout(path: string): Promise<ResolvedLayout | null> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch {
    return null;
  }

  if (info.isFile()) {
    const ext = extname(path);
    if (!SUPPORTED_EXTENSIONS.has(ext)) return null;
    return {
      name: basename(path, ext),
      path,
      entrypoint: path,
      format: formatFromExtension(ext),
      layout: 'file',
    };
  }

  if (!info.isDirectory()) return null;
  const packageEntrypoint = await resolvePackageEntrypoint(path);
  if (packageEntrypoint) {
    return {
      name: basename(path),
      path,
      entrypoint: packageEntrypoint,
      format: formatFromExtension(extname(packageEntrypoint)),
      layout: 'directory',
    };
  }

  for (const entry of ENTRYPOINT_NAMES) {
    const candidate = resolve(path, entry);
    if (await isRegularFile(candidate)) {
      return {
        name: basename(path),
        path,
        entrypoint: candidate,
        format: formatFromExtension(extname(candidate)),
        layout: 'directory',
      };
    }
  }
  return null;
}

async function resolvePackageEntrypoint(dir: string): Promise<string | null> {
  const packagePath = resolve(dir, 'package.json');
  let data: unknown;
  try {
    data = JSON.parse(await readFile(packagePath, 'utf-8'));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const pkg = data as Record<string, unknown>;
  const exportPath = entrypointFromExports(pkg.exports);
  const mainPath = typeof pkg.main === 'string' ? pkg.main : undefined;
  for (const candidate of [exportPath, mainPath]) {
    if (!candidate) continue;
    const resolved = resolve(dir, candidate);
    if (!isPathInside(resolved, dir)) continue;
    if (!SUPPORTED_EXTENSIONS.has(extname(resolved))) continue;
    if (await isRegularFile(resolved)) return resolved;
  }
  return null;
}

function entrypointFromExports(exportsField: unknown): string | undefined {
  if (typeof exportsField === 'string') return exportsField;
  if (!exportsField || typeof exportsField !== 'object') return undefined;
  const obj = exportsField as Record<string, unknown>;
  const root = obj['.'] ?? obj;
  if (typeof root === 'string') return root;
  if (!root || typeof root !== 'object') return undefined;
  const rootObj = root as Record<string, unknown>;
  for (const key of ['import', 'default']) {
    if (typeof rootObj[key] === 'string') return rootObj[key] as string;
  }
  return undefined;
}

async function readDirectoryEntries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

function formatFromExtension(ext: string): NativeExtensionFormat {
  switch (ext) {
    case '.ts': return 'ts';
    case '.mts': return 'mts';
    case '.js': return 'js';
    case '.mjs': return 'mjs';
    default: throw new Error(`Unsupported extension format: ${ext}`);
  }
}

function basenameWithoutKnownExtension(path: string): string {
  const ext = extname(path);
  return SUPPORTED_EXTENSIONS.has(ext) ? basename(path, ext) : basename(path);
}

function passesAutoFilters(name: string, include: string[] | undefined, exclude: string[] | undefined): boolean {
  if (include && !include.includes(name)) return false;
  if (exclude?.includes(name)) return false;
  return true;
}

/**
 * Returns the initial (pre-trust-store-lookup) trust value for a scope.
 * For project-team candidates, this is a placeholder; it will be overwritten
 * during `enrichCandidatesWithTrust`. For all other scopes, trust is always granted.
 */
function initialTrustForScope(scope: NativeExtensionScope): NativeExtensionTrust {
  return scope === 'project-team' ? 'untrusted' : 'trusted';
}

function scopeForPath(path: string, opts: ScopeResolverOpts): NativeExtensionScope {
  const resolvedPath = resolve(path);
  for (const scope of PRECEDENCE) {
    const dir = getScopeDirectory(scope, opts);
    if (isPathInside(resolvedPath, dir)) return scope;
  }
  return 'external';
}

function isPathInside(path: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
