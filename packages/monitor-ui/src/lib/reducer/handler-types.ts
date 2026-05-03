/**
 * Shared types for the event handler registry.
 *
 * Each handler receives the narrowed event (via TypeScript's discriminated union)
 * and the current read-only state, and returns a partial state delta describing
 * only the slices it mutated. Returning `undefined` signals "no state change" so
 * the reducer can return the prior state ref unchanged (stable refs → fewer
 * React.memo re-renders for unrelated consumers).
 *
 * Note: RunState is imported as a type-only import to avoid circular runtime
 * dependency (handler files → handler-types.ts ← reducer.ts). Type-only imports
 * are erased at compile time so there is no runtime circular reference.
 */
import type { EforgeEvent } from '../types';
import type { RunState } from '../reducer';

/**
 * Handler for a single EforgeEvent variant `T`.
 *
 * - `event` is narrowed to `Extract<EforgeEvent, { type: T }>` — no casts needed inside.
 * - `state` is readonly — handlers must not mutate it.
 * - Return value is a partial delta; only the slices included will be spread into
 *   the next state by the reducer's ADD_EVENT case.
 * - Return `undefined` when the event causes no state change at all.
 */
export type EventHandler<T extends EforgeEvent['type']> = (
  event: Extract<EforgeEvent, { type: T }>,
  state: Readonly<RunState>,
) => Partial<RunState> | undefined;

/** Alias for the handler return type — a partial state delta. */
export type RunStateDelta = Partial<RunState>;
