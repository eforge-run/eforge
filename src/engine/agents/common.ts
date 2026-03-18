/**
 * Provider-agnostic XML parsing utilities for agent output.
 * These parse structured blocks from free-text agent responses
 * regardless of which LLM backend produced them.
 */
import type { ClarificationQuestion, ExpeditionModule } from '../events.js';
import type { ResolvedProfileConfig, ReviewProfileConfig } from '../config.js';

/**
 * Parse <clarification> XML blocks from assistant text into structured questions.
 *
 * Expected format:
 *   <clarification>
 *     <question id="q1">What database should we use?</question>
 *     <question id="q2" default="PostgreSQL">
 *       Which ORM do you prefer?
 *       <context>We need to support migrations</context>
 *       <option>Prisma</option>
 *       <option>Drizzle</option>
 *     </question>
 *   </clarification>
 */
export function parseClarificationBlocks(text: string): ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];
  const blockRegex = /<clarification>([\s\S]*?)<\/clarification>/g;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRegex.exec(text)) !== null) {
    const blockContent = blockMatch[1];
    const questionRegex = /<question\s+([^>]*)>([\s\S]*?)<\/question>/g;
    let questionMatch: RegExpExecArray | null;

    while ((questionMatch = questionRegex.exec(blockContent)) !== null) {
      const attrs = questionMatch[1];
      const inner = questionMatch[2];

      const idMatch = attrs.match(/id="([^"]+)"/);
      const defaultMatch = attrs.match(/default="([^"]+)"/);

      if (!idMatch) continue;

      const contextMatch = inner.match(/<context>([\s\S]*?)<\/context>/);
      const optionRegex = /<option>([\s\S]*?)<\/option>/g;
      const options: string[] = [];
      let optionMatch: RegExpExecArray | null;
      while ((optionMatch = optionRegex.exec(inner)) !== null) {
        options.push(optionMatch[1].trim());
      }

      // Question text is inner content with tags stripped
      const questionText = inner
        .replace(/<context>[\s\S]*?<\/context>/g, '')
        .replace(/<option>[\s\S]*?<\/option>/g, '')
        .trim();

      const question: ClarificationQuestion = {
        id: idMatch[1],
        question: questionText,
      };

      if (contextMatch) {
        question.context = contextMatch[1].trim();
      }
      if (options.length > 0) {
        question.options = options;
      }
      if (defaultMatch) {
        question.default = defaultMatch[1];
      }

      questions.push(question);
    }
  }

  return questions;
}

/**
 * Parse a <modules> XML block from assistant text into ExpeditionModule[].
 *
 * Expected format:
 *   <modules>
 *     <module id="foundation" depends_on="">Core types and utilities</module>
 *     <module id="auth" depends_on="foundation">Auth system</module>
 *   </modules>
 */
export function parseModulesBlock(text: string): ExpeditionModule[] {
  const modules: ExpeditionModule[] = [];
  const blockMatch = text.match(/<modules>([\s\S]*?)<\/modules>/);
  if (!blockMatch) return modules;

  const blockContent = blockMatch[1];
  const moduleRegex = /<module\s+([^>]*)>([\s\S]*?)<\/module>/g;
  let moduleMatch: RegExpExecArray | null;

  while ((moduleMatch = moduleRegex.exec(blockContent)) !== null) {
    const attrs = moduleMatch[1];
    const description = moduleMatch[2].trim();

    const idMatch = attrs.match(/id="([^"]+)"/);
    const depsMatch = attrs.match(/depends_on="([^"]*)"/);

    if (!idMatch || !description) continue;

    const dependsOn = depsMatch && depsMatch[1].trim()
      ? depsMatch[1].split(',').map((d) => d.trim())
      : [];

    modules.push({ id: idMatch[1], description, dependsOn });
  }

  return modules;
}

export interface ProfileSelection {
  profileName: string;
  rationale: string;
}

/**
 * Parse a <profile> XML block from assistant text into a ProfileSelection.
 *
 * Expected format:
 *   <profile name="excursion">Rationale text</profile>
 */
export function parseProfileBlock(text: string): ProfileSelection | null {
  const match = text.match(/<profile\s+name="([^"]+)">([\s\S]*?)<\/profile>/);
  if (!match) return null;
  const profileName = match[1].trim();
  const rationale = match[2].trim();
  if (!profileName || !rationale) return null;
  return { profileName, rationale };
}

/**
 * Parse a <skip> XML block from assistant text.
 *
 * Expected format:
 *   <skip>Already implemented</skip>
 *
 * Returns the reason string or null if no block found.
 */
export function parseSkipBlock(text: string): string | null {
  const match = text.match(/<skip>([\s\S]*?)<\/skip>/);
  if (!match) return null;
  const reason = match[1].trim();
  return reason || null;
}

// ---------------------------------------------------------------------------
// Generated Profile Parsing
// ---------------------------------------------------------------------------

export interface GeneratedProfileBlock {
  extends?: string;
  name?: string;
  overrides?: Partial<{
    description: string;
    compile: string[];
    build: string[];
    agents: Record<string, unknown>;
    review: Partial<ReviewProfileConfig>;
  }>;
  config?: ResolvedProfileConfig;
}

/**
 * Parse a <generated-profile> XML block from assistant text.
 * The block contains JSON with either:
 * - `{ extends: "base-name", name?: "...", overrides: { ... } }`
 * - `{ config: { description, compile, build, agents, review }, name?: "..." }`
 *
 * Returns a typed object or null if no block found or parse failure.
 */
export function parseGeneratedProfileBlock(text: string): GeneratedProfileBlock | null {
  const match = text.match(/<generated-profile>([\s\S]*?)<\/generated-profile>/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1].trim());
    if (parsed.config) return { config: parsed.config, name: parsed.name };
    if (parsed.extends || parsed.overrides) return { extends: parsed.extends, overrides: parsed.overrides, name: parsed.name };
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Staleness Assessment Parsing
// ---------------------------------------------------------------------------

const VALID_STALENESS_VERDICTS = new Set(['proceed', 'revise', 'obsolete']);

export interface StalenessVerdict {
  verdict: 'proceed' | 'revise' | 'obsolete';
  justification: string;
  revision?: string;
}

/**
 * Parse a <staleness verdict="..."> XML block from assistant text.
 *
 * Expected format:
 *   <staleness verdict="proceed">All good</staleness>
 *   <staleness verdict="revise">Needs update<revision>new content</revision></staleness>
 *
 * Returns null if no valid block found.
 */
export function parseStalenessBlock(text: string): StalenessVerdict | null {
  const match = text.match(/<staleness\s+verdict="([^"]+)">([\s\S]*?)<\/staleness>/);
  if (!match) return null;

  const verdict = match[1].trim();
  if (!VALID_STALENESS_VERDICTS.has(verdict)) return null;

  const inner = match[2];

  // Extract revision content if present
  const revisionMatch = inner.match(/<revision>([\s\S]*?)<\/revision>/);
  const revision = revisionMatch ? revisionMatch[1].trim() : undefined;

  // Justification is the inner content with <revision> tag stripped
  const justification = inner
    .replace(/<revision>[\s\S]*?<\/revision>/g, '')
    .trim();

  if (!justification) return null;

  return {
    verdict: verdict as 'proceed' | 'revise' | 'obsolete',
    justification,
    ...(revision !== undefined && { revision }),
  };
}
