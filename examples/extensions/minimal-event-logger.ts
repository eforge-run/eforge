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
 * Runtime status: the factory can be loaded by the daemon, this `onEvent`
 * registration is captured in extension provenance, and matching events are
 * dispatched at runtime. Handler errors and timeouts emit extension diagnostics.
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
