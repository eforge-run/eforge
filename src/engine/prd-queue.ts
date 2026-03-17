/**
 * PRD queue loading, parsing, ordering, and status updates.
 * Scans a directory for .md files with YAML frontmatter, parses them
 * into QueuedPrd records, and resolves execution order using the
 * same dependency graph algorithm as plan orchestration.
 */

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { resolve, basename } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod/v4';
import { resolveDependencyGraph } from './plan.js';

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Frontmatter schema
// ---------------------------------------------------------------------------

const PRD_STATUSES = ['pending', 'running', 'completed', 'failed', 'skipped'] as const;
export type PrdStatus = (typeof PRD_STATUSES)[number];

const prdFrontmatterSchema = z.object({
  title: z.string(),
  created: z.string().optional(),
  priority: z.number().int().optional(),
  depends_on: z.array(z.string()).optional(),
  status: z.enum(PRD_STATUSES).optional(),
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
 * Filter to pending PRDs and resolve execution order.
 * Uses the same topological sort as plan orchestration for dependency ordering.
 * Within each wave, sorts by priority (ascending, nulls last) then created (ascending).
 */
export function resolveQueueOrder(prds: QueuedPrd[]): QueuedPrd[] {
  // Filter to pending only
  const pending = prds.filter((p) => (p.frontmatter.status ?? 'pending') === 'pending');
  if (pending.length === 0) return [];

  // Build lookup of all PRD ids (including non-pending) for dependency filtering
  const allIds = new Set(pending.map((p) => p.id));

  // Build plans-like structure for dependency resolution.
  // Filter out dependsOn entries that reference non-pending PRDs (e.g., completed)
  // since resolveDependencyGraph throws on unknown ids, and completed deps are
  // already satisfied.
  const plans = pending.map((p) => ({
    id: p.id,
    name: p.frontmatter.title,
    dependsOn: (p.frontmatter.depends_on ?? []).filter((dep) => allIds.has(dep)),
    branch: '', // Not used for queue ordering
  }));

  const { waves } = resolveDependencyGraph(plans);

  // Build lookup for sorting within waves
  const prdMap = new Map(pending.map((p) => [p.id, p]));

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
// Status updates
// ---------------------------------------------------------------------------

/**
 * Update the status field in a PRD file's frontmatter via regex replacement.
 * If no status field exists, inserts one before the closing `---`.
 */
export async function updatePrdStatus(filePath: string, newStatus: PrdStatus): Promise<void> {
  const content = await readFile(filePath, 'utf-8');

  let updated: string;
  if (/^status\s*:/m.test(content)) {
    // Replace existing status line
    updated = content.replace(/^(status\s*:\s*).*$/m, `$1${newStatus}`);
  } else {
    // Insert status before closing --- (skip the opening ---)
    const closingIdx = content.indexOf('\n---', content.indexOf('---') + 3);
    if (closingIdx !== -1) {
      updated = content.slice(0, closingIdx) + `\nstatus: ${newStatus}` + content.slice(closingIdx);
    } else {
      // No closing --- found — append after opening frontmatter
      updated = content;
    }
  }

  await writeFile(filePath, updated, 'utf-8');
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
    status: 'pending',
    ...(priority !== undefined && { priority }),
    ...(depends_on !== undefined && depends_on.length > 0 && { depends_on }),
  };

  // Serialize frontmatter
  const fmLines: string[] = [
    `title: ${title}`,
    `created: ${created}`,
    `status: pending`,
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
