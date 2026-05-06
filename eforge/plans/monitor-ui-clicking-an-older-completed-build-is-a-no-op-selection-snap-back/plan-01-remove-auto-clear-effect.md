---
id: plan-01-remove-auto-clear-effect
name: Remove auto-clear useEffect from monitor UI app.tsx
branch: monitor-ui-clicking-an-older-completed-build-is-a-no-op-selection-snap-back/plan-01-remove-auto-clear-effect
---

---
id: plan-01-remove-auto-clear-effect
name: Remove auto-clear useEffect from monitor UI app.tsx
depends_on: []
---

# Remove auto-clear useEffect from monitor UI app.tsx

## Architecture Context

The monitor UI's `AppContent` component (`packages/monitor-ui/src/app.tsx`) tracks two pieces of session state:

- `userSelectedSessionId` (state, line 31): set when the user clicks a build in the sidebar via `handleSelectSession` (lines 95-97).
- `latestSessionId` (derived from `daemonState`, line 40): the most recently started build per the daemon's run list.

The rendered session is computed at line 41:

```ts
const currentSessionId = userSelectedSessionId ?? latestSessionId;
```

Lines 99-105 contain an effect that auto-clears `userSelectedSessionId` when the watched session is complete:

```ts
// Clear user selection when the watched session completes so future new
// sessions can auto-switch again.
useEffect(() => {
  if (runState.isComplete && userSelectedSessionId === currentSessionId) {
    setUserSelectedSessionId(null);
  }
}, [runState.isComplete, currentSessionId, userSelectedSessionId]);
```

The author's intent was to fire only on a *transition* from running -> complete, but the effect actually re-evaluates on every render where the deps changed. When the user clicks an older completed build, React schedules a state update to `userSelectedSessionId`, but `runState` is still the previous (latest) build's state because `useEforgeEvents`' dispatch hasn't applied for the new `currentSessionId` yet. `runState.isComplete` is still `true` for the latest build, so the effect's condition matches and immediately resets `userSelectedSessionId` to `null`. The selection snaps back to `latestSessionId` and the view never swaps.

This interaction is independent of `useEforgeEvents` (`packages/monitor-ui/src/hooks/use-eforge-events.ts`) and the daemon reducer slice. The fix is upstream of the SSE/snapshot flow entirely.

## Implementation

### Overview

Delete lines 99-105 of `packages/monitor-ui/src/app.tsx` (the comment block and the `useEffect` it precedes). Do not add a replacement effect. With `userSelectedSessionId` no longer auto-cleared, user selection persists until the user clicks a different build. When `userSelectedSessionId` is `null` (initial state, or after a refresh), `currentSessionId` falls back to `latestSessionId` per line 41, preserving the default-selection behavior.

After deletion, the `useEffect` import on line 1 must remain - `useEffect` is still used by other hooks in the file (lines 59, 109, 197, 201, 218).

### Key Decisions

1. **No replacement effect.** The auto-switch-to-newest-build UX that the deleted effect was meant to enable (when a watched build finishes, let the next new build slide into view) is a niche win. Re-introducing it would require careful scoping (only on running -> complete transitions, only when the user has not selected a different build since the watch began) and is deferred per the source PRD. The new behavior is: explicit selection persists; new builds do not auto-switch the view.

2. **Single-file change, no test additions.** No existing test references `userSelectedSessionId`, the snap-back behavior, or the auto-clear effect (verified via repo-wide grep). The behavioral change is observable only end-to-end in the rendered UI; per the project's testing guidance, integration-level UI behavior is not covered by unit tests in this repo. Existing reducer and hook tests remain valid.

## Scope

### In Scope

- Delete the comment block and `useEffect` at `packages/monitor-ui/src/app.tsx:99-105`.

### Out of Scope

- Any change to `useEforgeEvents` (`packages/monitor-ui/src/hooks/use-eforge-events.ts`) or the cache-then-dispatch flow.
- Any change to `userSelectedSessionId` state declaration (line 31), `handleSelectSession` callback (lines 95-97), or `currentSessionId` derivation (line 41).
- Re-introducing an opt-in auto-switch UX (deferred follow-up per source PRD).
- Adding new tests for the deletion (no existing test covered the snap-back; UI behavior verification is end-to-end and out of scope for unit tests).

## Files

### Modify

- `packages/monitor-ui/src/app.tsx` - delete lines 99-105 (the two-line comment and the five-line `useEffect`, totaling 7 lines of code removed). Leave all surrounding code untouched: lines 95-97 `handleSelectSession`, line 107 onward `mergedPlanIds` block.

## Verification

- [ ] `packages/monitor-ui/src/app.tsx` no longer contains the string `Clear user selection when the watched session completes`.
- [ ] `packages/monitor-ui/src/app.tsx` no longer contains an effect with the condition `runState.isComplete && userSelectedSessionId === currentSessionId`.
- [ ] `packages/monitor-ui/src/app.tsx` still declares `const [userSelectedSessionId, setUserSelectedSessionId] = useState<string | null>(null);` unchanged.
- [ ] `packages/monitor-ui/src/app.tsx` still computes `const currentSessionId = userSelectedSessionId ?? latestSessionId;` unchanged.
- [ ] `packages/monitor-ui/src/app.tsx` `handleSelectSession` callback still calls `setUserSelectedSessionId(sessionId)` and is still passed as `onSelectSession` to the `Sidebar` component.
- [ ] `useEffect` is still imported on line 1 of `packages/monitor-ui/src/app.tsx` (it remains in use by 5 other effects in the file).
- [ ] `pnpm type-check` exits 0.
- [ ] `pnpm test` exits 0.
- [ ] `pnpm build` exits 0.
