/**
 * Playbook types, Zod schema, parser, and public API.
 *
 * A playbook is a Markdown file with YAML frontmatter that encodes a reusable
 * build intent. Playbooks live in three-tier directories (project-local,
 * project-team, user) under `playbooks/` and are resolved with the
 * @eforge-build/scopes named-set resolution infrastructure.
 *
 * Public API:
 *   parsePlaybook        — parse raw markdown to a typed Playbook
 *   serializePlaybook    — serialize a Playbook back to markdown
 *   listPlaybooks        — merged listing with source labels and shadow chains
 *   loadPlaybook         — highest-precedence copy for a given name
 *   validatePlaybook     — pure schema validation (used by daemon endpoint)
 *   writePlaybook        — atomic write to the target tier directory
 *   movePlaybook         — move between tiers (git mv when both in repo, else rename)
 *   copyPlaybookToScope  — copy to a different tier with updated scope frontmatter
 *   playbookToBuildSource — format a playbook as ordinary build source (preferred name)
 *   playbookToSessionPlan — alias for playbookToBuildSource (backward-compatible name)
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod/v4';

import {
  listNamedSet,
  resolveNamedSet,
  getScopeDirectory,
  type Scope,
  type ScopeShadow,
} from '@eforge-build/scopes';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Zod Schema
// ---------------------------------------------------------------------------

/**
 * Valid playbook scope values. Must match the storage tier the file was loaded
 * from; a mismatch is surfaced as a warning in `listPlaybooks`.
 */
export const playbookScopeSchema = z.enum(['user', 'project-team', 'project-local']);
export type PlaybookScope = z.output<typeof playbookScopeSchema>;

/**
 * Frontmatter schema for a playbook file.
 */
export const playbookFrontmatterSchema = z.object({
  /** Kebab-case playbook identifier. */
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be kebab-case'),
  /** Short human-readable description. */
  description: z.string().min(1),
  /** Which configuration tier this playbook belongs to. */
  scope: playbookScopeSchema,
  /** Commands to run after the build merges (e.g. `["pnpm build"]`). */
  postMerge: z.array(z.string()).optional(),
});

export type PlaybookFrontmatter = z.output<typeof playbookFrontmatterSchema>;

// ---------------------------------------------------------------------------
// Playbook body sections
// ---------------------------------------------------------------------------

export interface PlaybookBody {
  /** Content of the `## Goal` section (required). */
  goal: string;
  /** Content of the `## Out of scope` section (empty string when absent). */
  outOfScope: string;
  /** Content of the `## Acceptance criteria` section (empty string when absent). */
  acceptanceCriteria: string;
  /** Content of the `## Notes for the planner` section (empty string when absent). */
  plannerNotes: string;
}

// ---------------------------------------------------------------------------
// Playbook (composite)
// ---------------------------------------------------------------------------

/** A fully parsed playbook file (frontmatter + body). */
export interface Playbook extends PlaybookFrontmatter, PlaybookBody {}

// ---------------------------------------------------------------------------
// Shadow entry helper
// ---------------------------------------------------------------------------

/** A shadow entry in the merged playbook listing — a lower-precedence tier that
 *  also contains a playbook with the same name. */
export interface PlaybookShadowEntry {
  /** Which tier this shadow copy comes from. */
  source: ScopeShadow;
  /** Absolute path to the shadow file. */
  path: string;
}

// ---------------------------------------------------------------------------
// PlaybookEntry (listing)
// ---------------------------------------------------------------------------

/** A single entry in the merged playbook listing. */
export interface PlaybookEntry {
  name: string;
  description: string;
  scope: PlaybookScope;
  /** Which tier the highest-precedence copy came from. */
  source: Scope;
  /**
   * Full shadow chain — lower-precedence tiers that also have this playbook.
   * Highest-precedence first. Empty when no other tier has this name.
   */
  shadows: PlaybookShadowEntry[];
  /** Absolute path to the file. */
  path: string;
}

// ---------------------------------------------------------------------------
// Session plan output (build source compiled from a playbook)
// ---------------------------------------------------------------------------

/**
 * Structured input for the planner agent produced by `playbookToBuildSource`.
 *
 * The `source` field is the formatted PRD-style string that can be passed
 * directly to `runPlanner` as its first argument. The individual section
 * fields are provided for callers that need to inspect or transform the
 * content before feeding it to the planner.
 */
export interface SessionPlanInput {
  /** Suggested plan set name derived from the playbook name. */
  name: string;
  /** The formatted PRD-style prompt string, ready to pass to `runPlanner`. */
  source: string;
  /** Raw goal text extracted from the playbook. */
  goal: string;
  /** Raw out-of-scope text extracted from the playbook. */
  outOfScope: string;
  /** Raw acceptance criteria text extracted from the playbook. */
  acceptanceCriteria: string;
  /** Raw planner notes text extracted from the playbook. */
  plannerNotes: string;
  /** Commands to run after the build merges (forwarded from frontmatter). */
  postMerge?: string[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PlaybookNotFoundError extends Error {
  constructor(name: string) {
    super(`Playbook "${name}" not found in any tier (project-local, project-team, user).`);
    this.name = 'PlaybookNotFoundError';
  }
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

/** Map section headings to PlaybookBody field names. */
const SECTION_MAP: Record<string, keyof PlaybookBody> = {
  'goal': 'goal',
  'out of scope': 'outOfScope',
  'acceptance criteria': 'acceptanceCriteria',
  'notes for the planner': 'plannerNotes',
};

/**
 * Parse the body of a playbook Markdown file into named sections.
 * Sections are identified by `## <Heading>` (case-insensitive).
 * Missing optional sections are returned as empty strings.
 */
function parseBody(bodyText: string): PlaybookBody | { error: string } {
  const sections: Partial<PlaybookBody> = {};
  const lines = bodyText.split(/\r?\n/);

  let currentField: keyof PlaybookBody | null = null;
  const currentLines: string[] = [];

  function flush() {
    if (currentField !== null) {
      sections[currentField] = currentLines.join('\n').trim();
    }
    currentLines.length = 0;
  }

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      flush();
      const heading = headingMatch[1].trim().toLowerCase();
      currentField = SECTION_MAP[heading] ?? null;
    } else if (currentField !== null) {
      currentLines.push(line);
    }
  }
  flush();

  if (!sections.goal && sections.goal !== '') {
    return { error: 'Missing required section: ## Goal' };
  }

  return {
    goal: sections.goal ?? '',
    outOfScope: sections.outOfScope ?? '',
    acceptanceCriteria: sections.acceptanceCriteria ?? '',
    plannerNotes: sections.plannerNotes ?? '',
  };
}

/** Parse a raw playbook file. Returns the Playbook or an error list. */
function parsePlaybookInternal(raw: string): { ok: true; playbook: Playbook } | { ok: false; errors: string[] } {
  const [fm, bodyText] = splitFrontmatter(raw);
  const fmResult = playbookFrontmatterSchema.safeParse(fm);
  if (!fmResult.success) {
    const errors = fmResult.error.issues.map((i) => {
      const path = i.path.length > 0 ? i.path.join('.') + ': ' : '';
      return path + i.message;
    });
    return { ok: false, errors };
  }

  const bodyResult = parseBody(bodyText);
  if ('error' in bodyResult) {
    return { ok: false, errors: [bodyResult.error] };
  }

  return { ok: true, playbook: { ...fmResult.data, ...bodyResult } };
}

/** Return the playbooks subdirectory for a given scope tier. */
function playbooksDir(scope: PlaybookScope, opts: { cwd: string; configDir: string }): string {
  return resolve(getScopeDirectory(scope, opts), 'playbooks');
}

/** Compute shadow entries (with paths) for a given artifact name. */
function shadowEntries(
  name: string,
  shadows: ScopeShadow[],
  opts: { cwd: string; configDir: string },
): PlaybookShadowEntry[] {
  return shadows.map((source) => {
    const dir = resolve(getScopeDirectory(source, opts), 'playbooks');
    return { source, path: `${dir}/${name}.md` };
  });
}

// ---------------------------------------------------------------------------
// Public API — parse / serialize
// ---------------------------------------------------------------------------

/**
 * Parse a raw playbook markdown string into a typed `Playbook`.
 * Throws an error if the frontmatter is invalid or the `## Goal` section is missing.
 */
export function parsePlaybook(raw: string): Playbook {
  const result = parsePlaybookInternal(raw);
  if (!result.ok) {
    throw new Error(`Invalid playbook: ${result.errors.join('; ')}`);
  }
  return result.playbook;
}

/** Serialize a `Playbook` to a Markdown string with YAML frontmatter. */
export function serializePlaybook(playbook: Playbook): string {
  const fm: Record<string, unknown> = {
    name: playbook.name,
    description: playbook.description,
    scope: playbook.scope,
  };
  if (playbook.postMerge !== undefined && playbook.postMerge.length > 0) {
    fm.postMerge = playbook.postMerge;
  }

  const fmLines = Object.entries(fm)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        return `${k}:\n${v.map((item) => `  - ${item}`).join('\n')}`;
      }
      return `${k}: ${v}`;
    })
    .join('\n');

  const sections: string[] = [];
  sections.push(`## Goal\n\n${playbook.goal.trim()}`);

  if (playbook.outOfScope.trim()) {
    sections.push(`## Out of scope\n\n${playbook.outOfScope.trim()}`);
  }

  if (playbook.acceptanceCriteria.trim()) {
    sections.push(`## Acceptance criteria\n\n${playbook.acceptanceCriteria.trim()}`);
  }

  if (playbook.plannerNotes.trim()) {
    sections.push(`## Notes for the planner\n\n${playbook.plannerNotes.trim()}`);
  }

  return [`---`, fmLines, `---`, '', sections.join('\n\n'), ''].join('\n');
}

// ---------------------------------------------------------------------------
// Public API — validate
// ---------------------------------------------------------------------------

/**
 * Validate a raw playbook file string without writing or loading from disk.
 * Used by the daemon's `/api/playbook/validate` endpoint.
 */
export function validatePlaybook(
  raw: string,
): { ok: true; playbook: Playbook } | { ok: false; errors: string[] } {
  return parsePlaybookInternal(raw);
}

// ---------------------------------------------------------------------------
// Public API — list / load
// ---------------------------------------------------------------------------

export interface ListPlaybooksOpts {
  configDir: string;
  cwd: string;
}

/**
 * List all playbooks across all three tiers. The merged list contains one entry
 * per name (highest-precedence wins). Each entry carries `source` and `shadows`.
 *
 * Warnings are emitted when a playbook's frontmatter `scope` field does not
 * match the tier its file was loaded from.
 */
export async function listPlaybooks(
  opts: ListPlaybooksOpts,
): Promise<{ playbooks: PlaybookEntry[]; warnings: string[] }> {
  const entries = await listNamedSet('playbooks', { ...opts, extension: 'md' });
  const playbooks: PlaybookEntry[] = [];
  const warnings: string[] = [];

  await Promise.all(
    entries.map(async (entry) => {
      let description = '';
      let scope: PlaybookScope = entry.scope as PlaybookScope;

      try {
        const raw = await readFile(entry.path, 'utf-8');
        const [fm] = splitFrontmatter(raw);
        const fmResult = playbookFrontmatterSchema.safeParse(fm);
        if (fmResult.success) {
          description = fmResult.data.description;
          const declaredScope = fmResult.data.scope;
          const expectedScope = entry.scope as PlaybookScope;
          if (declaredScope !== expectedScope) {
            warnings.push(
              `Playbook "${entry.name}" at ${entry.path}: ` +
              `frontmatter scope "${declaredScope}" does not match storage tier "${expectedScope}".`,
            );
          }
          scope = declaredScope;
        }
      } catch {
        // unreadable — include with empty description
      }

      playbooks.push({
        name: entry.name,
        description,
        scope,
        source: entry.scope,
        shadows: shadowEntries(entry.name, entry.shadows, opts),
        path: entry.path,
      });
    }),
  );

  // Re-sort by name for deterministic output
  playbooks.sort((a, b) => a.name.localeCompare(b.name));

  return { playbooks, warnings };
}

export interface LoadPlaybookOpts {
  configDir: string;
  cwd: string;
  name: string;
}

/**
 * Load the highest-precedence copy of a named playbook.
 * Throws `PlaybookNotFoundError` when no tier has a playbook with that name.
 */
export async function loadPlaybook(
  opts: LoadPlaybookOpts,
): Promise<{ playbook: Playbook; source: Scope; shadows: PlaybookShadowEntry[] }> {
  const map = await resolveNamedSet('playbooks', { ...opts, extension: 'md' });
  const entry = map.get(opts.name);
  if (!entry) {
    throw new PlaybookNotFoundError(opts.name);
  }

  const raw = await readFile(entry.path, 'utf-8');
  const result = parsePlaybookInternal(raw);
  if (!result.ok) {
    throw new Error(`Playbook "${opts.name}" at ${entry.path} is invalid: ${result.errors.join('; ')}`);
  }

  return {
    playbook: result.playbook,
    source: entry.scope,
    shadows: shadowEntries(opts.name, entry.shadows, opts),
  };
}

// ---------------------------------------------------------------------------
// Public API — write / move / copy
// ---------------------------------------------------------------------------

export interface WritePlaybookOpts {
  configDir: string;
  cwd: string;
  scope: PlaybookScope;
  playbook: Playbook;
}

/**
 * Write a playbook to the tier directory matching `scope`.
 * Creates the tier directory if it does not exist.
 * Uses atomic temp-file + rename write.
 * Does not invoke `forgeCommit` — staging is the caller's responsibility.
 */
export async function writePlaybook(opts: WritePlaybookOpts): Promise<{ path: string }> {
  const { scope, playbook, cwd, configDir } = opts;
  const targetDir = playbooksDir(scope, { cwd, configDir });

  await mkdir(targetDir, { recursive: true });

  const filePath = resolve(targetDir, `${playbook.name}.md`);
  const content = serializePlaybook(playbook);

  const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, content, 'utf-8');
  await rename(tmp, filePath);

  return { path: filePath };
}

export interface MovePlaybookOpts {
  configDir: string;
  cwd: string;
  name: string;
  fromScope: PlaybookScope;
  toScope: PlaybookScope;
}

/**
 * Move a playbook between tier directories.
 * Uses `git mv` when both source and destination are inside the repo working
 * tree; falls back to `fs.rename` otherwise.
 * Returns the destination path so the caller can stage it.
 */
export async function movePlaybook(opts: MovePlaybookOpts): Promise<{ path: string }> {
  const { name, fromScope, toScope, cwd, configDir } = opts;

  const fromDir = playbooksDir(fromScope, { cwd, configDir });
  const toDir = playbooksDir(toScope, { cwd, configDir });

  const src = resolve(fromDir, `${name}.md`);
  const dst = resolve(toDir, `${name}.md`);

  await mkdir(toDir, { recursive: true });

  // Attempt git mv when both paths are inside the repo (i.e. not user scope)
  const bothInRepo = fromScope !== 'user' && toScope !== 'user';
  if (bothInRepo) {
    try {
      await execFileAsync('git', ['-C', cwd, 'mv', src, dst]);
      return { path: dst };
    } catch {
      // git mv failed — fall through to fs.rename
    }
  }

  await rename(src, dst);
  return { path: dst };
}

export interface CopyPlaybookToScopeOpts {
  configDir: string;
  cwd: string;
  name: string;
  targetScope: PlaybookScope;
}

export interface CopyPlaybookToScopeResult {
  sourcePath: string;
  targetPath: string;
  targetScope: PlaybookScope;
}

/**
 * Copy the highest-precedence version of a named playbook to a different tier.
 *
 * Loads the playbook from whichever tier currently owns the highest-precedence
 * copy, then writes it to the `targetScope` tier with the `scope` frontmatter
 * field updated to match. Overwrites the target if it already exists.
 *
 * Returns the source and target absolute paths so callers can stage/report them.
 */
export async function copyPlaybookToScope(opts: CopyPlaybookToScopeOpts): Promise<CopyPlaybookToScopeResult> {
  const { configDir, cwd, name, targetScope } = opts;

  const map = await resolveNamedSet('playbooks', { cwd, configDir, extension: 'md' });
  const entry = map.get(name);
  if (!entry) {
    throw new PlaybookNotFoundError(name);
  }

  const raw = await readFile(entry.path, 'utf-8');
  const result = parsePlaybookInternal(raw);
  if (!result.ok) {
    throw new Error(`Playbook "${name}" at ${entry.path} is invalid: ${result.errors.join('; ')}`);
  }

  // Write to target scope with updated scope field
  const updatedPlaybook: Playbook = { ...result.playbook, scope: targetScope };
  const { path: targetPath } = await writePlaybook({ configDir, cwd, scope: targetScope, playbook: updatedPlaybook });

  return {
    sourcePath: entry.path,
    targetPath,
    targetScope,
  };
}

// ---------------------------------------------------------------------------
// Public API — build source compilation
// ---------------------------------------------------------------------------

/**
 * Format a `Playbook` as ordinary build source suitable for the engine queue.
 *
 * The body sections are assembled into a PRD-style document and returned
 * alongside the individual fields for callers that need structured access.
 * Pass `result.source` directly to `runPlanner` as the `source` argument.
 *
 * This is the canonical name. `playbookToSessionPlan` is a backward-compatible
 * alias that callers should migrate away from.
 */
export function playbookToBuildSource(playbook: Playbook): SessionPlanInput {
  const sections: string[] = [];

  sections.push(`## Goal\n\n${playbook.goal.trim()}`);

  if (playbook.outOfScope.trim()) {
    sections.push(`## Out of scope\n\n${playbook.outOfScope.trim()}`);
  }

  if (playbook.acceptanceCriteria.trim()) {
    sections.push(`## Acceptance criteria\n\n${playbook.acceptanceCriteria.trim()}`);
  }

  if (playbook.plannerNotes.trim()) {
    sections.push(`## Notes for the planner\n\n${playbook.plannerNotes.trim()}`);
  }

  const source = [
    `# ${playbook.description}`,
    '',
    ...sections,
  ].join('\n\n');

  return {
    name: playbook.name,
    source,
    goal: playbook.goal,
    outOfScope: playbook.outOfScope,
    acceptanceCriteria: playbook.acceptanceCriteria,
    plannerNotes: playbook.plannerNotes,
    postMerge: playbook.postMerge,
  };
}

/**
 * Backward-compatible alias for `playbookToBuildSource`.
 * Prefer `playbookToBuildSource` in new code.
 */
export const playbookToSessionPlan = playbookToBuildSource;
