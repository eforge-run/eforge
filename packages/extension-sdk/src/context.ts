/**
 * Context types passed to extension hook handlers.
 *
 * Each hook receives a context object scoped to its execution environment.
 * Some fields (e.g. `exec`, `state`) are typed contracts whose runtime
 * implementations are not yet wired — they are included so authors can write
 * type-safe code against the future runtime surface.
 */

import type { EforgeEvent } from './events.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/**
 * Structured logger available to all extension hooks.
 *
 * Messages are routed through the eforge daemon's log pipeline, so they appear
 * in `eforge logs` output and the monitor UI.
 */
export interface ExtensionLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Exec API
// ---------------------------------------------------------------------------

/**
 * Minimal shell-exec capability made available to extension hooks.
 *
 * @remarks Runtime not yet wired. Typed contract only in this slice.
 */
export interface ExtensionExecApi {
  /**
   * Spawn a command and return its captured output.
   *
   * Resolves with the command's `stdout`, `stderr`, and `exitCode`.
   *
   * @param command - The executable to run.
   * @param args - Arguments passed to the command.
   * @param options - Optional cwd and env overrides.
   */
  run(
    command: string,
    args?: string[],
    options?: { cwd?: string; env?: Record<string, string> },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

// ---------------------------------------------------------------------------
// Extension diff
// ---------------------------------------------------------------------------

/**
 * Summary of file-level changes associated with a plan output.
 * Used by policy-gate contexts to describe what is being evaluated.
 */
export interface ExtensionDiff {
  files: Array<{
    path: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
  }>;
}

// ---------------------------------------------------------------------------
// Base extension context
// ---------------------------------------------------------------------------

/**
 * Base context object available to all extension hooks.
 *
 * Per-hook contexts extend this with additional fields relevant to the specific
 * hook family.
 */
export interface EforgeExtensionContext {
  /** Structured logger routed through the eforge daemon's log pipeline. */
  logger: ExtensionLogger;
  /**
   * Shell-exec API for running subprocesses from an extension.
   *
   * @remarks Runtime not yet wired. Typed contract only in this slice.
   */
  exec: ExtensionExecApi;
}

// ---------------------------------------------------------------------------
// Per-hook contexts
// ---------------------------------------------------------------------------

/**
 * Context passed to event hook handlers registered via `onEvent`.
 */
export interface EventHookContext extends EforgeExtensionContext {
  /**
   * The raw event that triggered the hook (same object as the handler's first
   * argument, provided here for convenience in shared helper functions).
   */
  event: EforgeEvent;
}

/**
 * Context passed to agent-run hooks and profile routers.
 */
export interface AgentRunContext extends EforgeExtensionContext {
  /** The agent's role in the current build stage. */
  role: import('@eforge-build/client').AgentRole;
  /**
   * The agent's compute tier for this run (e.g. `'standard'`, `'extended'`).
   * Exact values are defined by the active profile's tier configuration.
   */
  tier: string;
  /** Active profile name resolved for this run. */
  profile: string;
  /** The plan ID associated with this agent run, if applicable. */
  planId?: string;
  /**
   * Files changed in the plan worktree before this agent run, if available.
   * Populated for review and post-build stages.
   */
  changedFiles?: string[];
}

/**
 * Context passed to policy-gate handlers (e.g. `beforePlanMerge`).
 */
export interface PolicyGateContext extends EforgeExtensionContext {
  /** The plan ID for the operation being gated. */
  planId: string;
  /** Summary of file-level changes included in the merge. */
  diff: ExtensionDiff;
}
