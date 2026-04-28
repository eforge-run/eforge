---
id: plan-01-session-profile-event-and-inspector
name: session:profile event end-to-end + inspectable profile badge
branch: monitor-ui-replace-harness-indicator-with-inspectable-profile-name/session-profile-event-and-inspector
---

# session:profile event end-to-end + inspectable profile badge

## Architecture Context

A build today carries a single legacy `harness` label in the monitor UI session header (e.g., `claude-sdk` / `pi`), inherited from the era when one build = one backend. Builds now run under a **profile** that may declare multiple agent runtimes (one role on `claude-sdk`, another on `pi`). Showing one harness picks whichever ran first and is misleading.

The fix introduces a new engine event `session:profile` that carries `{ profileName, source, scope, config }`. It flows through the same path as every other event:

```
engine (eforge.ts) → events.ts type → SQLite event log (db.ts) → /api session metadata (client/types.ts) → monitor-ui reducer (RunState.profile) → SummaryCards → ProfileBadge (Sheet inspector)
```

The event needs to travel through the event stream (not the filesystem) so historical replays of completed sessions render the same way live sessions do. Sessions stored before this change simply won't have the event and will show no profile chip — no fallback derivation from `agent:start.harness`.

Alongside the new event, this plan removes the dead `harness` field from `RunState`/`SummaryCards`, the dead `plan:profile` event handling (the engine never emits this type any more — it's referenced only by `db.ts` and `event-card.tsx`), the dormant `ProfileHeader` in `thread-pipeline.tsx` (consumes the removed `ProfileInfo` shape, currently always rendered against `null`), and `SessionMetadata.backend` from the client types (replaced by `baseProfile`). The `DAEMON_API_VERSION` bump from 8 to 9 marks the breaking change.

The per-thread `AgentThread.harness` is preserved — it powers the per-row harness chip in the pipeline tooltip, which is the legitimate use of harness identity (per-agent, not per-session).

## Implementation

### Overview

1. Define `session:profile` in the `EforgeEvent` union.
2. Extend `loadConfig` to return profile metadata (`name`, `source`, `scope`, `config`).
3. Capture profile data on the `EforgeEngine` instance and emit `session:profile` from every async generator entry point.
4. Update the daemon DB to read the new event and drop the legacy `plan:profile` + `BUILTIN_PROFILES` + `agent:start → backend` paths.
5. Drop `backend` from the client `SessionMetadata` and bump the API version.
6. Wire the event through the monitor-ui types and reducer (drop `harness`, replace `profileInfo` with `profile`).
7. Build the new `ProfileBadge` Sheet inspector with structured sections + collapsible raw YAML.
8. Swap `harness` → `profile` in `SummaryCards` and `app.tsx`.
9. Remove dead code: `ProfileHeader` in `thread-pipeline.tsx`, `plan:profile` branches in `event-card.tsx`.
10. Add the `yaml` package to `monitor-ui` dependencies (used by the inspector to dump config back to YAML for the raw panel).

### Key Decisions

1. **Emit `session:profile` as the first non-envelope event.** It must precede the existing `config:warning` loop so consumers (DB, UI) see profile metadata before any warnings reference it. In the queue runner the engine emits `session:start` itself (lines 947, 1361, 1609 in `eforge.ts`), so `session:profile` lands immediately after that. In other entry points (`compile`, build runners, recovery runners) the harness emits the envelope, so `session:profile` is the first engine-emitted event in the generator body.
2. **Type `config` as `unknown` on the event surface.** The wire shape stays loose like other config-bearing events (`config:warning`). The engine populates it with a `PartialEforgeConfig`, but consumers treat it as opaque YAML for display purposes only.
3. **No fallback derivation for historical sessions.** Older sessions that lack the event simply render no profile chip. The PRD explicitly puts this out of scope — fallback logic would create silent rendering inconsistencies between live and replayed sessions.
4. **Bump `DAEMON_API_VERSION` 8 → 9.** Removing a required `backend` response field is a breaking change for any cached client.
5. **Sheet pattern modeled on `recovery/sidecar-sheet.tsx`.** Reuses the existing slide-over `Sheet`/`SheetContent` shadcn pattern for visual consistency.
6. **Raw YAML rendering uses `shiki` + the `yaml` npm package.** `shiki` is already a `monitor-ui` dep; `yaml` is added to deps. Dumping the `unknown` config back to YAML keeps arbitrary/unknown profile fields visible without the structured renderer needing exhaustive type knowledge.

## Scope

### In Scope

- New `session:profile` event type in `packages/engine/src/events.ts` with payload `{ profileName: string | null; source: 'local' | 'user-local' | 'missing' | 'none'; scope: 'project' | 'user' | null; config: unknown | null }`.
- Extending `loadConfig` in `packages/engine/src/config.ts` to return `profile: { name, source, scope, config }` (reusing the `resolveActiveProfileName` + `loadProfile` calls already inside `loadConfig`).
- Capturing the new `profile` field on the `EforgeEngine` instance in `packages/engine/src/eforge.ts` (alongside `configWarnings`).
- Emitting `session:profile` from each async generator entry point: `compile` (line 220), each build runner, `runQueue` (line 1250), and recovery runners. Place it before the existing `config:warning` loop, or immediately after the engine-emitted `session:start` in queue mode (lines 947, 1361, 1609).
- Daemon DB updates in `packages/monitor/src/db.ts`: replace `'plan:profile'` with `'session:profile'` in `getSessionMetadataEvents` (line 211); rewrite `getSessionMetadataBatch` (lines 312-355) to drop `BUILTIN_PROFILES` filtering and the `agent:start → backend` branch, populate `meta.baseProfile` from the new event's `profileName` when currently `null`, and drop `meta.backend` from the result shape.
- Removing `backend` from `SessionMetadata` in `packages/client/src/types.ts` (line 45).
- Bumping `DAEMON_API_VERSION` from `8` to `9` in `packages/client/src/api-version.ts` (line 17).
- Replacing `ProfileInfo`/`ProfileConfig` in `packages/monitor-ui/src/lib/types.ts` (lines 63-79) with `SessionProfile` (`{ profileName, source, scope, config }`); dropping `harness` from `SessionMetadata`, keeping `baseProfile`.
- Reducer updates in `packages/monitor-ui/src/lib/reducer.ts`: remove `harness: string | null` from `RunState` (lines 83, 110, 144, 302, 439); remove the `agent:start → state.harness` branch (lines 298-303); replace `profileInfo: ProfileInfo | null` with `profile: SessionProfile | null`; add a handler `if (event.type === 'session:profile') state.profile = { ...event };`.
- `SummaryCards` in `packages/monitor-ui/src/components/common/summary-cards.tsx`: replace `harness?: string | null` (line 23) with `profile?: SessionProfile | null`; replace the harness span (line 75) with `<ProfileBadge profile={profile} />` rendered only when `profile?.profileName` is set.
- New file `packages/monitor-ui/src/components/profile/profile-badge.tsx`:
  - Click-to-open Sheet (modeled on `components/recovery/sidecar-sheet.tsx`).
  - Trigger: `Badge` with the profile name (subtle outline styling).
  - `SheetContent` body sections:
    - Header: profile name + source/scope sub-badges (e.g., `local · project`).
    - **Agent runtimes** list from `config.agentRuntimes`, each row showing name, harness, and `pi.provider` / `claudeSdk` flags when present.
    - **Default runtime**: `config.defaultAgentRuntime` if present.
    - **Agents**: sections for `models`, `tiers`, `roles` (each present), each row showing the override (`{tier|role}: model=…, agentRuntime=…, effort=…`).
    - **Extends**: `config.extends` if set.
    - **Raw YAML** (collapsed by default): `Collapsible` from `components/ui/collapsible.tsx` wrapping a `shiki`-highlighted code block (`yaml` grammar). Use the `yaml` package to dump the config back to YAML.
  - When `config` is null (`source === 'none'` or `'missing'`), render a one-line note instead of the structured sections.
- `packages/monitor-ui/src/app.tsx` line 336: replace `harness={runState.harness}` with `profile={runState.profile}`.
- Removing the `ProfileHeader` rendering and props in `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` (lines 187-227 component, 484, 491, 597, 600, 606-608 references).
- Removing the three `plan:profile` branches in `packages/monitor-ui/src/components/timeline/event-card.tsx` (lines 40, 53, 133-154).
- Adding `yaml` (npm package, the same parser used in the engine) to `packages/monitor-ui/package.json` dependencies.

### Out of Scope

- Adding a timeline card for the new `session:profile` event (it's already surfaced in the header).
- Cleaning up the hardcoded `profileBadgeClasses` map (`errand`/`excursion`/`expedition`) in `packages/monitor-ui/src/components/layout/sidebar.tsx`. The sidebar already renders `metadata.baseProfile` and falls back gracefully for arbitrary names; the daemon change will start populating `baseProfile` for every build. Skip the cleanup to keep the change focused.
- Backfill or fallback derivation of profile metadata from `agent:start.harness` for historical sessions stored before this change. They will simply show no profile chip.

## Files

### Create

- `packages/monitor-ui/src/components/profile/profile-badge.tsx` — new Sheet-based profile inspector. Renders the `Badge` trigger and the slide-over panel with structured sections plus collapsible raw YAML (shiki-highlighted, `yaml`-dumped).

### Modify

- `packages/engine/src/events.ts` — add `| { type: 'session:profile'; profileName: string | null; source: 'local' | 'user-local' | 'missing' | 'none'; scope: 'project' | 'user' | null; config: unknown | null }` to the `EforgeEvent` union (around line 146).
- `packages/engine/src/config.ts` — extend `loadConfig`'s return type with `profile: { name: string | null; source: ActiveProfileSource; scope: 'project' | 'user' | null; config: PartialEforgeConfig | null }`. Thread the data out from the existing `resolveActiveProfileName` + `loadProfile` calls (around lines 912-928). Determine `scope` from which marker resolved the profile (`local` ⇒ `project`, `user-local` ⇒ `user`, otherwise `null`).
- `packages/engine/src/eforge.ts` — capture the new `profile` field on the engine instance in `EforgeEngine.create` (around line 165, alongside `configWarnings`). In each async generator entry point (`compile` line 220, build runners, `runQueue` line 1250, recovery runners) emit `session:profile` before the existing `config:warning` loop. For queue mode (lines 947, 1361, 1609) emit it immediately after the engine-emitted `session:start`.
- `packages/monitor/src/db.ts` — `getSessionMetadataEvents` (line 211): replace `'plan:profile'` with `'session:profile'` in the SQL `WHERE e.type IN (...)` clause. `getSessionMetadataBatch` (lines 312-355): drop the `BUILTIN_PROFILES` constant and its filtering, drop the `agent:start → backend` branch, add a branch for `row.type === 'session:profile'` that sets `meta.baseProfile = data.profileName` when `meta.baseProfile === null`. Remove `backend` from the result shape.
- `packages/client/src/types.ts` — `SessionMetadata` (line 45): remove the `backend: string | null` field; keep `planCount` and `baseProfile`.
- `packages/client/src/api-version.ts` — bump `DAEMON_API_VERSION` from `8` to `9` (line 17).
- `packages/monitor-ui/src/lib/types.ts` (lines 63-79) — replace `ProfileInfo` and `ProfileConfig` with a single `SessionProfile` type matching the event payload `{ profileName: string | null; source: 'local' | 'user-local' | 'missing' | 'none'; scope: 'project' | 'user' | null; config: unknown | null }`. Drop `harness` from the local `SessionMetadata`; keep `baseProfile`.
- `packages/monitor-ui/src/lib/reducer.ts` — drop `harness: string | null` from `RunState` (lines 83, 110, 144, 302, 439). Remove the `agent:start → state.harness` branch (lines 298-303). The per-thread `AgentThread.harness` is preserved. Replace `profileInfo: ProfileInfo | null` with `profile: SessionProfile | null` and add a handler `if (event.type === 'session:profile') state.profile = { ... }` populating the new shape from the event.
- `packages/monitor-ui/src/components/common/summary-cards.tsx` — replace the `harness?: string | null` prop (line 23) with `profile?: SessionProfile | null`. Replace the harness span (line 75) with `<ProfileBadge profile={profile} />` rendered only when `profile?.profileName` is non-null; otherwise render nothing.
- `packages/monitor-ui/src/app.tsx` (line 336) — replace `harness={runState.harness}` with `profile={runState.profile}`.
- `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` — remove the dormant `ProfileHeader` component (lines 187-227) and all its prop-passing/rendering callsites (lines 484, 491, 597, 600, 606-608). The per-thread harness chip in the pipeline tooltip is preserved.
- `packages/monitor-ui/src/components/timeline/event-card.tsx` — remove the three `plan:profile` branches (lines 40, 53, 133-154). The engine no longer emits this event type.
- `packages/monitor-ui/package.json` — add `"yaml": "^2.8.3"` to `dependencies` (matching the version already used at the repo root). Used by `profile-badge.tsx` to dump the profile config back to YAML for the raw panel.

## Verification

- [ ] `pnpm type-check` succeeds with zero errors from the repo root.
- [ ] `pnpm test` succeeds with zero failing tests from the repo root.
- [ ] `grep -r "plan:profile" packages/monitor packages/monitor-ui` returns no matches (the legacy event type is fully removed from consumers).
- [ ] `grep -rn "harness: string\" packages/monitor-ui/src/lib/reducer.ts` returns no matches outside the `AgentThread` interface (per-thread harness is preserved; per-session `RunState.harness` is removed).
- [ ] `grep -rn "backend" packages/client/src/types.ts` returns no matches inside the `SessionMetadata` interface body.
- [ ] `packages/client/src/api-version.ts` exports `DAEMON_API_VERSION = 9`.
- [ ] `packages/engine/src/events.ts` exports a `EforgeEvent` union member with `type: 'session:profile'` carrying `profileName`, `source`, `scope`, and `config` fields.
- [ ] `packages/engine/src/config.ts` `loadConfig` return type includes a `profile` field with `name`, `source`, `scope`, and `config` properties.
- [ ] `packages/monitor-ui/src/components/profile/profile-badge.tsx` exists and exports a `ProfileBadge` component that accepts `profile: SessionProfile | null | undefined` and renders nothing when `profile?.profileName` is null/undefined.
- [ ] The `ProfileBadge` Sheet renders 5 named sections when `config` is non-null: a header with profile name + source/scope sub-badges, an `Agent runtimes` section, a `Default runtime` line (when present in config), an `Agents` section grouping `models`/`tiers`/`roles`, an `Extends` line (when present in config), and a collapsible `Raw YAML` panel (collapsed by default) using `shiki` with the `yaml` grammar.
- [ ] The `ProfileBadge` Sheet renders a single one-line note instead of the structured sections when `profile.config === null` (covers `source === 'none'` and `source === 'missing'`).
- [ ] `packages/monitor-ui/package.json` `dependencies` lists `yaml` at version `^2.8.3`.
- [ ] `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` contains no `ProfileHeader` symbol.
- [ ] `packages/monitor-ui/src/components/timeline/event-card.tsx` contains no `'plan:profile'` string literal.
- [ ] `packages/monitor/src/db.ts` contains no `BUILTIN_PROFILES` symbol and no `agent:start` branch that writes a `backend` field on the metadata row.
- [ ] In `packages/engine/src/eforge.ts`, every async generator entry point that previously yielded `config:warning` events as the first engine output now yields a `session:profile` event before that loop (or, in the queue runner cases at lines 947/1361/1609, emits it immediately after the engine's own `session:start` yield).
- [ ] The per-thread `AgentThread.harness` field still exists on the reducer's thread state and the pipeline tooltip still renders a per-thread harness chip.
