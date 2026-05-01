/**
 * CLI: eforge playbook commands and eforge play shortcut.
 *
 * Registers the `playbook` command with six subcommands and the `play` alias.
 * All actions are thin daemon clients — no engine imports.
 * Daemon helpers return `{ data: T; port: number }`, so all callers unwrap `.data`.
 */

import { type Command } from 'commander';
import chalk from 'chalk';
import {
  apiPlaybookList,
  apiPlaybookShow,
  apiPlaybookSave,
  apiPlaybookEnqueue,
  apiPlaybookPromote,
  apiPlaybookDemote,
  apiPlaybookValidate,
  type PlaybookData,
  type PlaybookScope,
} from '@eforge-build/client';
import { formatCliError } from './errors.js';
import { renderPlaybookList } from './display.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reconstruct a raw playbook markdown string from a PlaybookData object. */
function playbookDataToRaw(playbook: PlaybookData): string {
  const lines: string[] = ['---'];
  lines.push(`name: ${playbook.name}`);
  lines.push(`description: ${playbook.description}`);
  lines.push(`scope: ${playbook.scope}`);
  if (playbook.postMerge && playbook.postMerge.length > 0) {
    lines.push('postMerge:');
    for (const cmd of playbook.postMerge) {
      lines.push(`  - ${cmd}`);
    }
  }
  lines.push('---');
  lines.push('');
  lines.push('## Goal');
  lines.push('');
  lines.push(playbook.goal || '');
  if (playbook.outOfScope) {
    lines.push('');
    lines.push('## Out of scope');
    lines.push('');
    lines.push(playbook.outOfScope);
  }
  if (playbook.acceptanceCriteria) {
    lines.push('');
    lines.push('## Acceptance criteria');
    lines.push('');
    lines.push(playbook.acceptanceCriteria);
  }
  if (playbook.plannerNotes) {
    lines.push('');
    lines.push('## Notes for the planner');
    lines.push('');
    lines.push(playbook.plannerNotes);
  }
  return lines.join('\n');
}

/** Extract the content of a named markdown section from a body string. */
function extractSection(body: string, heading: string): string {
  // Match `## <heading>` followed by any single newline (the engine's body
  // parser accepts both `## Goal\nDo thing.` and `## Goal\n\nDo thing.` —
  // we must too, otherwise content silently disappears on edit-save when the
  // user removes the blank line under a heading).
  const regex = new RegExp(`## ${heading}\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`);
  return body.match(regex)?.[1]?.trim() ?? '';
}

/**
 * Parse a raw playbook markdown string into frontmatter + body sections.
 * Returns null when the format is invalid (no frontmatter delimiters found).
 */
async function parsePlaybookRaw(raw: string): Promise<{
  frontmatter: Record<string, unknown>;
  body: { goal: string; outOfScope: string; acceptanceCriteria: string; plannerNotes: string };
} | null> {
  // Match the engine's splitFrontmatter (which accepts \r\n endings).
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) return null;

  const { parse: parseYaml } = await import('yaml');
  const frontmatter = parseYaml(match[1]) as Record<string, unknown>;
  const bodyStr = match[2];

  return {
    frontmatter,
    body: {
      goal: extractSection(bodyStr, 'Goal'),
      outOfScope: extractSection(bodyStr, 'Out of scope'),
      acceptanceCriteria: extractSection(bodyStr, 'Acceptance criteria'),
      plannerNotes: extractSection(bodyStr, 'Notes for the planner'),
    },
  };
}

/** Shared run logic — used by both `playbook run` and `play` alias. */
async function runAction(name: string, options: { after?: string }): Promise<void> {
  const cwd = process.cwd();
  try {
    const { data } = await apiPlaybookEnqueue({
      cwd,
      body: {
        name,
        ...(options.after ? { afterQueueId: options.after } : {}),
      },
    });
    console.log(data.id);
  } catch (err) {
    const { message, exitCode } = formatCliError(err);
    console.error(chalk.red(`Error: ${message}`));
    process.exit(exitCode);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register `eforge playbook` (with subcommands) and the `eforge play` shortcut
 * onto the given top-level Commander program.
 */
export function registerPlaybookCommand(program: Command): void {
  // ---- eforge playbook ---------------------------------------------------

  const playbook = program
    .command('playbook')
    .description('Manage playbooks');

  // -- list ----------------------------------------------------------------

  playbook
    .command('list')
    .description('List all available playbooks with source and shadow chain')
    .action(async () => {
      const cwd = process.cwd();
      try {
        const { data } = await apiPlaybookList({ cwd });
        for (const warning of data.warnings) {
          process.stderr.write(chalk.yellow(`Warning: ${warning}\n`));
        }
        renderPlaybookList(data.playbooks);
      } catch (err) {
        const { message, exitCode } = formatCliError(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(exitCode);
      }
    });

  // -- new -----------------------------------------------------------------

  playbook
    .command('new')
    .description('Scaffold a new playbook (non-interactive, for scripts)')
    .requiredOption('--scope <scope>', 'Playbook scope: user | project-team | project-local')
    .requiredOption('--name <name>', 'Playbook name (kebab-case)')
    .option('--description <description>', 'Short description of the playbook', '')
    .option('--from <file>', 'Read body content from this file (used as the Goal section)')
    .action(async (options: { scope: string; name: string; description: string; from?: string }) => {
      const cwd = process.cwd();

      const validScopes: PlaybookScope[] = ['user', 'project-team', 'project-local'];
      if (!validScopes.includes(options.scope as PlaybookScope)) {
        console.error(chalk.red(`Error: --scope must be one of: ${validScopes.join(', ')}`));
        process.exit(1);
      }
      const scope = options.scope as PlaybookScope;

      let goal = '';
      if (options.from) {
        const { readFile } = await import('node:fs/promises');
        try {
          goal = await readFile(options.from, 'utf-8');
        } catch {
          console.error(chalk.red(`Error: could not read file: ${options.from}`));
          process.exit(1);
        }
      }

      try {
        const { data } = await apiPlaybookSave({
          cwd,
          body: {
            scope,
            playbook: {
              frontmatter: {
                name: options.name,
                description: options.description,
                scope,
              },
              body: {
                goal,
                outOfScope: '',
                acceptanceCriteria: '',
                plannerNotes: '',
              },
            },
          },
        });
        console.log(chalk.green('✔') + ` Playbook saved: ${data.path}`);
      } catch (err) {
        const { message, exitCode } = formatCliError(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(exitCode);
      }
    });

  // -- edit ----------------------------------------------------------------

  playbook
    .command('edit <name>')
    .description('Open a playbook in $EDITOR, validate, and save to the same tier')
    .action(async (name: string) => {
      const cwd = process.cwd();

      const editor = process.env['EDITOR'];
      if (!editor) {
        console.error(chalk.red('Error: $EDITOR is not set. Set it to your preferred editor, e.g.:'));
        console.error(chalk.dim('  export EDITOR=vim'));
        process.exit(1);
        return;
      }

      try {
        // Fetch the current playbook content (resolved via shadow chain)
        const { data: showData } = await apiPlaybookShow({ cwd, name });
        const rawContent = playbookDataToRaw(showData.playbook);

        // Write to a temp file
        const { writeFile, readFile, unlink } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const tmpFile = join(tmpdir(), `eforge-playbook-${name}-${Date.now()}.md`);
        await writeFile(tmpFile, rawContent, 'utf-8');

        // Open the editor
        const { spawnSync } = await import('node:child_process');
        const spawnResult = spawnSync(editor, [tmpFile], { stdio: 'inherit' });
        if (spawnResult.error) {
          await unlink(tmpFile).catch(() => {});
          console.error(chalk.red(`Error: failed to open editor: ${spawnResult.error.message}`));
          process.exit(1);
          return;
        }
        // Treat a non-zero editor exit (e.g. vim `:cq` or a crash) as an
        // explicit abort — do NOT save whatever happens to be in the buffer.
        if (spawnResult.status !== null && spawnResult.status !== 0) {
          await unlink(tmpFile).catch(() => {});
          console.error(chalk.red(`Error: editor exited with status ${spawnResult.status} — aborting (no changes saved)`));
          process.exit(1);
          return;
        }

        // Read the edited content
        const editedRaw = await readFile(tmpFile, 'utf-8');
        await unlink(tmpFile).catch(() => {});

        // Validate the edited content via the daemon
        const { data: validateData } = await apiPlaybookValidate({ cwd, body: { raw: editedRaw } });
        if (!validateData.ok) {
          console.error(chalk.red('Validation failed — changes not saved:'));
          for (const error of (validateData.errors ?? [])) {
            console.error(chalk.red(`  - ${error}`));
          }
          process.exit(1);
          return;
        }

        // Parse and save to the same tier the file was loaded from
        const parsed = await parsePlaybookRaw(editedRaw);
        if (!parsed) {
          console.error(chalk.red('Error: could not parse edited playbook frontmatter'));
          process.exit(1);
          return;
        }

        // showData.source is already typed as PlaybookScope-compatible.
        const targetScope: PlaybookScope = showData.source;

        const { frontmatter, body } = parsed;

        // Preserve postMerge across the edit round-trip when present and shaped
        // as a string array. Without this, any playbook with a postMerge field
        // would silently lose it on edit-save.
        const fmPostMerge = frontmatter['postMerge'];
        const preservedPostMerge =
          Array.isArray(fmPostMerge) && fmPostMerge.every((x) => typeof x === 'string')
            ? (fmPostMerge as string[])
            : showData.playbook.postMerge;

        await apiPlaybookSave({
          cwd,
          body: {
            scope: targetScope,
            playbook: {
              frontmatter: {
                name: String(frontmatter['name'] ?? showData.playbook.name),
                description: String(frontmatter['description'] ?? showData.playbook.description),
                scope: targetScope,
                ...(preservedPostMerge && preservedPostMerge.length > 0
                  ? { postMerge: preservedPostMerge }
                  : {}),
              },
              body: {
                goal: body.goal,
                outOfScope: body.outOfScope,
                acceptanceCriteria: body.acceptanceCriteria,
                plannerNotes: body.plannerNotes,
              },
            },
          },
        });

        console.log(chalk.green('✔') + ` Playbook ${chalk.cyan(name)} saved`);
      } catch (err) {
        const { message, exitCode } = formatCliError(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(exitCode);
      }
    });

  // -- run -----------------------------------------------------------------

  playbook
    .command('run <name>')
    .description('Enqueue a playbook as a PRD')
    .option('--after <queue-id>', 'Queue ID that this PRD should run after (piggyback)')
    .action(async (name: string, options: { after?: string }) => {
      await runAction(name, options);
    });

  // -- promote -------------------------------------------------------------

  playbook
    .command('promote <name>')
    .description('Promote a playbook from project-local to project-team (stages with git add)')
    .action(async (name: string) => {
      const cwd = process.cwd();
      try {
        const { data } = await apiPlaybookPromote({ cwd, body: { name } });

        // Stage the new path for commit; non-fatal if git is unavailable
        const { execFileSync } = await import('node:child_process');
        try {
          execFileSync('git', ['add', data.path], { cwd });
        } catch {
          console.error(chalk.yellow(`Warning: failed to stage promoted playbook with git add`));
        }

        console.log(chalk.green('✔') + ` Promoted: ${data.path}`);
        console.log(chalk.dim(`  Staged for commit. Run 'git commit' to complete the promotion.`));
      } catch (err) {
        const { message, exitCode } = formatCliError(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(exitCode);
      }
    });

  // -- demote --------------------------------------------------------------

  playbook
    .command('demote <name>')
    .description('Demote a playbook from project-team to project-local (.eforge/playbooks/)')
    .action(async (name: string) => {
      const cwd = process.cwd();
      try {
        const { data } = await apiPlaybookDemote({ cwd, body: { name } });
        console.log(chalk.green('✔') + ` Demoted: ${data.path}`);
        console.log(chalk.dim(`  File is now in .eforge/playbooks/ (gitignored). Not staged.`));
      } catch (err) {
        const { message, exitCode } = formatCliError(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(exitCode);
      }
    });

  // ---- eforge play <name> (alias for eforge playbook run <name>) ---------

  program
    .command('play <name>')
    .description('Shortcut for `eforge playbook run <name>`')
    .option('--after <queue-id>', 'Queue ID that this PRD should run after (piggyback)')
    .action(async (name: string, options: { after?: string }) => {
      await runAction(name, options);
    });
}
