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
 * Parse simple YAML frontmatter fields from raw YAML text.
 * Handles flat key-value pairs and simple arrays (with `- item` syntax).
 * No external YAML library needed.
 */
export function parseFrontmatterFields(yaml: string): {
  id: string;
  name: string;
  dependsOn: string[];
  branch: string;
  migrations: Array<{ timestamp: string; description: string }>;
} {
  const lines = yaml.split('\n');
  let id = '';
  let name = '';
  let branch = '';
  const dependsOn: string[] = [];
  const migrations: Array<{ timestamp: string; description: string }> = [];

  let currentKey = '';

  for (const line of lines) {
    // Key-value pair
    const kvMatch = line.match(/^(\w[\w_]*):\s*(.+)?$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const value = kvMatch[2]?.trim() || '';

      if (currentKey === 'id') id = value;
      else if (currentKey === 'name') name = value;
      else if (currentKey === 'branch') branch = value;
      continue;
    }

    // Array item
    const itemMatch = line.match(/^\s+-\s+(.+)$/);
    if (itemMatch && currentKey === 'depends_on') {
      dependsOn.push(itemMatch[1].trim());
    }
  }

  return { id, name, dependsOn, branch, migrations };
}
