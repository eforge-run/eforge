---
description: Review current roadmap for alignment, staleness, and structural quality
disable-model-invocation: true
argument-hint: "[topic]"
---

# /eforge:roadmap

Health check for the project roadmap. Detects stale items that may have shipped, validates structural quality against policy conventions, and optionally checks alignment with a proposed topic.

## Arguments

- `topic` (optional) — A feature, direction, or proposal to check against the roadmap. When provided, the review includes an alignment assessment.

## Workflow

### Step 1: Load Context

Read `docs/roadmap.md` and CLAUDE.md.

If `docs/roadmap.md` doesn't exist, report:

> No roadmap found. Run `/eforge:roadmap-init` to create one.

**Stop here** if the roadmap doesn't exist.

### Step 2: Staleness Check

For each bullet point in the roadmap:
- **Codebase search** — Grep for key terms (function names, file paths, feature keywords)
- **Git history** — Check recent commits for related changes
- **CLAUDE.md** — Look for documentation of the capability as completed

Flag items with shipping evidence as potentially stale. Record the evidence found.

### Step 3: Structural Quality Check

Validate the roadmap against `roadmap-policy` conventions:
- Each section has a `**Goal**:` line
- Content is bullet points (not prose or code)
- No implementation details or code examples
- Sections ordered by proximity to current work
- Thematic separators (`---`) present between groups

Record any structural issues found.

### Step 4: Alignment Check

If `$ARGUMENTS` contains a topic:
- Find which roadmap section(s) relate to the topic
- Assess whether the topic aligns with, extends, or conflicts with roadmap direction
- If no section covers the topic, assess whether it should be added as a new section

If no topic argument, skip this step.

### Step 5: Report

Output a structured review:

```markdown
## Roadmap Review

### Staleness ({count} items may be stale)

| Item | Section | Evidence |
|------|---------|----------|
| {bullet text} | {section} | {code/commit/CLAUDE.md evidence} |

### Structural Issues ({count})

- {issue description and fix suggestion}

### Alignment (if topic provided)

{assessment of topic vs roadmap direction}

### Recommendations

1. {Priority action — e.g., "Run /eforge:roadmap-prune to remove 3 shipped items"}
2. {Next action}
```

If no issues found in a category, note "None found" rather than omitting the section.

## Error Handling

| Condition | Action |
|-----------|--------|
| `docs/roadmap.md` missing | Suggest `/eforge:roadmap-init` |
| CLAUDE.md missing | Proceed without it, note limited staleness detection |
| Roadmap is empty or malformed | Report structural issues, suggest regeneration with `/eforge:roadmap-init` |
| Topic doesn't relate to any section | Report as potential new direction, suggest adding if appropriate |
