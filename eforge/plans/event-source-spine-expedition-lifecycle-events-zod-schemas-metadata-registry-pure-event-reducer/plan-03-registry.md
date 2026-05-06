---
id: plan-03-registry
name: "Event metadata registry: create packages/client/src/event-registry.ts
  with one entry per variant declaring {scope, persist, project?, summary?}, add
  the _Exhaustive type-check gate, derive DAEMON_EVENT_TYPES from registry
  (replacing the literal at packages/monitor/src/db.ts:149-193), replace the
  140-branch switch in CLI display.ts and the eventToProgress summary table with
  registry summary lookups (rich rendering paths stay), inline the projection
  logic from packages/monitor-ui/src/lib/daemon-reducer/handle-*.ts into
  registry project functions."
branch: event-source-spine-expedition-lifecycle-events-zod-schemas-metadata-registry-pure-event-reducer/registry
---

