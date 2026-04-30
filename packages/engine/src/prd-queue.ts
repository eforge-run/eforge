/**
 * PRD queue loading, parsing, ordering, and status updates.
 * Scans a directory for .md files with YAML frontmatter, parses them
 * into QueuedPrd records, and resolves execution order using the
 * same dependency graph algorithm as plan orchestration.
 */

import { readFile, readdir, writeFile, mkdir, rm, open, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { resolve, basename } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod/v4';
import { resolveDependencyGraph } from './plan.js';
import { forgeCommit, retryOnLock } from './git.js';
import { composeCommitMessage } from './model-tracker.js';
import type { ModelTracker } from './model-tracker.js';
import { writeRecoverySidecar } from './recovery/sidecar.js';
import type { BuildFailureSummary, RecoveryVerdict } from './events.js';

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Frontmatter schema
// ---------------------------------------------------------------------------

const prdFrontmatterSchema = z.object({
  title: z.string(),
  created: z.string().optional(),
  priority: z.number().int().optional(),
  depends_on: z.array(z.string()).optional(),
  skip_reason: z.string().optional(),
});

export type PrdFrontmatter = z.output<typeof prdFrontmatterSchema>;

export interface QueuedPrd {
  /** Filename without extension — used as the PRD id */
  id: string;
  /** Absolute path to the PRD file */
  filePath: string;
  /** Parsed frontmatter */
  frontmatter: PrdFrontmatter;
  /** Full file content (frontmatter + body) */
  content: string;
  /** Last commit hash touching this file (empty string if untracked) */
  lastCommitHash: string;
  /** Last commit date for this file (empty string if untracked) */
  lastCommitDate: string;
}

// ---------------------------------------------------------------------------
// Frontmatter parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract YAML frontmatter from a markdown file.
 * Returns the parsed object or null if no frontmatter found.
 */
function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  // Simple YAML key-value parser (avoids full YAML dep for frontmatter)
  const lines = match[1].split('\n');
  const result: Record<string, unknown> = {};

  for (const line of lines) {
    const kvMatch = line.match(/^(\w[\w_]*)\s*:\s*(.*)/);
    if (!kvMatch) continue;
    const [, key, rawValue] = kvMatch;
    const value = rawValue.trim();

    // Handle arrays (inline [a, b] syntax)
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      result[key] = inner ? inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')) : [];
    }
    // Handle numbers
    else if (/^-?\d+$/.test(value)) {
      result[key] = parseInt(value, 10);
    }
    // Handle booleans
    else if (value === 'true' || value === 'false') {
      result[key] = value === 'true';
    }
    // Handle quoted strings
    else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      result[key] = value.slice(1, -1);
    }
    // Plain string
    else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Validate PRD frontmatter against the Zod schema.
 * Returns success/error result from safeParse.
 */
export function validatePrdFrontmatter(data: unknown): z.ZodSafeParseResult<PrdFrontmatter> {
  return prdFrontmatterSchema.safeParse(data);
}

// ---------------------------------------------------------------------------
// Queue loading
// ---------------------------------------------------------------------------

/**
 * Load all PRD files from a directory, parsing frontmatter and
 * fetching git metadata for each file.
 */
export async function loadQueue(dir: string, cwd: string): Promise<QueuedPrd[]> {
  const absDir = resolve(cwd, dir);
  let entries: string[];
  try {
    entries = await readdir(absDir);
  } catch {
    return []; // Directory doesn't exist — empty queue
  }

  const mdFiles = entries.filter((f) => f.endsWith('.md')).sort();
  const prds: QueuedPrd[] = [];

  for (const file of mdFiles) {
    const filePath = resolve(absDir, file);
    const content = await readFile(filePath, 'utf-8');
    const rawFrontmatter = parseFrontmatter(content);
    if (!rawFrontmatter) continue; // Skip files without frontmatter

    const parseResult = prdFrontmatterSchema.safeParse(rawFrontmatter);
    if (!parseResult.success) continue; // Skip files with invalid frontmatter

    const frontmatter = parseResult.data;
    const id = basename(file, '.md');

    // Get git metadata
    let lastCommitHash = '';
    let lastCommitDate = '';
    try {
      const { stdout } = await exec('git', ['log', '-1', '--format=%H %ci', '--', filePath], { cwd });
      const trimmed = stdout.trim();
      if (trimmed) {
        const spaceIdx = trimmed.indexOf(' ');
        lastCommitHash = trimmed.slice(0, spaceIdx);
        lastCommitDate = trimmed.slice(spaceIdx + 1);
      }
    } catch {
      // Not a git repo or file untracked — leave empty
    }

    prds.push({
      id,
      filePath,
      frontmatter,
      content,
      lastCommitHash,
      lastCommitDate,
    });
  }

  return prds;
}

// ---------------------------------------------------------------------------
// Queue ordering
// ---------------------------------------------------------------------------

/**
 * Resolve execution order for PRDs.
 * All PRDs in the queue directory are pending by definition (file-location state model).
 * Uses the same topological sort as plan orchestration for dependency ordering.
 * Within each wave, sorts by priority (ascending, nulls last) then created (ascending).
 */
export function resolveQueueOrder(prds: QueuedPrd[]): QueuedPrd[] {
  if (prds.length === 0) return [];

  // Build lookup of all PRD ids for dependency filtering
  const allIds = new Set(prds.map((p) => p.id));

  // Build plans-like structure for dependency resolution.
  // Filter out dependsOn entries that reference non-pending PRDs (e.g., completed)
  // since resolveDependencyGraph throws on unknown ids, and completed deps are
  // already satisfied.
  const plans = prds.map((p) => ({
    id: p.id,
    name: p.frontmatter.title,
    dependsOn: (p.frontmatter.depends_on ?? []).filter((dep) => allIds.has(dep)),
    branch: '', // Not used for queue ordering
  }));

  const { waves } = resolveDependencyGraph(plans);

  // Build lookup for sorting within waves
  const prdMap = new Map(prds.map((p) => [p.id, p]));

  const ordered: QueuedPrd[] = [];
  for (const wave of waves) {
    // Sort within wave: priority ascending (nulls last), then created ascending
    const wavePrds = wave
      .map((id) => prdMap.get(id))
      .filter((p): p is QueuedPrd => p !== undefined)
      .sort((a, b) => {
        const aPri = a.frontmatter.priority;
        const bPri = b.frontmatter.priority;
        // Priority: ascending, nulls last
        if (aPri !== undefined && bPri !== undefined) {
          if (aPri !== bPri) return aPri - bPri;
        } else if (aPri !== undefined) {
          return -1;
        } else if (bPri !== undefined) {
          return 1;
        }
        // Created: ascending
        const aCreated = a.frontmatter.created ?? '';
        const bCreated = b.frontmatter.created ?? '';
        return aCreated.localeCompare(bCreated);
      });
    ordered.push(...wavePrds);
  }

  return ordered;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Get the current HEAD commit hash.
 * Returns empty string if not a git repo.
 */
export async function getHeadHash(cwd: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd });
    return stdout.trim();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Git diff summary
// ---------------------------------------------------------------------------

/**
 * Get a git diff --stat summary between a commit hash and HEAD.
 * Returns empty string if hash is empty or diff fails.
 */
export async function getPrdDiffSummary(hash: string, cwd: string): Promise<string> {
  if (!hash) return '';
  try {
    const { stdout } = await exec('git', ['diff', '--stat', hash, 'HEAD'], { cwd });
    return stdout.trim();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// PRD removal
// ---------------------------------------------------------------------------

/**
 * Remove a completed PRD file from disk and git.
 * Handles `git rm`, empty queue directory cleanup, and commit.
 */
export async function cleanupCompletedPrd(filePath: string, queueDir: string, cwd: string): Promise<void> {
  // Guard: filePath must reside within the queue directory
  const absFilePath = resolve(filePath);
  const absQueueDir = resolve(cwd, queueDir);
  if (!absFilePath.startsWith(absQueueDir + '/')) {
    throw new Error(`filePath ${filePath} is outside queue directory ${absQueueDir}`);
  }

  // git rm (tracked files), fall back to fs rm (untracked)
  try {
    await retryOnLock(() => exec('git', ['rm', '-f', '--', filePath], { cwd }), cwd);
  } catch {
    await rm(absFilePath);
    // Stage the deletion so forgeCommit picks it up
    try {
      await retryOnLock(() => exec('git', ['add', '--', filePath], { cwd }), cwd);
    } catch { /* file may have been untracked */ }
  }


  const prdId = basename(filePath, '.md');
  await forgeCommit(cwd, composeCommitMessage(`cleanup(${prdId}): remove completed PRD`), { paths: [filePath] });
}

/**
 * Stage and commit a freshly enqueued PRD file.
 *
 * Used by both enqueue paths (engine subprocess and daemon HTTP playbook route)
 * to keep the write-and-commit step in one place. `paths: [filePath]` scopes the
 * commit so any unrelated staged changes in the working tree are not swept in.
 */
export async function commitEnqueuedPrd(
  filePath: string,
  prdId: string,
  title: string,
  cwd: string,
): Promise<void> {
  await retryOnLock(() => exec('git', ['add', '--', filePath], { cwd }), cwd);
  await forgeCommit(
    cwd,
    composeCommitMessage(`enqueue(${prdId}): ${title}`),
    { paths: [filePath] },
  );
}

// ---------------------------------------------------------------------------
// File-location state helpers
// ---------------------------------------------------------------------------

/**
 * Move a PRD file to a subdirectory (e.g. `failed/` or `skipped/`) via `git mv` + commit.
 * Keeps the working tree clean by committing the move.
 */
export async function movePrdToSubdir(filePath: string, subdir: string, cwd: string): Promise<void> {
  const dir = resolve(filePath, '..');
  const destDir = resolve(dir, subdir);
  await mkdir(destDir, { recursive: true });

  const destPath = resolve(destDir, basename(filePath));
  const prdId = basename(filePath, '.md');

  await retryOnLock(() => exec('git', ['mv', '--', filePath, destPath], { cwd }), cwd);
  await forgeCommit(cwd, composeCommitMessage(`queue(${prdId}): move to ${subdir}`));
}

/**
 * Move a failed PRD to `failed/` and commit the move + both recovery sidecar files
 * (`.recovery.md` + `.recovery.json`) in a single atomic `forgeCommit` call.
 *
 * This is the inline-recovery path: the queue parent runs recovery synchronously
 * after the child exits with a failure code, then calls this helper to produce
 * exactly one commit that contains the `git mv` + both sidecar paths. No prior
 * commit moves the PRD — the move and sidecars land atomically.
 *
 * @returns Absolute paths to the moved PRD and the two sidecar files.
 */
export async function moveAndCommitFailedWithSidecar(
  filePath: string,
  summary: BuildFailureSummary,
  verdict: RecoveryVerdict,
  modelTracker: ModelTracker | undefined,
  cwd: string,
): Promise<{ mdPath: string; jsonPath: string; destPath: string }> {
  const dir = resolve(filePath, '..');
  const destDir = resolve(dir, 'failed');
  await mkdir(destDir, { recursive: true });

  const destPath = resolve(destDir, basename(filePath));
  const prdId = basename(filePath, '.md');

  // git mv: move the PRD file to failed/
  await retryOnLock(() => exec('git', ['mv', '--', filePath, destPath], { cwd }), cwd);

  // Write both sidecar files (atomic temp-then-rename inside writeRecoverySidecar)
  const { mdPath, jsonPath } = await writeRecoverySidecar({
    failedPrdDir: destDir,
    prdId,
    summary,
    verdict,
  });

  // Stage both sidecar files
  await retryOnLock(() => exec('git', ['add', '--', mdPath, jsonPath], { cwd }), cwd);

  // Commit everything (git mv + both sidecars) in one forgeCommit
  await forgeCommit(
    cwd,
    composeCommitMessage(`queue(${prdId}): failed - ${verdict.verdict}`, modelTracker),
  );

  return { mdPath, jsonPath, destPath };
}

/**
 * Check whether a PRD is currently being processed by looking for its lock file.
 */
export async function isPrdRunning(prdId: string, cwd: string): Promise<boolean> {
  const lockPath = resolve(cwd, '.eforge', 'queue-locks', `${prdId}.lock`);
  try {
    await readFile(lockPath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Subprocess-per-build exit code contract
// ---------------------------------------------------------------------------

/**
 * Exit codes for the `eforge queue exec <prdId>` subprocess, used by the
 * queue scheduler to determine how to clean up after the child exits.
 *
 * The scheduler spawns one child process per PRD; this is the sole channel
 * by which the child tells the parent what happened and what cleanup is
 * needed. Any exit code not listed here (or signal kill) is treated as
 * `Failed` and the parent performs the safety-net cleanup (release lock,
 * move PRD to failed/).
 */
export const QueueExecExitCode = {
  /** PRD built successfully; file already deleted during build. */
  Completed: 0,
  /** Build failed; parent should release lock and move PRD to failed/. */
  Failed: 1,
  /** Skipped (e.g. obsolete); parent should release lock and move PRD to skipped/. */
  Skipped: 2,
  /** PRD not found in queue (bad prdId). */
  NotFound: 127,
  /** Skipped because another process holds the claim; parent must NOT release the lock and must NOT move the file. */
  SkippedAlreadyClaimed: 10,
  /** Skipped because the PRD needs manual revision; parent should release the lock but leave the file in queue/. */
  SkippedNeedsRevision: 11,
} as const;

export type QueueExecExit = typeof QueueExecExitCode[keyof typeof QueueExecExitCode];

/**
 * Canonical skip reasons emitted on `queue:prd:skip` events.
 *
 * These strings are load-bearing: they are how the subprocess entry point
 * communicates *why* a PRD was skipped back through the exit code, and in
 * turn how the parent scheduler decides whether to release the lock and/or
 * move the PRD file. Do not inline the literals — always reference this
 * const so emitter and interpreter can't drift.
 */
export const QueueSkipReason = {
  AlreadyClaimed: 'claimed by another process',
  NeedsRevision: 'needs revision',
  Obsolete: 'obsolete',
} as const;

export type QueueSkipReasonValue = typeof QueueSkipReason[keyof typeof QueueSkipReason];

/**
 * Map a terminal `queue:prd:complete` status (+ skip reason, if any) to the
 * exit code the child should return. Called by the subprocess entry point
 * after events drain.
 */
export function queueExecExitCode(
  completionStatus: 'completed' | 'failed' | 'skipped' | undefined,
  skipReason: string | undefined,
): number {
  if (completionStatus === 'completed') return QueueExecExitCode.Completed;
  if (completionStatus === 'failed') return QueueExecExitCode.Failed;
  if (completionStatus === 'skipped') {
    if (skipReason === QueueSkipReason.AlreadyClaimed) return QueueExecExitCode.SkippedAlreadyClaimed;
    if (skipReason === QueueSkipReason.NeedsRevision) return QueueExecExitCode.SkippedNeedsRevision;
    return QueueExecExitCode.Skipped;
  }
  // No terminal event was emitted — treat as failed so the parent cleans up.
  return QueueExecExitCode.Failed;
}

// ---------------------------------------------------------------------------
// Lockfile-based PRD claim
// ---------------------------------------------------------------------------

/**
 * Atomically claim a PRD by creating an exclusive lock file.
 * Uses O_CREAT | O_EXCL flags so only one process can create the file.
 * Writes the current PID into the lock file for debugging.
 * Returns `true` if the claim succeeded, `false` if another process holds it.
 */
export async function claimPrd(prdId: string, cwd: string): Promise<boolean> {
  const lockDir = resolve(cwd, '.eforge', 'queue-locks');
  await mkdir(lockDir, { recursive: true });
  const lockPath = resolve(lockDir, `${prdId}.lock`);
  try {
    const fd = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    await fd.writeFile(String(process.pid), 'utf-8');
    await fd.close();
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Lock is held by another process. Stale locks (owning PID dead) are
      // the startup reconciler's job, not ours — we assume a live lock means
      // a live owner.
      return false;
    }
    throw err;
  }
}

/**
 * Release a PRD claim by removing the lock file.
 * Best-effort and non-throwing — if the lock file is already gone, that's fine.
 */
export async function releasePrd(prdId: string, cwd: string): Promise<void> {
  const lockPath = resolve(cwd, '.eforge', 'queue-locks', `${prdId}.lock`);
  try {
    await rm(lockPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Title inference
// ---------------------------------------------------------------------------

/**
 * Infer a title from PRD content.
 * Extracts the first `# ` heading if present, otherwise deslugifies
 * a filename-like string (e.g., "my-feature" -> "My Feature").
 */
export function inferTitle(content: string, fallbackSlug?: string): string {
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) {
    return headingMatch[1].trim();
  }

  if (fallbackSlug) {
    return fallbackSlug
      .replace(/\.md$/, '')
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  return 'Untitled PRD';
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

export interface EnqueuePrdOptions {
  /** Formatted PRD body content */
  body: string;
  /** PRD title */
  title: string;
  /** Queue directory (absolute or relative to cwd) */
  queueDir: string;
  /** Working directory for resolving relative paths */
  cwd: string;
  /** Optional priority (lower = higher priority) */
  priority?: number;
  /** Optional dependency list */
  depends_on?: string[];
  /** If true, write to waiting/ subdirectory (for piggybacked PRDs awaiting upstream completion) */
  intoWaiting?: boolean;
  /** Agent runtime profile name to use when executing this PRD (forwarded from playbook frontmatter) */
  agentRuntime?: string;
  /** Commands to run after the build merges (forwarded from playbook frontmatter) */
  postMerge?: string[];
}

export interface EnqueuePrdResult {
  /** Slug-based id (filename without extension) */
  id: string;
  /** Absolute path to the written file */
  filePath: string;
  /** The frontmatter that was written */
  frontmatter: PrdFrontmatter;
}

/**
 * Generate a URL-safe slug from a title.
 * Lowercases, replaces non-alphanumeric chars with hyphens,
 * collapses consecutive hyphens, trims leading/trailing hyphens.
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Write a formatted PRD to the queue directory with YAML frontmatter.
 *
 * Pure file I/O - no agent calls, no events. Handles:
 * - Frontmatter generation (title, created=today, status=pending)
 * - Slug generation from title
 * - Duplicate slug handling (-2, -3 suffix)
 * - Queue directory auto-creation
 * - Optional `intoWaiting` flag to write to the waiting/ subdirectory
 */
export async function enqueuePrd(options: EnqueuePrdOptions): Promise<EnqueuePrdResult> {
  const { body, title, queueDir, cwd, priority, depends_on, intoWaiting, agentRuntime, postMerge } = options;

  // Use waiting/ subdirectory when the PRD has unsatisfied upstream deps
  const targetSubdir = intoWaiting ? 'waiting' : undefined;
  const absDir = targetSubdir
    ? resolve(cwd, queueDir, targetSubdir)
    : resolve(cwd, queueDir);

  // Create queue dir if needed
  await mkdir(absDir, { recursive: true });

  // Generate slug and handle duplicates
  const baseSlug = slugify(title) || 'untitled';
  let slug = baseSlug;
  let suffix = 1;

  // Read existing files to check for duplicates
  let existing: string[];
  try {
    existing = await readdir(absDir);
  } catch {
    existing = [];
  }

  const existingSet = new Set(existing.map((f) => basename(f, '.md')));
  while (existingSet.has(slug)) {
    suffix++;
    slug = `${baseSlug}-${suffix}`;
  }

  // Build frontmatter
  const created = new Date().toISOString().split('T')[0];
  const frontmatter: PrdFrontmatter = {
    title,
    created,
    ...(priority !== undefined && { priority }),
    ...(depends_on !== undefined && depends_on.length > 0 && { depends_on }),
  };

  // Serialize frontmatter
  const fmLines: string[] = [
    `title: ${title}`,
    `created: ${created}`,
  ];
  if (priority !== undefined) {
    fmLines.push(`priority: ${priority}`);
  }
  if (depends_on !== undefined && depends_on.length > 0) {
    fmLines.push(`depends_on: [${depends_on.map((d) => `"${d}"`).join(', ')}]`);
  }
  if (agentRuntime !== undefined) {
    fmLines.push(`agentRuntime: ${agentRuntime}`);
  }
  if (postMerge !== undefined && postMerge.length > 0) {
    fmLines.push(`postMerge:\n${postMerge.map((cmd) => `  - ${cmd}`).join('\n')}`);
  }

  const fileContent = `---\n${fmLines.join('\n')}\n---\n\n${body}\n`;
  const filePath = resolve(absDir, `${slug}.md`);
  await writeFile(filePath, fileContent, 'utf-8');

  return {
    id: slug,
    filePath,
    frontmatter,
  };
}

// ---------------------------------------------------------------------------
// Piggyback scheduling helpers
// ---------------------------------------------------------------------------

/**
 * Find all PRDs in the given array that list `upstreamId` in their `depends_on`.
 */
export function findDependents(prds: QueuedPrd[], upstreamId: string): QueuedPrd[] {
  return prds.filter((p) => p.frontmatter.depends_on?.includes(upstreamId) ?? false);
}

/**
 * Move a PRD file from `waiting/` to a destination directory.
 *
 * Tries `git mv` first (for git-tracked files), then falls back to
 * `fs.rename` + `git add` for untracked files (e.g. written by the
 * daemon without a prior commit). Non-fatal when git is unavailable.
 */
async function movePrdFromWaiting(
  filePath: string,
  destDir: string,
  cwd: string,
  message: string,
): Promise<void> {
  const destPath = resolve(destDir, basename(filePath));
  await mkdir(destDir, { recursive: true });
  const prdId = basename(filePath, '.md');

  // Try git mv first (tracked files)
  try {
    await retryOnLock(() => exec('git', ['mv', '--', filePath, destPath], { cwd }), cwd);
    await forgeCommit(cwd, composeCommitMessage(`queue(${prdId}): ${message}`), { paths: [filePath, destPath] });
    return;
  } catch {
    // Not tracked — fall back to fs rename
  }

  // fs rename for untracked files
  await rename(filePath, destPath);
  try {
    await retryOnLock(() => exec('git', ['add', '--', destPath], { cwd }), cwd);
    await forgeCommit(cwd, composeCommitMessage(`queue(${prdId}): ${message}`), { paths: [destPath] });
  } catch {
    // No git repo — non-fatal, file is in the correct location
  }
}

/**
 * Validate that all `depends_on` ids currently exist in the queue
 * (pending/running or waiting). Throws with a descriptive error if any
 * upstream is not found, so enqueue callers can surface the error to users.
 *
 * Does NOT check the `failed/` or `skipped/` directories — those are
 * terminal states and cannot serve as live upstream dependencies.
 */
export async function validateDependsOnExists(
  depends_on: string[],
  queueDir: string,
  cwd: string,
): Promise<void> {
  if (depends_on.length === 0) return;

  const [pendingPrds, waitingPrds] = await Promise.all([
    loadQueue(queueDir, cwd).catch((): QueuedPrd[] => []),
    loadQueue(`${queueDir}/waiting`, cwd).catch((): QueuedPrd[] => []),
  ]);

  const existingIds = new Set([
    ...pendingPrds.map((p) => p.id),
    ...waitingPrds.map((p) => p.id),
  ]);

  for (const dep of depends_on) {
    if (!existingIds.has(dep)) {
      throw new Error(
        `depends_on references unknown queue item: "${dep}". ` +
        `Only pending, running, or waiting queue items can be used as upstream dependencies.`,
      );
    }
  }
}

/**
 * Recursively transition waiting dependents of `upstreamId` to `skipped/`.
 *
 * Called when an upstream PRD transitions to a terminal failure state
 * (`failed` or `cancelled`). Dependents are moved from `waiting/` to
 * `skipped/` with a reason string, then their own dependents are also
 * skipped (cascade).
 */
export async function propagateSkip(
  queueDir: string,
  cwd: string,
  upstreamId: string,
  reason: string,
): Promise<void> {
  let waitingPrds: QueuedPrd[];
  try {
    waitingPrds = await loadQueue(`${queueDir}/waiting`, cwd);
  } catch {
    return; // No waiting directory or read error — nothing to do
  }

  const dependents = findDependents(waitingPrds, upstreamId);
  if (dependents.length === 0) return;

  const skippedDir = resolve(cwd, queueDir, 'skipped');

  for (const dep of dependents) {
    const depReason = `upstream ${upstreamId} ${reason}`;
    await movePrdFromWaiting(
      dep.filePath,
      skippedDir,
      cwd,
      `skipped - ${depReason}`,
    );
    // Cascade: skip dependents of this now-skipped PRD
    await propagateSkip(queueDir, cwd, dep.id, 'skipped');
  }
}

/**
 * Unblock waiting PRDs whose upstream `completedId` has now finished.
 *
 * Moves qualifying PRDs from `waiting/` back to the queue root so the
 * normal dispatcher can pick them up. A waiting PRD is unblocked when
 * ALL of its `depends_on` entries are either the just-completed id or
 * no longer present in the active queue (pending/waiting).
 *
 * Returns the ids of PRDs that were moved to pending.
 */
export async function unblockWaiting(
  queueDir: string,
  cwd: string,
  completedId: string,
): Promise<string[]> {
  let waitingPrds: QueuedPrd[];
  try {
    waitingPrds = await loadQueue(`${queueDir}/waiting`, cwd);
  } catch {
    return [];
  }

  if (waitingPrds.length === 0) return [];

  // Build the set of ids that are still actively blocked (pending or waiting)
  const pendingPrds = await loadQueue(queueDir, cwd).catch((): QueuedPrd[] => []);
  const stillActiveIds = new Set<string>([
    ...waitingPrds.map((p) => p.id),
    ...pendingPrds.map((p) => p.id),
  ]);
  // The just-completed PRD is no longer active
  stillActiveIds.delete(completedId);

  const queueRoot = resolve(cwd, queueDir);
  const unblocked: string[] = [];

  for (const prd of waitingPrds) {
    const deps: string[] = prd.frontmatter.depends_on ?? [];
    // A dep is satisfied when it's the just-completed id or not in any active queue
    const allSatisfied = deps.every(
      (dep: string) => dep === completedId || !stillActiveIds.has(dep),
    );

    if (allSatisfied) {
      await movePrdFromWaiting(
        prd.filePath,
        queueRoot,
        cwd,
        `unblocked - ${completedId} completed`,
      );
      unblocked.push(prd.id);
      // Remove from stillActiveIds so other waiting PRDs that depend on
      // this one can also be unblocked in subsequent loop iterations.
      stillActiveIds.delete(prd.id);
    }
  }

  return unblocked;
}
