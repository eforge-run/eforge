/**
 * Agent-context runtime — executes captured `agentRunHooks` with timeout/fail-open,
 * composes prompt fragments with provenance, and emits typed diagnostic events.
 *
 * This module is the EXTEND_08A runtime layer for prompt-context extension.
 * Tool fields (tools, allowedTools, disallowedTools) are not applied in this
 * slice; returning them emits an `extension:agent-context:unsupported` diagnostic.
 */

import { execFile } from 'node:child_process';
import type { EforgeEvent, AgentRole } from '../events.js';
import type { AgentHarness, AgentRunOptions } from '../harness.js';
import type { AgentRuntimeRegistry } from '../agent-runtime-registry.js';
import type { AgentRunRegistration, NativeExtensionRegistry } from './types.js';

// ---------------------------------------------------------------------------
// Local SDK-mirror types (avoid importing from @eforge-build/extension-sdk to
// prevent rootDir violations in the engine's per-package tsconfig)
// ---------------------------------------------------------------------------

/** Mirror of AgentRunAugmentation from @eforge-build/extension-sdk */
interface AgentRunAugmentation {
  promptAppend?: string;
  tools?: unknown[];
  allowedTools?: string[];
  disallowedTools?: string[];
}

/** Mirror of AgentRunContext from @eforge-build/extension-sdk */
interface AgentRunContext {
  role: string;
  tier?: string;
  profile: string;
  planId?: string;
  phase?: string;
  stage?: string;
  harness?: 'claude-sdk' | 'pi';
  toolbelt?: string | null;
  toolbeltSource?: 'tier' | 'role' | 'plan' | 'default';
  projectMcpSelection?: 'all' | 'none' | 'toolbelt';
  logger: {
    debug(msg: string): void;
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
  exec: {
    run(
      command: string,
      args?: string[],
      options?: { cwd?: string; env?: Record<string, string> },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
}

/** Mirror of AgentRunHandler from @eforge-build/extension-sdk */
type AgentRunHandler = (
  ctx: AgentRunContext,
) => AgentRunAugmentation | undefined | void | Promise<AgentRunAugmentation | undefined | void>;

// ---------------------------------------------------------------------------
// Runtime options
// ---------------------------------------------------------------------------

export interface AgentContextHookRuntimeOptions {
  /** Registry providing the agentRunHooks to execute. */
  extensionRegistry: Pick<NativeExtensionRegistry, 'agentRunHooks'>;
  /** Active profile name resolved for this engine instance. */
  profileName: string;
  /** Working directory (used for exec API). */
  cwd: string;
  /**
   * Timeout in milliseconds for each hook handler.
   * Defaults to `extensions.eventHookTimeoutMs` when not specified.
   */
  timeoutMs: number;
}

// ---------------------------------------------------------------------------
// Internal diagnostic event helpers
// ---------------------------------------------------------------------------

type AgentContextDiagnosticEvent = Extract<
  EforgeEvent,
  {
    type:
      | 'extension:agent-context:applied'
      | 'extension:agent-context:failed'
      | 'extension:agent-context:timeout'
      | 'extension:agent-context:unsupported';
  }
>;

/** Minimal correlation fields shared by all agent-context diagnostic events. */
interface CorrelationFields {
  extensionName: string;
  extensionPath: string;
  role: string;
  tier?: string;
  phase?: string;
  stage?: string;
  profile: string;
  planId?: string;
  harness?: string;
  toolbelt?: string | null;
  projectMcpSelection?: string;
}

function makeCorrelationFields(
  registration: AgentRunRegistration,
  options: AgentRunOptions,
  agent: AgentRole,
  planId: string | undefined,
  profileName: string,
): CorrelationFields {
  return {
    extensionName: registration.extensionName,
    extensionPath: registration.extensionPath,
    role: agent,
    ...(options.tier !== undefined && { tier: options.tier }),
    ...(options.phase !== undefined && { phase: options.phase }),
    ...(options.stage !== undefined && { stage: options.stage }),
    profile: profileName,
    ...(planId !== undefined && { planId }),
    ...(options.harness !== undefined && { harness: options.harness }),
    ...('toolbelt' in options && options.toolbelt !== undefined && { toolbelt: options.toolbelt as string | null }),
    ...(options.projectMcpSelection !== undefined && { projectMcpSelection: options.projectMcpSelection }),
  };
}

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

// ---------------------------------------------------------------------------
// AgentRunContext builder
// ---------------------------------------------------------------------------

function buildAgentRunContext(
  registration: AgentRunRegistration,
  options: AgentRunOptions,
  agent: AgentRole,
  planId: string | undefined,
  profileName: string,
  cwd: string,
): AgentRunContext {
  const prefix = `[eforge ext:${registration.extensionName} role:${agent}]`;
  const logger = {
    debug: (msg: string) => process.stderr.write(`${prefix} debug: ${msg}\n`),
    info: (msg: string) => process.stderr.write(`${prefix} info: ${msg}\n`),
    warn: (msg: string) => process.stderr.write(`${prefix} warn: ${msg}\n`),
    error: (msg: string) => process.stderr.write(`${prefix} error: ${msg}\n`),
  };

  const exec = {
    run: async (
      command: string,
      args: string[] = [],
      execOptions?: { cwd?: string; env?: Record<string, string> },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      return new Promise((resolve) => {
        execFile(
          command,
          args,
          {
            cwd: execOptions?.cwd ?? cwd,
            env: execOptions?.env ? { ...process.env, ...execOptions.env } : process.env,
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

  return {
    role: agent,
    ...(options.tier !== undefined && { tier: options.tier }),
    profile: profileName,
    ...(planId !== undefined && { planId }),
    ...(options.phase !== undefined && { phase: options.phase }),
    ...(options.stage !== undefined && { stage: options.stage }),
    ...(options.harness !== undefined && { harness: options.harness }),
    ...(options.toolbelt !== undefined && { toolbelt: options.toolbelt }),
    ...(options.toolbeltSource !== undefined && { toolbeltSource: options.toolbeltSource }),
    ...(options.projectMcpSelection !== undefined && { projectMcpSelection: options.projectMcpSelection }),
    logger,
    exec,
  };
}

// ---------------------------------------------------------------------------
// Single-hook executor (with timeout/fail-open)
// ---------------------------------------------------------------------------

interface HookExecutionResult {
  promptAppend?: string;
  unsupportedFields?: Array<'tools' | 'allowedTools' | 'disallowedTools'>;
  diagnostic?: AgentContextDiagnosticEvent;
}

function executeHookWithTimeout(
  registration: AgentRunRegistration,
  ctx: AgentRunContext,
  timeoutMs: number,
): Promise<HookExecutionResult> {
  // NOTE: The AgentRunContext does not currently expose an AbortSignal to
  // handlers, so a setTimeout race is the only mechanism to enforce timeouts.
  // If/when `ctx.signal` is added to the SDK contract, wire an
  // AbortController here so handler-internal exec/fetch can observe abort.
  const handler = registration.value as unknown as AgentRunHandler;
  let timedOut = false;

  const handlerPromise = Promise.resolve()
    .then(() => handler(ctx))
    .then(
      (augmentation): HookExecutionResult => {
        if (!augmentation) return {};
        const aug = augmentation as AgentRunAugmentation;
        const unsupported: Array<'tools' | 'allowedTools' | 'disallowedTools'> = [];
        if (Array.isArray(aug.tools) && aug.tools.length > 0) unsupported.push('tools');
        if (Array.isArray(aug.allowedTools) && aug.allowedTools.length > 0) unsupported.push('allowedTools');
        if (Array.isArray(aug.disallowedTools) && aug.disallowedTools.length > 0) unsupported.push('disallowedTools');
        return {
          promptAppend: aug.promptAppend,
          ...(unsupported.length > 0 && { unsupportedFields: unsupported }),
        };
      },
      (error): HookExecutionResult => {
        if (timedOut) return {};
        return {
          diagnostic: {
            type: 'extension:agent-context:failed',
            timestamp: new Date().toISOString(),
            extensionName: registration.extensionName,
            extensionPath: registration.extensionPath,
            role: ctx.role,
            ...(ctx.tier !== undefined && { tier: ctx.tier }),
            ...(ctx.phase !== undefined && { phase: ctx.phase }),
            ...(ctx.stage !== undefined && { stage: ctx.stage }),
            profile: ctx.profile,
            ...(ctx.planId !== undefined && { planId: ctx.planId }),
            ...(ctx.harness !== undefined && { harness: ctx.harness }),
            ...(ctx.toolbelt !== undefined && { toolbelt: ctx.toolbelt }),
            ...(ctx.projectMcpSelection !== undefined && { projectMcpSelection: ctx.projectMcpSelection }),
            message: errorMessage(error),
            ...(errorStack(error) && { stack: errorStack(error) }),
          } as AgentContextDiagnosticEvent,
        };
      },
    );

  // Ensure late rejections after timeout don't become unhandled rejections.
  handlerPromise.catch(() => undefined);

  return new Promise<HookExecutionResult>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      resolve({
        diagnostic: {
          type: 'extension:agent-context:timeout',
          timestamp: new Date().toISOString(),
          extensionName: registration.extensionName,
          extensionPath: registration.extensionPath,
          role: ctx.role,
          ...(ctx.tier !== undefined && { tier: ctx.tier }),
          ...(ctx.phase !== undefined && { phase: ctx.phase }),
          ...(ctx.stage !== undefined && { stage: ctx.stage }),
          profile: ctx.profile,
          ...(ctx.planId !== undefined && { planId: ctx.planId }),
          ...(ctx.harness !== undefined && { harness: ctx.harness }),
          ...(ctx.toolbelt !== undefined && { toolbelt: ctx.toolbelt }),
          ...(ctx.projectMcpSelection !== undefined && { projectMcpSelection: ctx.projectMcpSelection }),
          timeoutMs,
        } as AgentContextDiagnosticEvent,
      });
    }, timeoutMs);
    timer.unref();

    handlerPromise.then((result) => {
      if (timedOut) return;
      clearTimeout(timer);
      resolve(result);
    });
  });
}

// ---------------------------------------------------------------------------
// Core execution: executeAgentRunHooks
// ---------------------------------------------------------------------------

export interface AgentRunHooksExecutionResult {
  /** The final prompt (original + extension provenance section if any). */
  finalPrompt: string;
  /** Diagnostic events to yield before delegating to the inner harness. */
  diagnostics: AgentContextDiagnosticEvent[];
}

/**
 * Execute all registered `agentRunHooks` for a given agent run.
 *
 * - Invokes each handler sequentially with a per-hook timeout.
 * - Composes returned `promptAppend` fragments into a provenance section.
 * - Returns the augmented prompt and any diagnostic events.
 * - Fails open: a failing or timed-out hook never aborts the agent run.
 *
 * Exported for unit testing.
 */
export async function executeAgentRunHooks(
  hooks: AgentRunRegistration[],
  options: AgentRunOptions,
  agent: AgentRole,
  planId: string | undefined,
  runtimeOptions: {
    profileName: string;
    cwd: string;
    timeoutMs: number;
  },
): Promise<AgentRunHooksExecutionResult> {
  if (hooks.length === 0) {
    return { finalPrompt: options.prompt, diagnostics: [] };
  }

  const diagnostics: AgentContextDiagnosticEvent[] = [];
  const fragments: Array<{ registration: AgentRunRegistration; text: string }> = [];

  for (const registration of hooks) {
    const ctx = buildAgentRunContext(
      registration,
      options,
      agent,
      planId,
      runtimeOptions.profileName,
      runtimeOptions.cwd,
    );

    const result = await executeHookWithTimeout(registration, ctx, runtimeOptions.timeoutMs);

    // Emit unsupported-field diagnostic if the handler returned tool fields
    if (result.unsupportedFields && result.unsupportedFields.length > 0) {
      const correlation = makeCorrelationFields(registration, options, agent, planId, runtimeOptions.profileName);
      diagnostics.push({
        type: 'extension:agent-context:unsupported',
        timestamp: new Date().toISOString(),
        ...correlation,
        fields: result.unsupportedFields,
      } as AgentContextDiagnosticEvent);
    }

    // Add failure/timeout diagnostic
    if (result.diagnostic) {
      diagnostics.push(result.diagnostic);
      // Fail open: continue with no prompt change
      continue;
    }

    // Collect promptAppend fragment
    if (result.promptAppend) {
      fragments.push({ registration, text: result.promptAppend });
    }
  }

  // Build the provenance section and append to original prompt
  let finalPrompt = options.prompt;
  if (fragments.length > 0) {
    let provenanceSection = '\n\n## Native extension context\n';
    for (const { registration, text } of fragments) {
      provenanceSection += `\n### ${registration.extensionName}\n${text}\n`;
    }
    finalPrompt = options.prompt + provenanceSection;

    // Emit one applied event per extension that contributed a fragment.
    // `promptCharCount` reports THIS extension's fragment length (matches the
    // event-registry summary "Extension X appended N chars"), not the total
    // augmented prompt length. `fragmentCount` is the total fragments applied
    // to this run, identical across all `:applied` events for one run.
    for (const { registration, text } of fragments) {
      const correlation = makeCorrelationFields(registration, options, agent, planId, runtimeOptions.profileName);
      diagnostics.push({
        type: 'extension:agent-context:applied',
        timestamp: new Date().toISOString(),
        ...correlation,
        promptCharCount: text.length,
        fragmentCount: fragments.length,
      } as AgentContextDiagnosticEvent);
    }
  }

  return { finalPrompt, diagnostics };
}

// ---------------------------------------------------------------------------
// Registry decorator: withAgentContextHooks
// ---------------------------------------------------------------------------

/**
 * Wrap an `AgentRuntimeRegistry` so every harness returned by `forRole` /
 * `forRoleResolved` executes the registered `agentRunHooks` before delegating
 * to the inner harness's `run()` method.
 *
 * Extension fragments are appended AFTER the resolved `promptAppend` already
 * consumed by `loadPrompt(name, vars, options.promptAppend)`.
 *
 * @param registry - The registry to wrap.
 * @param runtimeOptions - Extension registry, profile, cwd, and timeout.
 */
export function withAgentContextHooks(
  registry: AgentRuntimeRegistry,
  runtimeOptions: AgentContextHookRuntimeOptions,
): AgentRuntimeRegistry {
  const hooks = runtimeOptions.extensionRegistry.agentRunHooks;

  // Fast path: if no hooks are registered, return the original registry unchanged.
  if (hooks.length === 0) {
    return registry;
  }

  function wrapHarness(innerHarness: AgentHarness): AgentHarness {
    return {
      effectiveCustomToolName(name: string): string {
        return innerHarness.effectiveCustomToolName(name);
      },

      async *run(options: AgentRunOptions, agent: AgentRole, planId?: string): AsyncGenerator<EforgeEvent> {
        // Execute all hooks and collect diagnostics + augmented prompt
        const { finalPrompt, diagnostics } = await executeAgentRunHooks(
          hooks,
          options,
          agent,
          planId,
          {
            profileName: runtimeOptions.profileName,
            cwd: runtimeOptions.cwd,
            timeoutMs: runtimeOptions.timeoutMs,
          },
        );

        // Yield diagnostics before any harness events
        for (const diagnostic of diagnostics) {
          yield diagnostic;
        }

        // Delegate to inner harness with (possibly augmented) prompt
        const augmentedOptions: AgentRunOptions =
          finalPrompt !== options.prompt
            ? { ...options, prompt: finalPrompt }
            : options;

        yield* innerHarness.run(augmentedOptions, agent, planId);
      },
    };
  }

  return {
    forRole(role, planEntry) {
      return wrapHarness(registry.forRole(role, planEntry));
    },
    forRoleResolved(role, planEntry) {
      const { harness, toolbeltSummary } = registry.forRoleResolved(role, planEntry);
      return { harness: wrapHarness(harness), toolbeltSummary };
    },
  };
}
