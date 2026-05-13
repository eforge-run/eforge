/**
 * MCP tools and skills surface generator.
 *
 * Extracts tool registrations from the Claude Code MCP proxy and Pi extension
 * using ts-morph AST parsing, then reads SKILL.md frontmatter from both skill
 * directories to produce a skills parity table.
 */

import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { Project } from 'ts-morph';
import { parse as parseYaml } from 'yaml';
import type { OutputPaths } from '../output-paths.js';
import type { ProvenanceInfo } from '../provenance.js';
import { buildProvenanceHeader } from '../provenance.js';

async function writeToAll(content: string, paths: string[]): Promise<void> {
  for (const p of paths) {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, 'utf-8');
  }
}

interface ToolEntry {
  name: string;
  description: string;
}

interface SkillPair {
  pluginName: string;
  piName: string;
  pluginDescription: string;
  piDescription: string;
}

// Explicit parity pairs from scripts/check-skill-parity.mjs
const SKILL_PAIRS_CONFIG = [
  { plugin: 'profile', pi: 'eforge-profile' },
  { plugin: 'profile-new', pi: 'eforge-profile-new' },
  { plugin: 'build', pi: 'eforge-build' },
  { plugin: 'config', pi: 'eforge-config' },
  { plugin: 'init', pi: 'eforge-init' },
  { plugin: 'plan', pi: 'eforge-plan' },
  { plugin: 'restart', pi: 'eforge-restart' },
  { plugin: 'status', pi: 'eforge-status' },
  { plugin: 'update', pi: 'eforge-update' },
  { plugin: 'playbook', pi: 'eforge-playbook' },
  { plugin: 'recover', pi: 'eforge-recover' },
] as const;

function extractStringLiteralValue(
  node: ReturnType<ReturnType<typeof Project.prototype.addSourceFileAtPath>['getDescendantsOfKind']>[0] | undefined,
): string | undefined {
  if (!node) return undefined;
  // node is a ts-morph Node; try to get literal value
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const asStr = (node as any).getLiteralValue?.() as string | undefined;
    if (typeof asStr === 'string') return asStr;
  } catch {
    // Ignore
  }
  return undefined;
}

function extractMcpTools(repoRoot: string): ToolEntry[] {
  const filePath = resolve(repoRoot, 'packages', 'eforge', 'src', 'cli', 'mcp-proxy.ts');
  if (!existsSync(filePath)) return [];

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      strict: false,
      skipLibCheck: true,
      noResolve: true,
    },
  });

  const sourceFile = project.addSourceFileAtPath(filePath);
  const tools: ToolEntry[] = [];

  // Import SyntaxKind from ts-morph's bundled typescript
  // ts-morph wraps TypeScript; getDescendantsOfKind accepts the TS SyntaxKind numeric value.
  // We use the string-based AST walker approach to avoid importing ts directly.
  sourceFile.forEachDescendant((node) => {
    // We're looking for CallExpression where expression text is 'createDaemonTool'
    if (node.getKindName() !== 'CallExpression') return;

    const callText = node.getText();
    if (!callText.startsWith('createDaemonTool(')) return;

    // Get the arguments of the call expression
    // ts-morph CallExpression has getArguments()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callExpr = node as any;
    const args: unknown[] = callExpr.getArguments?.() ?? [];
    if (args.length < 3) return;

    // Third argument is the options object
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const optObj = args[2] as any;
    if (optObj.getKindName?.() !== 'ObjectLiteralExpression') return;

    let name: string | undefined;
    let description: string | undefined;

    const nameProp = optObj.getProperty?.('name');
    const descProp = optObj.getProperty?.('description');

    if (nameProp?.getKindName?.() === 'PropertyAssignment') {
      const init = nameProp.getInitializer?.();
      if (init?.getKindName?.() === 'StringLiteral') {
        name = init.getLiteralValue?.() as string | undefined;
      }
    }

    if (descProp?.getKindName?.() === 'PropertyAssignment') {
      const init = descProp.getInitializer?.();
      if (init?.getKindName?.() === 'StringLiteral') {
        description = init.getLiteralValue?.() as string | undefined;
      }
    }

    if (name) {
      tools.push({ name, description: description ?? '' });
    }
  });

  return tools;
}

function extractPiTools(repoRoot: string): ToolEntry[] {
  const filePath = resolve(
    repoRoot,
    'packages',
    'pi-eforge',
    'extensions',
    'eforge',
    'index.ts',
  );
  if (!existsSync(filePath)) return [];

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      strict: false,
      skipLibCheck: true,
      noResolve: true,
    },
  });

  const sourceFile = project.addSourceFileAtPath(filePath);
  const tools: ToolEntry[] = [];

  sourceFile.forEachDescendant((node) => {
    if (node.getKindName() !== 'CallExpression') return;

    const callText = node.getText();
    if (!callText.includes('.registerTool(')) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callExpr = node as any;
    const args: unknown[] = callExpr.getArguments?.() ?? [];
    if (args.length < 1) return;

    // First argument is the options object
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const optObj = args[0] as any;
    if (optObj.getKindName?.() !== 'ObjectLiteralExpression') return;

    let name: string | undefined;
    let description: string | undefined;

    const nameProp = optObj.getProperty?.('name');
    const descProp = optObj.getProperty?.('description');

    if (nameProp?.getKindName?.() === 'PropertyAssignment') {
      const init = nameProp.getInitializer?.();
      if (init?.getKindName?.() === 'StringLiteral') {
        name = init.getLiteralValue?.() as string | undefined;
      }
    }

    if (descProp?.getKindName?.() === 'PropertyAssignment') {
      const init = descProp.getInitializer?.();
      if (init?.getKindName?.() === 'StringLiteral') {
        description = init.getLiteralValue?.() as string | undefined;
      }
    }

    if (name) {
      tools.push({ name, description: description ?? '' });
    }
  });

  return tools;
}

async function readSkillDescription(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return '';
    const fm = parseYaml(match[1]) as Record<string, unknown>;
    return typeof fm.description === 'string' ? fm.description : '';
  } catch {
    return '';
  }
}

async function gatherSkillPairs(repoRoot: string): Promise<SkillPair[]> {
  const pairs: SkillPair[] = [];

  for (const { plugin, pi } of SKILL_PAIRS_CONFIG) {
    const pluginPath = join(repoRoot, 'eforge-plugin', 'skills', plugin, `${plugin}.md`);
    const piPath = join(repoRoot, 'packages', 'pi-eforge', 'skills', pi, 'SKILL.md');

    const pluginDescription = await readSkillDescription(pluginPath);
    const piDescription = await readSkillDescription(piPath);

    pairs.push({ pluginName: plugin, piName: pi, pluginDescription, piDescription });
  }

  return pairs;
}

export async function generateTools(opts: {
  outputPaths: OutputPaths;
  provenance: ProvenanceInfo;
  repoRoot: string;
}): Promise<void> {
  const header = buildProvenanceHeader({
    sourceFiles: [
      'packages/eforge/src/cli/mcp-proxy.ts',
      'packages/pi-eforge/extensions/eforge/index.ts',
      'eforge-plugin/skills/',
      'packages/pi-eforge/skills/',
    ],
    eforgeVersion: opts.provenance.eforgeVersion,
    gitCommit: opts.provenance.gitCommit,
  });

  const mcpTools = extractMcpTools(opts.repoRoot);
  const piTools = extractPiTools(opts.repoRoot);
  const skillPairs = await gatherSkillPairs(opts.repoRoot);

  const lines: string[] = [
    header,
    '# eforge MCP Tools and Skills Reference',
    '',
    'eforge exposes its capabilities through two integration surfaces:',
    '- **MCP tools** for the Claude Code plugin (`eforge-plugin/`)',
    '- **Native Pi commands and tools** for the Pi extension (`packages/pi-eforge/`)',
    '',
    'Both surfaces are kept in parity per `AGENTS.md`.',
    '',
    '## MCP tools (Claude Code)',
    '',
    `Total tools: ${mcpTools.length}`,
    '',
    '| Tool name | Description |',
    '|-----------|-------------|',
  ];

  for (const tool of mcpTools) {
    const desc = tool.description.replace(/\|/g, '\\|');
    lines.push(`| \`${tool.name}\` | ${desc} |`);
  }

  lines.push('');
  lines.push('## Native tools (Pi extension)');
  lines.push('');
  lines.push(`Total tools: ${piTools.length}`);
  lines.push('');
  lines.push('| Tool name | Description |');
  lines.push('|-----------|-------------|');

  for (const tool of piTools) {
    const desc = tool.description.replace(/\|/g, '\\|');
    lines.push(`| \`${tool.name}\` | ${desc} |`);
  }

  lines.push('');
  lines.push('## Skill surfaces');
  lines.push('');
  lines.push(
    'Slash-command skills for Claude Code (plugin) and Pi are kept in parity.',
    'Source of truth: `scripts/check-skill-parity.mjs`.',
  );
  lines.push('');
  lines.push('| Skill (Claude Code `/eforge:<name>`) | Skill (Pi `eforge:<name>`) | Description |');
  lines.push('|--------------------------------------|---------------------------|-------------|');

  for (const pair of skillPairs) {
    const desc = (pair.pluginDescription || pair.piDescription).replace(/\|/g, '\\|');
    lines.push(`| \`${pair.pluginName}\` | \`${pair.piName}\` | ${desc} |`);
  }

  lines.push('');

  const content = lines.join('\n');
  await writeToAll(content, [opts.outputPaths.contentTools, opts.outputPaths.publicTools]);
}
