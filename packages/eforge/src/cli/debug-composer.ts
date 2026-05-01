/**
 * `eforge debug-composer <source>` — runs ONLY the pipeline-composer stage
 * against one or more backend profiles and writes the fully-constructed
 * request payload each backend hands to its SDK to disk.
 *
 * The point is to make backend framing asymmetries visible so we can diff
 * the system prompt, tool definitions, and model/thinking settings that
 * each backend constructs for the same PRD. No other pipeline stages run.
 *
 * Output layout:
 *   <out>/<profile>.json             — full captured payload + composer result
 *   <out>/<profile>.system-prompt.md — systemPrompt extracted for easy diffing
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  findConfigFile,
  loadProfile,
  loadUserConfig,
  mergePartialConfigs,
  parseRawConfig,
  resolveActiveProfileName,
  resolveConfig,
  type EforgeConfig,
  type PartialEforgeConfig,
} from '@eforge-build/engine/config';
import { parse as parseYaml } from 'yaml';

import { composePipeline } from '@eforge-build/engine/agents/pipeline-composer';
import { resolveAgentConfig } from '@eforge-build/engine/pipeline';
import { ClaudeSDKHarness } from '@eforge-build/engine/harnesses/claude-sdk';
import type { AgentHarness, HarnessDebugPayload } from '@eforge-build/engine/harness';
import type { EforgeEvent } from '@eforge-build/engine/events';

interface DebugComposerOptions {
  backend?: string[];
  out: string;
  verbose?: boolean;
}

/** Collector for the Commander `--backend <name>` repeatable option. */
function collectBackend(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

/** Resolve the PRD source: file path wins over inline text. */
async function resolveSourceContent(cwd: string, source: string): Promise<string> {
  const sourcePath = resolve(cwd, source);
  try {
    const info = await stat(sourcePath);
    if (info.isFile()) return readFile(sourcePath, 'utf-8');
  } catch {
    // not a file path — treat as inline source
  }
  return source;
}

/**
 * Load a named backend profile (or the active one when name is undefined)
 * and produce a fully resolved EforgeConfig for it, mirroring loadConfig()
 * but pinned to a specific profile.
 */
async function loadConfigForProfile(
  cwd: string,
  profileName: string | undefined,
): Promise<{ config: EforgeConfig; profileName: string; configDir: string }> {
  const globalConfig = await loadUserConfig();

  const configPath = await findConfigFile(cwd);
  if (!configPath) {
    throw new Error(
      `No eforge/config.yaml found walking up from ${cwd}. ` +
      `Run 'eforge init' first.`,
    );
  }
  const configDir = dirname(configPath);

  // Parse project config (same flow as loadConfig, but we re-parse here so we
  // can merge a specific profile rather than the active one).
  // Strict: ConfigValidationError / ConfigMigrationError propagate so users
  // see schema typos clearly. Missing project config is tolerated (ENOENT).
  let projectConfig: PartialEforgeConfig = {};
  try {
    const raw = await readFile(configPath, 'utf-8');
    const data = parseYaml(raw);
    if (data && typeof data === 'object') {
      projectConfig = parseRawConfig(data as Record<string, unknown>);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    // missing project config — fall through with empty projectConfig
  }

  // Resolve profile name: explicit arg > active marker > error
  let resolvedName = profileName;
  if (!resolvedName) {
    const { name: activeName, warnings: activeWarnings } = await resolveActiveProfileName(configDir, projectConfig, globalConfig);
    for (const warning of activeWarnings) {
      process.stderr.write(`${warning}\n`);
    }
    const active = { name: activeName };
    if (!active.name) {
      throw new Error(
        `No backend profile specified and no active profile marker found. ` +
        `Pass --backend <name> or run 'eforge backend use <name>'.`,
      );
    }
    resolvedName = active.name;
  }

  const profileResult = await loadProfile(configDir, resolvedName);
  if (!profileResult) {
    throw new Error(`Backend profile "${resolvedName}" not found in project or user scope.`);
  }

  const baseMerged = mergePartialConfigs(globalConfig, projectConfig);
  const merged = mergePartialConfigs(baseMerged, profileResult.profile);
  const config = resolveConfig(merged);

  if (!config.agents.tiers || Object.keys(config.agents.tiers).length === 0) {
    throw new Error(
      `Backend profile "${resolvedName}" has no agent tiers configured. ` +
      `Add agents.tiers entries (with harness + model + effort) to the profile or config.`,
    );
  }

  return { config, profileName: resolvedName, configDir };
}

/** Construct the right harness instance from a resolved config, with debug capture wired.
 *  The composer agent lives in the planning tier — pull its tier recipe and instantiate
 *  the harness it requests. */
async function buildBackendForDebug(
  config: EforgeConfig,
  onDebugPayload: (p: HarnessDebugPayload) => void,
): Promise<AgentHarness> {
  const tier = config.agents.tiers?.planning;

  if (tier?.harness === 'pi') {
    const { PiHarness } = await import('@eforge-build/engine/harnesses/pi');
    const piCfg: import('@eforge-build/engine/config').PiConfig = {
      apiKey: tier.pi?.apiKey,
      provider: tier.pi?.provider,
      thinkingLevel: tier.pi?.thinkingLevel ?? 'medium',
      extensions: {
        autoDiscover: tier.pi?.extensions?.autoDiscover ?? true,
        include: tier.pi?.extensions?.include,
        exclude: tier.pi?.extensions?.exclude,
        paths: tier.pi?.extensions?.paths,
      },
      compaction: {
        enabled: tier.pi?.compaction?.enabled ?? true,
        threshold: tier.pi?.compaction?.threshold ?? 100_000,
      },
      retry: {
        maxRetries: tier.pi?.retry?.maxRetries ?? 3,
        backoffMs: tier.pi?.retry?.backoffMs ?? 1000,
      },
    };
    return new PiHarness({
      piConfig: piCfg,
      bare: config.agents.bare,
      extensions: piCfg.extensions,
      onDebugPayload,
    });
  }

  // default: claude-sdk
  const disableSubagents = tier?.claudeSdk?.disableSubagents ?? false;
  return new ClaudeSDKHarness({
    settingSources: config.agents.settingSources as never,
    bare: config.agents.bare,
    disableSubagents,
    onDebugPayload,
  });
}

/** Run the composer for a single backend profile and capture its payload. */
async function runForProfile(
  cwd: string,
  source: string,
  sourceContent: string,
  config: EforgeConfig,
  profileName: string,
  outDir: string,
  verbose: boolean,
): Promise<{ profileName: string; outPath: string; harness: 'claude-sdk' | 'pi'; scope: string }> {
  let captured: HarnessDebugPayload | undefined;
  const backend = await buildBackendForDebug(config, (p) => {
    captured = p;
  });

  const composerConfig = resolveAgentConfig('pipeline-composer', config);

  // Drive composePipeline and collect the terminal composition event.
  // We keep a non-fatal try/catch so a failed compose still writes whatever
  // payload was captured — the payload is the primary artifact.
  const composerEvents: EforgeEvent[] = [];
  let composeError: string | undefined;
  try {
    for await (const event of composePipeline({
      ...composerConfig,
      source: sourceContent,
      cwd,
      verbose,
      harness: backend,
    })) {
      composerEvents.push(event);
      if (verbose && event.type === 'agent:message') {
        process.stdout.write(chalk.dim(event.content));
      }
    }
  } catch (err) {
    composeError = err instanceof Error ? err.message : String(err);
  }

  if (!captured) {
    throw new Error(
      `Backend for profile "${profileName}" did not emit a debug payload. ` +
      `This usually means the composer failed before dispatching the request. ` +
      `Compose error: ${composeError ?? '(none)'}`,
    );
  }

  // Extract the composer's final composition event for the record.
  const pipelineEvent = composerEvents.find((e) => e.type === 'planning:pipeline') as
    | { type: 'planning:pipeline'; scope: string; compile: unknown[]; defaultBuild: unknown[]; defaultReview: unknown; rationale: string }
    | undefined;

  const planningTier = config.agents.tiers?.planning;
  const record = {
    profileName,
    source,
    capturedAt: new Date().toISOString(),
    config: {
      planningTier: planningTier
        ? {
            harness: planningTier.harness,
            model: planningTier.model,
            effort: planningTier.effort,
            thinking: planningTier.thinking,
          }
        : null,
    },
    resolvedComposer: composerConfig,
    payload: captured,
    composition: pipelineEvent
      ? {
          scope: pipelineEvent.scope,
          compile: pipelineEvent.compile,
          defaultBuild: pipelineEvent.defaultBuild,
          defaultReview: pipelineEvent.defaultReview,
          rationale: pipelineEvent.rationale,
        }
      : null,
    composeError: composeError ?? null,
  };

  await mkdir(outDir, { recursive: true });
  const outPath = resolve(outDir, `${profileName}.json`);
  await writeFile(outPath, JSON.stringify(record, null, 2), 'utf-8');

  // Also write the system prompt alone as markdown for easy diffing.
  const sysOutPath = resolve(outDir, `${profileName}.system-prompt.md`);
  const header = [
    `<!-- Captured for backend profile: ${profileName} (${captured.harness}) -->`,
    `<!-- Agent: ${captured.agent}  -->`,
    `<!-- Model: ${captured.model.id}${captured.model.provider ? ` @ ${captured.model.provider}` : ''} -->`,
    `<!-- systemPrompt bytes: ${captured.systemPrompt.length} | tools: ${captured.tools.length} -->`,
    '',
  ].join('\n');
  await writeFile(sysOutPath, header + captured.systemPrompt, 'utf-8');

  return {
    profileName,
    outPath,
    harness: captured.harness,
    scope: pipelineEvent?.scope ?? '(compose failed)',
  };
}

export function registerDebugComposerCommand(program: Command): void {
  program
    .command('debug-composer <source>')
    .description(
      'Run only the pipeline-composer stage under one or more backend profiles and ' +
      'dump the request payload each backend constructs (system prompt, tools, model, thinking) ' +
      'for side-by-side diffing. Use --backend <name> to select profiles; repeat to compare multiple.',
    )
    .option(
      '--backend <name>',
      'Backend profile to test (repeatable). Defaults to the currently-active profile.',
      collectBackend,
      undefined as string[] | undefined,
    )
    .option(
      '--out <dir>',
      'Output directory for captured payloads',
      'eforge/debug/composer-payloads',
    )
    .option('--verbose', 'Stream composer agent messages to stdout')
    .action(async (source: string, options: DebugComposerOptions) => {
      const cwd = process.cwd();
      const outDir = resolve(cwd, options.out);
      const sourceContent = await resolveSourceContent(cwd, source);

      const profiles = options.backend && options.backend.length > 0
        ? options.backend
        : [undefined]; // undefined = use active profile

      const results: Array<{ profileName: string; outPath: string; harness?: 'claude-sdk' | 'pi'; scope: string; error?: string }> = [];

      for (const profile of profiles) {
        const label = profile ?? '(active)';
        process.stdout.write(chalk.cyan(`→ ${label}`) + ' … ');
        try {
          const { config, profileName } = await loadConfigForProfile(cwd, profile);
          const result = await runForProfile(cwd, source, sourceContent, config, profileName, outDir, options.verbose ?? false);
          process.stdout.write(
            chalk.green('✔') +
            ` ${chalk.dim(`[${result.harness}]`)} ${chalk.bold(`scope=${result.scope}`)} ${chalk.dim('→')} ${result.outPath}\n`,
          );
          results.push(result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stdout.write(chalk.red('✘') + ` ${msg}\n`);
          // Backend is omitted on failure — we may have errored before profile
          // resolution, so we don't know which backend was intended.
          results.push({ profileName: profile ?? '(active)', outPath: '', scope: '(failed)', error: msg });
        }
      }

      // Print a summary and a diff hint when 2 profiles were supplied.
      const successful = results.filter((r) => !r.error);
      if (successful.length === 0) {
        console.error(chalk.red('\nNo payloads captured.'));
        process.exit(1);
      }

      console.log('');
      console.log(chalk.bold(`Wrote ${successful.length} payload(s) under ${outDir}`));
      if (successful.length >= 2) {
        const [a, b] = successful;
        console.log('');
        console.log(chalk.dim('Diff the two system prompts with:'));
        console.log(`  diff -u ${a.outPath.replace(/\.json$/, '.system-prompt.md')} ${b.outPath.replace(/\.json$/, '.system-prompt.md')}`);
        console.log(chalk.dim('Or with delta/difftastic:'));
        console.log(`  delta ${a.outPath.replace(/\.json$/, '.system-prompt.md')} ${b.outPath.replace(/\.json$/, '.system-prompt.md')}`);
      }

      process.exit(results.some((r) => r.error) ? 2 : 0);
    });
}
