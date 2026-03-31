---
title: Build Failure Banner in Monitor UI
created: 2026-03-31
status: pending
depends_on: ["add-build-metrics-to-monitor-ui-summary-cards"]
---

# Build Failure Banner in Monitor UI

## Problem / Motivation

When a build fails, the error details are buried in the timeline console panel at the bottom of the monitor UI. The only top-level signals are a red "Failed" badge in SummaryCards and a red stage in the pipeline - neither shows _what_ went wrong. Users have no way to immediately see the cause of a failure without digging into the timeline.

## Goal

Add a prominent failure banner to the monitor UI that makes build errors immediately visible at a glance, positioned between the ArtifactsStrip and the tab selector.

## Approach

Add a `FailureBanner` component that only renders when `build:failed` events exist. All data is derived from the existing event stream via `useMemo` hooks - no reducer changes needed.

**Layout order after change:**
1. SummaryCards
2. ThreadPipeline
3. ArtifactsStrip
4. **FailureBanner** (new - only when failures exist)
5. Tab selector (Changes / Graph)
6. Tab content

### New component: `src/monitor/ui/src/components/common/failure-banner.tsx`

Props:
```ts
interface FailureBannerProps {
  failures: Array<{ planId: string; error: string }>;
  phaseSummary: string | null;
}
```

Visual structure:
```
[XCircle] Build Failed — "phase summary text here"
  plan-01  Agent exceeded max turns before completing implementation
  plan-02  Blocked by failed dependency: plan-01
```

- Red-tinted container: `bg-red/10 border border-red/25 rounded-lg px-4 py-3`
- `XCircle` icon from lucide-react (already used in SummaryCards)
- Phase summary from `phase:end` event shown as dimmer subtitle text
- Per-plan rows: mono plan ID badge + error message
- If 5+ failures: show first 3, collapse the rest with the existing `Collapsible` component

### Modifications to `src/monitor/ui/src/app.tsx`

- Import `FailureBanner`
- Add two `useMemo` hooks to derive failure data from `runState.events`:
  - `buildFailures`: scan for `build:failed` events, collect `{ planId, error }` tuples
  - `phaseSummary`: scan backward for last `phase:end` with `status === 'failed'`, return its summary
- Insert `<FailureBanner>` between `<ArtifactsStrip>` and the tab selector div

### Critical files

- `src/monitor/ui/src/components/common/failure-banner.tsx` (new)
- `src/monitor/ui/src/app.tsx` (modify - add import, useMemo hooks, render)
- `src/monitor/ui/src/components/ui/collapsible.tsx` (existing dependency)
- `src/monitor/ui/src/components/common/artifacts-strip.tsx` (reference for pill/abbreviation patterns)

## Scope

**In scope:**
- New `FailureBanner` component with red-tinted styling and per-plan error rows
- Deriving failure data from the existing event stream (no reducer changes)
- Collapsible overflow when 5+ failures exist
- Phase summary display from `phase:end` events

**Out of scope:**
- Changes to the event stream or reducer
- Modifications to existing failure indicators (SummaryCards badge, pipeline stage coloring)

## Acceptance Criteria

- [ ] `pnpm build` in `src/monitor/ui/` completes with no type errors
- [ ] When a build fails, the banner appears between ArtifactsStrip and the tab selector with red styling
- [ ] Each failed plan's ID and error message are visible as separate rows
- [ ] The phase summary text (from `phase:end` with `status === 'failed'`) is displayed as a dimmer subtitle
- [ ] The banner does not appear for successful builds
- [ ] For multi-plan failures, cascade errors ("Blocked by failed dependency") appear as separate rows
- [ ] When there are 5+ failures, only the first 3 are shown with the rest collapsed via `Collapsible`
