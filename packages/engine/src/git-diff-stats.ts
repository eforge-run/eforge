/**
 * Shared NUL-delimited git diff parsers for per-agent attribution.
 *
 * Extracted from `prd-validator-diff.ts` so the same battle-tested parsers
 * can be reused for `agent:activity` diffstat computation.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const GIT_MAX_BUFFER = 100 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Parsers for NUL-delimited `git diff` output
// ---------------------------------------------------------------------------

/**
 * Parse `git diff --name-status -z` output into a map keyed by (new) path.
 *
 * Token layout (NUL-separated):
 *   `<status>\0<path>\0`                 for M/A/D/T/U
 *   `<status>\0<old-path>\0<new-path>\0` for R<score>/C<score>
 */
export function parseNameStatusZ(raw: string): Map<string, string> {
  const tokens = raw.split('\0');
  // `.split` on trailing NUL leaves an empty last element — drop trailing empties
  while (tokens.length > 0 && tokens[tokens.length - 1] === '') tokens.pop();

  const map = new Map<string, string>();
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i];
    if (!status) { i++; continue; }
    const isRenameOrCopy = status.startsWith('R') || status.startsWith('C');
    if (isRenameOrCopy) {
      const newPath = tokens[i + 2];
      if (newPath) map.set(newPath, status);
      i += 3;
    } else {
      const path = tokens[i + 1];
      if (path) map.set(path, status);
      i += 2;
    }
  }
  return map;
}

export interface NumstatEntry {
  path: string;
  added: number;
  deleted: number;
  binary: boolean;
}

/**
 * Parse `git diff --numstat -z` output.
 *
 * Token layout:
 *   `<added>\t<deleted>\t<path>\0`                     for non-renames
 *   `<added>\t<deleted>\t\0<old-path>\0<new-path>\0`   for renames
 *
 * Binary files report `-\t-` for added/deleted.
 */
export function parseNumstatZ(raw: string): NumstatEntry[] {
  const tokens = raw.split('\0');
  while (tokens.length > 0 && tokens[tokens.length - 1] === '') tokens.pop();

  const out: NumstatEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token) { i++; continue; }
    // Split only on the first two tabs — the path itself may contain tabs
    const firstTab = token.indexOf('\t');
    if (firstTab < 0) { i++; continue; }
    const secondTab = token.indexOf('\t', firstTab + 1);
    if (secondTab < 0) { i++; continue; }

    const addedStr = token.slice(0, firstTab);
    const deletedStr = token.slice(firstTab + 1, secondTab);
    const pathInline = token.slice(secondTab + 1);
    const binary = addedStr === '-' && deletedStr === '-';
    const added = binary ? 0 : parseInt(addedStr, 10);
    const deleted = binary ? 0 : parseInt(deletedStr, 10);

    let path: string;
    if (pathInline === '') {
      // Rename: next two tokens are old-path, new-path
      path = tokens[i + 2] ?? '';
      i += 3;
    } else {
      path = pathInline;
      i += 1;
    }
    if (!path) continue;

    out.push({ path, added, deleted, binary });
  }
  return out;
}

// ---------------------------------------------------------------------------
// High-level collectDiffStats helper
// ---------------------------------------------------------------------------

export interface DiffStatFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface DiffStatTotals {
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface DiffStatResult {
  files: DiffStatFile[];
  totals: DiffStatTotals;
}

/**
 * Collect file-level and summary diffstats between `fromRef` and `toRef` (or
 * `fromRef...HEAD` when `toRef` is omitted) inside `cwd`.
 *
 * When `mode` is `'working-tree'`, diffs `fromRef` against the working tree
 * (staged + unstaged changes to tracked files, plus untracked files). This is
 * needed for agents that write worktree-only changes without committing (e.g.,
 * the review-fixer).
 *
 * Returns empty totals (no throw) on git failure or no-changes.
 */
export async function collectDiffStats(opts: {
  cwd: string;
  fromRef: string;
  toRef?: string;
  mode?: 'commit-range' | 'working-tree';
}): Promise<DiffStatResult> {
  const { cwd, fromRef, toRef, mode } = opts;

  if (mode === 'working-tree') {
    // Compare fromRef against the working tree: tracked file diffs (staged +
    // unstaged) plus untracked files via git ls-files.
    let nameStatusRaw = '';
    let numstatRaw = '';
    let untrackedRaw = '';

    try {
      const [ns, nm, ut] = await Promise.all([
        exec('git', ['diff', '--name-status', '-z', fromRef], { cwd, maxBuffer: GIT_MAX_BUFFER }),
        exec('git', ['diff', '--numstat', '-z', fromRef], { cwd, maxBuffer: GIT_MAX_BUFFER }),
        exec('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd, maxBuffer: GIT_MAX_BUFFER }),
      ]);
      nameStatusRaw = ns.stdout;
      numstatRaw = nm.stdout;
      untrackedRaw = ut.stdout;
    } catch {
      return { files: [], totals: { filesChanged: 0, additions: 0, deletions: 0 } };
    }

    const statusByPath = parseNameStatusZ(nameStatusRaw);
    const numstatEntries = parseNumstatZ(numstatRaw);

    let totalAdditions = 0;
    let totalDeletions = 0;

    const files: DiffStatFile[] = numstatEntries.map((entry) => {
      const status = statusByPath.get(entry.path) ?? 'M';
      totalAdditions += entry.added;
      totalDeletions += entry.deleted;
      return {
        path: entry.path,
        status,
        additions: entry.added,
        deletions: entry.deleted,
        binary: entry.binary,
      };
    });

    // Add untracked files (new files not yet staged, status 'A')
    const trackedPaths = new Set(files.map((f) => f.path));
    const untrackedFiles = untrackedRaw.split('\0').filter(Boolean);
    for (const path of untrackedFiles) {
      if (!trackedPaths.has(path)) {
        files.push({ path, status: 'A', additions: 0, deletions: 0, binary: false });
      }
    }

    return {
      files,
      totals: {
        filesChanged: files.length,
        additions: totalAdditions,
        deletions: totalDeletions,
      },
    };
  }

  // Default: commit-range mode
  const range = toRef ? `${fromRef}...${toRef}` : `${fromRef}...HEAD`;

  let nameStatusRaw = '';
  let numstatRaw = '';

  try {
    const [ns, nm] = await Promise.all([
      exec('git', ['diff', '--name-status', '-z', range], { cwd, maxBuffer: GIT_MAX_BUFFER }),
      exec('git', ['diff', '--numstat', '-z', range], { cwd, maxBuffer: GIT_MAX_BUFFER }),
    ]);
    nameStatusRaw = ns.stdout;
    numstatRaw = nm.stdout;
  } catch {
    // Git failure or no changes — return empty
    return { files: [], totals: { filesChanged: 0, additions: 0, deletions: 0 } };
  }

  const statusByPath = parseNameStatusZ(nameStatusRaw);
  const numstatEntries = parseNumstatZ(numstatRaw);

  if (numstatEntries.length === 0) {
    return { files: [], totals: { filesChanged: 0, additions: 0, deletions: 0 } };
  }

  let totalAdditions = 0;
  let totalDeletions = 0;

  const files: DiffStatFile[] = numstatEntries.map((entry) => {
    const status = statusByPath.get(entry.path) ?? 'M';
    totalAdditions += entry.added;
    totalDeletions += entry.deleted;
    return {
      path: entry.path,
      status,
      additions: entry.added,
      deletions: entry.deleted,
      binary: entry.binary,
    };
  });

  return {
    files,
    totals: {
      filesChanged: files.length,
      additions: totalAdditions,
      deletions: totalDeletions,
    },
  };
}
