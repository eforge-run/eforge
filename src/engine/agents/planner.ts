import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentBackend } from '../backend.js';
import { isAlwaysYieldedAgentEvent, SCOPE_ASSESSMENTS, type EforgeEvent, type CompileOptions, type ClarificationQuestion, type PlanFile, type ScopeAssessment } from '../events.js';
import { parseClarificationBlocks, parseScopeBlock, parseProfileBlock, parseGeneratedProfileBlock } from './common.js';
import { loadPrompt } from '../prompts.js';
import { parsePlanFile, deriveNameFromSource, extractPlanTitle } from '../plan.js';
import type { ResolvedProfileConfig, BuildStageSpec } from '../config.js';
import { validateProfileConfig, resolveGeneratedProfile } from '../config.js';

export interface PlannerOptions extends CompileOptions {
  backend: AgentBackend;
  onClarification?: (questions: ClarificationQuestion[]) => Promise<Record<string, string>>;
  /** Available workflow profiles for profile selection. When provided, the planner selects a profile. */
  profiles?: Record<string, ResolvedProfileConfig>;
  /** Override max conversation turns (default: 30) */
  maxTurns?: number;
}

/**
 * Format accumulated clarification Q&A into a prompt section for retry.
 * Returns empty string when there are no prior clarifications.
 */
export function formatPriorClarifications(
  allClarifications: Array<{ questions: ClarificationQuestion[]; answers: Record<string, string> }>,
): string {
  const rows: string[] = [];
  for (const { questions, answers } of allClarifications) {
    for (const q of questions) {
      if (answers[q.id] !== undefined) {
        const escapedQ = q.question.replaceAll('|', '\\|');
        const escapedA = answers[q.id].replaceAll('|', '\\|');
        rows.push(`| ${q.id}: ${escapedQ} | ${escapedA} |`);
      }
    }
  }

  if (rows.length === 0) return '';

  return `## Prior Clarifications

You previously asked the following clarifying questions and received answers. Use these answers directly. Do NOT re-ask these questions or ask for further clarification on topics already covered below.

| Question | Answer |
|----------|--------|
${rows.join('\n')}`;
}

/**
 * Format profile descriptions into a markdown table for prompt injection.
 * Returns empty string when no profiles are available.
 */
export function formatProfileDescriptions(profiles: Record<string, ResolvedProfileConfig>): string {
  if (Object.keys(profiles).length === 0) return '';

  const rows = Object.entries(profiles)
    .map(([name, profile]) => `| \`${name}\` | ${profile.description} |`)
    .join('\n');

  return `| Profile | Description |\n|---------|-------------|\n${rows}`;
}

/**
 * Format the profile generation prompt section for injection via {{profileGeneration}}.
 * Includes available profiles as JSON so the agent can reference exact field names.
 */
export function formatProfileGenerationSection(profiles: Record<string, ResolvedProfileConfig>): string {
  const profilesJson = JSON.stringify(profiles, null, 2);

  return `### Profile Generation

Instead of selecting a predefined profile by name, generate a custom profile configuration tailored to this specific work. Analyze the PRD and your codebase exploration to determine the optimal review strategy, perspectives, and pipeline stages.

Output a \`<generated-profile>\` block with JSON content. Prefer extending a base profile with overrides:

\`\`\`xml
<generated-profile>
{
  "extends": "excursion",
  "overrides": {
    "review": {
      "perspectives": ["code", "security"],
      "maxRounds": 2,
      "evaluatorStrictness": "strict"
    }
  }
}
</generated-profile>
\`\`\`

Available base profiles:
\`\`\`json
${profilesJson}
\`\`\`

Available review fields:
- \`strategy\`: "auto" | "single" | "parallel"
- \`perspectives\`: array of review perspective names (e.g. ["code", "security", "performance"])
- \`maxRounds\`: number of review-fix-evaluate cycles (default 1)
- \`autoAcceptBelow\`: auto-accept issues at or below this severity — "suggestion" | "warning"
- \`evaluatorStrictness\`: "strict" | "standard" | "lenient"

Rules:
- When a base profile fits with minor tweaks, use \`extends\` + \`overrides\`
- Only override fields that differ from the base — omit fields you want to inherit
- When the \`<generated-profile>\` block is present, skip the \`<profile>\` block
- After generating a profile, still emit the \`<scope>\` block (both are required)`;
}

/**
 * Format a markdown section describing parallel build lanes in the profile.
 * Returns empty string when the profile has no parallel groups in its build stages.
 */
export function formatParallelLanes(profile: ResolvedProfileConfig): string {
  const parallelGroups = profile.build.filter((spec: BuildStageSpec) => Array.isArray(spec)) as string[][];
  if (parallelGroups.length === 0) return '';

  const lanes = parallelGroups
    .map((group) => group.map((s) => `\`${s}\``).join(', '))
    .join('; ');

  return `## Parallel Build Lanes

This profile runs some build stages in parallel: ${lanes}

Documentation updates are handled by a separate **doc-updater** agent that runs alongside the builder. The builder should **not** modify documentation files - the doc-updater agent will handle that independently based on the plan content.`;
}

/**
 * Run the planner agent. Explores the codebase, asks clarifying questions
 * via <clarification> XML blocks, and writes plan files to disk.
 *
 * Clarification flow: when the agent emits <clarification> blocks,
 * the planner pauses, collects answers via onClarification callback,
 * bakes answers into the prompt, and restarts the agent.
 *
 * @param source - PRD file path or inline prompt string
 * @param options - Planner configuration
 * @yields EforgeEvent stream
 */
export async function* runPlanner(
  source: string,
  options: PlannerOptions,
): AsyncGenerator<EforgeEvent> {
  const cwd = options.cwd ?? process.cwd();
  const { backend } = options;

  // Resolve source: file path → read contents, otherwise use as inline string
  let sourceContent: string;
  try {
    const sourcePath = resolve(cwd, source);
    const stats = await stat(sourcePath);
    if (stats.isFile()) {
      sourceContent = await readFile(sourcePath, 'utf-8');
    } else {
      sourceContent = source;
    }
  } catch {
    sourceContent = source;
  }

  // Derive plan set name from options or source
  const planSetName = options.name ?? deriveNameFromSource(source);

  const sourceLabel = extractPlanTitle(source)
    ?? (source.includes('\n') ? source.split('\n')[0].slice(0, 80) : undefined);
  yield { type: 'plan:start', source, ...(sourceLabel && { label: sourceLabel }) };
  yield { type: 'plan:progress', message: 'Loading planner prompt...' };

  // Track clarification Q&A across iterations
  const allClarifications: Array<{ questions: ClarificationQuestion[]; answers: Record<string, string> }> = [];

  function buildPrompt(): Promise<string> {
    let profileGeneration = '';
    if (options.generateProfile && options.profiles) {
      profileGeneration = formatProfileGenerationSection(options.profiles);
    }

    // Compute parallel lanes notice from the first profile that has parallel groups
    let parallelLanes = '';
    if (options.profiles) {
      for (const profile of Object.values(options.profiles)) {
        const notice = formatParallelLanes(profile);
        if (notice) {
          parallelLanes = notice;
          break;
        }
      }
    }

    return loadPrompt('planner', {
      source: sourceContent,
      planSetName,
      cwd,
      priorClarifications: formatPriorClarifications(allClarifications),
      profiles: options.profiles ? formatProfileDescriptions(options.profiles) : '',
      profileGeneration,
      parallelLanes,
    });
  }

  let scopeEmitted = false;
  let profileEmitted = false;

  // Main loop: run agent, collect clarifications, restart with answers baked in
  let iteration = 0;
  const maxIterations = 5; // prevent infinite loops

  while (iteration < maxIterations) {
    iteration++;

    const prompt = await buildPrompt();

    if (iteration === 1) {
      yield { type: 'plan:progress', message: 'Starting planner agent...' };
    } else {
      yield { type: 'plan:progress', message: 'Planner restarted with prior clarifications' };
    }

    let needsRestart = false;

    for await (const event of backend.run(
      { prompt, cwd, maxTurns: options.maxTurns ?? 30, tools: 'coding', abortSignal: options.abortController?.signal },
      'planner',
    )) {
      if (event.type === 'agent:message') {
        if (!scopeEmitted) {
          const scope = parseScopeBlock(event.content);
          if (scope) {
            scopeEmitted = true;
            yield { type: 'plan:scope', assessment: scope.assessment, justification: scope.justification };
          }
        }

        if (!profileEmitted && options.generateProfile) {
          const generatedBlock = parseGeneratedProfileBlock(event.content);
          if (generatedBlock) {
            try {
              const resolved = resolveGeneratedProfile(generatedBlock, options.profiles ?? {});
              const { valid, errors } = validateProfileConfig(resolved);
              if (valid) {
                profileEmitted = true;
                yield {
                  type: 'plan:profile',
                  profileName: generatedBlock.extends ?? 'generated',
                  rationale: `Generated profile${generatedBlock.extends ? ` extending ${generatedBlock.extends}` : ''} tailored to this PRD`,
                  config: resolved,
                };
              } else {
                yield { type: 'plan:progress', message: `Generated profile invalid (${errors.join('; ')}), falling back to name-based selection` };
              }
            } catch (err) {
              yield { type: 'plan:progress', message: `Generated profile resolution failed (${(err as Error).message}), falling back to name-based selection` };
            }
          }
        }

        if (!profileEmitted) {
          const profile = parseProfileBlock(event.content);
          if (profile) {
            profileEmitted = true;
            yield {
              type: 'plan:profile',
              profileName: profile.profileName,
              rationale: profile.rationale,
              config: options.profiles?.[profile.profileName],
            };

            // Derive plan:scope if profile name matches a built-in scope
            if (!scopeEmitted && (SCOPE_ASSESSMENTS as readonly string[]).includes(profile.profileName)) {
              scopeEmitted = true;
              yield {
                type: 'plan:scope',
                assessment: profile.profileName as ScopeAssessment,
                justification: profile.rationale,
              };
            }
          }
        }

        const questions = parseClarificationBlocks(event.content);
        if (questions.length > 0 && !options.auto) {
          yield { type: 'plan:clarification', questions };

          if (options.onClarification) {
            const answers = await options.onClarification(questions);
            yield { type: 'plan:clarification:answer', answers };
            allClarifications.push({ questions, answers });
            // Restart agent with answers baked into prompt
            needsRestart = true;
            break;
          }
        }
      }

      // Always yield agent:result + tool events (for tracing); gate streaming text on verbose
      if (isAlwaysYieldedAgentEvent(event) || options.verbose) {
        yield event;
      }
    }

    if (!needsRestart) break;
  }

  yield { type: 'plan:progress', message: 'Scanning plan files...' };

  // Scan plan directory for generated plan files
  const planDir = resolve(cwd, 'plans', planSetName);
  const plans: PlanFile[] = [];

  if (existsSync(planDir)) {
    const entries = await readdir(planDir);
    const mdFiles = entries.filter((f) => f.endsWith('.md')).sort();

    for (const file of mdFiles) {
      try {
        const plan = await parsePlanFile(resolve(planDir, file));
        plans.push(plan);
      } catch {
        // Skip non-plan .md files (e.g. README)
      }
    }
  }

  yield { type: 'plan:complete', plans };
}
