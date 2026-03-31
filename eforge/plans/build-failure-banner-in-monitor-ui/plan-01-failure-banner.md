---
id: plan-01-failure-banner
name: Build Failure Banner Component
depends_on: []
branch: build-failure-banner-in-monitor-ui/failure-banner
---

# Build Failure Banner Component

## Architecture Context

The monitor UI renders build state in a vertical layout: SummaryCards → ThreadPipeline → ArtifactsStrip → tab selector → tab content. When builds fail, the only top-level signals are a red "Failed" badge in SummaryCards and a red stage in ThreadPipeline. The actual error messages are buried in the timeline console panel at the bottom. This plan adds a prominent `FailureBanner` component between ArtifactsStrip and the tab selector that surfaces per-plan error messages and the phase summary.

All data is derived from the existing `runState.events` array via `useMemo` hooks in `app.tsx` - no reducer changes needed.

## Implementation

### Overview

Create a new `FailureBanner` component and wire it into `app.tsx` with two `useMemo` hooks that scan the event stream for `build:failed` and `phase:end` events.

### Key Decisions

1. **Data derivation in app.tsx, not in the component** - keeps `FailureBanner` a pure presentational component receiving props, consistent with how `SummaryCards` and `ArtifactsStrip` receive their data.
2. **Collapsible for 5+ failures** - uses the existing Radix `Collapsible` component already available in `src/monitor/ui/src/components/ui/collapsible.tsx` rather than adding new UI primitives.
3. **Red-tinted container styling** - follows the established color pattern where `text-red` and `bg-red/*` variants are already used in `status-badge.tsx` and `summary-cards.tsx`.
4. **XCircle icon** - reuses the same icon already imported in `summary-cards.tsx` for consistency.
5. **Plan ID abbreviation** - reuses the `abbreviatePlanId` pattern from `artifacts-strip.tsx` (e.g., "plan-01-auth" → "Plan 01") for the per-plan badges. Extract or duplicate the helper since it's a simple 3-line function.

## Scope

### In Scope
- New `FailureBanner` component with red-tinted container, XCircle icon, phase summary subtitle, and per-plan error rows
- Two `useMemo` hooks in `app.tsx` to derive `buildFailures` and `phaseSummary` from `runState.events`
- Collapsible overflow when 5+ failures exist (show first 3, collapse rest)
- Rendering the banner between `ArtifactsStrip` and the tab selector div

### Out of Scope
- Changes to the event stream, reducer, or types
- Modifications to existing failure indicators (SummaryCards badge, ThreadPipeline stage coloring)
- Click-to-navigate from failure rows to timeline entries

## Files

### Create
- `src/monitor/ui/src/components/common/failure-banner.tsx` - FailureBanner component with props `{ failures: Array<{ planId: string; error: string }>; phaseSummary: string | null }`

### Modify
- `src/monitor/ui/src/app.tsx` - Import FailureBanner, add two `useMemo` hooks scanning `runState.events` for `build:failed` events and `phase:end` with `status === 'failed'`, render `<FailureBanner>` between `<ArtifactsStrip>` and the tab selector div (line ~307)

## Verification

- [ ] `pnpm build` in `src/monitor/ui/` completes with zero type errors
- [ ] `FailureBanner` renders only when `failures` array is non-empty (returns `null` otherwise)
- [ ] Banner appears between `ArtifactsStrip` and the tab selector div in the layout
- [ ] Container uses red-tinted styling: `bg-red/10 border border-red/25 rounded-lg`
- [ ] XCircle icon from lucide-react is displayed in the header row
- [ ] Phase summary text from the last `phase:end` event with `status === 'failed'` is shown as dimmer subtitle text
- [ ] Each failed plan renders as a separate row with a mono plan ID badge and error message
- [ ] Plan IDs are abbreviated using the same pattern as ArtifactsStrip (e.g., "plan-01-foo" → "Plan 01")
- [ ] When there are fewer than 5 failures, all rows are visible without collapsible
- [ ] When there are 5+ failures, only the first 3 rows are visible and the rest are inside a `Collapsible` with a trigger showing the count of hidden failures
- [ ] The `buildFailures` useMemo scans for events with `type === 'build:failed'` and collects `{ planId, error }` tuples
- [ ] The `phaseSummary` useMemo scans backward for the last `phase:end` event where `result.status === 'failed'` and returns `result.summary`
