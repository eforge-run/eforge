---
description: Identify and remove shipped items from the project roadmap
disable-model-invocation: true
argument-hint: "[--auto]"
---

# /eforge:roadmap-prune

Keep the roadmap future-focused by identifying and removing items that have shipped. The counterpart to the graduation lifecycle — when code reaches CLAUDE.md, it leaves the roadmap.

## Arguments

- `--auto` (optional) — Automatically remove items classified as "Shipped" without interactive confirmation. "Uncertain" items always require confirmation regardless of this flag.

## Workflow

### Step 1: Parse Roadmap

Read `docs/roadmap.md` and extract:
- All sections (headings, goals, bullet points)
- Individual bullet items for analysis

If `docs/roadmap.md` doesn't exist, report:

> No roadmap found. Run `/eforge:roadmap-init` to create one.

**Stop here** if the roadmap doesn't exist.

### Step 2: Check Each Item

For each bullet point, gather evidence from multiple sources:

| Source | What to check |
|--------|--------------|
| Codebase | Grep for key terms, check file existence |
| Git history | Recent commits matching the capability |
| CLAUDE.md | Feature documented in architecture/commands sections |
| Plan files | Completed plans that addressed this item |
| `.eforge/state.json` | Completed build sets |

### Step 3: Classify

Assign each item a classification:

| Classification | Criteria |
|---------------|---------|
| Shipped | Strong evidence in code AND documented in CLAUDE.md |
| Partially shipped | Some evidence but not fully delivered |
| Pending | No evidence of implementation |
| Uncertain | Ambiguous — needs user judgment |

### Step 4: Present Findings

Output a structured analysis:

```markdown
## Roadmap Prune Analysis

### Ready to Remove ({count})

| Item | Section | Evidence |
|------|---------|----------|
| {bullet} | {section} | {evidence summary} |

### Partially Shipped ({count})

| Item | Section | Done | Remaining |
|------|---------|------|-----------|
| {bullet} | {section} | {what's done} | {what remains} |

### Still Pending ({count})

These stay on the roadmap.

### Uncertain ({count})

| Item | Section | Question |
|------|---------|----------|
| {bullet} | {section} | {what's ambiguous} |
```

### Step 5: Confirm and Remove

- **Default (interactive)**: Confirm each removal with the user before editing the roadmap
- **`--auto` mode**: Remove items classified as "Shipped" without asking
- "Uncertain" items always require user confirmation, even in `--auto` mode
- "Partially shipped" items are presented for user decision — keep, remove, or rewrite the bullet

Apply removals to `docs/roadmap.md` using the Edit tool.

### Step 6: Clean Up

If all bullets have been removed from a section, remove the entire section:
- Section heading (`## Title`)
- Goal line
- All content
- Trailing separator (`---`) if present

### Step 7: Suggest CLAUDE.md Updates

For each shipped item that isn't yet documented in CLAUDE.md, suggest where to add it:

> **Not yet in CLAUDE.md**: "{item}" — suggest adding to the `{section}` section.

### Step 8: Summary

Output a final summary:

```markdown
## Prune Complete

Removed: {N} items
Kept: {M} items
Sections removed: {K}

### Suggested CLAUDE.md Updates (if any)

- {item} -> add to {CLAUDE.md section}
```

## Error Handling

| Condition | Action |
|-----------|--------|
| `docs/roadmap.md` missing | Suggest `/eforge:roadmap-init` |
| CLAUDE.md missing | Proceed but note limited evidence checking |
| `.eforge/state.json` missing | Skip that evidence source, note it |
| No items classified as shipped | Report "roadmap is current" and stop |
| All items shipped | Remove all content, suggest archiving or starting fresh with `/eforge:roadmap-init` |
| User cancels during interactive confirmation | Stop, keep remaining items, report partial prune |
