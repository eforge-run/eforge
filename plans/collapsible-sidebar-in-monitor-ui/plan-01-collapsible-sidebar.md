---
id: plan-01-collapsible-sidebar
name: Collapsible Sidebar Toggle
depends_on: []
branch: collapsible-sidebar-in-monitor-ui/collapsible-sidebar
---

# Collapsible Sidebar Toggle

## Architecture Context

The monitor UI uses a CSS Grid layout in `AppLayout` with a fixed 280px left sidebar column. The `Header` spans both columns and displays the "eforge" logo, project context, and connection status. State is managed in `app.tsx` and threaded down as props. `lucide-react` is already a project dependency with icons used throughout the UI. The project uses shadcn/ui `Button` component with a `ghost` variant available.

## Implementation

### Overview

Add a `sidebarCollapsed` boolean state to `app.tsx`, thread it to `AppLayout` (to toggle the grid column width) and `Header` (to render a toggle button). The sidebar collapses by transitioning `grid-template-columns` from `280px 1fr` to `0px 1fr`, with `overflow-hidden` on the sidebar slot to clip content at 0px width.

### Key Decisions

1. Use inline `style` prop for `gridTemplateColumns` instead of Tailwind classes - CSS transitions on grid-template-columns require dynamic values that Tailwind arbitrary values handle poorly with state changes.
2. Place the toggle button before the "eforge" text in the header so it remains visible and accessible regardless of sidebar state.
3. Use `PanelLeftClose` icon when sidebar is expanded (clicking will close) and `PanelLeft` icon when collapsed (clicking will open) - follows the convention of showing the action the button will perform.

## Scope

### In Scope
- Boolean state in `app.tsx` for sidebar collapsed/expanded
- Toggle button in `Header` using lucide-react icons
- CSS grid transition animation on `AppLayout`
- Overflow clipping on sidebar slot when collapsed

### Out of Scope
- Persisting sidebar state to localStorage
- Keyboard shortcut for toggling
- Changes to the vertical ResizablePanelGroup behavior

## Files

### Modify
- `src/monitor/ui/src/app.tsx` - Add `sidebarCollapsed` state via `useState(false)`, pass `sidebarCollapsed` and `onToggleSidebar={() => setSidebarCollapsed(prev => !prev)}` as props to both `AppLayout` and `Header`
- `src/monitor/ui/src/components/layout/app-layout.tsx` - Accept `sidebarCollapsed: boolean` prop, switch from static `grid-cols-[280px_1fr]` Tailwind class to dynamic `style={{ gridTemplateColumns }}`, add `transition-[grid-template-columns] duration-200` classes, add `overflow-hidden` on the sidebar wrapper div
- `src/monitor/ui/src/components/layout/header.tsx` - Accept `sidebarCollapsed: boolean` and `onToggleSidebar: () => void` props, render a ghost `Button` with `PanelLeftClose`/`PanelLeft` icon before the "eforge" text

## Verification

- [ ] `pnpm --filter @eforge/monitor-ui build` completes with exit code 0
- [ ] `pnpm type-check` completes with exit code 0
- [ ] Header renders a toggle button with `PanelLeftClose` icon when sidebar is expanded
- [ ] Header renders a toggle button with `PanelLeft` icon when sidebar is collapsed
- [ ] Clicking the toggle button sets `gridTemplateColumns` to `0px 1fr` on the layout grid container
- [ ] Clicking the toggle button again sets `gridTemplateColumns` back to `280px 1fr`
- [ ] The layout grid container has `transition-[grid-template-columns] duration-200` classes for smooth animation
- [ ] The sidebar slot div has `overflow-hidden` to clip content when width is 0
- [ ] The existing `ResizablePanelGroup` vertical split continues to function after sidebar collapse/expand
