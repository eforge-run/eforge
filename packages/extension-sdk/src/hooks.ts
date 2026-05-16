/**
 * Hook handler and result types for eforge extensions.
 *
 * These types define the contracts for each registration method on
 * `EforgeExtensionAPI`. Runtime support varies by capability — see
 * `docs/extensions-api.md` for the runtime-support table.
 */

import type { EforgeEvent } from './events.js';
import type {
  EventHookContext,
  AgentRunContext,
  PolicyGateContext,
  QueueDispatchPolicyGateContext,
  PlanMergePolicyGateContext,
  FinalMergePolicyGateContext,
  AnyPolicyGateContext,
  ProfileRouterContext,
} from './context.js';
import type { ExtensionTool } from './tools.js';
import type { TObject } from '@sinclair/typebox';
import type { EventPattern } from './patterns.js';

// ---------------------------------------------------------------------------
// Event hook
// ---------------------------------------------------------------------------

/**
 * Handler for typed event hooks registered via `EforgeExtensionAPI.onEvent`.
 *
 * Event hooks are non-blocking — the return value (`void | Promise<void>`) is
 * awaited opportunistically and must not affect the build pipeline.
 *
 * @typeParam TType - The specific event type string being handled.
 */
export type EventHookHandler<TType extends EforgeEvent['type']> = (
  event: Extract<EforgeEvent, { type: TType }>,
  ctx: EventHookContext,
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Policy gate
// ---------------------------------------------------------------------------

/**
 * Discriminated union representing the outcome of a policy-gate evaluation.
 *
 * - `allow` — permit the operation to proceed.
 * - `block` — halt the operation with a human-readable `reason`.
 * - `require-approval` — halt and surface the `reason` as requiring manual
 *   approval; current engine integrations treat this as blocking until an
 *   approval workflow is added.
 *
 * Note: A `modify` variant (allowing the gate to mutate the operation payload)
 * is intentionally absent from this slice. It will be introduced only for hook
 * families that explicitly allow mutation, to avoid ambiguous mutation contracts.
 */
export type PolicyDecision =
  | { decision: 'allow' }
  | { decision: 'block'; reason: string }
  | { decision: 'require-approval'; reason: string };

/**
 * Handler for policy-gate hooks (e.g. `beforePlanMerge`).
 *
 * Policy gates return a `PolicyDecision` that determines whether the gated
 * operation is allowed, blocked, or held for approval.
 */
export type PolicyGateHandler<TContext extends AnyPolicyGateContext = PolicyGateContext> = (
  ctx: TContext,
) => PolicyDecision | Promise<PolicyDecision>;

/** Handler for `beforeQueueDispatch` policy gates. */
export type QueueDispatchPolicyGateHandler = PolicyGateHandler<QueueDispatchPolicyGateContext>;

/** Handler for `beforePlanMerge` policy gates. */
export type PlanMergePolicyGateHandler = PolicyGateHandler<PlanMergePolicyGateContext>;

/** Handler for `beforeFinalMerge` policy gates. */
export type FinalMergePolicyGateHandler = PolicyGateHandler<FinalMergePolicyGateContext>;

// ---------------------------------------------------------------------------
// Agent run hook
// ---------------------------------------------------------------------------

/**
 * Optional augmentation returned by an `onAgentRun` handler.
 *
 * All fields are optional. Unspecified fields leave the default agent run
 * configuration unchanged.
 *
 * Runtime applies `promptAppend`, per-run `tools`, and additive
 * `allowedTools`/`disallowedTools` availability tuning. Returned tools are
 * injected only for the run whose hook returned them; loader-time
 * `registerTool()` entries are provenance and validation metadata, not
 * automatic injection.
 */
export interface AgentRunAugmentation {
  /**
   * Additional text appended to the agent's prompt, wrapped in a named
   * provenance section identifying the contributing extension.
   *
   * Extension fragments are appended after any config-level `promptAppend`
   * already resolved by the engine. Use sparingly — large appended text can
   * degrade agent performance.
   */
  promptAppend?: string;
  /**
   * Additional `ExtensionTool` instances made available to the agent for this run.
   *
   * Existing engine custom tools keep precedence. Extension tools are appended
   * only when their bare name does not duplicate an existing custom tool or an
   * earlier accepted extension tool. A returned tool is skipped when it is
   * denied by the final denylist.
   */
  tools?: ExtensionTool<TObject>[];
  /**
   * Tool names explicitly allowed for this agent run.
   *
   * Values are merged additively with the run's base allowlist. When an
   * allowlist is active, the runtime also preserves harness-effective names for
   * engine custom tools and accepted extension tools.
   */
  allowedTools?: string[];
  /**
   * Tool names explicitly disallowed for this agent run.
   *
   * Values are merged additively with the run's base denylist. Deny wins: a
   * returned extension tool whose bare or harness-effective name is denied is
   * not injected into the run.
   */
  disallowedTools?: string[];
}

/**
 * Handler invoked before an agent run starts, allowing augmentation of the run.
 *
 * Return `undefined` or an empty `AgentRunAugmentation` to leave the run unchanged.
 */
export type AgentRunHandler = (
  ctx: AgentRunContext,
) => AgentRunAugmentation | undefined | void | Promise<AgentRunAugmentation | undefined | void>;

// ---------------------------------------------------------------------------
// Profile router
// ---------------------------------------------------------------------------

/**
 * Result returned by a profile router, indicating which profile to activate
 * for the current plan build.
 */
export interface ProfileRouterResult {
  /** The resolved profile name. */
  profile: string;
  /**
   * Optional human-readable explanation of why this profile was selected.
   * Flows into the `queue:profile:selected` wire event so users can see
   * the router's reasoning in the monitor UI and event log.
   */
  reason?: string;
  /**
   * Optional confidence level for this selection.
   * Flows into the `queue:profile:selected` wire event.
   */
  confidence?: 'low' | 'medium' | 'high';
}

/**
 * Specification for a profile router registered via `registerProfileRouter`.
 *
 * The canonical method is `selectBuildProfile`, which receives a
 * `ProfileRouterContext` with full build/queue context (PRD id, title, body,
 * priority, dependencies, available profiles, and usage statistics).
 *
 * The `resolve` method is deprecated. If only `resolve` is provided the
 * engine will use it as a fallback, but new routers should implement
 * `selectBuildProfile` instead.
 *
 * At least one of `selectBuildProfile` or `resolve` must be provided.
 */
export interface ProfileRouterSpec {
  /** Unique name for this router (used for logging and conflict detection). */
  name: string;
  /**
   * Select the active profile for the given build/queue context.
   *
   * Return `null` or `undefined` to defer to the next registered router
   * (or the default profile if no router selects one).
   *
   * This is the canonical method for profile routers. Implement this in
   * preference to the deprecated `resolve` method.
   */
  selectBuildProfile?: (
    ctx: ProfileRouterContext,
  ) => ProfileRouterResult | null | undefined | Promise<ProfileRouterResult | null | undefined>;
  /**
   * @deprecated Use `selectBuildProfile` instead.
   *
   * Resolve the active profile for a given agent run context.
   * Return `null` or `undefined` to defer to the next registered router.
   *
   * This method receives `AgentRunContext` rather than the richer
   * `ProfileRouterContext`, so it lacks PRD-level context. Prefer
   * `selectBuildProfile` for new routers.
   */
  resolve?: (
    ctx: AgentRunContext,
  ) => ProfileRouterResult | null | undefined | Promise<ProfileRouterResult | null | undefined>;
}

// Re-export ProfileRouterContext for convenience in API signatures
export type { ProfileRouterContext };

// ---------------------------------------------------------------------------
// Input source
// ---------------------------------------------------------------------------

/**
 * Adapter for a custom input source registered via `registerInputSource`.
 *
 * Input sources allow extensions to supply PRD/build-source artifacts from
 * external systems (e.g. issue trackers, internal wikis) without manual file
 * placement.
 */
export interface InputSourceAdapter {
  /** Unique adapter name (e.g. `my-ext:linear`). */
  name: string;
  /** Human-readable description of where this source retrieves input from. */
  description: string;
  /**
   * Fetch the build input for a given identifier.
   * Returns the raw input artifact content or `null` if not found.
   */
  fetch: (id: string) => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Reviewer perspective
// ---------------------------------------------------------------------------

/**
 * Specification for an additional reviewer perspective registered via
 * `registerReviewerPerspective`.
 *
 * Reviewer perspectives allow extensions to contribute domain-specific review
 * lenses (e.g. security, accessibility, i18n) to the post-build review stage.
 */
export interface ReviewerPerspectiveSpec {
  /** Unique perspective key (matched against `REVIEW_PERSPECTIVES` in the engine). */
  key: string;
  /** Human-readable label shown in review output. */
  label: string;
  /**
   * Prompt fragment injected into the reviewer agent's context when this
   * perspective is active.
   */
  promptFragment: string;
}

// ---------------------------------------------------------------------------
// Validation provider
// ---------------------------------------------------------------------------

/**
 * Specification for a custom validation provider registered via
 * `registerValidationProvider`.
 *
 * Validation providers run after a plan's build stage completes, before the
 * review stage, allowing extensions to enforce project-specific quality gates.
 */
export interface ValidationProviderSpec {
  /** Unique provider name. */
  name: string;
  /** Human-readable description of what this provider validates. */
  description: string;
  /**
   * Run validation for the given plan output directory.
   *
   * @param planOutputDir - Absolute path to the worktree root for the plan.
   * @returns `null` or `undefined` to signal success; a `string` message to
   *   signal failure (the message is surfaced in build output).
   */
  validate: (planOutputDir: string) => Promise<string | null | undefined> | string | null | undefined;
}

// Re-export EventPattern for use in API signatures
export type { EventPattern };
