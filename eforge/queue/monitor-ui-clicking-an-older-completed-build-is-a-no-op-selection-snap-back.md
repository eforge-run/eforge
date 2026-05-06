---
title: Monitor UI: clicking an older completed build is a no-op (selection snap-back)
created: 2026-05-06
---

# Monitor UI: clicking an older completed build is a no-op (selection snap-back)

## Problem / Motivation

In the monitor UI, clicking on a completed build in the sidebar (other than the latest one) is a visual no-op. The main panel does not switch to show the clicked build's pipeline, log, or events. Browser refresh does not help — every click on an older completed build is silently dropped.

**User-reported behavior:** "Once a build completes, the UI freezes. I cannot select a different build in the view now that one view completed. I must refresh the browser to be able to do that. [...] Even on refresh I can't select. Nothing happens when I click an older build. No switching of the view at all."

**User impact:** Users can only inspect the most recently started build. Past completed builds are visible in the sidebar but unreachable. There is no error message or visible feedback — the click silently does nothing, which looks like a hard freeze.

This is independent of the SSE/snapshot bug pair tracked in `2026-05-06-monitor-ui-sse-replay-snapshot-fix`. Different file, different reducer slice, different root cause.

**Profile signal: Errand.** Single-file change. Removes 7 lines (one `useEffect` block plus its comment) in `packages/monitor-ui/src/app.tsx`. No new dependencies, no protocol change, no test infrastructure required. Mechanical edit with high confidence in the cause.

### Root cause

`packages/monitor-ui/src/app.tsx:99-105`:
```ts
useEffect(() => {
  if (runState.isComplete && userSelectedSessionId === currentSessionId) {
    setUserSelectedSessionId(null);
  }
}, [runState.isComplete, currentSessionId, userSelectedSessionId]);
```

Comment intent: "Clear user selection when the watched session completes so future new sessions can auto-switch again." That intent assumes the effect only fires on a *transition* from running to complete. It does not — it fires whenever `runState.isComplete` is true and the user has explicitly selected a session.

When the user clicks an already-complete build:
1. `setUserSelectedSessionId('clicked')` schedules a re-render.
2. Re-render: `currentSessionId === 'clicked'`, but `runState` is still the previous (latest) build's state because `useEforgeEvents`' dispatch hasn't applied yet — and that `runState.isComplete` is `true` (latest is complete).
3. The effect fires: condition matches → `setUserSelectedSessionId(null)`.
4. Re-render: `currentSessionId` falls back to `latestSessionId`. View never actually swapped.

The auto-clear effect has a race with `useEforgeEvents`' async dispatch and ends up reading stale state, firing in cases where it shouldn't. The auto-switch UX it was meant to enable (when a watched build finishes, let new builds auto-switch into view) is a niche win not worth the cost.

**Confidence: HIGH on the file and the responsible effect** (read the code end-to-end; intent is documented in the comment).
**Confidence: MEDIUM on the precise React render-cycle interaction** (reasoning about it without instrumenting React's scheduler, but the user-visible symptoms match).

### Reproduction Steps

**Prerequisite:** Have at least two completed builds in the eforge daemon's history, plus optionally a more recent (running or completed) build.

1. Open the monitor UI in a browser. The main panel shows the most recent build (`latestSessionId`).
2. In the sidebar, locate an OLDER completed build (not the latest).
3. Click on the older completed build's card.
4. **Observed:** Nothing visible happens. The main panel continues to show the latest build. The sidebar's active highlight may flicker for one frame but does not stick on the clicked item.
5. **Expected:** The main panel switches to show the clicked build's pipeline, log, and events. The sidebar's active highlight moves to the clicked item.
6. Refresh the browser tab and repeat step 3 — same result. The bug is in the live React state machine, not in any persisted client state.

## Goal

Make clicking any completed build in the sidebar reliably switch the main panel to that build's view, with the selection persisting until the user explicitly chooses another build.

## Approach

Remove the auto-clear `useEffect` (and its comment) at `packages/monitor-ui/src/app.tsx:99-105`. Do not add a replacement effect. User selection becomes explicit and persists until the user clicks a different build. The `userSelectedSessionId` state and `handleSelectSession` callback (`app.tsx:31, 95-97`) remain unchanged. With no `userSelectedSessionId`, `currentSessionId` defaults to `latestSessionId` per `app.tsx:41`.

## Scope

**In scope**

- Removing the auto-clear effect at `packages/monitor-ui/src/app.tsx:99-105` (including the comment block).
- Verifying the resulting behavior end-to-end in the monitor UI.
- Quality gates: `pnpm type-check`, `pnpm test`, `pnpm build`.
- Updating or removing any existing test that depends on the snap-back behavior.

**Out of scope (deferred follow-up)**

- Re-introducing an auto-switch UX (e.g., "when a NEW build starts and I'm watching the latest-as-default, follow it"). If desired, this can be added later as an explicit, opt-in subscription rather than the current implicit clear-on-complete.
- Any change to `useEforgeEvents` (the cache-then-dispatch flow at `use-eforge-events.ts:56-62`). The fix here is upstream of that race entirely.

## Acceptance Criteria

**Code change**

1. `packages/monitor-ui/src/app.tsx` — remove the auto-clear effect at lines 99-105 (including the comment block):
   ```ts
   // Clear user selection when the watched session completes so future new
   // sessions can auto-switch again.
   useEffect(() => {
     if (runState.isComplete && userSelectedSessionId === currentSessionId) {
       setUserSelectedSessionId(null);
     }
   }, [runState.isComplete, currentSessionId, userSelectedSessionId]);
   ```
2. No replacement effect. User selection is explicit and persists until the user clicks a different build. New builds starting do not auto-switch the view.
3. The `userSelectedSessionId` state and `handleSelectSession` callback (`app.tsx:31, 95-97`) remain unchanged.

**Behavioral end-to-end**

4. Click an older completed build in the sidebar. Main panel switches to show that build's pipeline, log, events. Sidebar active-highlight moves to the clicked item.
5. Click a different older completed build. Main panel switches again. Selection sticks.
6. Click the most recent build (the one that would have been the default). Active-highlight moves to it. Behavior matches default-selection state.
7. Start a new build (e.g. `/eforge:build`) while watching an older completed one. The view does NOT auto-switch — the user keeps watching what they explicitly chose. (This is the deliberate UX trade-off; documented in the deferred follow-up.)
8. Refresh the browser. With no `userSelectedSessionId`, `currentSessionId` defaults to `latestSessionId` per `app.tsx:41`. Verified: the most recent build is shown.

**Quality gates**

9. `pnpm type-check` passes.
10. `pnpm test` passes (no existing test should depend on the snap-back behavior; if one does, update or remove).
11. `pnpm build` succeeds.
