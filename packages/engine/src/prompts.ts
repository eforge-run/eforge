import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTRIBUTION } from './git.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, 'prompts');

const cache = new Map<string, string>();

// ---------------------------------------------------------------------------
// Project-level prompt directory override
// ---------------------------------------------------------------------------

let resolvedPromptDir: string | undefined;

/**
 * Set the project-level prompt directory. Files in this directory shadow
 * bundled prompts by name (e.g. `reviewer.md` overrides the bundled reviewer).
 *
 * Call once during engine initialization after config is loaded.
 *
 * @param dir - The `agents.promptDir` value from config (relative to project root)
 * @param cwd - The project root directory for resolving relative paths
 */
export function setPromptDir(dir: string | undefined, cwd: string): void {
  resolvedPromptDir = dir ? resolve(cwd, dir) : undefined;
}

/**
 * Load a prompt .md file from the prompts directory, optionally substituting
 * {{variable}} placeholders with provided values. Results are cached.
 *
 * Resolution order for non-path names:
 * 1. Project prompt directory (`agents.promptDir`) if configured and file exists
 * 2. Bundled prompts directory (`packages/engine/src/prompts/`)
 *
 * After variable substitution, `append` text is concatenated to the end.
 *
 * Throws if any `{{variable}}` tokens remain unresolved after substitution.
 * The error message includes the prompt filename and the deduplicated list of
 * missing variable names, so callers are forced to supply every placeholder a
 * prompt declares rather than silently shipping broken prompts to the model.
 */
export async function loadPrompt(
  name: string,
  vars?: Record<string, string>,
  append?: string,
): Promise<string> {
  // Path-like values load from the filesystem directly
  const isPath = name.includes('/');
  const filename = isPath ? name : (name.endsWith('.md') ? name : `${name}.md`);

  let content: string;
  if (isPath) {
    // Path-based prompts bypass cache (different files could share a basename)
    content = await readFile(resolve(filename), 'utf-8');
  } else {
    // Check project prompt directory first
    if (resolvedPromptDir) {
      const projectPath = resolve(resolvedPromptDir, filename);
      try {
        content = await readFile(projectPath, 'utf-8');
        // Don't cache project-level overrides — they may change between builds
      } catch {
        // File doesn't exist in project dir, fall through to bundled
        content = await loadBundled(filename);
      }
    } else {
      content = await loadBundled(filename);
    }
  }

  const allVars: Record<string, string> = { attribution: ATTRIBUTION, ...vars };
  content = content.replace(/\{\{(\w+)\}\}/g, (match, key) => allVars[key] ?? match);

  const unresolved = [...content.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map(m => m[1]);
  if (unresolved.length > 0) {
    throw new Error(
      `loadPrompt(${filename}): unresolved template variables: ${[...new Set(unresolved)].join(', ')}`,
    );
  }

  if (append) {
    content = content + '\n\n' + append;
  }

  return content;
}

/** Load from the bundled prompts directory with caching. */
async function loadBundled(filename: string): Promise<string> {
  const cached = cache.get(filename);
  if (cached !== undefined) return cached;
  const filePath = resolve(PROMPTS_DIR, filename);
  const content = await readFile(filePath, 'utf-8');
  cache.set(filename, content);
  return content;
}
