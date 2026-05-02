/**
 * Session plan types, schema, parser, and deterministic library helpers.
 *
 * A session plan is a Markdown file with YAML frontmatter that accumulates
 * decisions and context during a structured planning conversation. Session plans
 * live in `.eforge/session-plans/` (project-local scope only) and compile to
 * ordinary build source for the engine queue.
 *
 * Public API:
 *   parseSessionPlan          — parse raw markdown to a typed SessionPlan
 *   serializeSessionPlan      — serialize a SessionPlan back to markdown
 *   listActiveSessionPlans    — list active session plans in project-local scope
 *   selectDimensions          — resolve required/optional/skipped dimension sets
 *   checkReadiness            — check if all required dimensions have content
 *   getReadinessDetail        — check readiness with covered/skipped dimension lists
 *   migrateBooleanDimensions  — convert legacy boolean dimension shape to new format
 *   sessionPlanToBuildSource  — format a session plan as ordinary build source
 *   normalizeBuildSource      — detect session-plan paths and convert to build source
 *   createSessionPlan         — create a fresh SessionPlan with canonical frontmatter
 *   setSessionPlanSection     — append-or-replace a ## section in the plan body
 *   skipDimension             — add or update an entry in skipped_dimensions
 *   unskipDimension           — remove an entry from skipped_dimensions
 *   setSessionPlanStatus      — update status and optional metadata fields
 *   setSessionPlanDimensions  — apply planning_type/depth and write dimension lists
 *   resolveSessionPlanPath    — resolve session id to absolute path within .eforge/session-plans/
 *   loadSessionPlan           — read and parse a session plan by session id
 *   writeSessionPlan          — serialize and atomically write a session plan to disk
 */
import { readFile, readdir, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, basename, dirname, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod/v4';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionPlanStatus = 'planning' | 'ready' | 'abandoned' | 'submitted';
export type PlanningType =
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'architecture'
  | 'docs'
  | 'maintenance'
  | 'unknown';
export type PlanningDepth = 'quick' | 'focused' | 'deep';
export type PlanningProfile = 'errand' | 'excursion' | 'expedition' | null;

export interface SkippedDimension {
  name: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const skippedDimensionSchema = z.object({
  name: z.string(),
  reason: z.string(),
});

export const sessionPlanFrontmatterSchema = z.object({
  session: z.string(),
  topic: z.string(),
  created: z.string().optional(),
  status: z.enum(['planning', 'ready', 'abandoned', 'submitted']),
  planning_type: z.enum(['bugfix', 'feature', 'refactor', 'architecture', 'docs', 'maintenance', 'unknown']),
  planning_depth: z.enum(['quick', 'focused', 'deep']),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  eforge_session: z.string().optional(),
  required_dimensions: z.array(z.string()).default([]),
  optional_dimensions: z.array(z.string()).default([]),
  skipped_dimensions: z.array(skippedDimensionSchema).default([]),
  open_questions: z.array(z.string()).default([]),
  profile: z.enum(['errand', 'excursion', 'expedition']).nullable().default(null),
}).passthrough();

export type SessionPlanFrontmatter = z.output<typeof sessionPlanFrontmatterSchema>;

// ---------------------------------------------------------------------------
// SessionPlan (composite)
// ---------------------------------------------------------------------------

/** A fully parsed session plan (frontmatter + body + dimension sections). */
export interface SessionPlan extends SessionPlanFrontmatter {
  /** Raw markdown body — everything after the closing `---` separator. */
  body: string;
  /**
   * Dimension sections parsed from the body. Keys are lowercase heading text
   * (e.g. `'acceptance criteria'`, `'scope'`). Values are the trimmed section
   * content. Only `## Level` headings are parsed as dimension sections.
   */
  sections: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Session plan list entry
// ---------------------------------------------------------------------------

/** A lightweight listing entry for an active session plan file. */
export interface SessionPlanListEntry {
  /** Session identifier (e.g. `2026-04-03-add-dark-mode`). */
  session: string;
  /** Human-readable topic. */
  topic: string;
  /** Current plan status. */
  status: SessionPlanStatus;
  /** Absolute path to the session plan file. */
  path: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Parse YAML frontmatter from a Markdown file. Returns [frontmatter, body]. */
function splitFrontmatter(raw: string): [Record<string, unknown>, string] {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)/);
  if (!match) {
    return [{}, raw];
  }
  const fm = parseYaml(match[1]);
  return [
    fm && typeof fm === 'object' ? (fm as Record<string, unknown>) : {},
    match[2],
  ];
}

/**
 * Parse body markdown into a map of `## Heading` sections.
 * Keys are lowercase heading text; values are trimmed section content.
 */
function parseSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = body.split(/\r?\n/);

  let currentHeading: string | null = null;
  const currentLines: string[] = [];

  function flush() {
    if (currentHeading !== null) {
      sections.set(currentHeading, currentLines.join('\n').trim());
    }
    currentLines.length = 0;
  }

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[1].trim().toLowerCase();
    } else if (currentHeading !== null) {
      currentLines.push(line);
    }
  }
  flush();

  return sections;
}

/**
 * Convert a dimension name (kebab-case) to the lowercase heading key used
 * in the `sections` map (e.g. `'acceptance-criteria'` → `'acceptance criteria'`).
 */
function dimensionToSectionKey(dimensionName: string): string {
  return dimensionName.toLowerCase().replace(/-/g, ' ');
}

/** Placeholder line patterns that do not count as substantive content. */
const PLACEHOLDER_RE = /^(tbd|n\/a|none|todo|placeholder|\s*)$/i;

/**
 * Returns `true` when the section content contains at least one substantive
 * (non-empty, non-placeholder) line.
 */
function hasSubstantiveContent(content: string): boolean {
  return content.split('\n').some(
    (line) => line.trim() !== '' && !PLACEHOLDER_RE.test(line.trim()),
  );
}

/**
 * Convert a dimension name (kebab-case) to a Title Case heading string
 * (e.g. `'acceptance-criteria'` → `'Acceptance Criteria'`).
 */
function dimensionToTitle(name: string): string {
  return name.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Set or replace a `## {Title}` section in the plan body.
 * Returns the updated body string.
 *
 * Heading detection uses `^##\s+(.+)$` to match the same shape as
 * `parseSections` (any whitespace after `##`, not just a literal space).
 * If a body contains multiple `## {Title}` headings — even when separated
 * by other headings — the first occurrence is replaced in place and every
 * later duplicate (and its content up to the next heading) is removed,
 * leaving a single canonical section.
 */
function setBodySection(body: string, dimensionName: string, content: string): string {
  const title = dimensionToTitle(dimensionName);
  const sectionKeyLower = dimensionToSectionKey(dimensionName);

  const lines = body.split('\n');

  // Index every `## ...` heading so we can compute section ranges directly.
  const headings: Array<{ idx: number; key: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+)$/);
    if (m) {
      headings.push({ idx: i, key: m[1].trim().toLowerCase() });
    }
  }

  // Collect every range [start, end) for sections whose heading matches.
  const matchingRanges: Array<{ start: number; end: number }> = [];
  for (let h = 0; h < headings.length; h++) {
    if (headings[h].key === sectionKeyLower) {
      const start = headings[h].idx;
      const end = headings[h + 1]?.idx ?? lines.length;
      matchingRanges.push({ start, end });
    }
  }

  // New section lines: heading, blank, content, trailing blank
  const newSectionLines = [`## ${title}`, '', ...content.trim().split('\n'), ''];

  if (matchingRanges.length === 0) {
    // Append new section at the end
    const trimmed = body.trimEnd();
    return trimmed + '\n\n' + newSectionLines.join('\n');
  }

  // Replace the first matching section in place; drop every later duplicate.
  const insertAt = matchingRanges[0].start;
  const drop = new Set<number>();
  for (const r of matchingRanges) {
    for (let i = r.start; i < r.end; i++) drop.add(i);
  }

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === insertAt) {
      out.push(...newSectionLines);
    }
    if (!drop.has(i)) {
      out.push(lines[i]);
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Dimension playbook
// ---------------------------------------------------------------------------

interface DimensionSpec {
  required: string[];
  optional: string[];
}

const DIMENSION_MAP: Record<PlanningType, DimensionSpec> = {
  bugfix: {
    required: ['problem-statement', 'reproduction-steps', 'root-cause', 'acceptance-criteria'],
    optional: ['code-impact', 'risks'],
  },
  feature: {
    required: ['problem-statement', 'scope', 'acceptance-criteria', 'code-impact', 'design-decisions'],
    optional: ['architecture-impact', 'documentation-impact', 'risks'],
  },
  refactor: {
    required: ['scope', 'code-impact', 'acceptance-criteria'],
    optional: ['design-decisions', 'risks'],
  },
  architecture: {
    required: ['scope', 'architecture-impact', 'design-decisions', 'acceptance-criteria'],
    optional: ['code-impact', 'documentation-impact', 'risks'],
  },
  docs: {
    required: ['scope', 'documentation-impact', 'acceptance-criteria'],
    optional: ['code-impact'],
  },
  maintenance: {
    required: ['scope', 'code-impact', 'acceptance-criteria'],
    optional: ['risks'],
  },
  unknown: {
    required: [
      'scope',
      'code-impact',
      'architecture-impact',
      'design-decisions',
      'documentation-impact',
      'risks',
      'acceptance-criteria',
    ],
    optional: [],
  },
};

/**
 * Derive the dimension set for a planning type + depth combination.
 * Used by `selectDimensions` when the plan's frontmatter does not already
 * have explicit dimension lists.
 */
function getDimensionsForType(planningType: PlanningType, planningDepth: PlanningDepth): DimensionSpec {
  const base = DIMENSION_MAP[planningType];

  if (planningDepth === 'quick') {
    // Keep the first required dimension (anchor: problem-statement or scope),
    // up to one additional type-specific required dimension, and acceptance-criteria.
    const anchor = base.required[0] ?? 'scope';
    const typeSpecific = base.required
      .filter((d) => d !== anchor && d !== 'acceptance-criteria')
      .slice(0, 1);
    const required = [...new Set([anchor, ...typeSpecific, 'acceptance-criteria'])];
    return { required, optional: base.optional };
  }

  if (planningDepth === 'deep') {
    // All required AND all optional dimensions.
    return { required: base.required, optional: base.optional };
  }

  // focused (default): all required dimensions, no optional.
  return { required: base.required, optional: [] };
}

// ---------------------------------------------------------------------------
// Legacy migration constants
// ---------------------------------------------------------------------------

/** All six legacy dimension names plus acceptance-criteria. */
const LEGACY_DIMENSIONS = [
  'scope',
  'code-impact',
  'architecture-impact',
  'design-decisions',
  'documentation-impact',
  'risks',
  'acceptance-criteria',
];

// ---------------------------------------------------------------------------
// Public API — parse / serialize
// ---------------------------------------------------------------------------

/**
 * Parse a raw session plan markdown string into a typed `SessionPlan`.
 * Throws when the frontmatter is missing required fields.
 */
export function parseSessionPlan(raw: string): SessionPlan {
  const [fm, body] = splitFrontmatter(raw);
  const fmResult = sessionPlanFrontmatterSchema.safeParse(fm);
  if (!fmResult.success) {
    const errors = fmResult.error.issues.map((i) => {
      const path = i.path.length > 0 ? i.path.join('.') + ': ' : '';
      return path + i.message;
    });
    throw new Error(`Invalid session plan frontmatter: ${errors.join('; ')}`);
  }

  const sections = parseSections(body);

  return {
    ...fmResult.data,
    body,
    sections,
  };
}

/**
 * Serialize a `SessionPlan` back to a Markdown string with YAML frontmatter.
 *
 * The `body` field is written verbatim after the closing `---` separator.
 * The `sections` map is derived from the body and is not separately serialized.
 */
export function serializeSessionPlan(plan: SessionPlan): string {
  // Build the frontmatter object (exclude runtime-only fields)
  const { body, sections: _sections, ...frontmatterFields } = plan as SessionPlan & { sections: unknown };

  // Cast to mutable record for serialization
  const fm = frontmatterFields as Record<string, unknown>;

  // Remove passthrough-preserved legacy fields that have been migrated
  delete fm['dimensions'];

  const fmYaml = stringifyYaml(fm, { lineWidth: 0 });

  return `---\n${fmYaml}---\n${body}`;
}

// ---------------------------------------------------------------------------
// Public API — list
// ---------------------------------------------------------------------------

export interface ListActiveSessionPlansOpts {
  /** Project root directory. Session plans are always project-local. */
  cwd: string;
}

/**
 * List active session plan files from `.eforge/session-plans/` (project-local
 * scope only). Returns a lightweight listing — no full plan parsing.
 *
 * Only files with `status: planning` or `status: ready` are returned.
 */
export async function listActiveSessionPlans(
  opts: ListActiveSessionPlansOpts,
): Promise<SessionPlanListEntry[]> {
  const sessionPlansDir = resolve(opts.cwd, '.eforge', 'session-plans');

  let filenames: string[];
  try {
    filenames = await readdir(sessionPlansDir);
  } catch {
    return [];
  }

  const mdFiles = filenames.filter((f) => f.endsWith('.md')).sort();
  const results: SessionPlanListEntry[] = [];

  await Promise.all(
    mdFiles.map(async (filename) => {
      const filePath = resolve(sessionPlansDir, filename);
      try {
        const raw = await readFile(filePath, 'utf-8');
        const plan = parseSessionPlan(raw);
        if (plan.status === 'planning' || plan.status === 'ready') {
          results.push({
            session: plan.session,
            topic: plan.topic,
            status: plan.status,
            path: filePath,
          });
        }
      } catch {
        // Skip unparseable files
      }
    }),
  );

  // Sort by session ID for deterministic output
  results.sort((a, b) => a.session.localeCompare(b.session));
  return results;
}

// ---------------------------------------------------------------------------
// Public API — dimension helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the required, optional, and skipped dimension sets for a plan.
 *
 * If the plan's frontmatter already has explicit `required_dimensions` /
 * `optional_dimensions` lists (set by the planning skill in Step 4), those are
 * returned as-is. Otherwise, the sets are derived from `planning_type` and
 * `planning_depth`.
 *
 * `skipped_dimensions` from the frontmatter are always returned unchanged.
 */
export function selectDimensions(plan: SessionPlan): {
  required: string[];
  optional: string[];
  skipped: string[];
} {
  const skipped = plan.skipped_dimensions.map((s) => s.name);

  if (plan.required_dimensions.length > 0) {
    return {
      required: plan.required_dimensions,
      optional: plan.optional_dimensions,
      skipped,
    };
  }

  const dims = getDimensionsForType(plan.planning_type, plan.planning_depth);
  return {
    required: dims.required,
    optional: dims.optional,
    skipped,
  };
}

/**
 * Check whether a session plan is ready to be enqueued.
 *
 * A plan is ready when every entry in `required_dimensions` either:
 * - Has a `## {Dimension Title}` section in the body with substantive content
 *   (at least one non-empty, non-placeholder line — not just the header,
 *   blank lines, or "TBD"/"N/A"), OR
 * - Appears in `skipped_dimensions` with a reason.
 *
 * Optional dimensions never block readiness.
 */
export function checkReadiness(plan: SessionPlan): {
  ready: boolean;
  missingDimensions: string[];
} {
  const skippedNames = new Set(plan.skipped_dimensions.map((s) => s.name));
  const { required } = selectDimensions(plan);

  const missingDimensions = required.filter((dim) => {
    if (skippedNames.has(dim)) return false;
    const sectionKey = dimensionToSectionKey(dim);
    const content = plan.sections.get(sectionKey) ?? '';
    return !hasSubstantiveContent(content);
  });

  return {
    ready: missingDimensions.length === 0,
    missingDimensions,
  };
}

/**
 * Returns a detailed readiness summary including covered and skipped dimensions.
 *
 * A dimension is **covered** when it has substantive body content.
 * A dimension is **skipped** when it appears in `skipped_dimensions`.
 * A dimension is **missing** when it is required but neither covered nor skipped.
 *
 * Optional dimensions are not included in any of the arrays.
 */
export function getReadinessDetail(plan: SessionPlan): {
  ready: boolean;
  missingDimensions: string[];
  coveredDimensions: string[];
  skippedDimensions: string[];
} {
  const skippedNames = new Set(plan.skipped_dimensions.map((s) => s.name));
  const { required } = selectDimensions(plan);

  const missingDimensions: string[] = [];
  const coveredDimensions: string[] = [];

  for (const dim of required) {
    if (skippedNames.has(dim)) {
      continue;
    }
    const sectionKey = dimensionToSectionKey(dim);
    const content = plan.sections.get(sectionKey) ?? '';
    if (hasSubstantiveContent(content)) {
      coveredDimensions.push(dim);
    } else {
      missingDimensions.push(dim);
    }
  }

  return {
    ready: missingDimensions.length === 0,
    missingDimensions,
    coveredDimensions,
    skippedDimensions: plan.skipped_dimensions.map((s) => s.name),
  };
}

// ---------------------------------------------------------------------------
// Public API — mutation helpers
// ---------------------------------------------------------------------------

/**
 * Options for creating a new session plan.
 */
export interface CreateSessionPlanOpts {
  session: string;
  topic: string;
  planningType?: PlanningType;
  planningDepth?: PlanningDepth;
  profile?: PlanningProfile;
}

/**
 * Create a fresh `SessionPlan` with canonical frontmatter for a new session.
 * The plan starts in `planning` status with an empty body.
 */
export function createSessionPlan(opts: CreateSessionPlanOpts): SessionPlan {
  const planningType = opts.planningType ?? 'unknown';
  const planningDepth = opts.planningDepth ?? 'focused';
  const body = `\n# ${opts.topic}\n`;

  return {
    session: opts.session,
    topic: opts.topic,
    status: 'planning',
    planning_type: planningType,
    planning_depth: planningDepth,
    eforge_session: undefined,
    required_dimensions: [],
    optional_dimensions: [],
    skipped_dimensions: [],
    open_questions: [],
    profile: opts.profile ?? null,
    body,
    sections: parseSections(body),
  };
}

/**
 * Append or replace a `## {Dimension Title}` section in the plan body.
 * Returns a new `SessionPlan` — does not mutate the original.
 *
 * The heading is derived from `dimensionName` by converting kebab-case to Title
 * Case (e.g. `'acceptance-criteria'` → `## Acceptance Criteria`). If a matching
 * section already exists in the body (case-insensitive heading match), it is
 * replaced in-place; otherwise a new section is appended.
 */
export function setSessionPlanSection(plan: SessionPlan, dimensionName: string, content: string): SessionPlan {
  const newBody = setBodySection(plan.body, dimensionName, content);
  return {
    ...plan,
    body: newBody,
    sections: parseSections(newBody),
  };
}

/**
 * Add or update an entry in `skipped_dimensions` for the given dimension name.
 * Returns a new `SessionPlan` — does not mutate the original.
 */
export function skipDimension(plan: SessionPlan, name: string, reason: string): SessionPlan {
  const filtered = plan.skipped_dimensions.filter((s) => s.name !== name);
  return {
    ...plan,
    skipped_dimensions: [...filtered, { name, reason }],
  };
}

/**
 * Remove an entry from `skipped_dimensions` by dimension name.
 * Returns a new `SessionPlan` — does not mutate the original.
 * No-op if the dimension was not skipped.
 */
export function unskipDimension(plan: SessionPlan, name: string): SessionPlan {
  return {
    ...plan,
    skipped_dimensions: plan.skipped_dimensions.filter((s) => s.name !== name),
  };
}

/**
 * Optional metadata for `setSessionPlanStatus`.
 * When status is `'submitted'`, `eforge_session` is required.
 */
export interface SetSessionPlanStatusMetadata {
  eforge_session?: string;
}

/**
 * Update the `status` field of a session plan, and optionally set additional
 * frontmatter fields via `metadata`.
 *
 * When `status` is `'submitted'`, `metadata.eforge_session` is required and
 * will be written to the frontmatter. Omitting it throws.
 *
 * Returns a new `SessionPlan` — does not mutate the original.
 */
export function setSessionPlanStatus(
  plan: SessionPlan,
  status: SessionPlanStatus,
  metadata?: SetSessionPlanStatusMetadata,
): SessionPlan {
  if (status === 'submitted') {
    if (!metadata?.eforge_session) {
      throw new Error('eforge_session is required in metadata when setting status to "submitted"');
    }
    return {
      ...plan,
      status,
      eforge_session: metadata.eforge_session,
    };
  }
  return {
    ...plan,
    status,
  };
}

/**
 * Options for `setSessionPlanDimensions`.
 */
export interface SetSessionPlanDimensionsOpts {
  planningType?: PlanningType;
  planningDepth?: PlanningDepth;
  /** When `true`, overwrite any existing explicit dimension lists. Default: `false`. */
  overwrite?: boolean;
}

/**
 * Apply `planning_type`, `planning_depth`, and derived dimension lists to a plan.
 *
 * If the plan already has explicit `required_dimensions` (non-empty) and
 * `overwrite` is not set, only `planning_type` and `planning_depth` are
 * updated — the dimension lists are left as-is.
 *
 * Returns a new `SessionPlan` — does not mutate the original.
 */
export function setSessionPlanDimensions(plan: SessionPlan, opts: SetSessionPlanDimensionsOpts): SessionPlan {
  const planningType = opts.planningType ?? plan.planning_type;
  const planningDepth = opts.planningDepth ?? plan.planning_depth;

  if (!opts.overwrite && plan.required_dimensions.length > 0) {
    return {
      ...plan,
      planning_type: planningType,
      planning_depth: planningDepth,
    };
  }

  const dims = getDimensionsForType(planningType, planningDepth);
  return {
    ...plan,
    planning_type: planningType,
    planning_depth: planningDepth,
    required_dimensions: dims.required,
    optional_dimensions: dims.optional,
  };
}

// ---------------------------------------------------------------------------
// Public API — path resolution and I/O
// ---------------------------------------------------------------------------

/**
 * Options for `resolveSessionPlanPath`.
 */
export interface ResolveSessionPlanPathOpts {
  /** Project root directory. */
  cwd: string;
  /** Session identifier (e.g. `'2026-04-03-add-dark-mode'`). Must not contain path separators. */
  session: string;
}

/**
 * Resolve a session identifier to its absolute file path within
 * `<cwd>/.eforge/session-plans/<session>.md`.
 *
 * Throws if the resolved path would escape the `.eforge/session-plans/`
 * directory (path traversal guard).
 */
export function resolveSessionPlanPath(opts: ResolveSessionPlanPathOpts): string {
  // Session ids are flat filenames within .eforge/session-plans/; reject
  // empty values, path separators, and traversal segments up-front so that
  // clients cannot create nested files (which `listActiveSessionPlans`
  // would silently miss) or sneak a non-canonical resolution past the
  // prefix guard below.
  if (
    opts.session.length === 0 ||
    opts.session.includes('/') ||
    opts.session.includes('\\') ||
    opts.session === '.' ||
    opts.session === '..'
  ) {
    throw new Error(
      `Invalid session identifier "${opts.session}": must be a flat filename without path separators`,
    );
  }

  const sessionPlansDir = resolve(opts.cwd, '.eforge', 'session-plans');
  const filePath = resolve(sessionPlansDir, `${opts.session}.md`);

  // Guard against path traversal: the resolved path must start with the
  // session-plans directory (use sep-terminated prefix to avoid false matches).
  const guardPrefix = sessionPlansDir.endsWith(sep)
    ? sessionPlansDir
    : sessionPlansDir + sep;

  if (!filePath.startsWith(guardPrefix)) {
    throw new Error(
      `Session identifier "${opts.session}" would escape .eforge/session-plans/`,
    );
  }

  return filePath;
}

/**
 * Options for `loadSessionPlan`.
 */
export interface LoadSessionPlanOpts {
  /** Project root directory. */
  cwd: string;
  /** Session identifier. */
  session: string;
}

/**
 * Read and parse a session plan by session identifier.
 * Path is resolved via `resolveSessionPlanPath` (path-traversal safe).
 *
 * Throws if the file does not exist or fails to parse.
 */
export async function loadSessionPlan(opts: LoadSessionPlanOpts): Promise<SessionPlan> {
  const filePath = resolveSessionPlanPath(opts);
  const raw = await readFile(filePath, 'utf-8');
  return parseSessionPlan(raw);
}

/**
 * Options for `writeSessionPlan`.
 */
export interface WriteSessionPlanOpts {
  /** Project root directory. Used for path resolution and the path-traversal guard. */
  cwd: string;
  /**
   * Session identifier. If omitted, `plan.session` is used.
   * Mutually exclusive with `path`.
   */
  session?: string;
  /**
   * Absolute path to write to. Must be within `<cwd>/.eforge/session-plans/`.
   * Mutually exclusive with `session`.
   */
  path?: string;
  /** The session plan to serialize and write. */
  plan: SessionPlan;
}

/**
 * Serialize a `SessionPlan` and write it atomically to disk.
 *
 * The target path is constrained to `<cwd>/.eforge/session-plans/`.
 * Passing a `path` or `session` that would escape this directory throws.
 *
 * Uses a temporary-file-then-rename strategy for atomic writes.
 */
export async function writeSessionPlan(opts: WriteSessionPlanOpts): Promise<void> {
  const sessionPlansDir = resolve(opts.cwd, '.eforge', 'session-plans');
  const guardPrefix = sessionPlansDir.endsWith(sep)
    ? sessionPlansDir
    : sessionPlansDir + sep;

  let filePath: string;
  if (opts.path !== undefined) {
    const resolvedPath = resolve(opts.path);
    if (!resolvedPath.startsWith(guardPrefix)) {
      throw new Error(
        `writeSessionPlan: path "${opts.path}" would escape .eforge/session-plans/`,
      );
    }
    filePath = resolvedPath;
  } else {
    const session = opts.session ?? opts.plan.session;
    filePath = resolveSessionPlanPath({ cwd: opts.cwd, session });
  }

  const content = serializeSessionPlan(opts.plan);
  await mkdir(dirname(filePath), { recursive: true });

  // Atomic write: write to a temp file then rename
  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Public API — legacy migration
// ---------------------------------------------------------------------------

/**
 * Migrate a session plan that uses the legacy boolean `dimensions: { ... }`
 * frontmatter shape to the new `required_dimensions` / `optional_dimensions` /
 * `skipped_dimensions` format.
 *
 * If the plan does not use the legacy shape, it is returned unchanged.
 *
 * Migration rules (per the planning skill):
 * - Set `planning_type` to `'unknown'` (the legacy fallback type).
 * - All six legacy dimensions plus `acceptance-criteria` become `required_dimensions`.
 * - Dimensions that were `true` in the legacy map are assumed to have body
 *   content already — they remain in `required_dimensions` and will pass the
 *   body-content check in `checkReadiness`.
 * - Dimensions that were `false` will fail readiness until their body sections
 *   are filled in.
 * - `optional_dimensions` is set to empty.
 * - `skipped_dimensions` is preserved as-is.
 */
export function migrateBooleanDimensions(plan: SessionPlan): SessionPlan {
  const raw = plan as unknown as Record<string, unknown>;
  const legacyDimensions = raw['dimensions'];

  if (
    !legacyDimensions ||
    typeof legacyDimensions !== 'object' ||
    legacyDimensions === null ||
    Array.isArray(legacyDimensions)
  ) {
    return plan;
  }

  // Detected legacy boolean shape
  return {
    ...plan,
    planning_type: 'unknown',
    planning_depth: plan.planning_depth === 'unknown' as PlanningDepth ? 'focused' : plan.planning_depth,
    required_dimensions: LEGACY_DIMENSIONS,
    optional_dimensions: [],
  };
}

// ---------------------------------------------------------------------------
// Public API — build source compilation
// ---------------------------------------------------------------------------

/**
 * Format a `SessionPlan` as ordinary build source (PRD-style markdown) suitable
 * for the engine queue.
 *
 * The topic becomes the top-level heading. Dimension sections from the body are
 * included verbatim. Any leading `# {topic}` heading in the body is stripped to
 * avoid duplication.
 */
export function sessionPlanToBuildSource(plan: SessionPlan): string {
  // Strip a leading "# ..." heading from the body if present (it duplicates the topic)
  const cleanBody = plan.body.replace(/^\s*#[^\n]*\n*/, '').trim();

  const parts: string[] = [`# ${plan.topic}`];

  if (cleanBody) {
    parts.push('', cleanBody);
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Public API — boundary normalization
// ---------------------------------------------------------------------------

export interface NormalizeBuildSourceInput {
  /** Absolute or relative path to the source file. */
  sourcePath: string;
  /** Raw file content. */
  content: string;
}

export interface NormalizeBuildSourceResult {
  /** Path to the normalized source (unchanged for non-session-plan files). */
  sourcePath: string;
  /** Normalized content (converted build source for session plans; original for others). */
  content: string;
}

/**
 * Returns `true` when `sourcePath` matches the `.eforge/session-plans/*.md`
 * pattern. Only files under this specific path are treated as session plans.
 * Arbitrary markdown PRDs pass through untouched.
 */
function isSessionPlanPath(sourcePath: string): boolean {
  // Normalize path separators for cross-platform matching
  const normalized = sourcePath.replace(/\\/g, '/');
  return /\/.eforge\/session-plans\/[^/]+\.md$/.test(normalized);
}

/**
 * Normalize a build source input.
 *
 * If `sourcePath` matches `.eforge/session-plans/<name>.md`, the `content` is
 * parsed as a session plan and converted to ordinary build source via
 * `sessionPlanToBuildSource`. Otherwise, the input is returned unchanged.
 *
 * This is the single chokepoint for session-plan handling at the boundary —
 * both daemon and in-process CLI paths call this to avoid divergent behavior.
 *
 * @throws If the path matches the session-plan pattern but the content cannot
 *   be parsed as a valid session plan.
 */
export function normalizeBuildSource(input: NormalizeBuildSourceInput): NormalizeBuildSourceResult {
  if (!isSessionPlanPath(input.sourcePath)) {
    return { sourcePath: input.sourcePath, content: input.content };
  }

  const plan = parseSessionPlan(input.content);
  const content = sessionPlanToBuildSource(plan);
  return { sourcePath: input.sourcePath, content };
}
