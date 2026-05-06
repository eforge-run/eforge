---
id: plan-01-foundation
name: "Lifecycle events + Zod schemas: add 5 new event variants
  (plan:status:change, plan:error:set, plan:error:clear, merge:worktree:set,
  merge:worktree:clear), create events.schemas.ts as wire-protocol source of
  truth, make EforgeEvent = z.infer<typeof EforgeEventSchema>, bump
  DAEMON_API_VERSION 18→19, remove the 'Pure TypeScript — no Zod' comment, add
  the 'Event types and schemas are co-located' convention to AGENTS.md."
branch: event-source-spine-expedition-lifecycle-events-zod-schemas-metadata-registry-pure-event-reducer/foundation
---

