export interface DocNavItem {
  slug: string;
  title: string;
  group: string;
}

export interface ReferenceNavItem {
  slug: string;
  title: string;
  raw: string;
  schema?: string;
}

export const DOCS_NAV: DocNavItem[] = [
  { slug: 'getting-started', title: 'Getting Started', group: 'Guides' },
  { slug: 'concepts', title: 'Core Concepts', group: 'Guides' },
  { slug: 'configuration', title: 'Configuration', group: 'Guides' },
  { slug: 'extensions', title: 'Extensions', group: 'Extensibility' },
  { slug: 'extensions-api', title: 'Extensions API Reference', group: 'Extensibility' },
  { slug: 'glossary', title: 'Glossary', group: 'Reference' },
];

export const REFERENCE_NAV: ReferenceNavItem[] = [
  {
    slug: 'cli',
    title: 'CLI Reference',
    raw: '/reference/cli.md',
  },
  {
    slug: 'api',
    title: 'HTTP API Reference',
    raw: '/reference/api.md',
  },
  {
    slug: 'events',
    title: 'Events Reference',
    raw: '/reference/events.md',
    schema: '/schemas/events.schema.json',
  },
  {
    slug: 'config',
    title: 'Config Reference',
    raw: '/reference/config.md',
    schema: '/schemas/config.schema.json',
  },
  {
    slug: 'tools',
    title: 'MCP Tools Reference',
    raw: '/reference/tools.md',
  },
];
