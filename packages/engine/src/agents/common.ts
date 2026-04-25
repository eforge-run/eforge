/**
 * Provider-agnostic XML parsing utilities for agent output.
 * These parse structured blocks from free-text agent responses
 * regardless of which LLM backend produced them.
 */
import { z } from 'zod/v4';
import type { ClarificationQuestion, TestIssue, ReviewIssue } from '../events.js';
import type { ReviewProfileConfig, BuildStageSpec } from '../config.js';
import { buildStageSpecSchema, reviewProfileConfigSchema } from '../config.js';
import type { stalenessVerdictSchema, evaluationEvidenceSchema, evaluationVerdictSchema, recoveryVerdictSchema } from '../schemas.js';

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
// Staleness Assessment Parsing
// ---------------------------------------------------------------------------

const VALID_STALENESS_VERDICTS = new Set(['proceed', 'revise', 'obsolete']);

export type StalenessVerdict = z.output<typeof stalenessVerdictSchema>;

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

// ---------------------------------------------------------------------------
// Recovery Verdict Parsing
// ---------------------------------------------------------------------------

const VALID_RECOVERY_VERDICTS = new Set(['retry', 'split', 'abandon', 'manual']);
const VALID_RECOVERY_CONFIDENCES = new Set(['low', 'medium', 'high']);

export type RecoveryVerdict = z.output<typeof recoveryVerdictSchema>;

/**
 * Extract a list of `<item>` elements from inside a named XML tag.
 * Returns an empty array if the tag is absent or contains no items.
 */
function parseListItems(content: string, tagName: string): string[] {
  const blockMatch = content.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`));
  if (!blockMatch) return [];
  const items: string[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let itemMatch: RegExpExecArray | null;
  while ((itemMatch = itemRegex.exec(blockMatch[1])) !== null) {
    const item = itemMatch[1].trim();
    if (item) items.push(item);
  }
  return items;
}

/**
 * Parse a `<recovery verdict="..." confidence="...">` XML block from agent text.
 *
 * Expected format:
 * ```xml
 * <recovery verdict="split" confidence="medium">
 *   <rationale>The plan was too large to complete in one session.</rationale>
 *   <completedWork>
 *     <item>Database schema implemented</item>
 *   </completedWork>
 *   <remainingWork>
 *     <item>API endpoints not implemented</item>
 *   </remainingWork>
 *   <risks>
 *     <item>Foundation may need updates</item>
 *   </risks>
 *   <suggestedSuccessorPrd>Full PRD content here</suggestedSuccessorPrd>
 * </recovery>
 * ```
 *
 * Returns null if no valid block found or attributes are invalid.
 */
export function parseRecoveryVerdictBlock(text: string): RecoveryVerdict | null {
  const match = text.match(/<recovery\s+verdict="([^"]+)"\s+confidence="([^"]+)">([\s\S]*?)<\/recovery>/);
  if (!match) return null;

  const verdict = match[1].trim();
  const confidence = match[2].trim();
  if (!VALID_RECOVERY_VERDICTS.has(verdict) || !VALID_RECOVERY_CONFIDENCES.has(confidence)) return null;

  const inner = match[3];

  const rationaleMatch = inner.match(/<rationale>([\s\S]*?)<\/rationale>/);
  if (!rationaleMatch) return null;
  const rationale = rationaleMatch[1].trim();
  if (!rationale) return null;

  const completedWork = parseListItems(inner, 'completedWork');
  const remainingWork = parseListItems(inner, 'remainingWork');
  const risks = parseListItems(inner, 'risks');

  const successorMatch = inner.match(/<suggestedSuccessorPrd>([\s\S]*?)<\/suggestedSuccessorPrd>/);
  const suggestedSuccessorPrd = successorMatch ? successorMatch[1].trim() : undefined;

  return {
    verdict: verdict as 'retry' | 'split' | 'abandon' | 'manual',
    confidence: confidence as 'low' | 'medium' | 'high',
    rationale,
    completedWork,
    remainingWork,
    risks,
    ...(suggestedSuccessorPrd !== undefined && { suggestedSuccessorPrd }),
  };
}

// ---------------------------------------------------------------------------
// Evaluation Verdict Parsing
// ---------------------------------------------------------------------------

/**
 * Structured evidence extracted from evaluation verdict child elements.
 * Present when the evaluator uses the structured format with `<staged>`/`<original>`,
 * `<fix>`, `<rationale>`, `<if-accepted>`, and `<if-rejected>` child elements.
 */
export type EvaluationEvidence = z.output<typeof evaluationEvidenceSchema>;

/**
 * A single evaluation verdict from the evaluator's XML output.
 */
export type EvaluationVerdict = z.output<typeof evaluationVerdictSchema>;

/**
 * Extract text content of a child element from XML content.
 * Returns undefined if the element is not found.
 */
function extractChildElement(content: string, tagName: string): string | undefined {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`);
  const match = content.match(regex);
  return match ? match[1].trim() : undefined;
}

/**
 * Parse `<evaluation>` XML blocks from agent output into structured verdicts.
 * Returns an empty array if no evaluation block is found or XML is malformed.
 *
 * Supports two formats:
 *
 * Plain text (backwards compatible):
 * ```xml
 * <evaluation>
 *   <verdict file="path/to/file.ts" action="accept">Reason text</verdict>
 * </evaluation>
 * ```
 *
 * Structured evidence:
 * ```xml
 * <evaluation>
 *   <verdict file="path/to/file.ts" action="accept" hunk="2">
 *     <staged>What the staged code does</staged>
 *     <fix>What the fix does</fix>
 *     <rationale>Why this verdict</rationale>
 *     <if-accepted>Consequence if accepted</if-accepted>
 *     <if-rejected>Consequence if rejected</if-rejected>
 *   </verdict>
 * </evaluation>
 * ```
 *
 * The plan-evaluator uses `<original>` instead of `<staged>` — both are supported.
 */
export function parseEvaluationBlock(text: string): EvaluationVerdict[] {
  const verdicts: EvaluationVerdict[] = [];

  const blockRegex = /<evaluation>([\s\S]*?)<\/evaluation>/g;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRegex.exec(text)) !== null) {
    const blockContent = blockMatch[1];
    const verdictRegex = /<verdict\s+([^>]*)>([\s\S]*?)<\/verdict>/g;
    let verdictMatch: RegExpExecArray | null;

    while ((verdictMatch = verdictRegex.exec(blockContent)) !== null) {
      const attrs = verdictMatch[1];
      const innerContent = verdictMatch[2];

      const fileMatch = attrs.match(/file="([^"]+)"/);
      const actionMatch = attrs.match(/action="([^"]+)"/);

      if (!fileMatch || !actionMatch) continue;

      const action = actionMatch[1];
      if (action !== 'accept' && action !== 'reject' && action !== 'review') continue;

      // Extract optional hunk attribute
      const hunkMatch = attrs.match(/hunk="(\d+)"/);
      const hunk = hunkMatch ? parseInt(hunkMatch[1], 10) : undefined;

      // Try to extract structured evidence child elements
      const staged = extractChildElement(innerContent, 'staged') ?? extractChildElement(innerContent, 'original');
      const fix = extractChildElement(innerContent, 'fix');
      const rationale = extractChildElement(innerContent, 'rationale');
      const ifAccepted = extractChildElement(innerContent, 'if-accepted');
      const ifRejected = extractChildElement(innerContent, 'if-rejected');

      // Build evidence if structured elements are present
      let evidence: EvaluationEvidence | undefined;
      if (staged && fix && rationale && ifAccepted && ifRejected) {
        evidence = { staged, fix, rationale, ifAccepted, ifRejected };
      }

      // For reason: if structured elements are present, strip them out and use remaining text;
      // otherwise use the full inner content as plain text reason
      let reason: string;
      if (evidence) {
        reason = innerContent
          .replace(/<staged>[\s\S]*?<\/staged>/g, '')
          .replace(/<original>[\s\S]*?<\/original>/g, '')
          .replace(/<fix>[\s\S]*?<\/fix>/g, '')
          .replace(/<rationale>[\s\S]*?<\/rationale>/g, '')
          .replace(/<if-accepted>[\s\S]*?<\/if-accepted>/g, '')
          .replace(/<if-rejected>[\s\S]*?<\/if-rejected>/g, '')
          .trim();
        // If no remaining text after stripping, use rationale as reason
        if (!reason) {
          reason = rationale!;
        }
      } else {
        reason = innerContent.trim();
      }

      verdicts.push({
        file: fileMatch[1],
        action,
        reason,
        ...(evidence && { evidence }),
        ...(hunk !== undefined && { hunk }),
      });
    }
  }

  return verdicts;
}

// ---------------------------------------------------------------------------
// Build Config Parsing
// ---------------------------------------------------------------------------

const buildConfigSchema = z.object({
  build: z.array(buildStageSpecSchema),
  review: reviewProfileConfigSchema,
});

/**
 * Parse a `<build-config>` XML block from assistant text into per-plan build/review config.
 *
 * Expected format:
 *   <build-config>
 *   {
 *     "build": [["implement", "doc-update"], "review-cycle"],
 *     "review": { "strategy": "auto", "perspectives": ["code"], "maxRounds": 1, "evaluatorStrictness": "standard" }
 *   }
 *   </build-config>
 *
 * Returns null if no block found, JSON is invalid, or Zod validation fails.
 */
export function parseBuildConfigBlock(text: string): { build: BuildStageSpec[]; review: ReviewProfileConfig } | null {
  const match = text.match(/<build-config>([\s\S]*?)<\/build-config>/);
  if (!match) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch {
    return null;
  }

  const result = buildConfigSchema.safeParse(parsed);
  if (!result.success) return null;

  return result.data;
}

// ---------------------------------------------------------------------------
// Test Issue Parsing
// ---------------------------------------------------------------------------

const VALID_TEST_SEVERITIES = new Set(['critical', 'warning']);
const VALID_TEST_CATEGORIES = new Set(['production-bug', 'missing-behavior', 'regression']);

/**
 * Parse `<test-issues>` XML blocks from agent output into structured TestIssue[].
 * Returns an empty array if no block found or XML is malformed.
 *
 * Expected format:
 * ```xml
 * <test-issues>
 *   <issue severity="critical" category="production-bug" file="src/foo.ts" testFile="test/foo.test.ts">
 *     Description of the issue
 *     <test-output>failure output</test-output>
 *     <fix>fix description</fix>
 *   </issue>
 * </test-issues>
 * ```
 */
export function parseTestIssues(text: string): TestIssue[] {
  const issues: TestIssue[] = [];

  const blockRegex = /<test-issues>([\s\S]*?)<\/test-issues>/g;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRegex.exec(text)) !== null) {
    const blockContent = blockMatch[1];
    const issueRegex = /<issue\s+([^>]*)>([\s\S]*?)<\/issue>/g;
    let issueMatch: RegExpExecArray | null;

    while ((issueMatch = issueRegex.exec(blockContent)) !== null) {
      const attrs = issueMatch[1];
      const innerContent = issueMatch[2];

      const severityMatch = attrs.match(/severity="([^"]+)"/);
      const categoryMatch = attrs.match(/category="([^"]+)"/);
      const fileMatch = attrs.match(/file="([^"]+)"/);
      const testFileMatch = attrs.match(/testFile="([^"]+)"/);

      if (!severityMatch || !categoryMatch || !fileMatch || !testFileMatch) continue;

      const severity = severityMatch[1];
      const category = categoryMatch[1];
      if (!VALID_TEST_SEVERITIES.has(severity) || !VALID_TEST_CATEGORIES.has(category)) continue;

      const testOutput = extractChildElement(innerContent, 'test-output');
      const fix = extractChildElement(innerContent, 'fix');

      // Description is the inner content with child elements stripped
      const description = innerContent
        .replace(/<test-output>[\s\S]*?<\/test-output>/g, '')
        .replace(/<fix>[\s\S]*?<\/fix>/g, '')
        .trim();

      if (!description) continue;

      issues.push({
        severity: severity as 'critical' | 'warning',
        category: category as 'production-bug' | 'missing-behavior' | 'regression',
        file: fileMatch[1],
        testFile: testFileMatch[1],
        description,
        ...(testOutput !== undefined && { testOutput }),
        ...(fix !== undefined && { fix }),
      });
    }
  }

  return issues;
}

/**
 * Convert a TestIssue to a ReviewIssue for the evaluate stage.
 * Maps test-specific fields to the review issue structure.
 */
export function testIssueToReviewIssue(issue: TestIssue): ReviewIssue {
  return {
    severity: issue.severity,
    category: issue.category,
    file: issue.file,
    description: issue.description,
    fix: issue.fix,
  };
}
