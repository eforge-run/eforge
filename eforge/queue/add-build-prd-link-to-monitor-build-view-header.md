---
title: Add "Build PRD" link to monitor build view header
created: 2026-03-29
status: pending
---



# Add "Build PRD" link to monitor build view header

## Problem / Motivation

The monitor UI currently has no way to quickly view the PRD that initiated a build. The PRD content is only accessible via the timeline's "view source" link on `plan:start` events, which is buried and not easily discoverable.

## Goal

Add a visible, right-justified "Build PRD" link to the build view header so users can quickly open and read the PRD that initiated a build.

## Approach

- Single-file change to `src/monitor/ui/src/app.tsx`
- Destructure `openContentPreview` from `usePlanPreview()`
- Derive PRD source from the first `plan:start` event via `useMemo`
- Use the existing `openContentPreview` mechanism to slide in the markdown viewer panel (same behavior as plan file links)
- Wrap `SummaryCards` in a flex container with the "Build PRD" link right-justified next to the cost stat
- Style with `text-blue cursor-pointer hover:underline text-xs`, consistent with existing links
- The link only appears once a `plan:start` event has been received

## Scope

**In scope:**
- Adding the "Build PRD" link to the build view header
- Deriving PRD content from the first `plan:start` event
- Using existing `openContentPreview` / `usePlanPreview()` infrastructure

**Out of scope:**
- Changes to other files
- New preview mechanisms or components
- Changes to the timeline's existing "view source" link behavior

## Acceptance Criteria

- A "Build PRD" link appears right-justified in the build view header, next to the cost stat
- The link is only visible after a `plan:start` event has been received
- Clicking the link opens the markdown viewer panel showing the PRD content (via `openContentPreview`)
- The link is styled with `text-blue cursor-pointer hover:underline text-xs`
- `SummaryCards` is wrapped in a flex container to support the right-justified layout
- PRD source is derived from the first `plan:start` event using `useMemo`
- Implementation is contained to `src/monitor/ui/src/app.tsx`
