/**
 * docs-gen CLI entry point.
 *
 * Subcommands:
 *   generate [--all | --surface <name>]   — run surface generators
 *   check                                  — drift and link check
 */

import { Command } from 'commander';
import { findRepoRoot, getOutputPaths } from './output-paths.js';
import { gatherProvenance } from './provenance.js';
import { generateCli } from './generators/cli.js';
import { generateApi } from './generators/api.js';
import { generateEvents } from './generators/events.js';
import { generateConfig } from './generators/config.js';
import { generateTools } from './generators/tools.js';
import { generateLlms } from './generators/llms.js';
import { runDocsCheck } from './check.js';

const SURFACES = ['cli', 'api', 'events', 'config', 'tools', 'llms'] as const;
type Surface = (typeof SURFACES)[number];

async function runSurface(
  surface: Surface,
  opts: Parameters<typeof generateCli>[0],
): Promise<void> {
  switch (surface) {
    case 'cli':
      await generateCli(opts);
      break;
    case 'api':
      await generateApi(opts);
      break;
    case 'events':
      await generateEvents(opts);
      break;
    case 'config':
      await generateConfig(opts);
      break;
    case 'tools':
      await generateTools(opts);
      break;
    case 'llms':
      await generateLlms(opts);
      break;
  }
}

const program = new Command();

program
  .name('docs-gen')
  .description('Generate eforge reference documentation artifacts');

program
  .command('generate')
  .description('Generate reference docs (all surfaces or a specific one)')
  .option('--all', 'Generate all surfaces')
  .option('--surface <name>', `Surface to generate (${SURFACES.join(', ')})`)
  .action(async (options: { all?: boolean; surface?: string }) => {
    const repoRoot = findRepoRoot();
    const outputPaths = getOutputPaths(repoRoot);
    const provenance = gatherProvenance(repoRoot);
    const shared = { outputPaths, provenance, repoRoot };

    if (options.all) {
      console.log('Generating all surfaces…');
      for (const surface of SURFACES) {
        if (surface === 'llms') continue; // llms runs last
        process.stdout.write(`  ${surface}… `);
        await runSurface(surface, shared);
        process.stdout.write('done\n');
      }
      // llms reads files written by other generators, so it runs last
      process.stdout.write('  llms… ');
      await generateLlms(shared);
      process.stdout.write('done\n');
      console.log('All surfaces generated.');
    } else if (options.surface) {
      if (!(SURFACES as readonly string[]).includes(options.surface)) {
        console.error(`Unknown surface: ${options.surface}. Valid: ${SURFACES.join(', ')}`);
        process.exit(1);
      }
      console.log(`Generating surface: ${options.surface}…`);
      await runSurface(options.surface as Surface, shared);
      console.log('Done.');
    } else {
      console.error('Specify --all or --surface <name>');
      process.exit(1);
    }
  });

program
  .command('check')
  .description('Check for docs drift and broken internal links')
  .action(async () => {
    const repoRoot = findRepoRoot();
    console.log('Checking docs for drift and internal links…');
    const result = await runDocsCheck(repoRoot);

    if (!result.drift.ok) {
      console.error(`Docs drift detected in ${result.drift.changed.length} file(s):`);
      for (const key of result.drift.changed) {
        console.error(`  - ${key}`);
      }
      console.error('Run `pnpm docs:generate` to regenerate.');
    }

    if (!result.links.ok) {
      console.error(`Docs link issues detected in ${result.links.issues.length} link(s):`);
      for (const issue of result.links.issues) {
        console.error(`  - ${issue.sourceFile}: ${issue.href} — ${issue.reason}`);
      }
    }

    if (!result.ok) {
      process.exit(1);
    }

    console.log('No drift or link issues detected. Docs are up-to-date.');
  });

await program.parseAsync(process.argv);
