/**
 * Context types passed to extension hook handlers.
 *
 * Each hook receives a context object scoped to its execution environment.
 * Event-hook, agent-run, profile-router, and policy-gate contexts are
 * runtime-supported for the currently wired extension capabilities. Deferred
 * extension families may still expose typed contracts before their runtime
 * execution is added.
 */

import type { EforgeEvent } from './events.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/**
 * Structured logger available to all extension hooks.
 *
 * Messages are routed through the eforge daemon's log pipeline. Event-hook
 * handler failure and timeout diagnostics are emitted as monitor-recorded
 * `extension:event-handler:*` events, but logger output itself is not a
 * separate monitor event variant in this scope.
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
 * @remarks Runtime-supported for currently wired hook families.
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
   * @remarks Runtime-supported for currently wired hook families.
   */
  exec: ExtensionExecApi;
}

// ---------------------------------------------------------------------------
// Policy gate kinds
// ---------------------------------------------------------------------------

/** Supported blocking policy-gate invocation points. */
export type PolicyGateKind = 'queue-dispatch' | 'plan-merge' | 'final-merge';

// ---------------------------------------------------------------------------
// Per-hook contexts
// ---------------------------------------------------------------------------

/**
 * Context passed to event hook handlers registered via `onEvent`.
 *
 * `onEvent` handlers are runtime-supported. The context carries the same
 * enriched event object as the handler's first argument, including available
 * `sessionId` and `runId` correlation fields. Handler failures and timeouts are
 * emitted as `extension:event-handler:*` diagnostics; `ctx.logger` messages do
 * not create separate monitor event variants in this scope.
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
 *
 * All fields are read-only metadata. Handlers must not write to or mutate
 * toolbelt, profile, or MCP selection — those are engine-owned values.
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
  /**
   * The engine pipeline phase in which this agent run is executing.
   *
   * Known values:
   * - `'compile'` - planning/compilation pipeline (planner, module-planner, etc.)
   * - `'build'` - build pipeline (builder, reviewer, evaluator, etc.)
   * - `'standalone'` - standalone helper invocations outside a pipeline
   *   (recovery-analyst, staleness-assessor, formatter, etc.)
   */
  phase?: string;
  /**
   * The specific pipeline stage in which this agent run is executing.
   *
   * Known values for `phase: 'build'`: `'implement'`, `'review'`, `'review-fix'`,
   * `'evaluate'`, `'test'`, `'test-write'`, `'doc-author'`, `'doc-sync'`.
   *
   * Known values for `phase: 'compile'`: `'planner'`, `'module-planner'`,
   * `'pipeline-composer'`, `'plan-review'`, `'plan-evaluate'`,
   * `'architecture-review'`, `'architecture-evaluate'`, `'cohesion-review'`,
   * `'cohesion-evaluate'`.
   *
   * Not set when `phase` is `'standalone'`.
   */
  stage?: string;
  /**
   * The agent harness backend used for this run.
   *
   * - `'claude-sdk'` - Anthropic Claude Agent SDK
   * - `'pi'` - Pi AI agent harness
   */
  harness?: 'claude-sdk' | 'pi';
  /**
   * The active toolbelt name for this run, or `null` when no named toolbelt
   * is active. Read-only — do not use this to infer or override tool availability.
   */
  toolbelt?: string | null;
  /**
   * How the active toolbelt was selected.
   *
   * - `'tier'` - toolbelt resolved from the agent's tier configuration
   * - `'role'` - toolbelt resolved from the agent's role configuration
   * - `'plan'` - toolbelt overridden at the plan level
   * - `'default'` - fallback toolbelt used
   */
  toolbeltSource?: 'tier' | 'role' | 'plan' | 'default';
  /**
   * The project MCP server selection mode active for this run.
   *
   * - `'all'` - all project MCP servers are available
   * - `'none'` - no project MCP servers are available
   * - `'toolbelt'` - only toolbelt-selected project MCP servers are available
   */
  projectMcpSelection?: 'all' | 'none' | 'toolbelt';
  /**
   * Translate a bare extension custom tool name into the harness-visible name
   * the agent model should call at runtime.
   *
   * Claude SDK prefixes custom tools when they are exposed through its
   * in-process MCP server; Pi exposes custom tools by their bare names. Use
   * this helper when prompt text needs to mention a contributed tool.
   */
  effectiveToolName(name: string): string;
}

/**
 * Context passed to `beforeQueueDispatch` policy-gate handlers.
 */
export interface QueueDispatchPolicyGateContext extends EforgeExtensionContext {
  /** Identifies this policy gate invocation point. */
  gateKind: 'queue-dispatch';
  /** The PRD/queue item identifier being considered for dispatch. */
  prdId: string;
  /** The PRD title, when available from the queue item. */
  prdTitle?: string;
  /** Numeric dispatch priority, if set in queue frontmatter. */
  priority?: number;
  /** Current PRD frontmatter profile, before profile routers run. */
  profile?: string;
  /** IDs of PRDs this item depends on. */
  dependsOn: string[];
}

/**
 * Context passed to `beforePlanMerge` policy-gate handlers.
 */
export interface PlanMergePolicyGateContext extends EforgeExtensionContext {
  /** Identifies this policy gate invocation point. */
  gateKind: 'plan-merge';
  /** The plan ID for the operation being gated. */
  planId: string;
  /** Summary of file-level changes included in the merge. */
  diff: ExtensionDiff;
}

/**
 * Backward-compatible alias for the original plan-merge policy-gate context.
 */
export type PolicyGateContext = PlanMergePolicyGateContext;

/**
 * Context passed to `beforeFinalMerge` policy-gate handlers.
 */
export interface FinalMergePolicyGateContext extends EforgeExtensionContext {
  /** Identifies this policy gate invocation point. */
  gateKind: 'final-merge';
  /** Feature branch being merged into the base branch. */
  featureBranch: string;
  /** Base branch receiving the final merge. */
  baseBranch: string;
  /** Plan IDs included in the final merge, when known. */
  planIds?: string[];
  /** Summary of file-level changes included in the final merge. */
  diff: ExtensionDiff;
}

/** Union of all policy-gate contexts. */
export type AnyPolicyGateContext =
  | QueueDispatchPolicyGateContext
  | PlanMergePolicyGateContext
  | FinalMergePolicyGateContext;

// ---------------------------------------------------------------------------
// Profile router context types
// ---------------------------------------------------------------------------

/**
 * Summary of a single profile available for selection by a profile router.
 *
 * All fields are read-only. The `toolbeltHint` field is advisory only —
 * do not use it to infer or override actual tool availability.
 */
export interface ProfileSummary {
  /** Profile name as declared in `eforge/config.yaml`. */
  name: string;
  /** The scope this profile belongs to (e.g. `'project-local'`, `'user'`). */
  scope: string;
  /** The agent harness backend this profile targets. */
  harness: 'claude-sdk' | 'pi' | string;
  /** Optional human-readable description of the profile's purpose. */
  description?: string;
  /** Optional guidance on when to prefer this profile. */
  whenToUse?: string;
  /** Optional free-form tags for categorization. */
  tags?: string[];
  /** Advisory hint about the toolbelt associated with this profile. Do not use to infer tool availability. */
  toolbeltHint?: string;
}

/**
 * Best-effort usage summary for a single profile.
 *
 * All numeric fields are optional and may be absent when the daemon has not
 * yet recorded data for this profile. `dataSource` indicates whether any
 * event history was used; `'none'` means the router has no usage data to act on.
 *
 * This contract does not imply exact provider quota limits.
 */
export interface ProfileUsageSummary {
  /** ISO 8601 timestamp of the most recent build using this profile. */
  lastUsedAt?: string;
  /** Number of build runs using this profile in a recent window. */
  recentRunCount?: number;
  /** Approximate token usage in a recent window. */
  recentTokens?: {
    input?: number;
    output?: number;
    total?: number;
  };
  /** Approximate cost (USD) accumulated in a recent window. */
  recentCostUsd?: number;
  /** Number of quota errors encountered in a recent window. */
  recentQuotaErrors?: number;
  /** Whether a cooldown is currently active for this profile. */
  cooldownActive?: boolean;
  /** ISO 8601 timestamp when the cooldown expires, if active. */
  cooldownUntil?: string;
  /** Whether this profile is approaching its usage limit. */
  nearLimit?: boolean;
  /**
   * Indicates the source of the usage data.
   *
   * - `'event-history'` - populated from recorded daemon event history.
   * - `'none'` - no provider is wired; all other fields will be absent.
   */
  dataSource: 'event-history' | 'none';
}

/**
 * Context passed to profile router handlers registered via `registerProfileRouter`.
 *
 * All fields are read-only. Do not mutate any field — the engine owns all
 * profile, toolbelt, and MCP state.
 *
 * The `usage` helper returns best-effort data. When no usage provider is
 * configured, `usage.profile(name)` returns `{ dataSource: 'none' }`.
 */
export interface ProfileRouterContext extends EforgeExtensionContext {
  /** The PRD/queue item identifier being dispatched. */
  prdId: string;
  /** The PRD title as declared in the queue file. */
  prdTitle: string;
  /**
   * Full PRD body text, if available and within the size cap (~4KB).
   * Absent when the body is too large; use `prdContentSummary` in that case.
   */
  prdBody?: string;
  /**
   * Truncated PRD body summary (capped to ~4KB) when `prdBody` is absent.
   * At most one of `prdBody` or `prdContentSummary` is populated.
   */
  prdContentSummary?: string;
  /** Numeric dispatch priority, if set in the queue file frontmatter. */
  priority?: number;
  /** IDs of PRDs this item depends on, as declared in the queue file frontmatter. */
  dependsOn: string[];
  /** The profile currently resolved for this build, or `null` if none is set. */
  currentProfile: string | null;
  /**
   * The base profile from the active eforge configuration, or `null` if no
   * default profile is configured.
   */
  baseProfile: string | null;
  /** All profiles available for selection from the active configuration. */
  availableProfiles: ProfileSummary[];
  /**
   * Usage data helper. Returns best-effort usage statistics for the named profile.
   *
   * When no usage provider is wired, returns `{ dataSource: 'none' }` for all names.
   */
  usage: {
    profile(name: string): ProfileUsageSummary;
  };
}
