/**
 * Shared error classifier and formatter for daemon errors.
 *
 * A single `classifyDaemonError(err)` call classifies the error into a tagged
 * union. Both `formatMcpError` and `formatCliError` consume that tag, keeping
 * the two surfaces in lock-step. Hardening-03 can add a new `kind` value here
 * without touching the MCP factory or CLI entry points.
 */

export type DaemonErrorKind =
  | 'daemon-down'
  | 'version-mismatch'
  | 'invalid-config'
  | 'lock'
  | 'network'
  | 'unknown';

export interface ClassifiedDaemonError {
  kind: DaemonErrorKind;
  message: string;
  hint?: string;
}

/**
 * Classify an unknown thrown value into a structured daemon error.
 * Call once; pass the result to `formatMcpError` or `formatCliError`.
 */
export function classifyDaemonError(err: unknown): ClassifiedDaemonError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  // Worktree guard (DaemonInWorktreeError)
  if (lower.includes('worktree')) {
    return {
      kind: 'daemon-down',
      message,
      hint: 'Run eforge from the project root, not from inside a worktree.',
    };
  }

  // Daemon not running / failed to start
  if (
    lower.includes('daemon not running') ||
    lower.includes('daemon failed to start') ||
    lower.includes('econnrefused') ||
    lower.includes('connection refused')
  ) {
    return {
      kind: 'daemon-down',
      message,
      hint: 'Run `eforge daemon start` to start the daemon.',
    };
  }

  // Version mismatch — reserved for hardening-03 which wires the actual HTTP
  // header check. The classification slot exists so the factory/formatter need
  // not change when that plan lands.
  if (lower.includes('version-mismatch') || lower.includes('api version')) {
    return {
      kind: 'version-mismatch',
      message,
      hint: 'Restart the daemon to pick up the latest version: `eforge daemon restart`.',
    };
  }

  // Invalid config / missing eforge/config.yaml
  if (
    lower.includes('config') &&
    (lower.includes('invalid') ||
      lower.includes('missing') ||
      lower.includes('not found') ||
      lower.includes('enoent'))
  ) {
    return {
      kind: 'invalid-config',
      message,
      hint: 'Check eforge/config.yaml or run `eforge init` to create it.',
    };
  }

  // Lock file errors
  if (
    lower.includes('lockfile') ||
    lower.includes('lock file') ||
    lower.includes('.eforge/daemon.lock')
  ) {
    return {
      kind: 'lock',
      message,
      hint: 'Remove the stale lockfile with `eforge daemon kill`.',
    };
  }

  // Generic network / timeout errors
  if (
    lower.includes('fetch') ||
    lower.includes('network') ||
    lower.includes('etimedout') ||
    lower.includes('timeout') ||
    lower.includes('socket')
  ) {
    return {
      kind: 'network',
      message,
      hint: 'Check that the daemon is reachable and try again.',
    };
  }

  return { kind: 'unknown', message };
}

/**
 * MCP-oriented renderer.
 *
 * Returns a `CallToolResult`-compatible payload with `isError: true`.
 * Used by the MCP tool factory to wrap daemon/network errors uniformly.
 */
export function formatMcpError(err: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  const classified = classifyDaemonError(err);
  const payload: Record<string, string> = {
    error: classified.message,
    kind: classified.kind,
  };
  if (classified.hint) payload.hint = classified.hint;

  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

/**
 * CLI-oriented renderer.
 *
 * Returns a human-readable message string and a suggested process exit code.
 * The message and exit code semantics mirror `formatMcpError`'s classification
 * so the two surfaces stay in sync.
 */
export function formatCliError(err: unknown): { message: string; exitCode: number } {
  const classified = classifyDaemonError(err);

  let message = classified.message;
  if (classified.hint) {
    message += `\n  Hint: ${classified.hint}`;
  }

  // Daemon-down and version-mismatch are environmental issues (exit 2);
  // all others are general errors (exit 1).
  const exitCode =
    classified.kind === 'daemon-down' || classified.kind === 'version-mismatch' ? 2 : 1;
  return { message, exitCode };
}
