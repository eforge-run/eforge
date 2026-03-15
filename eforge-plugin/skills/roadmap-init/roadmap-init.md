---
description: Create an initial project roadmap document
disable-model-invocation: true
argument-hint: "[theme...]"
---

# /eforge:roadmap-init

Scaffold a new `docs/roadmap.md` following roadmap policy conventions. A one-time setup skill for projects that don't have a roadmap yet.

## Arguments

- `theme` (optional, repeatable) — High-level directions to seed the roadmap with. Examples: "plugin architecture", "CI/CD support", "multi-provider". If omitted, themes are identified through conversation.

## Workflow

### Step 1: Check Existence

Check if `docs/roadmap.md` already exists.

If it exists, **abort** and report:

> A roadmap already exists at `docs/roadmap.md`. Use `/eforge:roadmap` to review it instead.

**Stop here** if the roadmap exists.

### Step 2: Gather Context

Read project context to understand the current state:

- **CLAUDE.md** — Project overview, architecture, current capabilities
- **README** — Project description, goals
- **Project structure** — Scan directories to understand scope and tech stack
- **Existing planning artifacts** — Check for PRDs (`docs/prd-*.md`), plan files (`plans/`), ADRs (`docs/architecture/`)

Share key findings with the user to ground the conversation.

### Step 3: Identify Themes

If `$ARGUMENTS` contains theme keywords, use those as the starting themes.

Otherwise, ask the user about 2-4 high-level directions for the project. Frame the question around:
- What capabilities they want to add next
- What architectural improvements are planned
- What longer-term vision they have

Examples of good themes: "plugin architecture", "CI/CD support", "multi-provider", "monitoring dashboard", "performance optimization".

### Step 4: Generate Roadmap

Create the roadmap content following `roadmap-policy` conventions:

- One section per theme
- Each section: `## Title` -> `**Goal**:` one-sentence outcome -> 3-5 bullet points
- Ordered by proximity to current work (nearest first)
- Thematic groups separated by `---`
- Lean — no implementation details, code examples, or step-by-step instructions
- Add a top-level `# Roadmap` heading

Present the draft to the user for review before writing.

### Step 5: Write

Save to `docs/roadmap.md`. Create the `docs/` directory if it doesn't exist.

### Step 6: Suggest CLAUDE.md Update

If CLAUDE.md doesn't already reference the roadmap, suggest adding a `## Roadmap` section:

```markdown
## Roadmap

See [docs/roadmap.md](docs/roadmap.md) for planned features and strategic direction.
```

## Error Handling

| Condition | Action |
|-----------|--------|
| `docs/roadmap.md` already exists | Abort, suggest `/eforge:roadmap` |
| CLAUDE.md not found | Proceed without it, note the gap |
| User wants to restart theme selection | Re-run from Step 3 |
| No themes provided and user unsure | Suggest themes based on project context from Step 2 |
