/**
 * Misc pipeline utilities — PRD metadata extraction.
 */

import { parse as parseYaml } from 'yaml';

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
