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

import { parseNameStatusZ, parseNumstatZ } from './git-diff-stats.js';

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
  /**
   * Global cap on the total byte length of `renderedText`. When the sum of
   * per-file bodies would exceed this cap, the largest non-summarized files
   * are iteratively demoted to `[summarized: ..., demoted by global cap]`
   * markers (ties broken by `path` ascending) until the total falls under
   * the cap. Default `500_000`.
   */
  globalBudgetBytes?: number;
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
  /** Effective global byte cap applied to `renderedText`. */
  globalBudgetBytes: number;
  /** Files summarized because their per-file body exceeded the per-file budget (or the changed-line threshold, or binary). */
  summarizedByPerFileBudget: number;
  /** Files additionally demoted to a summary marker because the total exceeded `globalBudgetBytes`. */
  summarizedByGlobalCap: number;
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
    globalBudgetBytes = 500_000,
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
    return {
      summary: '',
      files: [],
      renderedText: '',
      totalBytes: 0,
      summarizedCount: 0,
      globalBudgetBytes,
      summarizedByPerFileBudget: 0,
      summarizedByGlobalCap: 0,
    };
  }

  const statusByPath = parseNameStatusZ(nameStatusRaw);
  const numstatEntries = parseNumstatZ(numstatRaw);

  if (numstatEntries.length === 0) {
    return {
      summary: '',
      files: [],
      renderedText: '',
      totalBytes: 0,
      summarizedCount: 0,
      globalBudgetBytes,
      summarizedByPerFileBudget: 0,
      summarizedByGlobalCap: 0,
    };
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

  const summarizedByPerFileBudget = files.reduce((n, f) => n + (f.summarized ? 1 : 0), 0);

  // --- Global cap pass: demote largest non-summarized files until total <= globalBudgetBytes ---
  const computeTotalBytes = (): number => {
    const chunks = files.map((f) => f.body).filter((b) => b.length > 0);
    return Buffer.byteLength([summary, ...chunks].join('\n\n'), 'utf-8');
  };

  let summarizedByGlobalCap = 0;
  while (computeTotalBytes() > globalBudgetBytes) {
    // Find largest non-summarized, non-binary file (ties: path asc)
    const candidates = files
      .filter((f) => !f.summarized)
      .sort((a, b) => {
        const db = Buffer.byteLength(b.body, 'utf-8') - Buffer.byteLength(a.body, 'utf-8');
        if (db !== 0) return db;
        return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
      });
    if (candidates.length === 0) break;
    const victim = candidates[0];
    victim.summarized = true;
    victim.body = `diff --git a/${victim.path} b/${victim.path}\n[summarized: status=${victim.status} +${victim.added} -${victim.deleted}, demoted by global cap]`;
    summarizedByGlobalCap++;
  }

  // --- Compose final rendered text ---
  const bodyChunks = files.map((f) => f.body).filter((b) => b.length > 0);
  const renderedText = [summary, ...bodyChunks].join('\n\n');
  const summarizedCount = summarizedByPerFileBudget + summarizedByGlobalCap;

  return {
    summary,
    files,
    renderedText,
    totalBytes: Buffer.byteLength(renderedText, 'utf-8'),
    summarizedCount,
    globalBudgetBytes,
    summarizedByPerFileBudget,
    summarizedByGlobalCap,
  };
}

