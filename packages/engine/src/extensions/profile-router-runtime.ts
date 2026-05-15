/**
 * Profile router runtime — executes registered profile routers sequentially
 * with timeout/fail-open semantics before each queued PRD build.
 *
 * This module is the EXTEND_09 pre-build dispatch layer. It mirrors the
 * timeout/fail-open patterns established in event-runtime.ts and
 * agent-context-runtime.ts.
 *
 * Key behaviors:
 * - Routers are invoked in registration order.
 * - A `null`/`undefined` result defers to the next router.
 * - A throw emits `queue:profile:router-failed` and continues (fail-open).
 * - A timeout emits `queue:profile:router-timeout` and continues (fail-open).
 * - A result whose `profile` fails `loadProfile` emits
 *   `queue:profile:invalid-selection` and continues.
 * - The first valid router result wins.
 * - If no router yields a valid selection, `selection` is `null` and the
 *   build proceeds under the default profile (existing behavior).
 */

import { execFile } from 'node:child_process';
import type { EforgeEvent } from '../events.js';
import type { EforgeConfig } from '../config.js';
import type { QueuedPrd } from '../prd-queue.js';
import type { ProfileRouterRegistration, NativeExtensionRegistry } from './types.js';
import type { ProfileUsageProvider, ProfileUsageSummary } from '../profile-usage.js';

// ---------------------------------------------------------------------------
// Local SDK-mirror types (avoid importing from @eforge-build/extension-sdk to
// prevent rootDir violations in the engine's per-package tsconfig)
// ---------------------------------------------------------------------------

interface ProfileRouterResult {
  profile: string;
  reason?: string;
  confidence?: 'low' | 'medium' | 'high';
}

interface ProfileSummaryMirror {
  name: string;
  scope: string;
  harness: 'claude-sdk' | 'pi' | string;
  description?: string;
  whenToUse?: string;
  tags?: string[];
}

interface ProfileRouterContextMirror {
  prdId: string;
  prdTitle: string;
  prdBody?: string;
  prdContentSummary?: string;
  priority?: number;
  dependsOn: string[];
  currentProfile: string | null;
  baseProfile: string | null;
  availableProfiles: ProfileSummaryMirror[];
  usage: {
    profile(name: string): ProfileUsageSummary;
  };
  logger: {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  exec: {
    run(
      command: string,
      args?: string[],
      options?: { cwd?: string; env?: Record<string, string> },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
}

// ---------------------------------------------------------------------------
// PRD body cap
// ---------------------------------------------------------------------------

/** Default cap for PRD body content passed to routers (in characters). */
const DEFAULT_PRD_BODY_CAP_CHARS = 4096;
/** Size of the `prdContentSummary` summary snippet (first ~600 chars). */
const PRD_CONTENT_SUMMARY_CHARS = 600;

// ---------------------------------------------------------------------------
// Router execution result
// ---------------------------------------------------------------------------

export interface RouterSelection {
  profile: string;
  routerName: string;
  extensionName: string;
  extensionPath: string;
  reason?: string;
  confidence?: 'low' | 'medium' | 'high';
}

export interface ProfileRouterExecutionResult {
  /** The winning router's selection, or `null` if no router produced a valid result. */
  selection: RouterSelection | null;
  /** Diagnostic events to emit (router-failed, router-timeout, invalid-selection). */
  diagnostics: EforgeEvent[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

function createLogger(extensionName: string, routerName: string) {
  const prefix = `[eforge ext:${extensionName} router:${routerName}]`;
  return {
    debug: (msg: string) => process.stderr.write(`${prefix} debug: ${msg}\n`),
    info: (msg: string) => process.stderr.write(`${prefix} info: ${msg}\n`),
    warn: (msg: string) => process.stderr.write(`${prefix} warn: ${msg}\n`),
    error: (msg: string) => process.stderr.write(`${prefix} error: ${msg}\n`),
  };
}

function createExec(cwd: string) {
  return {
    run: async (
      command: string,
      args: string[] = [],
      options?: { cwd?: string; env?: Record<string, string> },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      return new Promise((resolve) => {
        execFile(
          command,
          args,
          {
            cwd: options?.cwd ?? cwd,
            env: options?.env ? { ...process.env, ...options.env } : process.env,
          },
          (error, stdout, stderr) => {
            if (error) {
              resolve({ stdout: stdout || '', stderr: stderr || error.message, exitCode: 1 });
            } else {
              resolve({ stdout: stdout || '', stderr: stderr || '', exitCode: 0 });
            }
          },
        );
      });
    },
  };
}

/**
 * Execute a single router with timeout/fail-open semantics.
 *
 * @returns The router's result (may be null/undefined), or throws if timed out or errored.
 * The caller handles the error categorization.
 */
function executeRouterWithTimeout(
  registration: ProfileRouterRegistration,
  ctx: ProfileRouterContextMirror,
  timeoutMs: number,
): Promise<{ result: ProfileRouterResult | null | undefined } | { timedOut: true } | { error: unknown }> {
  const spec = registration.value;

  // Prefer selectBuildProfile; fall back to deprecated resolve if it is the
  // only callable available.
  const callable = typeof spec.selectBuildProfile === 'function'
    ? (spec.selectBuildProfile as (ctx: ProfileRouterContextMirror) => unknown)
    : typeof spec.resolve === 'function'
      ? (spec.resolve as (ctx: ProfileRouterContextMirror) => unknown)
      : null;

  if (!callable) {
    return Promise.resolve({ result: null });
  }

  let timedOut = false;

  const handlerPromise = Promise.resolve()
    .then(() => callable(ctx))
    .then(
      (result): { result: ProfileRouterResult | null | undefined } | { timedOut: true } | { error: unknown } => {
        if (timedOut) return { timedOut: true };
        return { result: result as ProfileRouterResult | null | undefined };
      },
      (error): { result: ProfileRouterResult | null | undefined } | { timedOut: true } | { error: unknown } => {
        if (timedOut) return { timedOut: true };
        return { error };
      },
    );

  // Ensure a late rejection never becomes an unhandled rejection.
  handlerPromise.catch(() => undefined);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      resolve({ timedOut: true });
    }, timeoutMs);
    timer.unref();

    handlerPromise.then((r) => {
      if (timedOut) return;
      clearTimeout(timer);
      resolve(r);
    });
  });
}

// ---------------------------------------------------------------------------
// buildProfileRouterContext
// ---------------------------------------------------------------------------

export interface BuildProfileRouterContextDeps {
  /** Profile name currently active for this engine session. */
  configProfileName: string | null;
  /** Usage provider — returns { dataSource: 'none' } when not wired. */
  profileUsageProvider?: ProfileUsageProvider | null;
  /** List of all available profiles in scope. */
  availableProfiles: ProfileSummaryMirror[];
  /** Working directory for exec API. */
  cwd: string;
  /** Max chars for prdBody before capping to prdContentSummary. */
  prdBodyCapChars?: number;
}

/**
 * Build the `ProfileRouterContext` passed to each router handler.
 *
 * - `prdBody` is capped at `prdBodyCapChars` (default 4096) to bound memory.
 * - `prdContentSummary` is always the first ~600 chars regardless of cap.
 * - At most one of `prdBody` or `prdContentSummary` is populated.
 * - `usage.profile(name)` returns `{ dataSource: 'none' }` when the provider is absent.
 */
export function buildProfileRouterContext(
  prd: QueuedPrd,
  deps: BuildProfileRouterContextDeps,
  extensionName: string,
  routerName: string,
): ProfileRouterContextMirror {
  const capChars = deps.prdBodyCapChars ?? DEFAULT_PRD_BODY_CAP_CHARS;

  // Extract body text (strip frontmatter delimiter block)
  const bodyMatch = prd.content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  const rawBody = bodyMatch ? bodyMatch[1] : prd.content;
  const trimmedBody = rawBody.trim();

  let prdBody: string | undefined;
  let prdContentSummary: string | undefined;

  if (trimmedBody.length <= capChars) {
    prdBody = trimmedBody;
  } else {
    prdContentSummary = trimmedBody.slice(0, PRD_CONTENT_SUMMARY_CHARS);
  }

  const provider = deps.profileUsageProvider ?? null;

  return {
    prdId: prd.id,
    prdTitle: prd.frontmatter.title,
    ...(prdBody !== undefined ? { prdBody } : {}),
    ...(prdContentSummary !== undefined ? { prdContentSummary } : {}),
    priority: prd.frontmatter.priority,
    dependsOn: prd.frontmatter.depends_on ?? [],
    currentProfile: deps.configProfileName,
    baseProfile: deps.configProfileName,
    availableProfiles: deps.availableProfiles,
    usage: {
      profile(name: string): ProfileUsageSummary {
        if (!provider) return { dataSource: 'none' };
        const summary = provider.getUsageSummary(name);
        if (summary === null) return { dataSource: 'none' };
        return summary;
      },
    },
    logger: createLogger(extensionName, routerName),
    exec: createExec(deps.cwd),
  };
}

// ---------------------------------------------------------------------------
// executeProfileRouters
// ---------------------------------------------------------------------------

export interface ExecuteProfileRoutersOptions {
  /** PRD session id for diagnostic event correlation. */
  prdSessionId?: string;
  /** Config directory used to validate returned profile names. */
  configDir: string;
  /** Working directory. */
  cwd: string;
  /** Resolved engine config (used for timeouts and available profiles). */
  config: EforgeConfig;
  /** Optional usage provider. */
  profileUsageProvider?: ProfileUsageProvider | null;
  /** Active config profile name. */
  configProfileName: string | null;
  /** Pre-built list of available profiles (or `null` to build lazily). */
  availableProfiles?: ProfileSummaryMirror[] | null;
}

/**
 * Execute all registered profile routers sequentially for a single PRD.
 *
 * Routers are invoked in registration order. The first router that returns a
 * valid, loadable profile name wins. Failures and timeouts emit diagnostics
 * but do not abort subsequent routers or the build (fail-open).
 *
 * Returns `{ selection: null, diagnostics: [] }` when no router is registered
 * or none yields a valid selection.
 */
export async function executeProfileRouters(
  registry: Pick<NativeExtensionRegistry, 'profileRouters'>,
  prd: QueuedPrd,
  opts: ExecuteProfileRoutersOptions,
): Promise<ProfileRouterExecutionResult> {
  const routers = registry.profileRouters;
  if (routers.length === 0) {
    return { selection: null, diagnostics: [] };
  }

  const timeoutMs = opts.config.extensions.profileRouterTimeoutMs
    ?? opts.config.extensions.eventHookTimeoutMs;

  // Load available profiles (lazily built once per PRD dispatch)
  let availableProfiles = opts.availableProfiles ?? null;
  if (!availableProfiles) {
    try {
      const { listProfiles } = await import('../config.js');
      const profileList = await listProfiles(opts.configDir, opts.cwd);
      availableProfiles = profileList
        .filter((p) => !p.shadowedBy) // exclude shadowed profiles from router view
        .map((p) => ({
          name: p.name,
          scope: p.scope,
          harness: p.harness ?? 'claude-sdk',
          description: p.metadata?.description,
          whenToUse: p.metadata?.whenToUse?.join(', '),
          tags: p.metadata?.tags,
        }));
    } catch {
      availableProfiles = [];
    }
  }

  const diagnostics: EforgeEvent[] = [];
  let selection: RouterSelection | null = null;

  for (const registration of routers) {
    const routerName = registration.name;
    const extensionName = registration.extensionName;
    const extensionPath = registration.extensionPath;

    const ctx = buildProfileRouterContext(
      prd,
      {
        configProfileName: opts.configProfileName,
        profileUsageProvider: opts.profileUsageProvider,
        availableProfiles,
        cwd: opts.cwd,
      },
      extensionName,
      routerName,
    );

    const outcome = await executeRouterWithTimeout(registration, ctx, timeoutMs);

    if ('timedOut' in outcome) {
      diagnostics.push({
        type: 'queue:profile:router-timeout',
        prdId: prd.id,
        routerName,
        extensionName,
        extensionPath,
        timeoutMs,
        timestamp: new Date().toISOString(),
      } as EforgeEvent);
      continue;
    }

    if ('error' in outcome) {
      const stack = errorStack(outcome.error);
      diagnostics.push({
        type: 'queue:profile:router-failed',
        prdId: prd.id,
        routerName,
        extensionName,
        extensionPath,
        message: errorMessage(outcome.error),
        ...(stack ? { stack } : {}),
        timestamp: new Date().toISOString(),
      } as EforgeEvent);
      continue;
    }

    const result = outcome.result;
    if (result == null) {
      // Deferred — try next router
      continue;
    }

    // Validate the returned profile name
    const profileName = result.profile;
    let profileValid = false;
    let invalidReason: 'not-found' | 'load-error' = 'not-found';
    let invalidMessage = `Profile '${profileName}' not found`;

    try {
      const { loadProfile } = await import('../config.js');
      const loaded = await loadProfile(opts.configDir, profileName, opts.cwd);
      if (loaded) {
        profileValid = true;
      } else {
        invalidReason = 'not-found';
        invalidMessage = `Router returned profile '${profileName}' which was not found in any scope`;
      }
    } catch (e) {
      invalidReason = 'load-error';
      invalidMessage = `Error loading profile '${profileName}': ${errorMessage(e)}`;
    }

    if (!profileValid) {
      diagnostics.push({
        type: 'queue:profile:invalid-selection',
        prdId: prd.id,
        routerName,
        extensionName,
        extensionPath,
        requestedProfile: profileName,
        reason: invalidReason,
        message: invalidMessage,
        timestamp: new Date().toISOString(),
      } as EforgeEvent);
      continue;
    }

    // Valid selection — first-wins
    selection = {
      profile: profileName,
      routerName,
      extensionName,
      extensionPath,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
    };
    break;
  }

  return { selection, diagnostics };
}
