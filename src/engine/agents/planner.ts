import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentBackend } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent, type CompileOptions, type ClarificationQuestion, type PlanFile } from '../events.js';
import { parseClarificationBlocks, parseSkipBlock, parseProfileBlock, parseGeneratedProfileBlock } from './common.js';
import { loadPrompt } from '../prompts.js';
import { parsePlanFile, deriveNameFromSource, extractPlanTitle } from '../plan.js';
import type { ResolvedProfileConfig } from '../config.js';
import { validateProfileConfig, resolveGeneratedProfile, getCompileOnlyProfileSchemaYaml } from '../config.js';
import { getClarificationSchemaYaml, getModuleSchemaYaml, getPlanFrontmatterSchemaYaml } from '../schemas.js';

export interface PlannerOptions extends CompileOptions {
  backend: AgentBackend;
  onClarification?: (questions: ClarificationQuestion[]) => Promise<Record<string, string>>;
  /** Available workflow profiles for profile selection. When provided, the planner selects a profile. */
  profiles?: Record<string, ResolvedProfileConfig>;
  /** Override max conversation turns (default: 30) */
  maxTurns?: number;
  /** Continuation context when restarting after hitting max turns */
  continuationContext?: { attempt: number; maxContinuations: number; existingPlans: string };
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
  // Strip build/review/agents from each profile — the planner only controls compile-time config.
  // Per-plan build/review is handled by module planners via <build-config> blocks.
  const compileOnlyProfiles: Record<string, { description: string; compile: string[]; extends?: string }> = {};
  for (const [name, profile] of Object.entries(profiles)) {
    compileOnlyProfiles[name] = {
      description: profile.description,
      compile: profile.compile,
      ...(profile.extends ? { extends: profile.extends } : {}),
    };
  }
  const profilesJson = JSON.stringify(compileOnlyProfiles, null, 2);
  const schemaYaml = getCompileOnlyProfileSchemaYaml();

  return `### Profile Generation

Instead of selecting a predefined profile by name, generate a custom profile configuration tailored to this specific work. Analyze the PRD and your codebase exploration to determine the optimal review strategy, perspectives, and pipeline stages.

Output a \`<generated-profile>\` block with JSON content. Prefer extending a base profile with overrides:

\`\`\`xml
<generated-profile>
{
  "extends": "excursion",
  "name": "security-focused",
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

Profile schema:
\`\`\`yaml
${schemaYaml}\`\`\`

Rules:
- Give the profile a descriptive kebab-case name reflecting its purpose (e.g. "security-focused", "perf-tuning", "api-migration")
- When a base profile fits with minor tweaks, use \`extends\` + \`overrides\`
- Only override fields that differ from the base — omit fields you want to inherit
- When the \`<generated-profile>\` block is present, skip the \`<profile>\` block

### Stage Customization

Build stages control the post-implementation pipeline. You can add, remove, or reorder stages in your generated profile to match the work's needs.

**Adding \`doc-update\`**: Include \`doc-update\` when the work adds or changes user-facing surface area — new API endpoints, modified request/response contracts, CLI flags, configuration options, or behavioral changes that users or integrators would notice. This applies regardless of which base profile you extend. Place it in a parallel group with \`implement\`: \`[["implement", "doc-update"], "review", "review-fix", "evaluate"]\`.

**Omitting \`doc-update\`**: Skip it for purely internal changes — refactors, bug fixes with no API surface change, test-only additions, or dependency updates. The overhead (~100k tokens) isn't justified when there's nothing user-facing to document.

**Parallel groups**: Wrap stage names in an inner array to run them concurrently. Only stages with no data dependencies should be parallelized. Example: \`[["implement", "doc-update"], "review"]\` runs implement and doc-update in parallel, then review sequentially after both complete.`;

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
  yield { timestamp: new Date().toISOString(), type: 'plan:start', source, ...(sourceLabel && { label: sourceLabel }) };
  yield { timestamp: new Date().toISOString(), type: 'plan:progress', message: 'Loading planner prompt...' };

  // Track clarification Q&A across iterations
  const allClarifications: Array<{ questions: ClarificationQuestion[]; answers: Record<string, string> }> = [];

  function buildPrompt(): Promise<string> {
    let profileGeneration = '';
    if (options.generateProfile && options.profiles) {
      profileGeneration = formatProfileGenerationSection(options.profiles);
    }

    let continuationContextText = '';
    if (options.continuationContext) {
      const { attempt, maxContinuations, existingPlans } = options.continuationContext;
      continuationContextText = `## Continuation Context

This is continuation attempt ${attempt} of ${maxContinuations}. The planner hit the max turns limit on the previous attempt. The following plan files have already been written. Do NOT redo any of the completed work below.

### Existing Plans

${existingPlans}`;
    }

    return loadPrompt('planner', {
      source: sourceContent,
      planSetName,
      cwd,
      priorClarifications: formatPriorClarifications(allClarifications),
      continuation_context: continuationContextText,
      profiles: options.profiles ? formatProfileDescriptions(options.profiles) : '',
      profileGeneration,
      parallelLanes: '',
      clarification_schema: getClarificationSchemaYaml(),
      module_schema: getModuleSchemaYaml(),
      plan_frontmatter_schema: getPlanFrontmatterSchemaYaml(),
    });
  }

  let skipEmitted = false;
  let profileEmitted = false;

  // Main loop: run agent, collect clarifications, restart with answers baked in
  let iteration = 0;
  const maxIterations = 5; // prevent infinite loops

  while (iteration < maxIterations) {
    iteration++;

    const prompt = await buildPrompt();

    if (iteration === 1) {
      yield { timestamp: new Date().toISOString(), type: 'plan:progress', message: 'Starting planner agent...' };
    } else {
      yield { timestamp: new Date().toISOString(), type: 'plan:progress', message: 'Planner restarted with prior clarifications' };
    }

    let needsRestart = false;

    for await (const event of backend.run(
      { prompt, cwd, maxTurns: options.maxTurns ?? 30, tools: 'coding', abortSignal: options.abortController?.signal },
      'planner',
    )) {
      if (event.type === 'agent:message') {
        if (!skipEmitted) {
          const skipReason = parseSkipBlock(event.content);
          if (skipReason) {
            skipEmitted = true;
            yield { timestamp: new Date().toISOString(), type: 'plan:skip', reason: skipReason };
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
                  timestamp: new Date().toISOString(),
                  type: 'plan:profile',
                  profileName: generatedBlock.name ?? generatedBlock.extends ?? 'generated',
                  rationale: `Generated profile${generatedBlock.extends ? ` extending ${generatedBlock.extends}` : ''} tailored to this PRD`,
                  config: resolved,
                };
              } else {
                yield { timestamp: new Date().toISOString(), type: 'plan:progress', message: `Generated profile invalid (${errors.join('; ')}), falling back to name-based selection` };
              }
            } catch (err) {
              yield { timestamp: new Date().toISOString(), type: 'plan:progress', message: `Generated profile resolution failed (${(err as Error).message}), falling back to name-based selection` };
            }
          }
        }

        if (!profileEmitted) {
          const profile = parseProfileBlock(event.content);
          if (profile) {
            profileEmitted = true;
            yield {
              timestamp: new Date().toISOString(),
              type: 'plan:profile',
              profileName: profile.profileName,
              rationale: profile.rationale,
              config: options.profiles?.[profile.profileName],
            };
          }
        }

        const questions = parseClarificationBlocks(event.content);
        if (questions.length > 0 && !options.auto) {
          yield { timestamp: new Date().toISOString(), type: 'plan:clarification', questions };

          if (options.onClarification) {
            const answers = await options.onClarification(questions);
            yield { timestamp: new Date().toISOString(), type: 'plan:clarification:answer', answers };
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

  // Skip was emitted — no plans to scan, no orchestration.yaml written
  if (skipEmitted) return;

  yield { timestamp: new Date().toISOString(), type: 'plan:progress', message: 'Scanning plan files...' };

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

  yield { timestamp: new Date().toISOString(), type: 'plan:complete', plans };
}
