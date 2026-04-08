/**
 * PRD queue loading, parsing, ordering, and status updates.
 * Scans a directory for .md files with YAML frontmatter, parses them
 * into QueuedPrd records, and resolves execution order using the
 * same dependency graph algorithm as plan orchestration.
 */

import { readFile, readdir, writeFile, mkdir, rm, open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { resolve, basename } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod/v4';
import { resolveDependencyGraph } from './plan.js';
import { forgeCommit, retryOnLock } from './git.js';

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Frontmatter schema
// ---------------------------------------------------------------------------

const prdFrontmatterSchema = z.object({
  title: z.string(),
  created: z.string().optional(),
  priority: z.number().int().optional(),
  depends_on: z.array(z.string()).optional(),
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
  await forgeCommit(cwd, `cleanup(${prdId}): remove completed PRD`, [filePath]);
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
  await forgeCommit(cwd, `queue(${prdId}): move to ${subdir}`);
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
      // Check if the lock is stale (owning process no longer alive)
      let lockContent: string;
      try {
        lockContent = await readFile(lockPath, 'utf-8');
      } catch {
        // Can't read lock file - treat as actively held
        return false;
      }

      const pid = parseInt(lockContent.trim(), 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        // Corrupt/invalid lock file content - treat as actively held
        return false;
      }

      // Check if the PID is alive
      let isPidAlive = false;
      try {
        process.kill(pid, 0);
        isPidAlive = true;
      } catch (killErr: unknown) {
        // EPERM means the process exists but is owned by a different user
        if ((killErr as NodeJS.ErrnoException).code === 'EPERM') {
          isPidAlive = true;
        }
        // ESRCH or other errors mean the process is dead - stale lock
      }

      if (isPidAlive) {
        // Process is alive - lock is legitimately held
        return false;
      }

      try {
        await rm(lockPath);
      } catch {
        // Can't remove stale lock - treat as actively held
        return false;
      }

      try {
        const fd = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
        await fd.writeFile(String(process.pid), 'utf-8');
        await fd.close();
        return true;
      } catch (retryErr: unknown) {
        if ((retryErr as NodeJS.ErrnoException).code === 'EEXIST') {
          // Another process claimed it between our remove and retry
          return false;
        }
        throw retryErr;
      }
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
 */
export async function enqueuePrd(options: EnqueuePrdOptions): Promise<EnqueuePrdResult> {
  const { body, title, queueDir, cwd, priority, depends_on } = options;

  const absDir = resolve(cwd, queueDir);

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

  const fileContent = `---\n${fmLines.join('\n')}\n---\n\n${body}\n`;
  const filePath = resolve(absDir, `${slug}.md`);
  await writeFile(filePath, fileContent, 'utf-8');

  return {
    id: slug,
    filePath,
    frontmatter,
  };
}
