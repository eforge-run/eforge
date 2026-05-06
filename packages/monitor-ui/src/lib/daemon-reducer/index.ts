/**
 * Flat handler registry keyed by daemon-wide event type.
 *
 * Derived from the event registry in @eforge-build/client: every entry whose
 * `project` function is defined contributes a handler. The registry is
 * exhaustive over all EforgeEvent types (verified by a compile-time check in
 * event-registry.ts), so no separate exhaustiveness check is needed here.
 *
 * Dispatch in daemon-reducer.ts uses:
 *   const handler = (daemonHandlerRegistry as Record<string, ...>)[event.type];
 *   const delta = handler ? handler(event as never, state) : undefined;
 */
import type { EforgeEvent } from '@/lib/types';
import type { DaemonState } from '../daemon-reducer';
import { eventRegistry } from '@eforge-build/client/browser';

// ---------------------------------------------------------------------------
// Handler registry — derived from event registry project functions
// ---------------------------------------------------------------------------

/**
 * Extract the project function for each event type that has one.
 * Cast to DaemonEventHandler shape for use in daemon-reducer.ts dispatch.
 *
 * ProjectableState is structurally compatible with DaemonState (DaemonState
 * has all ProjectableState fields plus more), so spreading a
 * Partial<ProjectableState> delta into DaemonState is always safe.
 */
export const daemonHandlerRegistry: Record<
  string,
  ((event: never, state: Readonly<DaemonState>) => Partial<DaemonState> | undefined) | undefined
> = Object.fromEntries(
  (Object.entries(eventRegistry) as Array<[string, { project?: unknown }]>)
    .filter(([, meta]) => meta.project != null)
    .map(([type, meta]) => [
      type,
      meta.project as (event: never, state: Readonly<DaemonState>) => Partial<DaemonState> | undefined,
    ]),
);
