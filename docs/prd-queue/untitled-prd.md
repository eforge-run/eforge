---
title: Untitled PRD
created: 2026-03-24
status: pending
---

## Problem / Motivation

The project is rebranding from the `eforge.run` domain and `eforge-run` GitHub org to `eforge.build` and `eforge-build` respectively. All in-repo references need to be updated to reflect the new domain and organization name.

## Goal

Rename all occurrences of `eforge.run` → `eforge.build` and `eforge-run` → `eforge-build` across the codebase to complete the domain migration and GitHub org rename.

## Approach

- Perform text replacements across the identified files for both `eforge.run` → `eforge.build` and `eforge-run` → `eforge-build`.
- Remove the "Rebrand to eforge.build" section from `docs/roadmap.md` since this work completes those items.
- Leave the "Marketing Site" section header in the roadmap as-is (it already says `eforge.build`).

## Scope

**In scope:**
- `src/engine/git.ts`
- `package.json`
- `CLAUDE.md`
- `README.md`
- 6 prompt files in `src/engine/prompts/`: `builder.md`, `tester.md`, `test-writer.md`, `evaluator.md`, `plan-evaluator.md`, `validation-fixer.md`
- `docs/roadmap.md` — remove the "Rebrand to eforge.build" roadmap section

**Out of scope:**
- `node_modules/`, `.git/`, `dist/` directories
- The "Marketing Site" section header in `docs/roadmap.md` (already uses `eforge.build`)

## Acceptance Criteria

- `grep -r "eforge\.run" .` returns no matches (excluding `node_modules`, `.git`, `dist`)
- `grep -r "eforge-run" .` returns no matches (excluding `node_modules`, `.git`, `dist`)
- The "Rebrand to eforge.build" section is removed from `docs/roadmap.md`
