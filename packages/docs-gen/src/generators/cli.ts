/**
 * CLI surface generator.
 *
 * Imports the eforge Commander program tree via `buildEforgeCommand` and
 * walks it to emit a Markdown reference for each subcommand.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Command } from 'commander';
import { buildEforgeCommand } from '@eforge-build/eforge/cli';
import type { OutputPaths } from '../output-paths.js';
import type { ProvenanceInfo } from '../provenance.js';
import { buildProvenanceHeader } from '../provenance.js';

async function writeToAll(content: string, paths: string[]): Promise<void> {
  for (const p of paths) {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, 'utf-8');
  }
}

function optionsTable(cmd: Command): string[] {
  const opts = cmd.options;
  if (opts.length === 0) return [];
  const lines: string[] = [
    '',
    '**Options:**',
    '',
    '| Flag | Description |',
    '|------|-------------|',
  ];
  for (const opt of opts) {
    const flags = opt.flags.replace(/\|/g, '\\|');
    const desc = (opt.description ?? '').replace(/\|/g, '\\|');
    lines.push(`| \`${flags}\` | ${desc} |`);
  }
  return lines;
}

function renderCommand(cmd: Command, level: number): string[] {
  const h = '#'.repeat(Math.min(level, 6));
  const lines: string[] = [];

  lines.push(`${h} \`${cmd.name()}\``);
  lines.push('');

  if (cmd.description()) {
    lines.push(cmd.description());
    lines.push('');
  }

  // Show usage alias if present
  const aliases = cmd.aliases();
  if (aliases.length > 0) {
    lines.push(`**Alias:** \`${aliases.join('`, `')}\``);
    lines.push('');
  }

  lines.push(...optionsTable(cmd));

  // Recurse into subcommands
  for (const sub of cmd.commands as Command[]) {
    lines.push('');
    lines.push(...renderCommand(sub, level + 1));
  }

  return lines;
}

export async function generateCli(opts: {
  outputPaths: OutputPaths;
  provenance: ProvenanceInfo;
  repoRoot: string;
}): Promise<void> {
  const program = buildEforgeCommand();

  const header = buildProvenanceHeader({
    sourceFiles: ['packages/eforge/src/cli/index.ts'],
    eforgeVersion: opts.provenance.eforgeVersion,
    gitCommit: opts.provenance.gitCommit,
  });

  const lines: string[] = [
    header,
    '# eforge CLI Reference',
    '',
    'Autonomous plan-build-review CLI for code generation.',
    '',
    `**Usage:** \`eforge [command] [options]\``,
    '',
    '## Commands',
    '',
  ];

  for (const cmd of program.commands as Command[]) {
    lines.push(...renderCommand(cmd, 3));
    lines.push('');
  }

  // Top-level options
  const topOpts = optionsTable(program);
  if (topOpts.length > 0) {
    lines.push('## Global options');
    lines.push(...topOpts);
    lines.push('');
  }

  const content = lines.join('\n');
  await writeToAll(content, [opts.outputPaths.contentCli, opts.outputPaths.publicCli]);
}
