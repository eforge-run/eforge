---
title: Cancel-build button: clickability, confirmation, and daemon-shutdown clarification
created: 2026-04-30
---

# Cancel-build button: clickability, confirmation, and daemon-shutdown clarification

## Problem / Motivation

In the monitor UI sidebar, each running session shows a cancel icon. There are three problems:

1. **Looks unclickable.** The button uses `variant="ghost"` and `size="icon"` overridden to `h-auto w-auto p-0`. Tailwind preflight resets `<button>` to `cursor: default`, and the base `buttonVariants` cva in `packages/monitor-ui/src/components/ui/button.tsx` does not add `cursor-pointer`. Hovering shows a text/default cursor, so the icon doesn't read as interactive.
2. **No confirmation.** `onClick` calls `cancelSession(group.key)` immediately. A misclick instantly kills the worker.
3. **"Daemon dies" perception.** The user reports the daemon appears to die after cancel. Investigation shows cancel only sends SIGTERM to the worker subprocess. What actually happens: in ephemeral mode, once the cancel ends the only running run, the idle state machine in `packages/monitor/src/server-main.ts:527-603` transitions `WATCHING → COUNTDOWN → SHUTDOWN`. This is by design, but is conflated with the cancel action because they happen back-to-back.

## Goal

Cancelling a build should be a deliberate, two-step action with a clearly clickable button, and the daemon-shutdown countdown (already wired) should make it obvious that any subsequent shutdown is the idle timer, not the cancel itself.

## Approach

### 1. Make all buttons show a pointer cursor (1-line cva change)

Add `cursor-pointer` to the base class string in `buttonVariants` in `packages/monitor-ui/src/components/ui/button.tsx:7`. The `disabled:pointer-events-none` already prevents hover interaction on disabled buttons; the disabled-cursor visual is handled by `disabled:opacity-50`. Adding `cursor-pointer` to the base affects every Button in the app and aligns with shadcn's typical defaults - preferred over a one-off className on this button.

### 2. Add shadcn AlertDialog and wrap the cancel button

`@radix-ui/react-alert-dialog` is not yet a dep. Install it and add a standard shadcn `alert-dialog.tsx` component:

- Add dep: `@radix-ui/react-alert-dialog` to `packages/monitor-ui/package.json` (matches the `^1.x` pattern of sibling Radix packages already there).
- Create `packages/monitor-ui/src/components/ui/alert-dialog.tsx` (the standard shadcn file: `AlertDialog`, `AlertDialogTrigger`, `AlertDialogContent`, `AlertDialogHeader`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogCancel`, `AlertDialogAction`).

Then in `packages/monitor-ui/src/components/layout/sidebar.tsx:71-85`, replace the bare `<Button>` with:

```tsx
<AlertDialog>
  <AlertDialogTrigger asChild>
    <Button
      type="button"
      variant="ghost"
      size="icon"
      title="Cancel this session"
      className="h-auto w-auto p-0"
      onClick={(e) => e.stopPropagation()}
    >
      <CircleStop size={14} />
    </Button>
  </AlertDialogTrigger>
  <AlertDialogContent onClick={(e) => e.stopPropagation()}>
    <AlertDialogHeader>
      <AlertDialogTitle>Cancel this build?</AlertDialogTitle>
      <AlertDialogDescription>
        The running worker will be terminated and any in-progress work will be lost.
        Files staged in the worktree may remain.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Keep running</AlertDialogCancel>
      <AlertDialogAction
        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
        onClick={() => cancelSession(group.key)}
      >
        Cancel build
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

The `e.stopPropagation()` on both the trigger and the content prevents the surrounding `SessionItem` `onClick={onSelect}` (line 59) from firing when interacting with the dialog.

### 3. Daemon-shutdown perception: verify, don't change code

The cancel handler at `packages/monitor/src/server-main.ts:282-346` (`cancelWorker`) sends `SIGTERM` to `child.pid` only; the daemon process is unaffected. After all runs end, the existing state machine triggers a countdown, broadcasts `monitor:shutdown-pending` (server-main.ts:544), and the UI's `use-eforge-events.ts:112-119` already starts a visible countdown tick. With an open subscriber, `COUNTDOWN_WITH_SUBSCRIBERS_MS` is used, which gives time to react.

No code change here - just verify in the manual test that:

- The daemon process is still alive immediately after cancel (`eforge_status` returns OK).
- If the daemon does eventually shut down, a countdown banner appears first.

If the verification surfaces a real bug (e.g. countdown not visible, daemon exits with no countdown), capture it as a separate follow-up - out of scope for this plan.

### Files to modify

- `packages/monitor-ui/src/components/ui/button.tsx` - add `cursor-pointer` to base cva string at line 7.
- `packages/monitor-ui/package.json` - add `@radix-ui/react-alert-dialog` dependency.
- `packages/monitor-ui/src/components/ui/alert-dialog.tsx` - new file, standard shadcn component.
- `packages/monitor-ui/src/components/layout/sidebar.tsx` - wrap cancel button in AlertDialog (lines 71-85), add imports.

## Scope

### In scope

- 1-line cva change in `packages/monitor-ui/src/components/ui/button.tsx:7` to add `cursor-pointer` to the base class string.
- Adding `@radix-ui/react-alert-dialog` (matching the `^1.x` pattern of sibling Radix packages) to `packages/monitor-ui/package.json`.
- New `packages/monitor-ui/src/components/ui/alert-dialog.tsx` (standard shadcn component exporting `AlertDialog`, `AlertDialogTrigger`, `AlertDialogContent`, `AlertDialogHeader`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogCancel`, `AlertDialogAction`).
- Wrapping the cancel button in `packages/monitor-ui/src/components/layout/sidebar.tsx:71-85` with the AlertDialog (with `e.stopPropagation()` on trigger and content to prevent the surrounding `SessionItem` `onClick={onSelect}` at line 59 from firing).
- Manual verification that the daemon stays alive after cancel and that any subsequent shutdown is preceded by a countdown banner.

### Out of scope

- Changing the daemon idle-shutdown state machine.
- Replacing `cancelSession`'s API contract or worker termination semantics (still SIGTERM-only).
- Backporting AlertDialog usage to other destructive actions in the UI (separate sweep if desired).
- Any code changes resulting from the daemon-shutdown verification - if a real bug is found (e.g. countdown not visible, daemon exits with no countdown), it must be captured as a separate follow-up.

## Acceptance Criteria

1. `pnpm install` succeeds and picks up the new Radix dep.
2. `pnpm build` completes with no type errors.
3. Starting the daemon and enqueuing a long-running build (any project with eforge, via `eforge_enqueue` with a slow PRD) works as before.
4. In the monitor UI, hovering the stop icon next to the running session shows a pointer cursor.
5. Clicking the stop icon opens an AlertDialog with the title "Cancel this build?" and two buttons.
6. Clicking "Keep running" closes the dialog and leaves the build running.
7. Clicking the stop icon again and then "Cancel build" closes the dialog and transitions the session to failed/Cancelled in the sidebar.
8. Immediately after cancel, `eforge_status` confirms the daemon is still alive. If the only build was cancelled, any subsequent shutdown is preceded by a visible countdown banner (existing behavior) - the daemon must not exit without first showing the countdown.
9. Smoke-testing other buttons in the UI (e.g. enqueue submit, queue actions) shows they also display pointer cursors on hover.
10. Interacting with the AlertDialog (trigger and content) does not trigger the surrounding `SessionItem` `onClick={onSelect}` handler.
