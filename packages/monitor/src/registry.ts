/**
 * Global monitor port registry.
 *
 * Manages a shared registry file at $XDG_CONFIG_HOME/eforge/monitors.json
 * that tracks which project directory owns which monitor port. This prevents
 * port collisions when multiple eforge projects run simultaneously.
 *
 * The registry is advisory - it prevents eforge-vs-eforge collisions.
 * Non-eforge processes may still occupy a port, which the existing
 * EADDRINUSE retry logic handles.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { isPidAlive } from '@eforge-build/client';

export interface RegistryEntry {
  port: number;
  pid: number;
}

export type Registry = Record<string, RegistryEntry>;

export const PORT_RANGE_START = 4567;
export const PORT_RANGE_SIZE = 101; // 4567-4667

/**
 * Resolve the registry file path using XDG conventions.
 * Uses $XDG_CONFIG_HOME/eforge/monitors.json when set,
 * otherwise ~/.config/eforge/monitors.json.
 */
function registryPath(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_CONFIG_HOME || resolve(homedir(), '.config');
  return resolve(base, 'eforge', 'monitors.json');
}

/**
 * Deterministic port from cwd string.
 * Uses a simple hash (sum of char codes * prime) mod PORT_RANGE_SIZE + PORT_RANGE_START.
 * Pure function, no I/O.
 */
export function hashPort(cwd: string): number {
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) {
    hash = (hash * 31 + cwd.charCodeAt(i)) >>> 0; // unsigned 32-bit
  }
  return (hash % PORT_RANGE_SIZE) + PORT_RANGE_START;
}

/**
 * Read the registry file and prune stale entries (dead PIDs).
 * Creates the file if missing, returns {} on parse error.
 * Writes back if any entries were pruned.
 */
export function readRegistry(): Registry {
  const path = registryPath();
  let registry: Registry;

  try {
    const raw = readFileSync(path, 'utf-8');
    registry = JSON.parse(raw) as Registry;
  } catch {
    return {};
  }

  // Prune stale entries
  let pruned = false;
  for (const [cwd, entry] of Object.entries(registry)) {
    if (!isPidAlive(entry.pid)) {
      delete registry[cwd];
      pruned = true;
    }
  }

  if (pruned) {
    try {
      writeRegistry(registry);
    } catch {
      // Best-effort prune write - don't fail the read
    }
  }

  return registry;
}

/**
 * Atomically write the registry (temp file + rename).
 */
export function writeRegistry(registry: Registry): void {
  const path = registryPath();
  const dir = dirname(path);

  // Ensure directory exists
  mkdirSync(dir, { recursive: true });

  // Write to temp file, then rename for atomicity
  const tmpPath = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, path);
}

/**
 * Allocate a port for a project.
 *
 * 1. If explicitPort provided, return it (will be registered after bind)
 * 2. Read + prune registry
 * 3. If cwd already has a live entry, return that port
 * 4. Compute preferred = hashPort(cwd)
 * 5. Collect all ports claimed by OTHER projects
 * 6. If preferred not claimed, return it
 * 7. Otherwise, scan the range starting from preferred, wrapping around
 * 8. Return first unclaimed port
 */
export function allocatePort(cwd: string, explicitPort?: number): number {
  if (explicitPort !== undefined) {
    return explicitPort;
  }

  try {
    const registry = readRegistry();

    // If cwd already has a live entry, reuse it
    const existing = registry[cwd];
    if (existing && isPidAlive(existing.pid)) {
      return existing.port;
    }

    const preferred = hashPort(cwd);

    // Collect ports claimed by OTHER projects
    const claimedPorts = new Set<number>();
    for (const [registryCwd, entry] of Object.entries(registry)) {
      if (registryCwd !== cwd) {
        claimedPorts.add(entry.port);
      }
    }

    // If preferred is not claimed, use it
    if (!claimedPorts.has(preferred)) {
      return preferred;
    }

    // Scan range starting from preferred, wrapping around
    for (let i = 1; i < PORT_RANGE_SIZE; i++) {
      const candidate = PORT_RANGE_START + ((preferred - PORT_RANGE_START + i) % PORT_RANGE_SIZE);
      if (!claimedPorts.has(candidate)) {
        return candidate;
      }
    }

    // All ports claimed (unlikely with 101 ports) - return preferred anyway
    // and let EADDRINUSE retry logic handle it
    return preferred;
  } catch {
    // Registry is advisory - fall back to hash-based port on any I/O error
    return hashPort(cwd);
  }
}

/**
 * Register a port for a project after successful bind.
 */
export function registerPort(cwd: string, port: number, pid: number): void {
  try {
    const registry = readRegistry();
    registry[cwd] = { port, pid };
    writeRegistry(registry);
  } catch {
    // Registry is advisory - silently ignore I/O errors
  }
}

/**
 * Remove a project's entry from the registry.
 */
export function deregisterPort(cwd: string): void {
  try {
    const registry = readRegistry();
    if (cwd in registry) {
      delete registry[cwd];
      writeRegistry(registry);
    }
  } catch {
    // Registry is advisory - silently ignore I/O errors
  }
}
