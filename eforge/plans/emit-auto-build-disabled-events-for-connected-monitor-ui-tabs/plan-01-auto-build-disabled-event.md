---
id: plan-01-auto-build-disabled-event
name: Emit and Project Auto-build Disabled Events
branch: emit-auto-build-disabled-events-for-connected-monitor-ui-tabs/plan-01-auto-build-disabled-event
---

# Emit and Project Auto-build Disabled Events

## Architecture Context

Eforge's daemon event wire contract is owned by `@eforge-build/client`. Event variants live in `packages/client/src/events.schemas.ts`; event metadata, persistence selection, summaries, and daemon-state projectors live in `packages/client/src/event-registry.ts`. The monitor UI daemon reducer derives live state handlers from that shared registry, while the per-session reducer keeps an exhaustive ignored-event list for daemon-scoped variants it does not render.

The daemon already returns an authoritative `AutoBuildState` from `GET /api/auto-build`, `POST /api/auto-build`, and `stream:hello.autoBuild`. The missing delta is a persisted daemon event from the manual toggle-off branch so connected tabs receive the state transition without reconnecting.

## Implementation

### Overview

Add a daemon-scoped `daemon:auto-build:disabled` event with no payload beyond the common event envelope. Persist it, summarize it, project it into `state.autoBuild.enabled = false`, and emit it from the accepted `POST /api/auto-build` false branch after watcher shutdown is requested. Keep REST response shapes and snapshot seeding unchanged.

### Key Decisions

1. Use `daemon:auto-build:disabled` for operator-driven toggle-off events, keeping failure-triggered pauses on `daemon:auto-build:paused`.
2. Mark the disabled event `persist: true` so DB replay, `/api/daemon-events`, and the activity feed include it like the existing enabled/resumed/triggered auto-build events.
3. Put live UI state projection in `packages/client/src/event-registry.ts`; do not add a custom monitor UI daemon reducer branch.
4. Preserve watcher shutdown behavior and REST responses. The false branch mutates `options.daemonState.autoBuild` as it does today, calls `onKillWatcher?.()`, emits the disabled event, then returns `autoBuildStateToWire(options.daemonState)`.
5. Keep the projector idempotent: return no state delta when `state.autoBuild` is `null` or already disabled, while the daemon reducer still appends non-heartbeat events to activity.

## Scope

### In Scope

- Add `daemon:auto-build:disabled` to the canonical `EforgeEvent` TypeBox schema.
- Add event registry metadata with daemon scope, persistence, activity summary, and auto-build disable projection.
- Emit the event from `POST /api/auto-build` when `{ "enabled": false }` is accepted in daemon mode.
- Add the event to monitor UI exhaustive ignored-event lists where daemon-scoped events are intentionally no-ops for per-session state.
- Update tests for schema/wire fixtures, registry metadata, DB daemon-event allowlist, server route emission, daemon reducer projection, and live hook dispatch.
- Regenerate committed event reference artifacts after the schema change.

### Out of Scope

- Changing `GET /api/auto-build` or `POST /api/auto-build` response shapes.
- Changing `stream:hello.autoBuild` snapshot semantics.
- Driving the header toggle from heartbeat payloads.
- Changing auto-build config persistence semantics.
- Changing failure pause/resume semantics or in-flight build shutdown behavior.
- Adding new monitor UI controls or visual elements.

## Files

### Create

- `packages/monitor/src/__tests__/auto-build-route.test.ts` — Real HTTP/server test for the manual disable route emitting `daemon:auto-build:disabled` through `onDaemonEvent` while preserving the `AutoBuildState` response.

### Modify

- `packages/client/src/events.schemas.ts` — Add `Type.Object({ type: Type.Literal('daemon:auto-build:disabled') })` in the daemon auto-build variants near enabled/resumed/triggered.
- `packages/client/src/event-registry.ts` — Add the registry entry with `scope: 'daemon'`, `persist: true`, summary `Auto-build disabled`, and projector that returns `{ autoBuild: { ...state.autoBuild, enabled: false } }` only when `state.autoBuild` exists and is enabled.
- `packages/client/src/__tests__/events.test.ts` — Add the disabled event fixture and expected literal; update the daemon variant count text and assertions from 18 to 19.
- `packages/client/src/__tests__/events-wire-parity.test.ts` — Add a valid disabled event payload case.
- `packages/client/src/__tests__/events-schemas.test.ts` — Add targeted assertions that `safeParseEforgeEvent` accepts the disabled payload, the event registry marks it daemon-scoped and persisted, `getEventSummary` returns the summary text, and the projector disables an enabled auto-build state.
- `packages/monitor/src/server.ts` — In the accepted false branch of `POST /api/auto-build`, emit `{ type: 'daemon:auto-build:disabled', timestamp: new Date().toISOString() }` via `options.daemonState.onDaemonEvent?.(...)` after `options.daemonState.onKillWatcher?.()`.
- `packages/monitor/src/__tests__/db.test.ts` — Add `daemon:auto-build:disabled` to `NEW_PERSISTED_TYPES` so `getDaemonEventsAfter(0)` returns rows for the new persisted daemon event.
- `packages/monitor-ui/src/lib/reducer/index.ts` — Add `daemon:auto-build:disabled` to `IGNORED_EVENT_TYPES` with the adjacent daemon auto-build variants so the per-session reducer exhaustiveness check passes.
- `packages/monitor-ui/src/lib/__tests__/daemon-reducer.test.ts` — Add disabled-event cases proving `autoBuild.enabled` flips from true to false and activity gains one entry, plus the `autoBuild: null` no-delta case with activity append.
- `packages/monitor-ui/src/hooks/__tests__/use-daemon-events.test.ts` — Add an event-frame test proving a connected hook instance applies `daemon:auto-build:disabled` to `daemonState.autoBuild.enabled`.
- `web/content/reference/events.md` — Regenerated event reference table must include `daemon:auto-build:disabled` with no extra fields.
- `web/public/reference/events.md` — Regenerated public event reference table must include `daemon:auto-build:disabled` with no extra fields.
- `web/public/llms-full.txt` — Regenerated public LLM reference must include `daemon:auto-build:disabled` with no extra fields.
- `web/public/schemas/events.schema.json` — Regenerated schema artifact must include the new event literal.

## Implementation Notes

- Do not add a DB migration; event rows store type strings in the existing `events.type` column.
- Keep the disabled event payload empty beyond `timestamp` and the optional envelope fields from `EventEnvelopeSchema`.
- Do not clear `autoBuildPaused` in the manual disable branch. Failure-triggered pauses remain distinguishable and enabling after a pause continues to emit `daemon:auto-build:resumed`.
- Use `API_ROUTES.autoBuildSet` in route tests rather than hard-coded `/api/auto-build` paths.
- The monitor DB daemon-event query imports `DAEMON_EVENT_TYPES` from the client registry, so adding `persist: true` includes the event in the runtime allowlist; the DB test guards that integration.
- Run `pnpm docs:generate` after schema/registry changes, then inspect generated artifacts for only event-reference/schema changes.

## Verification

- [ ] `safeParseEforgeEvent({ type: 'daemon:auto-build:disabled', timestamp })` returns `success: true`.
- [ ] `eventRegistry['daemon:auto-build:disabled']` has `scope: 'daemon'`, `persist: true`, summary `Auto-build disabled`, and a projector that returns an `enabled: false` delta for an enabled auto-build state.
- [ ] `POST ${API_ROUTES.autoBuildSet}` with `{ enabled: false }` calls `onKillWatcher`, emits one `daemon:auto-build:disabled` event through `onDaemonEvent`, and returns the existing `AutoBuildState` JSON shape.
- [ ] `daemonReducer` receives `daemon:auto-build:disabled`, changes `autoBuild.enabled` from true to false, and appends one daemon activity entry.
- [ ] `daemonReducer` receives `daemon:auto-build:disabled` with `autoBuild: null`, leaves `autoBuild` null, and appends one daemon activity entry.
- [ ] `getDaemonEventsAfter(0)` returns a row whose type is `daemon:auto-build:disabled`; it still excludes `daemon:heartbeat`.
- [ ] Existing stream hello parity tests pass, demonstrating `stream:hello.autoBuild` still matches `GET /api/auto-build`.
- [ ] Generated event reference tables and event schema JSON include `daemon:auto-build:disabled`.
- [ ] Targeted test commands pass for client event tests, monitor DB/server tests, and monitor UI daemon reducer/hook tests.
