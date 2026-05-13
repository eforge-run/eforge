/**
 * Curated LLMs manifest.
 *
 * This file is the hand-authored source of truth for llms.txt. It defines
 * what eforge is, which reference files are canonical, and the order in which
 * they are concatenated into llms-full.txt.
 */

export interface LlmsManifestEntry {
  /** Short surface identifier — must match the generator module name. */
  surface: string;
  title: string;
  rawUrl: string;
  description: string;
}

export interface LlmsManifest {
  overview: string;
  entries: LlmsManifestEntry[];
  schemas: Array<{ title: string; url: string }>;
}

export const LLMS_MANIFEST: LlmsManifest = {
  overview:
    'eforge is an autonomous build-and-review orchestration engine for code generation. ' +
    'It accepts a PRD (Product Requirements Document) as input, plans implementation steps ' +
    'using AI agents, builds in parallel worktrees, reviews the result, and merges to the ' +
    'base branch. The daemon keeps a persistent HTTP server for queue management and live ' +
    'SSE event streaming.',
  entries: [
    {
      surface: 'cli',
      title: 'CLI reference',
      rawUrl: '/reference/cli.md',
      description: 'All eforge CLI subcommands and options',
    },
    {
      surface: 'api',
      title: 'Daemon HTTP API',
      rawUrl: '/reference/api.md',
      description: 'REST endpoints and SSE streams exposed by the eforge daemon',
    },
    {
      surface: 'events',
      title: 'Event protocol',
      rawUrl: '/reference/events.md',
      description: 'All EforgeEvent discriminant variants emitted on the SSE stream',
    },
    {
      surface: 'config',
      title: 'Configuration',
      rawUrl: '/reference/config.md',
      description: 'eforge/config.yaml schema with all fields and defaults',
    },
    {
      surface: 'tools',
      title: 'MCP tools and skills',
      rawUrl: '/reference/tools.md',
      description:
        'MCP tools (Claude Code plugin) and native commands (Pi extension) plus skill parity table',
    },
  ],
  schemas: [
    { title: 'Event schema (JSON Schema)', url: '/schemas/events.schema.json' },
    { title: 'Config schema (JSON Schema)', url: '/schemas/config.schema.json' },
  ],
};
