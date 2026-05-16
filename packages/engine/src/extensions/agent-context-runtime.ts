/**
 * Agent-context runtime — executes captured `agentRunHooks` with timeout/fail-open,
 * composes prompt fragments with provenance, applies extension-contributed tools
 * and tool availability, and emits typed diagnostic events.
 *
 * This module is the single runtime application point for native extension
 * agent-run augmentation. Toolbelt filtering remains owned by
 * AgentRuntimeRegistry and applies only to project MCP server maps.
 */

import { execFile } from 'node:child_process';
import type { EforgeEvent, AgentRole } from '../events.js';
import type { AgentHarness, AgentRunOptions, CustomTool } from '../harness.js';
import type { AgentRuntimeRegistry } from '../agent-runtime-registry.js';
import type { AgentRunRegistration, NativeExtensionRegistry, ToolRegistration } from './types.js';
import type { TObject } from '@sinclair/typebox';

// ---------------------------------------------------------------------------
// Local SDK-mirror types (avoid importing from @eforge-build/extension-sdk to
// prevent rootDir violations in the engine's per-package tsconfig)
// ---------------------------------------------------------------------------

interface ExtensionTool {
  name: string;
  description: string;
  inputSchema: TObject;
  handler: (input: unknown) => Promise<string> | string;
}

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
  effectiveToolName(name: string): string;
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
  /** Registry providing the agentRunHooks and registered tool metadata. */
  extensionRegistry: Pick<NativeExtensionRegistry, 'agentRunHooks' | 'tools'>;
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
      | 'extension:agent-context:unsupported'
      | 'extension:agent-tools:applied';
  }
>;

type AgentToolsAppliedEvent = Extract<EforgeEvent, { type: 'extension:agent-tools:applied' }>;

/** Minimal correlation fields shared by agent-context diagnostic events. */
interface CorrelationFields {
  extensionName: string;
  extensionPath: string;
  role: AgentRole;
  tier?: string;
  phase?: string;
  stage?: string;
  profile: string;
  planId?: string;
  harness?: 'claude-sdk' | 'pi';
  toolbelt?: string | null;
  projectMcpSelection?: 'all' | 'none' | 'toolbelt';
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
    ...('toolbelt' in options && options.toolbelt !== undefined && { toolbelt: options.toolbelt }),
    ...(options.projectMcpSelection !== undefined && { projectMcpSelection: options.projectMcpSelection }),
  };
}

function makeToolCorrelationFields(
  registration: AgentRunRegistration,
  options: AgentRunOptions,
  agent: AgentRole,
  planId: string | undefined,
  profileName: string,
): Omit<AgentToolsAppliedEvent, 'type' | 'timestamp' | 'toolNames' | 'effectiveToolNames' | 'registeredToolNames' | 'inlineToolNames' | 'allowedToolsAdded' | 'disallowedToolsAdded' | 'excludedToolNames' | 'toolCount' | 'allowedToolCount' | 'disallowedToolCount' | 'excludedToolCount'> {
  return {
    ...makeCorrelationFields(registration, options, agent, planId, profileName),
    ...(options.projectMcpServerNames !== undefined && { projectMcpServerNames: [...options.projectMcpServerNames] }),
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

function normalizeToolName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function uniqueStrings(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function isObjectRootSchema(value: unknown): value is TObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const schema = value as { type?: unknown; properties?: unknown };
  return (
    schema.type === 'object' &&
    typeof schema.properties === 'object' &&
    schema.properties !== null &&
    !Array.isArray(schema.properties)
  );
}

function isExtensionTool(value: unknown): value is ExtensionTool {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ExtensionTool>;
  return (
    normalizeToolName(candidate.name) !== undefined &&
    typeof candidate.description === 'string' &&
    isObjectRootSchema(candidate.inputSchema) &&
    typeof candidate.handler === 'function'
  );
}

function adaptExtensionTool(tool: ExtensionTool, name: string): CustomTool {
  return {
    name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    handler: async (input: unknown): Promise<string> => {
      const result = await tool.handler(input);
      return typeof result === 'string' ? result : String(result);
    },
  };
}

function registeredToolNamesForExtension(
  tools: ToolRegistration[],
  registration: AgentRunRegistration,
): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    if (tool.extensionName !== registration.extensionName) continue;
    if (tool.extensionPath !== registration.extensionPath) continue;
    const name = normalizeToolName(tool.name) ?? normalizeToolName(tool.value?.name);
    if (name) names.add(name);
  }
  return names;
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
  effectiveCustomToolName: (name: string) => string,
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
    effectiveToolName: effectiveCustomToolName,
    logger,
    exec,
  };
}

// ---------------------------------------------------------------------------
// Single-hook executor (with timeout/fail-open)
// ---------------------------------------------------------------------------

interface HookExecutionResult {
  augmentation?: AgentRunAugmentation;
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
        return { augmentation };
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
  /** Final custom tools when extension tool contributions changed the run. */
  customTools?: CustomTool[];
  /** Final allowlist when extension availability contributions changed the run. */
  allowedTools?: string[];
  /** Final denylist when extension availability contributions changed the run. */
  disallowedTools?: string[];
  /** Diagnostic events to yield before delegating to the inner harness. */
  diagnostics: AgentContextDiagnosticEvent[];
}

interface SuccessfulHookContribution {
  registration: AgentRunRegistration;
  augmentation: AgentRunAugmentation;
}

interface ExtensionToolDecision {
  registration: AgentRunRegistration;
  toolNames: string[];
  effectiveToolNames: string[];
  registeredToolNames: string[];
  inlineToolNames: string[];
  allowedToolsAdded: string[];
  disallowedToolsAdded: string[];
  excludedToolNames: string[];
}

function hasToolFieldContributions(augmentation: AgentRunAugmentation): boolean {
  return (
    (Array.isArray(augmentation.tools) && augmentation.tools.length > 0) ||
    (Array.isArray(augmentation.allowedTools) && augmentation.allowedTools.length > 0) ||
    (Array.isArray(augmentation.disallowedTools) && augmentation.disallowedTools.length > 0)
  );
}

/**
 * Execute all registered `agentRunHooks` for a given agent run.
 *
 * - Invokes each handler sequentially with a per-hook timeout.
 * - Composes returned `promptAppend` fragments into a provenance section.
 * - Applies returned extension tools and tool availability safely.
 * - Returns the augmented prompt/options and any diagnostic events.
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
    effectiveCustomToolName?: (name: string) => string;
    registeredTools?: ToolRegistration[];
  },
): Promise<AgentRunHooksExecutionResult> {
  if (hooks.length === 0) {
    return { finalPrompt: options.prompt, diagnostics: [] };
  }

  const diagnostics: AgentContextDiagnosticEvent[] = [];
  const fragments: Array<{ registration: AgentRunRegistration; text: string }> = [];
  const successfulContributions: SuccessfulHookContribution[] = [];
  const effectiveCustomToolName = runtimeOptions.effectiveCustomToolName ?? ((name: string) => name);
  const registeredTools = runtimeOptions.registeredTools ?? [];

  for (const registration of hooks) {
    const ctx = buildAgentRunContext(
      registration,
      options,
      agent,
      planId,
      runtimeOptions.profileName,
      runtimeOptions.cwd,
      effectiveCustomToolName,
    );

    const result = await executeHookWithTimeout(registration, ctx, runtimeOptions.timeoutMs);

    // Add failure/timeout diagnostic
    if (result.diagnostic) {
      diagnostics.push(result.diagnostic);
      // Fail open: continue with no prompt/tool/availability changes
      continue;
    }

    if (!result.augmentation) continue;

    successfulContributions.push({ registration, augmentation: result.augmentation });

    // Collect promptAppend fragment
    if (result.augmentation.promptAppend) {
      fragments.push({ registration, text: result.augmentation.promptAppend });
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

  const existingCustomTools = options.customTools ?? [];
  const existingBareNames = new Set(existingCustomTools.map(tool => normalizeToolName(tool.name)).filter((name): name is string => name !== undefined));
  const acceptedBareNames = new Set<string>();
  const acceptedExtensionTools: CustomTool[] = [];
  const toolDecisions: ExtensionToolDecision[] = [];

  const allExtensionAllowed = uniqueStrings(successfulContributions.flatMap(({ augmentation }) =>
    Array.isArray(augmentation.allowedTools)
      ? augmentation.allowedTools.map(normalizeToolName).filter((name): name is string => name !== undefined)
      : [],
  ));
  const allExtensionDisallowed = uniqueStrings(successfulContributions.flatMap(({ augmentation }) =>
    Array.isArray(augmentation.disallowedTools)
      ? augmentation.disallowedTools.map(normalizeToolName).filter((name): name is string => name !== undefined)
      : [],
  ));
  const disallowedNameSet = new Set<string>([
    ...(options.disallowedTools ?? []).map(normalizeToolName).filter((name): name is string => name !== undefined),
    ...allExtensionDisallowed,
  ]);

  for (const { registration, augmentation } of successfulContributions) {
    if (!hasToolFieldContributions(augmentation)) continue;

    const registeredNames = registeredToolNamesForExtension(registeredTools, registration);
    const decision: ExtensionToolDecision = {
      registration,
      toolNames: [],
      effectiveToolNames: [],
      registeredToolNames: [],
      inlineToolNames: [],
      allowedToolsAdded: uniqueStrings(
        (augmentation.allowedTools ?? []).map(normalizeToolName).filter((name): name is string => name !== undefined),
      ),
      disallowedToolsAdded: uniqueStrings(
        (augmentation.disallowedTools ?? []).map(normalizeToolName).filter((name): name is string => name !== undefined),
      ),
      excludedToolNames: [],
    };

    for (const returnedTool of augmentation.tools ?? []) {
      const fallbackName = normalizeToolName((returnedTool as { name?: unknown } | null | undefined)?.name) ?? '<invalid>';
      if (!isExtensionTool(returnedTool)) {
        decision.excludedToolNames.push(fallbackName);
        continue;
      }

      const name = normalizeToolName(returnedTool.name)!;
      const effectiveName = effectiveCustomToolName(name);
      if (existingBareNames.has(name) || acceptedBareNames.has(name)) {
        decision.excludedToolNames.push(name);
        continue;
      }
      if (disallowedNameSet.has(name) || disallowedNameSet.has(effectiveName)) {
        decision.excludedToolNames.push(name);
        continue;
      }

      acceptedBareNames.add(name);
      const adaptedTool = adaptExtensionTool(returnedTool, name);
      acceptedExtensionTools.push(adaptedTool);
      decision.toolNames.push(name);
      decision.effectiveToolNames.push(effectiveName);
      if (registeredNames.has(name)) {
        decision.registeredToolNames.push(name);
      } else {
        decision.inlineToolNames.push(name);
      }
    }

    decision.excludedToolNames = uniqueStrings(decision.excludedToolNames);
    toolDecisions.push(decision);
  }

  for (const decision of toolDecisions) {
    const toolCorrelation = makeToolCorrelationFields(
      decision.registration,
      options,
      agent,
      planId,
      runtimeOptions.profileName,
    );
    diagnostics.push({
      type: 'extension:agent-tools:applied',
      timestamp: new Date().toISOString(),
      ...toolCorrelation,
      toolNames: decision.toolNames,
      effectiveToolNames: decision.effectiveToolNames,
      registeredToolNames: decision.registeredToolNames,
      inlineToolNames: decision.inlineToolNames,
      allowedToolsAdded: decision.allowedToolsAdded,
      disallowedToolsAdded: decision.disallowedToolsAdded,
      excludedToolNames: decision.excludedToolNames,
      toolCount: decision.toolNames.length,
      allowedToolCount: decision.allowedToolsAdded.length,
      disallowedToolCount: decision.disallowedToolsAdded.length,
      excludedToolCount: decision.excludedToolNames.length,
    } as AgentContextDiagnosticEvent);
  }

  const result: AgentRunHooksExecutionResult = { finalPrompt, diagnostics };

  if (acceptedExtensionTools.length > 0) {
    result.customTools = [...existingCustomTools, ...acceptedExtensionTools];
  }

  const shouldComputeAllowed = allExtensionAllowed.length > 0 || ((options.allowedTools?.length ?? 0) > 0 && acceptedExtensionTools.length > 0);
  if (shouldComputeAllowed) {
    const engineCustomEffectiveNames = existingCustomTools.map(tool => effectiveCustomToolName(tool.name));
    const extensionCustomEffectiveNames = acceptedExtensionTools.map(tool => effectiveCustomToolName(tool.name));
    result.allowedTools = uniqueStrings([
      ...(options.allowedTools ?? []).map(normalizeToolName).filter((name): name is string => name !== undefined),
      ...allExtensionAllowed,
      ...engineCustomEffectiveNames,
      ...extensionCustomEffectiveNames,
    ]).filter(name => !disallowedNameSet.has(name));
  }

  if (allExtensionDisallowed.length > 0) {
    result.disallowedTools = uniqueStrings([
      ...(options.disallowedTools ?? []).map(normalizeToolName).filter((name): name is string => name !== undefined),
      ...allExtensionDisallowed,
    ]);
  }

  return result;
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
        // Execute all hooks and collect diagnostics + augmented prompt/tools/availability
        const { finalPrompt, customTools, allowedTools, disallowedTools, diagnostics } = await executeAgentRunHooks(
          hooks,
          options,
          agent,
          planId,
          {
            profileName: runtimeOptions.profileName,
            cwd: runtimeOptions.cwd,
            timeoutMs: runtimeOptions.timeoutMs,
            effectiveCustomToolName: (name) => innerHarness.effectiveCustomToolName(name),
            registeredTools: runtimeOptions.extensionRegistry.tools,
          },
        );

        // Yield diagnostics before any harness events
        for (const diagnostic of diagnostics) {
          yield diagnostic;
        }

        const changed =
          finalPrompt !== options.prompt ||
          customTools !== undefined ||
          allowedTools !== undefined ||
          disallowedTools !== undefined;

        // Delegate to inner harness with fresh options when prompt/tools/availability changed.
        const augmentedOptions: AgentRunOptions = changed
          ? {
              ...options,
              ...(finalPrompt !== options.prompt && { prompt: finalPrompt }),
              ...(customTools !== undefined && { customTools }),
              ...(allowedTools !== undefined && { allowedTools }),
              ...(disallowedTools !== undefined && { disallowedTools }),
            }
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
