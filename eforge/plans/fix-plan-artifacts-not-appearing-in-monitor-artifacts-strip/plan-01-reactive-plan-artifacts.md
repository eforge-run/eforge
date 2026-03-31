---
id: plan-01-reactive-plan-artifacts
name: Reactive Plan Artifacts with Pill Chips
dependsOn: []
branch: fix-plan-artifacts-not-appearing-in-monitor-artifacts-strip/reactive-plan-artifacts
---

# Reactive Plan Artifacts with Pill Chips

## Architecture Context

The monitor's `ArtifactsStrip` component currently fetches plan data via a one-time REST call (`useApi`) keyed on `sessionId`. If the session is selected before the `plan:complete` SSE event arrives, the fetch returns empty and never retries. The PRD source is already derived reactively from SSE events in `app.tsx` - plans need the same treatment.

The `plan:complete` event carries the full `PlanFile[]` payload (with `id`, `name`, `body` fields), so all data needed for the artifacts strip is already in the SSE event stream - no REST fetch required.

## Implementation

### Overview

1. Derive `planArtifacts` from SSE events in `app.tsx` (parallel to existing `prdSource` derivation)
2. Replace `ArtifactsStrip`'s `sessionId` prop with a `plans` prop, removing the `useApi` fetch entirely
3. Redesign artifact items as pill-style chips with abbreviated labels, tooltips, and clickability affordances

### Key Decisions

1. **Derive from `plan:complete` event rather than refetching via REST** - The event payload contains all needed data (`id`, `name`, `body`). This eliminates the timing bug entirely and is consistent with how `prdSource` works.
2. **Abbreviate plan IDs to "Plan NN" with tooltip for full name** - Keeps the strip compact. Full names are accessible on hover via shadcn Tooltip.
3. **Use pill-style chips with `bg-cyan/15 text-cyan/70`** - Matches the existing `StagePill` pattern in `thread-pipeline.tsx` while using a distinct color to differentiate artifacts from pipeline stages.
4. **Use `openContentPreview` for plans instead of `openPreview`** - Since plan body is embedded in the event, this avoids a secondary REST fetch and works even after post-merge cleanup when plan files no longer exist on disk.

## Scope

### In Scope
- Adding `planArtifacts` useMemo derivation in `app.tsx`
- Changing `ArtifactsStrip` props from `sessionId` to `plans` array
- Removing `useApi` import and REST fetch from `ArtifactsStrip`
- Rendering artifact items as pill-style chip buttons
- Adding shadcn `Tooltip` with full plan name on hover
- Using `openContentPreview(label, body)` for click behavior on both PRD and plans
- Abbreviating plan IDs (e.g., `plan-01-some-name` -> `Plan 01`)

### Out of Scope
- Changes to the SSE event format or engine event types
- Changes to the REST API endpoints
- Architecture doc artifacts (currently work via `useApi` - separate concern)

## Files

### Modify
- `src/monitor/ui/src/app.tsx` - Add `planArtifacts` useMemo derivation from `plan:complete` events; change `ArtifactsStrip` props from `sessionId`+`prdSource` to `prdSource`+`plans`
- `src/monitor/ui/src/components/common/artifacts-strip.tsx` - Replace `sessionId` prop with `plans` prop; remove `useApi` import and fetch; add `abbreviatePlanId` helper; redesign items as pill chips with shadcn Tooltip; wrap strip in `TooltipProvider`; use `openContentPreview` for plan clicks

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm build` completes with exit code 0
- [ ] `pnpm test` passes with no regressions
- [ ] `ArtifactsStrip` no longer imports or uses `useApi`
- [ ] `ArtifactsStrip` accepts a `plans` array prop instead of `sessionId`
- [ ] Plan artifacts render as pill-style buttons with `bg-cyan/15` background class
- [ ] Each plan pill displays abbreviated label matching pattern "Plan NN"
- [ ] Hovering a plan pill shows a Tooltip containing the full plan name
- [ ] Clicking a plan pill calls `openContentPreview` with the plan name and body
- [ ] PRD artifact renders as a pill-style button (same visual treatment as plans)
