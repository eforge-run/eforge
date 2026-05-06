---
id: plan-02-mutate-state
name: "Single mutation entry point: add mutateState(state, event) to
  packages/engine/src/state.ts (folds in updatePlanStatus), route every direct
  mutation in plan-lifecycle.ts and worktree-manager.ts through it, rewrite
  orchestrator.initializeState() to prefer event-log replay with state.json
  fallback, replace hydrateEventData with parseEventRow (Zod log-and-skip,
  preserves back-compat field-patching), add the 'State mutation is
  single-entry-point' convention to AGENTS.md, write state.json.bak guard before
  first overwrite."
branch: event-source-spine-expedition-lifecycle-events-zod-schemas-metadata-registry-pure-event-reducer/mutate-state
---

