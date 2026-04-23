/**
 * Misc pipeline utilities — PRD metadata extraction, issue filtering, dependency backfill.
 */

import { parse as parseYaml } from 'yaml';

import { SEVERITY_ORDER } from '../events.js';
import type { ReviewIssue, PlanFile, OrchestrationConfig } from '../events.js';
import { extractPlanTitle } from '../plan.js';

/** Convert kebab-case name to a human-readable title. */
function humanizeName(name: string): string {
  return name
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Extract metadata from PRD content: title from YAML frontmatter or H1 heading,
 * and body with frontmatter stripped.
 */
export function extractPrdMetadata(
  content: string,
  fallbackName: string,
): { title: string; body: string } {
  // Try YAML frontmatter title
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fmMatch) {
    const frontmatter = parseYaml(fmMatch[1]) as Record<string, unknown>;
    const body = fmMatch[2].trim();
    if (typeof frontmatter.title === 'string' && frontmatter.title.trim()) {
      return { title: frontmatter.title.trim(), body };
    }
    // No title in frontmatter — try H1 in body
    const h1Title = extractPlanTitle(body);
    if (h1Title) return { title: h1Title, body };
    // Fall back to humanized planSetName
    return { title: humanizeName(fallbackName), body };
  }

  // No frontmatter — try H1 heading
  const h1Title = extractPlanTitle(content);
  if (h1Title) return { title: h1Title, body: content };

  // Fall back to humanized planSetName
  return { title: humanizeName(fallbackName), body: content };
}

/**
 * Filter review issues by severity threshold.
 * `autoAcceptBelow: 'warning'` means issues at warning and below (warning, suggestion)
 * are auto-accepted. Only critical issues reach the fixer.
 * `autoAcceptBelow: 'suggestion'` means only suggestion-severity issues are auto-accepted.
 * Critical and warning reach the fixer.
 */
export function filterIssuesBySeverity(
  issues: ReviewIssue[],
  autoAcceptBelow?: 'suggestion' | 'warning',
): { filtered: ReviewIssue[]; autoAccepted: ReviewIssue[] } {
  if (!autoAcceptBelow) return { filtered: issues, autoAccepted: [] };
  const threshold = SEVERITY_ORDER[autoAcceptBelow];
  const filtered = issues.filter(i => SEVERITY_ORDER[i.severity] < threshold);
  const autoAccepted = issues.filter(i => SEVERITY_ORDER[i.severity] >= threshold);
  return { filtered, autoAccepted };
}

/**
 * Enrich plan files with dependsOn from orchestration config.
 * The planner writes depends_on only to orchestration.yaml, not to individual
 * plan file frontmatter. This function cross-references the two sources.
 */
export function backfillDependsOn(
  plans: PlanFile[],
  orchConfig: OrchestrationConfig,
): PlanFile[] {
  const depsMap = new Map(orchConfig.plans.map((p) => [p.id, p.dependsOn]));
  return plans.map((plan) => {
    const deps = depsMap.get(plan.id);
    if (deps && deps.length > 0 && plan.dependsOn.length === 0) {
      return { ...plan, dependsOn: deps };
    }
    return plan;
  });
}
