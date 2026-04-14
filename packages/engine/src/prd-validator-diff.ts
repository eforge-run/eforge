/**
 * Per-file budgeted diff construction for the PRD validator.
 *
 * Replaces the legacy monolithic `git diff baseBranch...HEAD` + 80K slice with a
 * structured, per-file budget: every changed file either appears verbatim or is
 * replaced with a one-line `[summarized: ...]` marker. No global truncation, so
 * alphabetically-early large files (e.g. `package-lock.json`) cannot starve
 * alphabetically-later real source changes.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const GIT_MAX_BUFFER = 100 * 1024 * 1024;

export interface DiffFile {
  /** Path of the changed file (new path for renames). */
  path: string;
  /** Raw `--name-status` code (e.g. `M`, `A`, `D`, `R100`, `C90`). */
  status: string;
  /** Lines added, or -1 for binary files. */
  added: number;
  /** Lines deleted, or -1 for binary files. */
  deleted: number;
  /** True when `--numstat` reports `-\t-` (binary). */
  binary: boolean;
  /** True when the per-file body was replaced with a summary marker. */
  summarized: boolean;
  /**
   * Per-file rendered body — either a full `git diff -- <path>` block, a
   * `diff --git a/<path> b/<path>\n[summarized: ...]` marker, or a name-only
   * marker for binary files.
   */
  body: string;
}

export interface BuildPrdDiffOptions {
  cwd: string;
  baseRef: string;
  /** Max bytes for a single file's diff body before it is summarized. Default 20_000. */
  perFileBudgetBytes?: number;
  /** Max `added + deleted` before a file is summarized. Default 2_000. */
  maxChangedLinesBeforeSummary?: number;
}

export interface BuildPrdDiffResult {
  /** Output of `git diff --name-status` + `git diff --numstat` concatenated. */
  summary: string;
  /** One entry per changed file, in enumeration order. */
  files: DiffFile[];
  /**
   * Concatenation of `summary` followed by every file's `body`, separated by
   * blank lines. The exact string passed to the PRD validator agent.
   */
  renderedText: string;
  /** Total byte length of `renderedText`. */
  totalBytes: number;
  /** Count of files whose bodies were replaced with a summary marker. */
  summarizedCount: number;
}

/**
 * Build a per-file-budgeted diff between `baseRef` and `HEAD` inside `cwd`.
 *
 * Enumeration uses `git diff --name-status -z` + `git diff --numstat -z` so
 * paths with spaces or unusual characters are handled safely. Each file's
 * body is produced by a dedicated `git diff baseRef...HEAD -- <path>` call
 * and then either kept verbatim or replaced with a marker based on the
 * per-file budgets.
 */
export async function buildPrdValidatorDiff(
  opts: BuildPrdDiffOptions,
): Promise<BuildPrdDiffResult> {
  const {
    cwd,
    baseRef,
    perFileBudgetBytes = 20_000,
    maxChangedLinesBeforeSummary = 2_000,
  } = opts;

  const range = `${baseRef}...HEAD`;

  // --- Enumerate changed files ---
  let nameStatusRaw = '';
  let numstatRaw = '';
  let nameStatusHuman = '';
  let numstatHuman = '';
  try {
    const [ns, nm, nsh, nmh] = await Promise.all([
      exec('git', ['diff', '--name-status', '-z', range], { cwd, maxBuffer: GIT_MAX_BUFFER }),
      exec('git', ['diff', '--numstat', '-z', range], { cwd, maxBuffer: GIT_MAX_BUFFER }),
      exec('git', ['diff', '--name-status', range], { cwd, maxBuffer: GIT_MAX_BUFFER }),
      exec('git', ['diff', '--numstat', range], { cwd, maxBuffer: GIT_MAX_BUFFER }),
    ]);
    nameStatusRaw = ns.stdout;
    numstatRaw = nm.stdout;
    nameStatusHuman = nsh.stdout;
    numstatHuman = nmh.stdout;
  } catch {
    // No changes or git failure — empty result
    return { summary: '', files: [], renderedText: '', totalBytes: 0, summarizedCount: 0 };
  }

  const statusByPath = parseNameStatusZ(nameStatusRaw);
  const numstatEntries = parseNumstatZ(numstatRaw);

  if (numstatEntries.length === 0) {
    return { summary: '', files: [], renderedText: '', totalBytes: 0, summarizedCount: 0 };
  }

  // --- Build per-file bodies ---
  const files: DiffFile[] = [];
  for (const entry of numstatEntries) {
    const status = statusByPath.get(entry.path) ?? 'M';
    const file: DiffFile = {
      path: entry.path,
      status,
      added: entry.binary ? -1 : entry.added,
      deleted: entry.binary ? -1 : entry.deleted,
      binary: entry.binary,
      summarized: false,
      body: '',
    };

    if (entry.binary) {
      file.summarized = true;
      file.body = `diff --git a/${entry.path} b/${entry.path}\n[summarized: status=${status} binary file, per-file diff omitted]`;
      files.push(file);
      continue;
    }

    const changedLines = entry.added + entry.deleted;
    if (changedLines > maxChangedLinesBeforeSummary) {
      file.summarized = true;
      file.body = `diff --git a/${entry.path} b/${entry.path}\n[summarized: status=${status} +${entry.added} -${entry.deleted}, per-file diff omitted (${changedLines} changed lines exceeds threshold)]`;
      files.push(file);
      continue;
    }

    let body = '';
    try {
      const { stdout } = await exec('git', ['diff', range, '--', entry.path], { cwd, maxBuffer: GIT_MAX_BUFFER });
      body = stdout;
    } catch {
      body = '';
    }

    if (body.length > perFileBudgetBytes) {
      file.summarized = true;
      file.body = `diff --git a/${entry.path} b/${entry.path}\n[summarized: status=${status} +${entry.added} -${entry.deleted}, per-file diff omitted (${body.length} bytes exceeds per-file budget)]`;
    } else {
      file.body = body;
    }
    files.push(file);
  }

  // --- Compose rendered text ---
  const summary = [
    '## Changed files (name-status)',
    '',
    nameStatusHuman.trimEnd(),
    '',
    '## Changed files (numstat: added\tdeleted\tpath)',
    '',
    numstatHuman.trimEnd(),
    '',
  ].join('\n');

  const bodyChunks = files.map((f) => f.body).filter((b) => b.length > 0);
  const renderedText = [summary, ...bodyChunks].join('\n\n');
  const summarizedCount = files.reduce((n, f) => n + (f.summarized ? 1 : 0), 0);

  return {
    summary,
    files,
    renderedText,
    totalBytes: Buffer.byteLength(renderedText, 'utf-8'),
    summarizedCount,
  };
}

// -----------------------------------------------------------------------------
// Parsers for NUL-delimited `git diff` output
// -----------------------------------------------------------------------------

/**
 * Parse `git diff --name-status -z` output into a map keyed by (new) path.
 *
 * Token layout (NUL-separated):
 *   `<status>\0<path>\0`                 for M/A/D/T/U
 *   `<status>\0<old-path>\0<new-path>\0` for R<score>/C<score>
 */
function parseNameStatusZ(raw: string): Map<string, string> {
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

interface NumstatEntry {
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
function parseNumstatZ(raw: string): NumstatEntry[] {
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
