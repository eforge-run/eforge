import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTRIBUTION } from './git.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, 'prompts');

const cache = new Map<string, string>();

/**
 * Load a prompt .md file from the prompts directory, optionally substituting
 * {{variable}} placeholders with provided values. Results are cached.
 */
export async function loadPrompt(
  name: string,
  vars?: Record<string, string>,
): Promise<string> {
  // Path-like values load from the filesystem directly
  const isPath = name.includes('/');
  const filename = isPath ? name : (name.endsWith('.md') ? name : `${name}.md`);

  let content: string;
  if (isPath) {
    // Path-based prompts bypass cache (different files could share a basename)
    content = await readFile(resolve(filename), 'utf-8');
  } else {
    const cached = cache.get(filename);
    if (cached !== undefined) {
      content = cached;
    } else {
      const filePath = resolve(PROMPTS_DIR, filename);
      content = await readFile(filePath, 'utf-8');
      cache.set(filename, content);
    }
  }

  const allVars: Record<string, string> = { attribution: ATTRIBUTION, ...vars };
  content = content.replace(/\{\{(\w+)\}\}/g, (match, key) => allVars[key] ?? match);

  return content;
}
