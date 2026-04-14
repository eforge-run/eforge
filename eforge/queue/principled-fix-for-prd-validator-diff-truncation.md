---
title: Principled fix for PRD validator diff truncation
created: 2026-04-14
---

# Principled fix for PRD validator diff truncation

## Problem / Motivation

PRD validation failed on eval run `2026-04-14T00-20-00` / variant `claude-sdk` (excursion). All plan builders produced working code, merges succeeded, type-check and tests passed — yet the validator reported "0% complete, 13 gaps — diff contains only planning documents and package-lock.json."

Root cause: `packages/engine/src/eforge.ts:639-640` runs `git diff baseBranch...HEAD`, then slices the raw string at 80K chars. git diff emits hunks in alphabetical path order. For this scenario:
- `eforge/plans/...` planning docs: ~26 KB
- `package-lock.json`: ~90 KB
- `src/**`, `test/**`: ~25 KB (past the 80K cut)

The validator literally never saw the implementation code.

The user rejected a patch-style fix (exclude list + bigger number) because it just pushes the failure mode around. The correct shape is to remove the possibility of a byte-cliff hiding code from the validator by construction.

### Investigation findings

Current flow:
1. Single `git diff baseBranch...HEAD` → one blob → slice at 80K → pass as `diff` to `runPrdValidator`.
2. `prdValidator` in `packages/engine/src/eforge.ts:626-670` constructs the diff inside eforge.ts itself — the validator agent just consumes a string.

Key observation: the validator's job is **PRD ↔ implementation comparison**. What it actually needs is per-file diffs for files that could plausibly implement PRD requirements. Dependency lockfiles, generated files, and planning docs contribute zero signal and unbounded bytes.

Better structure available but not used:
- `git diff --stat` / `git diff --name-status` — cheap enumeration of changed files with add/delete line counts.
- `git diff -- <path>` — per-file diff, bounded by that file's change size.
- The agent itself has a filesystem and can request specific files. The validator currently is passed a static string; it is not given tools to explore.

## Goal

Eliminate the byte-cliff truncation that can silently hide implementation code from the PRD validator, by replacing the monolithic truncated-string diff input with a per-file, individually-budgeted diff structure that cannot starve the validator of any file through alphabetical ordering.

## Approach

### Recommended approach: per-file diff fan-out, validator-driven

Replace the monolithic truncated-string input with a two-layer structure:

**Layer 1 — file-level summary (always included, small):**
Produced with `git diff --name-status` + `git diff --numstat` in the validator's cwd. Yields:
```
M  src/api/workspaces.ts   (+42 -3)
A  src/api/members.ts      (+87 -0)
M  test/workspaces.test.ts (+55 -2)
...
```
This is O(files), typically <2 KB even for large changesets. It cannot be hidden behind a truncation cliff.

**Layer 2 — per-file diffs, budgeted individually:**
For each changed file:
- Run `git diff baseBranch...HEAD -- <path>`.
- If the file's diff fits under a per-file budget (e.g. 20 KB), include it verbatim.
- If it exceeds the budget, include `--stat` for that file plus the first N lines of the hunk header context and a marker noting the diff was summarized. Validator can still ask for more.

No global truncation, no exclude list. Each file is either fully present or explicitly summarized with a clear marker — the validator cannot be silently starved of a file because an alphabetically earlier file ballooned.

**Binary + generated file handling, done by signal not allowlist:**
`git diff --numstat` reports binary files as `- -` and returns massive line counts for generated files. Use those signals, not a hardcoded path list:
- Binary (`numstat == "-\t-"`) → name-only entry.
- Very large diffs (e.g. >20 KB or >2000 changed lines) → stat-only entry with a `[summarized: N lines changed]` marker.

Lockfiles (`package-lock.json`, `pnpm-lock.yaml`, etc.) naturally fall into the "very large" bucket and get summarized to one line without needing an exclude list. If a genuine small lockfile change happens, the validator sees it; if it's a regeneration dump, it's reduced to a stat line. Same mechanism handles any future generated artifact.

**Planning docs:**
The plan output directory is a legitimate code-vs-planning distinction, not a size issue — planning files are typically small enough to pass the budget. Two options, in order of preference:
1. Leave them in. The validator seeing the plan alongside the code is arguably useful signal — it can notice when a plan promised something the code didn't deliver. Cost is ~26 KB of input per validation.
2. If we later find they confuse the validator, pass `config.plan.outputDir` to the diff builder and skip that subtree. This is data-driven (one config-derived path), not an exclude list that grows over time.

Default to option 1 (leave in). Revisit only if the validator's accuracy suffers.

### Concrete changes

#### New file: `packages/engine/src/prd-validator-diff.ts`

Factor the diff-construction logic out of `eforge.ts` so it is unit-testable.

Exports:
```ts
export interface DiffFile {
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';
  path: string;
  added: number;       // -1 for binary
  deleted: number;     // -1 for binary
  binary: boolean;
}

export interface BuildPrdDiffOptions {
  cwd: string;
  baseRef: string;           // e.g. orchConfig.baseBranch
  perFileBudgetBytes?: number;  // default 20_000
  maxChangedLinesBeforeSummary?: number; // default 2000
}

export interface BuildPrdDiffResult {
  summary: string;  // the --name-status/--numstat table
  files: Array<{
    file: DiffFile;
    body: string;        // either the full per-file diff, or a stat-only summary line with marker
    summarized: boolean;
  }>;
  renderedText: string;  // summary + joined per-file bodies, ready for the prompt
  totalBytes: number;
  summarizedCount: number;
}

export async function buildPrdValidatorDiff(opts: BuildPrdDiffOptions): Promise<BuildPrdDiffResult>;
```

Implementation outline:
1. Run `git diff --name-status -z --numstat -z baseRef...HEAD` (or two separate calls; `-z` gives NUL-delimited output so paths with spaces are safe) to build the `DiffFile[]`.
2. For each file, run `git diff baseRef...HEAD -- <path>` with `maxBuffer: 100 * 1024 * 1024`.
3. Apply the per-file decision: keep full, or replace with `diff --git a/<path> b/<path>\n[summarized: status=<S> +<add> -<del>, per-file diff omitted (<bytes> bytes)]`.
4. Concatenate and return.

No global truncation. Budget is per-file, bounded by file count. A worst-case expedition touching 200 files at 20 KB each is 4 MB — fine for the validator's context; a human-sized changeset is tens of KB.

#### Edit: `packages/engine/src/eforge.ts` ~line 636-645

Replace the `git diff | slice(80_000)` block with a call to `buildPrdValidatorDiff`. Use its `renderedText` as the `diff` string passed to `runPrdValidator`. Keep the early-return on empty.

Record `totalBytes`, `summarizedCount`, and file count on the `prdSpan` input so tracing shows when/why summarization fired.

#### Validator prompt (optional, likely small tweak)

`runPrdValidator`'s prompt should briefly note that files over a budget appear with a `[summarized: ...]` marker and invite the validator to call its own `Read` / `Bash` tools against `cwd` if it wants fuller context for a specific file. The validator already runs with a cwd — this just makes that affordance explicit. If the current validator prompt does not grant tools, this plan does **not** add them; the per-file budget alone fixes the reported failure. Tool-driven deep-dive is a later enhancement.

### Critical files

- `packages/engine/src/eforge.ts` (~L626-670, diff construction call site)
- `packages/engine/src/prd-validator-diff.ts` (new)
- `packages/engine/src/agents/prd-validator.ts` or wherever `runPrdValidator`'s prompt lives — verify no prompt change is needed; if the prompt hard-codes "full diff below," soften the wording. (Read-only check, may be no-op.)
- `test/prd-validator-diff.test.ts` (new)

## Scope

### In scope

- New file `packages/engine/src/prd-validator-diff.ts` implementing `buildPrdValidatorDiff` with the exported types/interfaces above.
- Edit `packages/engine/src/eforge.ts` (~L626-670) to replace `git diff | slice(80_000)` with a call to `buildPrdValidatorDiff`; record `totalBytes`, `summarizedCount`, and file count on the `prdSpan`.
- Optional, minimal wording tweak to `runPrdValidator`'s prompt explaining the `[summarized: ...]` marker and the affordance to read files from `cwd`, only if the existing prompt hard-codes "full diff below."
- New tests in `test/prd-validator-diff.test.ts` exercising real `git` on a scratch tmp repo, built programmatically in `beforeEach`.
- Default behavior: leave planning docs (plan output directory) in the diff (option 1).

### Explicitly out of scope

- No exclude list. Lockfiles, generated files, and future noise are handled by size signal.
- No global byte budget / magic truncation number. Per-file budget is a ceiling on individual noise, not a cliff across the whole changeset.
- No prompt-level redesign of the validator. If per-file budgeting proves insufficient, a follow-up can give the validator file-read tools and let it pull hunks on demand. That is a larger scope change and not required to fix the reported bug.
- Adding tools to the validator if the current prompt does not grant them — deferred as a later enhancement.
- Committed fixture trees for tests — repos are built programmatically.

## Acceptance Criteria

1. `pnpm type-check` and `pnpm test` green.
2. New unit tests green, covering:
   - Small changeset: every file present verbatim.
   - One file over budget: that file summarized, others verbatim, summary table complete.
   - Binary file: marked binary, no body bytes.
   - No changes: empty result (caller short-circuits).
   - Changeset where alphabetically early files would have exhausted a global budget: later files are still fully present (regression test for the reported bug).
3. Re-run the failing eval — scenario `workspace-api-excursion-engagement`, variant `claude-sdk`. Expected: validator completion percent > 0 and matches the `claude-sdk-balanced` variant's outcome, with no "diff contains only planning documents" signal.
4. Spot-check tracing for the `prd-validator` span: `totalBytes`, `summarizedCount`, and per-file entries all populated.
5. The implementation performs no global truncation; each changed file is either fully present or explicitly summarized with a `[summarized: ...]` marker.
6. Binary files (numstat `-\t-`) appear as name-only entries; files exceeding the per-file budget (default 20 KB) or changed-line threshold (default 2000) appear as stat-only summary lines.
7. Diff construction logic lives in `packages/engine/src/prd-validator-diff.ts` (not inline in `eforge.ts`) and is unit-testable via the exported `buildPrdValidatorDiff` function with the specified option defaults (`perFileBudgetBytes = 20_000`, `maxChangedLinesBeforeSummary = 2000`).
8. `git diff` commands used to enumerate files use `-z` NUL-delimited output so paths with spaces are safe; per-file `git diff` calls use `maxBuffer: 100 * 1024 * 1024`.
