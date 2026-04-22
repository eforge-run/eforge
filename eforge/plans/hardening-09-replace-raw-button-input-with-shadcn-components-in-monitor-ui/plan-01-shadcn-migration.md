---
id: plan-01-shadcn-migration
name: Migrate raw button/input to shadcn components
depends_on: []
branch: hardening-09-replace-raw-button-input-with-shadcn-components-in-monitor-ui/shadcn-migration
---

# Migrate raw button/input to shadcn components

## Architecture Context

The monitor UI (`packages/monitor-ui/`) is built on shadcn/ui. `AGENTS.md` mandates: "The monitor UI uses shadcn/ui components rather than custom UI primitives." The codebase has drifted from this rule — raw `<button>` and `<input>` elements with inline Tailwind classes appear across 12 component files. This plan restores compliance.

Existing shadcn inventory in `packages/monitor-ui/src/components/ui/`:
- `button.tsx` — present. CVA defines variants `default | destructive | outline | secondary | ghost | link` and sizes `default | sm | lg | icon`. This covers every inline style found in the offender sites; no new variants are required.
- `input.tsx` — **missing**. Must be created as the standard shadcn Input primitive before migrating input sites.

All migrated sites must compose layout/positioning classes through `className` (shadcn `Button`/`Input` use `cn()` internally) rather than reintroducing the full inline class string. Preserve all handlers (`onClick`, `onChange`, `onKeyDown`, etc.), accessibility attributes (`aria-*`, `title`, `role`), `disabled`, `type`, `value`, `placeholder`, and `ref` forwarding.

## Implementation

### Overview

1. Create the missing shadcn `Input` primitive at `packages/monitor-ui/src/components/ui/input.tsx` using the canonical shadcn implementation (forwardRef, `cn()` composition, standard `h-9` baseline with `text-sm`, focus ring, disabled styles).
2. Migrate every raw `<button>` / `<input>` in the 11 offender files to `Button` / `Input`, mapping inline Tailwind to `variant` and `size` props. Keep only layout/positioning classes in `className`.
3. Verify there are zero remaining raw `<button>` or `<input>` elements in `packages/monitor-ui/src/components/` outside `components/ui/`.

### Variant mapping rules

- Transparent / text-only / icon-only click targets → `variant="ghost"`.
- Destructive confirmations (e.g., shutdown, dismiss-with-side-effect) → `variant="destructive"`.
- Primary CTA → default (omit `variant`).
- Outlined → `variant="outline"`.
- Small icon-only buttons → `size="icon"` (keep shape) or `size="sm"` for compact text buttons. Override dimensions via `className` only when the icon button must be tighter than `h-9 w-9` (e.g., sidebar collapse chevrons).
- For inputs, use shadcn `Input` defaults. Compact search inputs may need `className="h-8 text-xs"` override; otherwise rely on defaults.

When the inline class string carried non-visual semantics (e.g., `flex items-center gap-1`, `w-full`, `mt-1`, absolute positioning), keep only those layout-specific classes in `className`. Drop background/hover/text/border/rounded/padding/focus classes that the shadcn variant already provides.

### Key Decisions

1. **Create `Input` instead of inlining fixes.** The only input site (`sidebar.tsx:183`) is a search box; a proper shadcn `Input` primitive is needed both for this migration and for any future inputs. Canonical shadcn implementation is trivial and already matches the repo's component style (see `button.tsx`).
2. **No new Button variants.** The existing CVA already covers every observed inline style. Do NOT extend the CVA; if a site's style doesn't fit cleanly, pass the remaining layout classes via `className` and pick the closest variant — the shadcn composition model handles the rest.
3. **No logic changes.** Every migrated site must preserve existing handlers, state, refs, keyboard behavior, and `type` attributes (important: `type="button"` vs default `"submit"` matters inside forms; shadcn `Button` does not default `type`, so retain explicit `type` attributes where the original set them).
4. **Skip the optional eslint/CI grep guard.** Out of scope per the source's "optional" label; verification grep below suffices to catch regressions at review time.

### Per-file migration plan

**`packages/monitor-ui/src/components/ui/input.tsx` (CREATE)** — standard shadcn `Input` primitive.

**`packages/monitor-ui/src/components/layout/sidebar.tsx`**
- Line 69: nav item button → `Button variant="ghost"` with retained layout/active-state `className`.
- Line 183: `<input>` search → `Input` with size-overriding `className` if needed; preserve `value`, `onChange`, `placeholder`, `type`.
- Line 196: collapse/toggle button → `Button variant="ghost" size="icon"`.
- Line 220: action button → map to `ghost` or `outline` per visible style; preserve handlers.
- This is the nav — migrate carefully, do not change layout.

**`packages/monitor-ui/src/components/layout/shutdown-banner.tsx`**
- Line 36: restart/shutdown action → `Button variant="destructive"` (destructive confirmation per source guidance).

**`packages/monitor-ui/src/components/common/failure-banner.tsx`**
- Line 78: text-only dismiss/toggle button (`flex items-center gap-1 text-[11px] text-text-dim hover:text-text-bright transition-colors mt-1 cursor-pointer`) → `Button variant="ghost" size="sm"` with retained layout classes.

**`packages/monitor-ui/src/components/console/console-panel.tsx`**
- Line 53: tab/segment button → `Button variant="ghost"` (or `secondary` for the active state if the original used a background fill).
- Line 77: filter/clear button → `Button variant="ghost" size="sm"`; confirm click handler still fires.
- Line 100: row-level action → `Button variant="ghost" size="sm"`.

**`packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx`**
- Lines 737, 754, 775: thread interaction buttons → `Button variant="ghost"` with size matching the original footprint; preserve all click/keyboard handlers.

**`packages/monitor-ui/src/components/heatmap/file-heatmap.tsx`**
- Line 147: row toggle button → `Button variant="ghost"`.

**`packages/monitor-ui/src/components/heatmap/diff-viewer.tsx`**
- Line 132: diff toggle button → `Button variant="ghost"`.

**`packages/monitor-ui/src/components/plans/plan-card.tsx`**
- Line 83: card action button → match original variant (likely `ghost` or `outline`).

**`packages/monitor-ui/src/components/preview/plan-metadata.tsx`**
- Line 68: metadata toggle → `Button variant="ghost" size="sm"`.

**`packages/monitor-ui/src/components/preview/plan-preview-panel.tsx`**
- Line 106: preview panel control → `Button variant="ghost"`.

**`packages/monitor-ui/src/components/timeline/event-card.tsx`**
- Line 286: event expand/collapse toggle → `Button variant="ghost" size="sm"`.

## Scope

### In Scope
- Creating `packages/monitor-ui/src/components/ui/input.tsx` (shadcn Input primitive).
- Replacing every raw `<button>` and `<input>` in the 11 files listed above with shadcn `Button` / `Input`.
- Mapping inline Tailwind classes to `variant` / `size` props; retaining only layout/positioning classes via `className`.
- Preserving all handlers, refs, accessibility attributes, `type`, `disabled`, `value`, `placeholder`, `onChange`.

### Out of Scope
- Extending the existing shadcn `Button` CVA with new variants (existing variants cover all sites).
- Adding eslint / CI grep regression guards (source marks optional; verification grep suffices).
- Visual redesign, logic changes, state-management refactors.
- Introducing other shadcn primitives (`Toggle`, `Select`, etc.) unless a site's original element was genuinely a toggle/select rather than a button — none of the offenders are.
- Migrating any file not listed above.

## Files

### Create
- `packages/monitor-ui/src/components/ui/input.tsx` — canonical shadcn Input primitive (forwardRef, `cn()` composition, matches `button.tsx` style).

### Modify
- `packages/monitor-ui/src/components/layout/sidebar.tsx` — 3 `<button>` + 1 `<input>` → `Button` / `Input`.
- `packages/monitor-ui/src/components/layout/shutdown-banner.tsx` — 1 `<button>` → `Button variant="destructive"`.
- `packages/monitor-ui/src/components/common/failure-banner.tsx` — 1 `<button>` → `Button variant="ghost"`.
- `packages/monitor-ui/src/components/console/console-panel.tsx` — 3 `<button>` → `Button`.
- `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` — 3 `<button>` → `Button`.
- `packages/monitor-ui/src/components/heatmap/file-heatmap.tsx` — 1 `<button>` → `Button`.
- `packages/monitor-ui/src/components/heatmap/diff-viewer.tsx` — 1 `<button>` → `Button`.
- `packages/monitor-ui/src/components/plans/plan-card.tsx` — 1 `<button>` → `Button`.
- `packages/monitor-ui/src/components/preview/plan-metadata.tsx` — 1 `<button>` → `Button`.
- `packages/monitor-ui/src/components/preview/plan-preview-panel.tsx` — 1 `<button>` → `Button`.
- `packages/monitor-ui/src/components/timeline/event-card.tsx` — 1 `<button>` → `Button`.

## Verification

- [ ] `pnpm --filter @eforge-build/monitor-ui type-check` exits 0.
- [ ] `pnpm --filter @eforge-build/monitor-ui build` exits 0.
- [ ] `rg "^\s*<button\b" packages/monitor-ui/src/components` returns zero matches outside `packages/monitor-ui/src/components/ui/`.
- [ ] `rg "^\s*<input\b" packages/monitor-ui/src/components` returns zero matches outside `packages/monitor-ui/src/components/ui/`.
- [ ] `packages/monitor-ui/src/components/ui/input.tsx` exists and exports `Input` as a `React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>` composed via `cn()`.
- [ ] Every migrated site imports `Button` from `@/components/ui/button` (or relative equivalent) and — where inputs were migrated — `Input` from `@/components/ui/input`.
- [ ] Every migrated `<button>` retains its original `onClick` handler, `type` attribute (when originally set), `disabled` prop, and any `aria-*` / `title` attributes. Grep for each original handler name inside the migrated file to confirm presence.
- [ ] Every migrated `<input>` retains `value`, `onChange`, `placeholder`, `type`, and any `aria-*` attributes.
- [ ] No inline background/hover/text-color/border/padding/rounded/focus Tailwind classes remain on any migrated element — only layout/positioning classes (flex, gap, margin, padding-for-layout, width, position) may remain in `className`.
- [ ] No new variants were added to `packages/monitor-ui/src/components/ui/button.tsx` (file is unmodified relative to base branch).
- [ ] Manual verification: run the monitor UI and exercise each migrated surface (sidebar nav/search, failure-banner dismiss, shutdown-banner restart, console-panel controls, pipeline thread buttons, heatmap file/diff toggles, plan-card action, preview panel controls, timeline event-card toggle). Confirm no functional regressions and visual parity in both dark and light themes.
