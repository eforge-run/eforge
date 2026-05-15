/**
 * Core extension API — the `EforgeExtensionAPI` interface and the factory types
 * that define how an extension module's default export is structured.
 *
 * Extension authors write a default-export factory function that receives an
 * `EforgeExtensionAPI` instance and calls registration methods on it:
 *
 * ```ts
 * import type { EforgeExtensionAPI } from '@eforge-build/extension-sdk';
 *
 * export default function myExtension(eforge: EforgeExtensionAPI) {
 *   eforge.onEvent('plan:build:failed', async (event, ctx) => {
 *     ctx.logger.warn(`Plan failed: ${event.planId}`);
 *   });
 * }
 * ```
 *
 * The `defineEforgeExtension` helper is available for named-export or
 * inference-friendly usage.
 */

import type { EforgeEvent } from './events.js';
import type { EventHookContext } from './context.js';
import type { EventHookHandler, PolicyGateHandler, AgentRunHandler, ProfileRouterSpec, InputSourceAdapter, ReviewerPerspectiveSpec, ValidationProviderSpec } from './hooks.js';
import type { EventPattern } from './patterns.js';
import type { ExtensionTool } from './tools.js';

/**
 * The API surface passed to an extension factory at load time.
 *
 * All registration methods are typed contracts. Runtime support for each
 * method is noted in `docs/extensions-api.md`.
 */
export interface EforgeExtensionAPI {
  /**
   * Register a typed event hook.
   *
   * The handler is called whenever an event matching `pattern` is emitted by
   * the eforge daemon. Handlers are non-blocking — the return value is awaited
   * opportunistically and must not affect the build pipeline.
   *
   * @param pattern - Glob pattern matching event type strings (e.g. `plan:build:*`).
   * @param handler - Async or sync handler invoked with the matched event and context.
   *
   * @remarks Runtime-supported. Matching events are dispatched to handlers;
   * failures and timeouts emit `extension:event-handler:*` diagnostics.
   *
   * @example
   * ```ts
   * eforge.onEvent('plan:build:failed', async (event, ctx) => {
   *   ctx.logger.warn(`Plan failed: ${event.planId}`);
   * });
   * ```
   */
  // Exact event-type overload — TypeScript infers `TType` from the literal
  // pattern, so the handler's `event` parameter is narrowed to that variant.
  onEvent<TType extends EforgeEvent['type']>(
    pattern: TType,
    handler: EventHookHandler<TType>,
  ): void;
  // Glob pattern overload — patterns containing `*` (or any non-literal event
  // type) receive the full `EforgeEvent` union in the handler.
  onEvent(
    pattern: EventPattern,
    handler: (event: EforgeEvent, ctx: EventHookContext) => void | Promise<void>,
  ): void;

  /**
   * Register an agent-run hook invoked before each agent run starts.
   *
   * The handler receives an `AgentRunContext` describing the role, tier,
   * profile, phase, and stage of the run, and may return an
   * `AgentRunAugmentation` to contribute additional prompt context.
   *
   * Prompt fragments returned via `promptAppend` are appended after any
   * config-level `promptAppend` already resolved by the engine, wrapped in a
   * named provenance section:
   *
   * ```
   * ## Native extension context
   *
   * ### <extension-name>
   * <fragment>
   * ```
   *
   * Multiple registered handlers are invoked sequentially in registration order.
   * Each runs with a per-handler timeout (configurable via
   * `extensions.agentContextHookTimeoutMs`; defaults to
   * `extensions.eventHookTimeoutMs`). A handler that throws or times out emits
   * a typed diagnostic event (`extension:agent-context:failed` or
   * `extension:agent-context:timeout`) and does not prevent the agent run from
   * proceeding with the unmodified prompt.
   *
   * @remarks Runtime-supported for `promptAppend` (EXTEND_08A). Tool fields
   * (`tools`, `allowedTools`, `disallowedTools`) are not applied at runtime in
   * this slice — returning them emits an `extension:agent-context:unsupported`
   * diagnostic and those fields are otherwise ignored. Tool injection is tracked
   * for EXTEND_08B.
   *
   * @example
   * ```ts
   * eforge.onAgentRun(async (ctx) => {
   *   if (ctx.role !== 'builder') return;
   *   return {
   *     promptAppend: 'Check the design system before modifying UI components.',
   *   };
   * });
   * ```
   */
  onAgentRun(handler: AgentRunHandler): void;

  /**
   * Register a policy gate evaluated before a plan's changes are merged into
   * the main branch.
   *
   * Return `{ decision: 'allow' }` to permit the merge, `{ decision: 'block', reason }` to
   * halt it, or `{ decision: 'require-approval', reason }` to pause for manual approval.
   *
   * @remarks Runtime not yet wired. Typed contract only in this slice.
   *
   * @example
   * ```ts
   * eforge.beforePlanMerge(async (ctx) => {
   *   const hasDangerousFiles = ctx.diff.files.some(f => f.path.startsWith('infra/'));
   *   return hasDangerousFiles
   *     ? { decision: 'require-approval', reason: 'Changes touch infra/ — manual review required' }
   *     : { decision: 'allow' };
   * });
   * ```
   */
  beforePlanMerge(handler: PolicyGateHandler): void;

  /**
   * Register a profile router that dynamically resolves which profile to use
   * for a given agent run.
   *
   * @remarks Runtime not yet wired. Typed contract only in this slice.
   */
  registerProfileRouter(spec: ProfileRouterSpec): void;

  /**
   * Register a custom input source adapter that fetches build input artifacts
   * from an external system (e.g. an issue tracker or internal wiki).
   *
   * @remarks Runtime not yet wired. Typed contract only in this slice.
   */
  registerInputSource(adapter: InputSourceAdapter): void;

  /**
   * Register an additional reviewer perspective contributed to the post-build
   * review stage.
   *
   * @remarks Runtime not yet wired. Typed contract only in this slice.
   */
  registerReviewerPerspective(spec: ReviewerPerspectiveSpec): void;

  /**
   * Register a custom validation provider that runs after the build stage
   * completes, before review.
   *
   * @remarks Runtime not yet wired. Typed contract only in this slice.
   */
  registerValidationProvider(spec: ValidationProviderSpec): void;

  // --- eforge:region plan-01-extension-runtime-foundation ---
  /**
   * Register a custom agent tool contributed by this extension.
   *
   * @remarks Runtime capture only in this slice; agent injection is not yet wired.
   */
  registerTool(tool: ExtensionTool): void;
  // --- eforge:endregion plan-01-extension-runtime-foundation ---
}

/**
 * The type of a default-export extension factory function.
 *
 * An extension module must export a function matching this signature as its
 * default export. The runtime loader will call it once at extension load time,
 * passing a live `EforgeExtensionAPI` instance.
 */
export type EforgeExtensionFactory = (api: EforgeExtensionAPI) => void | Promise<void>;

/**
 * Identity helper for defining an extension factory with correct type inference.
 *
 * Wrap your factory with `defineEforgeExtension` to get parameter inference
 * and IDE autocomplete on the `EforgeExtensionAPI` argument without needing
 * an explicit type annotation.
 *
 * @example
 * ```ts
 * import { defineEforgeExtension } from '@eforge-build/extension-sdk';
 *
 * export default defineEforgeExtension((eforge) => {
 *   eforge.onEvent('plan:build:failed', async (event, ctx) => {
 *     ctx.logger.warn(`Plan failed: ${event.planId}`);
 *   });
 * });
 * ```
 */
export function defineEforgeExtension(factory: EforgeExtensionFactory): EforgeExtensionFactory {
  return factory;
}
