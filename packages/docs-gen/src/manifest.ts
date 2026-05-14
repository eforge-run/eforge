/**
 * Curated LLMs manifest.
 *
 * This file is the hand-authored source of truth for llms.txt. It defines
 * what eforge is, which links are canonical for agents, and the order in which
 * reference files are concatenated into llms-full.txt.
 */

export interface LlmsManifestEntry {
  /** Short surface identifier — must match the generator module name. */
  surface: string;
  title: string;
  rawUrl: string;
  description: string;
}

export interface LlmsManifestLink {
  title: string;
  url: string;
  description: string;
}

export interface LlmsManifest {
  summary: string;
  overview: string;
  guides: LlmsManifestLink[];
  entries: LlmsManifestEntry[];
  packages: LlmsManifestLink[];
  schemas: Array<{ title: string; url: string }>;
  optional: LlmsManifestLink[];
}

export const LLMS_MANIFEST: LlmsManifest = {
  summary:
    'eforge turns prompts, plans, playbooks, or PRDs into reviewed code through a multi-agent build pipeline.',
  overview:
    'eforge is an autonomous build-and-review orchestration engine for code generation. ' +
    'It accepts build intent from CLI prompts, rough notes, session plans, playbooks, or PRD files; ' +
    'normalizes that input into build source; plans implementation steps using AI agents; builds in ' +
    'parallel worktrees; reviews the result; and merges to the base branch. The daemon keeps a ' +
    'persistent HTTP server for queue management and live SSE event streaming.',
  guides: [
    {
      title: 'Getting Started',
      url: '/docs/getting-started.md',
      description: 'Install eforge, initialize a project, and run your first build',
    },
    {
      title: 'Configuration guide',
      url: '/docs/configuration.md',
      description: 'Practical setup and tuning guidance before using the full config reference',
    },
    // --- eforge:region plan-01-reference-and-mirror-content ---
    {
      title: 'Extensions guide',
      url: '/docs/extensions.md',
      description: 'How native eforge extensions are discovered, trusted, loaded, and authored',
    },
    {
      title: 'Extensions API reference',
      url: '/docs/extensions-api.md',
      description: 'Typed extension SDK concepts, hook registration, context objects, and runtime boundaries',
    },
    // --- eforge:endregion plan-01-reference-and-mirror-content ---
  ],
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
  packages: [
    {
      title: 'GitHub repository',
      url: 'https://github.com/eforge-build/eforge',
      description: 'Source repository for the engine, daemon, docs, Claude Code plugin, and Pi extension',
    },
    {
      title: 'Standalone CLI npm package',
      url: 'https://www.npmjs.com/package/@eforge-build/eforge',
      description: 'npm package for the eforge CLI and daemon runtime',
    },
    {
      title: 'Pi extension npm package',
      url: 'https://www.npmjs.com/package/@eforge-build/pi-eforge',
      description: 'npm package for the native Pi integration',
    },
  ],
  schemas: [
    { title: 'Event schema (JSON Schema)', url: '/schemas/events.schema.json' },
    { title: 'Config schema (JSON Schema)', url: '/schemas/config.schema.json' },
  ],
  optional: [
    {
      title: 'Why eforge',
      url: '/why',
      description: 'Positioning and product thesis: asynchronous engineering for planned work',
    },
    {
      title: 'Core concepts',
      url: '/docs/concepts.md',
      description: 'Pipeline concepts, harnesses, tiers, queues, and agent-readable artifacts',
    },
    {
      title: 'Glossary',
      url: '/docs/glossary.md',
      description: 'eforge-specific terms such as profile, worktree, planner, reviewer, recovery sidecar, and playbook',
    },
    {
      title: 'Project README',
      url: 'https://github.com/eforge-build/eforge#readme',
      description: 'Broader project narrative, screenshots, install notes, and examples',
    },
  ],
};
