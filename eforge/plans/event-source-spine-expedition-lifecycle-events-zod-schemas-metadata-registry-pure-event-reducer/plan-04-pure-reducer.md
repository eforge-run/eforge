---
id: plan-04-pure-reducer
name: "Pure-event reducer + acceptance gate: delete inference heuristics from
  packages/monitor-ui/src/lib/reducer.ts (e.g. plan:build:start ⇒ running),
  delete DAEMON_IGNORED_EVENT_TYPES (line 122) and surrounding filter logic from
  daemon-reducer/index.ts, delete the now-redundant handle-*.ts files whose
  logic moved to the registry, add
  packages/monitor-ui/test/event-replay-equivalence.test.ts (must fail on main,
  pass after merge — uses multiple recorded sessions including
  merge/errors/recovery as fixtures), verify agent:start
  thinkingCoerced/thinkingOriginal reaches the agent-stage hover, remove
  docs/roadmap.md line 32 ('Typed SSE events in client package')."
branch: event-source-spine-expedition-lifecycle-events-zod-schemas-metadata-registry-pure-event-reducer/pure-reducer
---

