/**
 * Minimal event logger extension — demonstrates typed event hooks.
 *
 * This extension subscribes to `plan:build:failed` events and logs a warning
 * through the extension logger. It demonstrates:
 *
 * - Default-export factory pattern (the required entrypoint shape)
 * - `onEvent` registration with a typed event pattern
 * - Typed event narrowing via `EventOfType`
 * - Access to `ctx.logger` for structured logging
 *
 * Runtime status: Phase 1 target. The `onEvent` hook type contract is fully
 * defined in this release. Runtime dispatch is not yet wired — this module
 * serves as a compile-checked type demonstration.
 */

import type { EforgeExtensionAPI, EventOfType } from '@eforge-build/extension-sdk';

// Demonstrate EventOfType narrowing in a type annotation:
// EventOfType<'plan:build:failed'> narrows EforgeEvent to the specific variant.
type FailedEvent = EventOfType<'plan:build:failed'>;

export default function minimalEventLogger(eforge: EforgeExtensionAPI): void {
  eforge.onEvent('plan:build:failed', async (event: FailedEvent, ctx) => {
    ctx.logger.warn(`Plan failed: ${event.planId}`);
  });
}
