---
id: plan-03-roadmap-update
name: Roadmap Update
depends_on: []
branch: eforge-daemon-mcp-server-architecture/roadmap-update
---

# Roadmap Update

## Architecture Context

The roadmap (`docs/roadmap.md`) captures project direction — future work only. This plan adds the Daemon & MCP Server section describing Phase 2 and Phase 3 ahead. Phase 1 is being implemented by the other plans in this set, so it is NOT added to the roadmap (shipped work lives in git history and CLAUDE.md, not the roadmap).

The section is inserted after "Parallel Execution Reliability" and before "Multimodal Input" per the PRD's instruction, since this work is higher priority than multimodal.

## Implementation

### Overview

Add a new `## Daemon & MCP Server` section to `docs/roadmap.md` between the "Parallel Execution Reliability" and "Multimodal Input" sections. The section describes Phase 2 (control plane) and Phase 3 (re-guidance) — the future work that builds on the daemon infrastructure being implemented in Plans 01-02.

### Key Decisions

1. **Only Phase 2 and Phase 3 appear** — Phase 1 is being built now and will be shipped before the roadmap is read, so including it would violate the "future only" rule.
2. **Lean format** — goal + bullet points, no code examples or implementation details, consistent with existing roadmap style.

## Scope

### In Scope
- New roadmap section with Phase 2 and Phase 3 descriptions
- Correct insertion point (after Parallel Execution Reliability)

### Out of Scope
- CLAUDE.md updates (those happen after Phase 1 ships, not in planning)
- Removing any existing roadmap items

## Files

### Modify
- `docs/roadmap.md` — Insert new section after "Parallel Execution Reliability" separator (`---`) and before "## Multimodal Input". Content:

```markdown
## Daemon & MCP Server

**Goal**: Evolve the monitor into a persistent per-project daemon with MCP server interface for multi-session coordination and build control.

- **Control plane** — Build cancellation via MCP tool and web UI, queue auto-build mode with `--watch`, queue priority/reordering
- **Re-guidance** — Build interruption with amended context, daemon-to-worker IPC for mid-build guidance changes
```

## Verification

- [ ] `docs/roadmap.md` contains a `## Daemon & MCP Server` section
- [ ] The section appears after `## Parallel Execution Reliability` and before `## Multimodal Input`
- [ ] The section contains bullet points for control plane and re-guidance
- [ ] No Phase 1 content appears in the roadmap (Phase 1 is implemented, not planned)
- [ ] Existing roadmap sections are unchanged
