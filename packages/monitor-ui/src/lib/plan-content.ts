import { parse as parseYaml } from 'yaml';

/**
 * Split plan file content into frontmatter (YAML between --- delimiters) and markdown body.
 */
export function splitPlanContent(raw: string): { frontmatter: string | null; body: string } {
  if (!raw.startsWith('---')) {
    return { frontmatter: null, body: raw };
  }

  // Find closing --- (must be on its own line after the opening ---)
  const afterOpening = raw.indexOf('\n');
  if (afterOpening === -1) {
    return { frontmatter: null, body: raw };
  }

  const closingIndex = raw.indexOf('\n---', afterOpening);
  if (closingIndex === -1) {
    return { frontmatter: null, body: raw };
  }

  const frontmatter = raw.slice(afterOpening + 1, closingIndex).trim();
  const body = raw.slice(closingIndex + 4).trim(); // +4 for \n---

  return { frontmatter: frontmatter || null, body };
}

/**
 * Parse YAML frontmatter fields using the yaml library.
 * Handles all YAML structures including nested objects and arrays.
 */
export function parseFrontmatterFields(yaml: string): {
  id: string;
  name: string;
  dependsOn: string[];
  branch: string;
  migrations: Array<{ timestamp: string; description: string }>;
} {
  let parsed: Record<string, unknown> = {};
  try {
    const result = parseYaml(yaml);
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      parsed = result as Record<string, unknown>;
    }
  } catch {
    // Malformed YAML — return empty defaults
  }

  const id = typeof parsed['id'] === 'string' ? parsed['id'] : '';
  const name = typeof parsed['name'] === 'string' ? parsed['name'] : '';
  const branch = typeof parsed['branch'] === 'string' ? parsed['branch'] : '';

  // depends_on is the canonical YAML key; dependsOn is the camelCase variant
  const rawDependsOn = parsed['depends_on'] ?? parsed['dependsOn'];
  const dependsOn: string[] = Array.isArray(rawDependsOn)
    ? rawDependsOn.filter((v): v is string => typeof v === 'string')
    : [];

  const rawMigrations = parsed['migrations'];
  const migrations: Array<{ timestamp: string; description: string }> = Array.isArray(rawMigrations)
    ? rawMigrations.filter(
        (m): m is { timestamp: string; description: string } =>
          m !== null &&
          typeof m === 'object' &&
          typeof (m as Record<string, unknown>)['timestamp'] === 'string' &&
          typeof (m as Record<string, unknown>)['description'] === 'string',
      )
    : [];

  return { id, name, dependsOn, branch, migrations };
}
