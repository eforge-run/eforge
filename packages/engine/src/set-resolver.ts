/**
 * Generic three-tier set-artifact resolver.
 *
 * Supports the three configuration tiers:
 *   - project-local: `<cwd>/.eforge/<kind.dirSegment>/`  (gitignored, highest precedence)
 *   - project-team:  `<configDir>/<kind.dirSegment>/`     (checked in, mid precedence)
 *   - user:          `~/.config/eforge/<kind.dirSegment>/` (user-global, lowest precedence)
 *
 * Any set kind (profiles, playbooks, …) registers with the resolver by providing
 * a `SetKind` descriptor. The resolver scans all three tiers, returns merged
 * listings with full shadow chains, and locates the highest-precedence copy of a
 * named artifact.
 */
import { readdir, access } from 'node:fs/promises';
import { resolve, basename, extname } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which configuration tier an artifact was loaded from. */
export type SetArtifactSource = 'project-local' | 'project-team' | 'user';

/**
 * Which lower-precedence tiers also contain an artifact with the same name.
 * Only `'project-team'` and `'user'` appear here because only project-local
 * and project-team can shadow lower tiers (user is the lowest).
 */
export type SetArtifactShadow = 'project-team' | 'user';

/** A single artifact entry in the merged listing returned by `listSetArtifacts`. */
export interface SetArtifactEntry {
  /** Artifact name (file basename without extension). */
  name: string;
  /** Absolute path to the file. */
  path: string;
  /** Which tier this (highest-precedence) copy came from. */
  source: SetArtifactSource;
  /**
   * Full shadow chain — all lower-precedence tiers that also have an artifact
   * with this name. Listed highest-precedence first.
   * Empty when no lower tier has the same name.
   */
  shadows: SetArtifactShadow[];
}

/**
 * Descriptor for a set kind. Register one per artifact category
 * (e.g. profiles, playbooks).
 */
export interface SetKind {
  /** Subdirectory name within each tier config directory (e.g. `'profiles'`, `'playbooks'`). */
  dirSegment: string;
  /** File extension without the leading dot (e.g. `'yaml'`, `'md'`). */
  fileExtension: string;
}

/** Options for resolver operations. */
export interface SetResolverOpts {
  /** Absolute path to the project-team eforge config directory (`eforge/`). */
  configDir: string;
  /** Project root (used to resolve `.eforge/` project-local paths). */
  cwd: string;
}

// ---------------------------------------------------------------------------
// Tier path helpers
// ---------------------------------------------------------------------------

/** Return the user XDG eforge config directory (`~/.config/eforge/`). */
function userEforgeConfigDir(): string {
  const base = process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config');
  return resolve(base, 'eforge');
}

const LOCAL_CONFIG_SUBDIR = '.eforge';

/** Return the project-local set directory (`<cwd>/.eforge/<kind.dirSegment>/`). */
export function projectLocalSetDir(kind: SetKind, cwd: string): string {
  return resolve(cwd, LOCAL_CONFIG_SUBDIR, kind.dirSegment);
}

/** Return the project-team set directory (`<configDir>/<kind.dirSegment>/`). */
export function projectTeamSetDir(kind: SetKind, configDir: string): string {
  return resolve(configDir, kind.dirSegment);
}

/** Return the user-scope set directory (`~/.config/eforge/<kind.dirSegment>/`). */
export function userSetDir(kind: SetKind): string {
  return resolve(userEforgeConfigDir(), kind.dirSegment);
}

// ---------------------------------------------------------------------------
// Internal scanner
// ---------------------------------------------------------------------------

type RawEntry = { name: string; path: string; source: SetArtifactSource };

async function scanDir(
  dir: string,
  source: SetArtifactSource,
  ext: string,
): Promise<RawEntry[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: RawEntry[] = [];
  for (const entry of entries.sort()) {
    if (extname(entry) !== `.${ext}`) continue;
    const name = basename(entry, `.${ext}`);
    out.push({ name, path: resolve(dir, entry), source });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all artifacts for a given kind across all three tiers.
 *
 * The returned list is **merged**: each artifact name appears at most once.
 * The highest-precedence tier wins (project-local > project-team > user).
 * The winning entry's `shadows` array lists every lower-precedence tier that
 * also has an artifact with the same name (full chain, not just the immediate
 * parent).
 *
 * Artifacts in non-winning tiers are omitted from the list entirely.
 */
export async function listSetArtifacts(
  kind: SetKind,
  opts: SetResolverOpts,
): Promise<SetArtifactEntry[]> {
  const [localRaw, projectRaw, userRaw] = await Promise.all([
    scanDir(projectLocalSetDir(kind, opts.cwd), 'project-local', kind.fileExtension),
    scanDir(projectTeamSetDir(kind, opts.configDir), 'project-team', kind.fileExtension),
    scanDir(userSetDir(kind), 'user', kind.fileExtension),
  ]);

  const localNames = new Set(localRaw.map((e) => e.name));
  const projectNames = new Set(projectRaw.map((e) => e.name));

  const result: SetArtifactEntry[] = [];

  // Project-local entries: highest precedence, never shadowed.
  for (const e of localRaw) {
    const shadows: SetArtifactShadow[] = [];
    if (projectNames.has(e.name)) shadows.push('project-team');
    if (userRaw.some((u) => u.name === e.name)) shadows.push('user');
    result.push({ name: e.name, path: e.path, source: 'project-local', shadows });
  }

  // Project-team entries: only included when no local copy exists.
  for (const e of projectRaw) {
    if (localNames.has(e.name)) continue;
    const shadows: SetArtifactShadow[] = [];
    if (userRaw.some((u) => u.name === e.name)) shadows.push('user');
    result.push({ name: e.name, path: e.path, source: 'project-team', shadows });
  }

  // User entries: only included when no local or project-team copy exists.
  for (const e of userRaw) {
    if (localNames.has(e.name) || projectNames.has(e.name)) continue;
    result.push({ name: e.name, path: e.path, source: 'user', shadows: [] });
  }

  return result;
}

/**
 * Locate the highest-precedence copy of a named artifact across all three tiers.
 *
 * Returns `{ path, source }` for the winning tier, or `null` when no tier has
 * an artifact with that name.
 */
export async function loadSetArtifact(
  kind: SetKind,
  name: string,
  opts: SetResolverOpts,
): Promise<{ path: string; source: SetArtifactSource } | null> {
  // Check tiers in precedence order.
  const candidates: Array<{ path: string; source: SetArtifactSource }> = [
    {
      path: resolve(projectLocalSetDir(kind, opts.cwd), `${name}.${kind.fileExtension}`),
      source: 'project-local',
    },
    {
      path: resolve(projectTeamSetDir(kind, opts.configDir), `${name}.${kind.fileExtension}`),
      source: 'project-team',
    },
    {
      path: resolve(userSetDir(kind), `${name}.${kind.fileExtension}`),
      source: 'user',
    },
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate.path);
      return candidate;
    } catch {
      // not found in this tier — try next
    }
  }
  return null;
}
