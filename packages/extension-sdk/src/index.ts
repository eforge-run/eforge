/**
 * @eforge-build/extension-sdk
 *
 * TypeScript SDK for authoring eforge extensions.
 *
 * Extension authors import from this package to access the full typed API
 * surface for event hooks, policy gates, tool registration, and more.
 *
 * @example
 * ```ts
 * import type { EforgeExtensionAPI } from '@eforge-build/extension-sdk';
 *
 * export default function myExtension(eforge: EforgeExtensionAPI) {
 *   eforge.onEvent('plan:build:failed', async (event, ctx) => {
 *     ctx.logger.warn(`Plan failed: ${event.planId}`);
 *   });
 * }
 * ```
 */

// API surface
export type { EforgeExtensionAPI, EforgeExtensionFactory } from './api.js';
export { defineEforgeExtension } from './api.js';

// Context types
export type {
  EforgeExtensionContext,
  ExtensionLogger,
  ExtensionExecApi,
  ExtensionDiff,
  EventHookContext,
  AgentRunContext,
  PolicyGateContext,
  ProfileRouterContext,
  ProfileSummary,
  ProfileUsageSummary,
} from './context.js';

// Hook handler and result types
export type {
  EventHookHandler,
  PolicyDecision,
  PolicyGateHandler,
  AgentRunHandler,
  AgentRunAugmentation,
  ProfileRouterSpec,
  ProfileRouterResult,
  InputSourceAdapter,
  ReviewerPerspectiveSpec,
  ValidationProviderSpec,
} from './hooks.js';

// Event types (re-exported from @eforge-build/client)
export type { EforgeEvent, AgentRole, EventOfType } from './events.js';
export { EforgeEventSchema, safeParseEforgeEvent } from './events.js';

// Pattern matching
export type { EventPattern } from './patterns.js';
export { compileEventPattern, matchesEventPattern } from './patterns.js';

// Tool types
export type { ExtensionTool } from './tools.js';
export { defineExtensionTool } from './tools.js';

// TypeBox re-exports
export { Type } from './schema.js';
export type { TSchema, TObject, Static } from './schema.js';
