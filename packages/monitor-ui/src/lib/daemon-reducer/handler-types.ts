/**
 * Shared types for the daemon-state event handler registry.
 *
 * DaemonEventHandler is analogous to EventHandler in lib/reducer/handler-types.ts,
 * but operates on DaemonState instead of RunState. Type-only imports avoid
 * circular runtime dependencies (handlers import this file; daemon-reducer.ts
 * imports the handler registry; handler-types.ts imports DaemonState as type-only).
 */
import type { EforgeEvent } from '@/lib/types';
import type { DaemonState } from '../daemon-reducer';

/**
 * Handler for a single EforgeEvent variant `T` within the daemon reducer.
 *
 * - `event` is narrowed to `Extract<EforgeEvent, { type: T }>` — no casts needed inside.
 * - `state` is readonly — handlers must not mutate it.
 * - Return value is a partial delta; only the slices included will be spread into
 *   the next state by the reducer's ADD_EVENT case.
 * - Return `undefined` when the event causes no state change at all.
 */
export type DaemonEventHandler<T extends EforgeEvent['type']> = (
  event: Extract<EforgeEvent, { type: T }>,
  state: Readonly<DaemonState>,
) => Partial<DaemonState> | undefined;
