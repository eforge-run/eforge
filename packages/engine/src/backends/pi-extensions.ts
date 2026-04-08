/**
 * Pi extension discovery — resolves extension paths from config and auto-discovery locations.
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';

/** Configuration for Pi extension discovery. */
export interface PiExtensionConfig {
  /** Explicit extension directory paths to load. */
  paths?: string[];
  /** Whether to auto-discover extensions from standard locations. Default: true. */
  autoDiscover?: boolean;
  /** Whitelist of extension directory basenames to include (auto-discovered only). */
  include?: string[];
  /** Blacklist of extension directory basenames to exclude (auto-discovered only). */
  exclude?: string[];
}

/**
 * Discover Pi extension paths from explicit config and standard auto-discovery locations.
 *
 * Auto-discovery locations:
 * 1. `.pi/extensions/` in the project root (cwd)
 * 2. `~/.pi/extensions/` global directory
 *
 * When `autoDiscover: false`, only explicit `paths` are returned.
 *
 * @param cwd - Project working directory
 * @param config - Extension discovery configuration
 * @returns Array of resolved extension directory paths that exist on disk
 */
export async function discoverPiExtensions(
  cwd: string,
  config?: PiExtensionConfig,
): Promise<string[]> {
  const result: string[] = [];

  // Add explicit paths first (never filtered by include/exclude)
  if (config?.paths) {
    for (const p of config.paths) {
      if (existsSync(p)) {
        result.push(p);
      }
    }
  }

  // Skip auto-discovery if disabled
  if (config?.autoDiscover === false) {
    return result;
  }

  // Auto-discover from standard locations
  const autoDiscovered: string[] = [];

  // Auto-discover from project-local .pi/extensions/
  const projectExtDir = join(cwd, '.pi', 'extensions');
  await collectExtensionDirs(projectExtDir, autoDiscovered);

  // Auto-discover from global ~/.pi/extensions/
  const globalExtDir = join(homedir(), '.pi', 'extensions');
  await collectExtensionDirs(globalExtDir, autoDiscovered);

  // Filter the eforge extension to prevent orphaned daemons in agent worktrees
  const safeAutoDiscovered = autoDiscovered.filter(p => basename(p) !== 'eforge');

  // Apply include filter (whitelist) — keep only matching basenames
  let filtered = safeAutoDiscovered;
  if (config?.include && config.include.length > 0) {
    const includeSet = new Set(config.include);
    filtered = filtered.filter(p => includeSet.has(basename(p)));
  }

  // Apply exclude filter (blacklist) — remove matching basenames
  if (config?.exclude && config.exclude.length > 0) {
    const excludeSet = new Set(config.exclude);
    filtered = filtered.filter(p => !excludeSet.has(basename(p)));
  }

  result.push(...filtered);
  return result;
}

/**
 * Collect extension directories from a parent directory.
 * Each immediate subdirectory is treated as an extension.
 */
async function collectExtensionDirs(parentDir: string, out: string[]): Promise<void> {
  if (!existsSync(parentDir)) return;

  try {
    const entries = await readdir(parentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        out.push(join(parentDir, entry.name));
      }
    }
  } catch {
    // Directory not readable — skip silently
  }
}
