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
 *   migrateBooleanDimensions  — convert legacy boolean dimension shape to new format
 *   sessionPlanToBuildSource  — format a session plan as ordinary build source
 *   normalizeBuildSource      — detect session-plan paths and convert to build source
 */
import { readFile, readdir } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod/v4';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionPlanStatus = 'planning' | 'ready' | 'abandoned';
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
  status: z.enum(['planning', 'ready', 'abandoned']),
  planning_type: z.enum(['bugfix', 'feature', 'refactor', 'architecture', 'docs', 'maintenance', 'unknown']),
  planning_depth: z.enum(['quick', 'focused', 'deep']),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
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
