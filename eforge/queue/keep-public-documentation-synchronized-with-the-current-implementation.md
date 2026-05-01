---
title: Keep public documentation synchronized with the current implementation
created: 2026-05-01
---

# Keep public documentation synchronized with the current implementation



## Goal

Inspect all public documentation, especially `README.md`, `docs/config.md`, and every file under `docs/`, compare it against the current codebase behavior, and update docs so they accurately reflect the implementation.

## Out of scope

- Do not add marketing copy, tutorials, or speculative future behavior.
- Do not rewrite docs wholesale unless necessary for correctness.
- Do not change implementation code unless required to verify documentation accuracy.
- Do not document internal implementation details that are not user-facing.

## Acceptance criteria

- `README.md` reflects current user-facing capabilities and commands.
- `docs/config.md` accurately documents the current configuration model and options.
- Every file under `docs/` has been inspected for drift against the codebase.
- Stale, incorrect, or misleading documentation is corrected or removed.
- Documentation remains lean, essential, and free of fluff.
- Any changed docs are consistent with current CLI, daemon, config, profile, playbook, and integration behavior.

## Notes for the planner

Use the codebase as the source of truth. Prefer small, targeted edits over broad rewrites. Pay special attention to public-facing APIs, CLI commands, daemon behavior, configuration schema, profiles, playbooks, Pi integration, Claude plugin behavior, and README examples.
