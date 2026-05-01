/**
 * Playbook types, Zod schema, parser, and engine API.
 *
 * A playbook is a Markdown file with YAML frontmatter that encodes a reusable
 * build intent. Playbooks live in three-tier directories (project-local,
 * project-team, user) under `playbooks/` and are resolved with the generic
 * `set-resolver` infrastructure.
 *
 * Public API:
 *   listPlaybooks   — merged listing with source labels and shadow chains
 *   loadPlaybook    — highest-precedence copy for a given name
 *   validatePlaybook — pure schema validation (used by daemon endpoint)
 *   writePlaybook   — atomic write to the target tier directory
 *   movePlaybook    — move between tiers (git mv when both in repo, else rename)
 *   playbookToSessionPlan — format a playbook for the planner agent
 */
import { readFile, writeFile, rename, mkdir, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod/v4';

import {
  listSetArtifacts,
  loadSetArtifact,
  projectLocalSetDir,
  projectTeamSetDir,
  userSetDir,
  type SetArtifactSource,
  type SetArtifactShadow,
} from './set-resolver.js';

// ---------------------------------------------------------------------------
// Shadow entry helper
// ---------------------------------------------------------------------------

/** A shadow entry in the merged playbook listing — a lower-precedence tier that
 *  also contains a playbook with the same name. */
export interface PlaybookShadowEntry {
  /** Which tier this shadow copy comes from. */
  source: SetArtifactShadow;
  /** Absolute path to the shadow file. */
  path: string;
}

/** Compute shadow entries (with paths) for a given artifact name. */
function shadowEntries(
  name: string,
  shadows: SetArtifactShadow[],
  opts: { configDir: string; cwd: string },
): PlaybookShadowEntry[] {
  return shadows.map((source) => {
    let dir: string;
    if (source === 'project-team') {
      dir = projectTeamSetDir(PLAYBOOKS_KIND, opts.configDir);
    } else {
      dir = userSetDir(PLAYBOOKS_KIND);
    }
    return { source, path: `${dir}/${name}.${PLAYBOOKS_KIND.fileExtension}` };
  });
}

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Set kind descriptor
// ---------------------------------------------------------------------------

const PLAYBOOKS_KIND = { dirSegment: 'playbooks', fileExtension: 'md' } as const;

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
// PlaybookEntry (listing)
// ---------------------------------------------------------------------------

/** A single entry in the merged playbook listing. */
export interface PlaybookEntry {
  name: string;
  description: string;
  scope: PlaybookScope;
  /** Which tier the highest-precedence copy came from. */
  source: SetArtifactSource;
  /**
   * Full shadow chain — lower-precedence tiers that also have this playbook.
   * Highest-precedence first. Empty when no other tier has this name.
   */
  shadows: PlaybookShadowEntry[];
  /** Absolute path to the file. */
  path: string;
}

// ---------------------------------------------------------------------------
// Session plan output
// ---------------------------------------------------------------------------

/**
 * Structured input for the planner agent produced by `playbookToSessionPlan`.
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

/** Source label → expected scope value mapping. */
const SOURCE_TO_SCOPE: Record<SetArtifactSource, PlaybookScope> = {
  'project-local': 'project-local',
  'project-team': 'project-team',
  'user': 'user',
};

/** Parse a raw playbook file. Returns the Playbook or an error list. */
function parsePlaybookRaw(raw: string): { ok: true; playbook: Playbook } | { ok: false; errors: string[] } {
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
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
  const artifacts = await listSetArtifacts(PLAYBOOKS_KIND, opts);
  const playbooks: PlaybookEntry[] = [];
  const warnings: string[] = [];

  await Promise.all(
    artifacts.map(async (artifact) => {
      let description = '';
      let scope: PlaybookScope = SOURCE_TO_SCOPE[artifact.source];

      try {
        const raw = await readFile(artifact.path, 'utf-8');
        const [fm] = splitFrontmatter(raw);
        const fmResult = playbookFrontmatterSchema.safeParse(fm);
        if (fmResult.success) {
          description = fmResult.data.description;
          const declaredScope = fmResult.data.scope;
          const expectedScope = SOURCE_TO_SCOPE[artifact.source];
          if (declaredScope !== expectedScope) {
            warnings.push(
              `Playbook "${artifact.name}" at ${artifact.path}: ` +
              `frontmatter scope "${declaredScope}" does not match storage tier "${expectedScope}".`,
            );
          }
          scope = declaredScope;
        }
      } catch {
        // unreadable — include with empty description
      }

      playbooks.push({
        name: artifact.name,
        description,
        scope,
        source: artifact.source,
        shadows: shadowEntries(artifact.name, artifact.shadows, opts),
        path: artifact.path,
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
): Promise<{ playbook: Playbook; source: SetArtifactSource; shadows: PlaybookShadowEntry[] }> {
  const artifact = await loadSetArtifact(PLAYBOOKS_KIND, opts.name, opts);
  if (!artifact) {
    throw new PlaybookNotFoundError(opts.name);
  }

  const raw = await readFile(artifact.path, 'utf-8');
  const result = parsePlaybookRaw(raw);
  if (!result.ok) {
    throw new Error(`Playbook "${opts.name}" at ${artifact.path} is invalid: ${result.errors.join('; ')}`);
  }

  // Determine full shadow chain
  const allArtifacts = await listSetArtifacts(PLAYBOOKS_KIND, opts);
  const entry = allArtifacts.find((a) => a.name === opts.name);
  const rawShadows = entry?.shadows ?? [];

  return { playbook: result.playbook, source: artifact.source, shadows: shadowEntries(opts.name, rawShadows, opts) };
}

/**
 * Validate a raw playbook file string without writing or loading from disk.
 * Used by the daemon's `/api/playbook/validate` endpoint.
 */
export function validatePlaybook(
  raw: string,
): { ok: true; playbook: Playbook } | { ok: false; errors: string[] } {
  return parsePlaybookRaw(raw);
}

export interface WritePlaybookOpts {
  configDir: string;
  cwd: string;
  scope: PlaybookScope;
  playbook: Playbook;
}

/**
 * Write a playbook to the tier directory matching `scope`.
 * Creates the tier directory if it does not exist.
 * Uses atomic temp-file + rename write (same pattern as `createAgentRuntimeProfile`).
 * Does not invoke `forgeCommit` — staging is the caller's responsibility.
 */
export async function writePlaybook(opts: WritePlaybookOpts): Promise<{ path: string }> {
  const { scope, playbook, configDir, cwd } = opts;

  const targetDir =
    scope === 'project-local'
      ? projectLocalSetDir(PLAYBOOKS_KIND, cwd)
      : scope === 'project-team'
        ? projectTeamSetDir(PLAYBOOKS_KIND, configDir)
        : userSetDir(PLAYBOOKS_KIND);

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
  const { name, fromScope, toScope, configDir, cwd } = opts;

  const fromDir =
    fromScope === 'project-local'
      ? projectLocalSetDir(PLAYBOOKS_KIND, cwd)
      : fromScope === 'project-team'
        ? projectTeamSetDir(PLAYBOOKS_KIND, configDir)
        : userSetDir(PLAYBOOKS_KIND);

  const toDir =
    toScope === 'project-local'
      ? projectLocalSetDir(PLAYBOOKS_KIND, cwd)
      : toScope === 'project-team'
        ? projectTeamSetDir(PLAYBOOKS_KIND, configDir)
        : userSetDir(PLAYBOOKS_KIND);

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

/**
 * Format a `Playbook` as the structured prompt input the planner agent accepts.
 *
 * The body sections are assembled into a PRD-style document and returned
 * alongside the individual fields for callers that need structured access.
 * Pass `result.source` directly to `runPlanner` as the `source` argument.
 */
export function playbookToSessionPlan(playbook: Playbook): SessionPlanInput {
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

  // Resolve the highest-precedence artifact to get its path
  const artifact = await loadSetArtifact(PLAYBOOKS_KIND, name, opts);
  if (!artifact) {
    throw new PlaybookNotFoundError(name);
  }

  const raw = await readFile(artifact.path, 'utf-8');
  const result = parsePlaybookRaw(raw);
  if (!result.ok) {
    throw new Error(`Playbook "${name}" at ${artifact.path} is invalid: ${result.errors.join('; ')}`);
  }

  // Write to target scope with updated scope field
  const updatedPlaybook: Playbook = { ...result.playbook, scope: targetScope };
  const { path: targetPath } = await writePlaybook({ configDir, cwd, scope: targetScope, playbook: updatedPlaybook });

  return {
    sourcePath: artifact.path,
    targetPath,
    targetScope,
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Serialize a Playbook to a Markdown string with YAML frontmatter. */
function serializePlaybook(playbook: Playbook): string {
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
