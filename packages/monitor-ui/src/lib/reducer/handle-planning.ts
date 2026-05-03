/**
 * Handlers for compile-phase planning events.
 *
 * planning:complete — seeds planStatuses with 'plan' for every submitted plan.
 *   All other planning:* variants have no state effect and live in IGNORED_EVENT_TYPES.
 */
import type { EventHandler } from './handler-types';

export const handlePlanningComplete: EventHandler<'planning:complete'> = (event, state) => {
  const updated = { ...state.planStatuses };
  for (const plan of event.plans) {
    updated[plan.id] = 'plan';
  }
  return { planStatuses: updated };
};
