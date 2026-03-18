---
id: plan-01-add-attribution
name: Add eforge attribution to all commit messages
depends_on: []
branch: plan-add-forged-by-eforge-attribution-to-all-commits/add-attribution
---

# Add eforge attribution to all commit messages

## Architecture Context

eforge creates commits in two ways: agents execute `git commit -m` instructions from prompt files, and the orchestrator constructs commit messages programmatically. Both paths need the attribution line `Forged by eforge https://eforge.run` appended after a blank line, following standard git message conventions (subject + blank line + body).

## Implementation

### Overview

Add the attribution trailer to all 6 commit message locations - 5 in prompt markdown files and 1 in the orchestrator's TypeScript commit message template.

### Key Decisions

1. Use multi-line `-m` strings in prompt files (git accepts newlines inside quoted `-m` arguments) rather than introducing `-F` or heredoc patterns - keeps the change minimal and consistent with existing style.
2. Use `\n\n` in the TypeScript template literal for the orchestrator - git's `-m` flag handles embedded newlines correctly.

## Scope

### In Scope
- All 5 prompt files with `git commit -m` instructions
- The orchestrator's programmatic commit message in `src/engine/orchestrator.ts`

### Out of Scope
- `src/engine/worktree.ts` - receives commit messages from the orchestrator, inherits the change automatically
- Commit hooks, signing, or message format changes beyond adding the attribution line
- Tests (no existing commit message tests, and these are static strings - no logic to test)

## Files

### Modify
- `src/engine/prompts/builder.md` — Add attribution to the `git commit -m` instruction on line 53
- `src/engine/prompts/evaluator.md` — Add attribution to the `git commit -m` instruction on line 195
- `src/engine/prompts/validation-fixer.md` — Add attribution to the `git commit -m` instruction on line 29
- `src/engine/prompts/cohesion-evaluator.md` — Add attribution to the `git commit -m` instruction on line 150
- `src/engine/prompts/plan-evaluator.md` — Add attribution to the `git commit -m` instruction on line 150
- `src/engine/orchestrator.ts` — Add `\n\nForged by eforge https://eforge.run` to the commit message template literal on line 379

## Verification

- [ ] `pnpm build` exits with code 0
- [ ] `pnpm test` exits with code 0
- [ ] Every `git commit -m` instruction in `src/engine/prompts/builder.md`, `src/engine/prompts/evaluator.md`, `src/engine/prompts/validation-fixer.md`, `src/engine/prompts/cohesion-evaluator.md`, and `src/engine/prompts/plan-evaluator.md` contains the string `Forged by eforge https://eforge.run` after a blank line
- [ ] The commit message template in `src/engine/orchestrator.ts` contains `\n\nForged by eforge https://eforge.run`
- [ ] `grep -r "git commit -m" src/engine/prompts/` returns no results without the attribution (all commit instructions include it)
