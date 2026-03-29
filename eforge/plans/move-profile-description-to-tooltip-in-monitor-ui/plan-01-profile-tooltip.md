---
id: plan-01-profile-tooltip
name: Move Profile Description to Tooltip
depends_on: []
branch: move-profile-description-to-tooltip-in-monitor-ui/profile-tooltip
---

# Move Profile Description to Tooltip

## Architecture Context

The `ProfileHeader` component in `thread-pipeline.tsx` renders the profile badge, optional "extends" badge, and inline description text. The component already uses shadcn `Tooltip`/`TooltipContent`/`TooltipTrigger` for the profile name badge (showing rationale on hover). This change removes the inline description and distributes it into existing tooltip patterns.

## Implementation

### Overview

Remove the inline description `<span>` from `ProfileHeader` and add the description to tooltips:
- When `profileInfo.config.extends` exists, wrap the "extends <base>" text in a `Tooltip` showing the description on hover.
- When there is no `extends` (base profile used directly), append the description below the rationale in the existing profile name badge tooltip.

### Key Decisions

1. **Reuse existing Tooltip components** - The file already imports and uses `Tooltip`, `TooltipContent`, `TooltipTrigger` from shadcn/ui, so no new dependencies are needed.
2. **Conditional tooltip content** - The profile name badge tooltip shows rationale unconditionally; when there's no `extends`, it also shows the description. This keeps all profile info accessible from one hover target.

## Scope

### In Scope
- Removing the inline description `<span>` on line 165
- Wrapping the "extends <base>" text in a `Tooltip` that shows `profileInfo.config.description`
- Appending description to the profile name badge tooltip when `extends` is absent

### Out of Scope
- Changes to any other components or files
- Styling changes beyond tooltip additions

## Files

### Modify
- `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx` - Remove inline description span from `ProfileHeader`, add description tooltip to "extends" badge, conditionally add description to profile name badge tooltip

## Verification

- [ ] `pnpm type-check` exits with code 0
- [ ] `pnpm build` exits with code 0
- [ ] The inline `<span>` containing `profileInfo.config.description` is no longer rendered as visible text in `ProfileHeader`
- [ ] When `profileInfo.config.extends` is set, the "extends <base>" text is wrapped in a `Tooltip` whose `TooltipContent` contains `profileInfo.config.description`
- [ ] When `profileInfo.config.extends` is not set, the profile name badge `TooltipContent` contains both the rationale and the description
