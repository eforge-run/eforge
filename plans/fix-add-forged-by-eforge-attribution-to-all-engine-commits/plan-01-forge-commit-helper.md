---
id: plan-01-forge-commit-helper
name: Add forgeCommit helper and migrate all commit sites
depends_on: []
branch: fix-add-forged-by-eforge-attribution-to-all-engine-commits/forge-commit-helper
---

# Add forgeCommit helper and migrate all commit sites

## Architecture Context

Every commit eforge makes must include the `Forged by eforge https://eforge.run` attribution line. Currently, the orchestrator squash-merge (orchestrator.ts:379) includes it, but 7 other engine-level commit sites use raw `exec('git', ['commit', ...])` without attribution. A shared helper eliminates the duplication and prevents future omissions.

Each engine file currently defines its own `const exec = promisify(execFile)` locally. The new `forgeCommit` helper will follow the same pattern internally, keeping it self-contained in a new `src/engine/git.ts` module.

## Implementation

### Overview

Create `src/engine/git.ts` with a `forgeCommit()` function that appends the attribution to every commit message. Replace all 7 missing commit sites with calls to `forgeCommit()`. Also migrate the orchestrator squash-merge to use `forgeCommit()` for consistency, even though it already has the attribution baked into its message string.

### Key Decisions

1. **Separate `git.ts` module** rather than inlining in each file - centralizes the attribution constant and commit logic, makes it impossible to forget the attribution in future commit sites.
2. **Function accepts `cwd`, `message`, and optional `paths`** - covers both `git commit -m <msg>` (staged changes) and `git commit -m <msg> -- <paths>` patterns found across the codebase.
3. **Orchestrator migration** - the orchestrator currently constructs a commit message with the attribution baked in and passes it to `mergeWorktree()` as `commitMessage`. After migration, the orchestrator passes just the subject line to `forgeCommit()` and the attribution is appended automatically. The `mergeWorktree()` function in `worktree.ts` receives its `commitMessage` param from the orchestrator - those call sites in worktree.ts are not modified directly since they're parameterized.

## Scope

### In Scope
- Create `src/engine/git.ts` with `ATTRIBUTION` constant and `forgeCommit()` export
- Replace 4 raw commit calls in `src/engine/eforge.ts` (lines 209, 274, 565, 703)
- Replace 2 raw commit calls in `src/engine/pipeline.ts` (lines 912, 937)
- Replace 1 raw commit call in `src/engine/prd-queue.ts` (line 291)
- Migrate `src/engine/orchestrator.ts` squash-merge commit message (line 379) to use `forgeCommit` or at minimum use the shared `ATTRIBUTION` constant

### Out of Scope
- `src/engine/worktree.ts` commit calls (lines 148, 165) - these receive `commitMessage` as a parameter from the orchestrator, which already includes attribution
- Agent prompts (builder.md, evaluator.md, etc.) - already instruct agents to include attribution
- Tests for the helper itself - the function is a thin wrapper over `exec('git', ['commit', ...])` with string concatenation; the real validation is the grep check in verification

## Files

### Create
- `src/engine/git.ts` - Exports `forgeCommit(cwd, message, paths?)` and `ATTRIBUTION` constant. Uses `promisify(execFile)` internally like other engine modules.

### Modify
- `src/engine/eforge.ts` - Import `forgeCommit` from `./git.js`. Replace 4 raw `exec('git', ['commit', ...])` calls at lines 209, 274, 565, 703 with `forgeCommit()`. The `exec` alias and `execFile`/`promisify` imports can remain since `eforge.ts` uses `exec` for non-commit git operations too.
- `src/engine/pipeline.ts` - Import `forgeCommit` from `./git.js`. Replace 2 raw commit calls at lines 912 and 937 with `forgeCommit()`.
- `src/engine/prd-queue.ts` - Import `forgeCommit` from `./git.js`. Replace 1 raw commit call at line 291 with `forgeCommit()`.
- `src/engine/orchestrator.ts` - Import `ATTRIBUTION` from `./git.js`. Use the shared constant in the commit message construction at line 379 instead of the inline string. Alternatively, restructure to pass just the subject to `forgeCommit()` and let it append - but since the message is passed to `mergeWorktree()` which handles the actual commit, importing `ATTRIBUTION` and using it in the message template is the cleaner path.

## Verification

- [ ] `src/engine/git.ts` exists and exports `forgeCommit` and `ATTRIBUTION`
- [ ] `ATTRIBUTION` equals `'Forged by eforge https://eforge.run'`
- [ ] `forgeCommit` appends `\n\n${ATTRIBUTION}` to the message before calling `git commit`
- [ ] Zero raw `exec('git', ['commit'` calls remain in `eforge.ts`, `pipeline.ts`, or `prd-queue.ts` (all replaced with `forgeCommit`)
- [ ] `orchestrator.ts` references the shared `ATTRIBUTION` constant instead of an inline string
- [ ] `pnpm type-check` exits 0
- [ ] `pnpm test` exits 0
- [ ] `grep -rn "exec.*git.*commit" src/engine/ | grep -v "git.ts" | grep -v "worktree.ts" | grep -v "\.d\.ts"` returns no matches (every engine commit outside git.ts and worktree.ts uses the helper)
