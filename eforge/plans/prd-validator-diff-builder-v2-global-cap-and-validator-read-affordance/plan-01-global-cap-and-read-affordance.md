---
id: plan-01-global-cap-and-read-affordance
name: Global cap + validator read affordance
depends_on: []
branch: prd-validator-diff-builder-v2-global-cap-and-validator-read-affordance/global-cap-and-read-affordance
---

# Global cap + validator read affordance

## Architecture Context

v1 of `buildPrdValidatorDiff` (in `packages/engine/src/prd-validator-diff.ts`) already
implements per-file budgeting, binary handling, and a `[summarized: ...]` marker shape.
It has no global byte ceiling, so a changeset with many medium files can still produce
a renderedText that overflows the validator's context window. It also offers no escape
hatch when a single legitimately large implementation file is itself summarized: the
validator sees only a stat marker and cannot open the file.

The call site at `packages/engine/src/eforge.ts` (line ~648) wraps each diff build in a
tracing span (`prdSpan`) that currently records `summarizedCount` but not the breakdown
between per-file-budget and global-cap demotions. The validator agent itself already
has `tools: 'coding'` and `maxTurns: 15`, so it can `Read` files from its `cwd` with no
additional plumbing — the only missing piece is prompt guidance giving it permission.

## Implementation

### Overview

1. Extend `BuildPrdDiffOptions` with `globalBudgetBytes` (default `500_000`).
2. After the existing per-file render pass, compute `totalBytes` from `files[].body`.
   If it exceeds `globalBudgetBytes`, iteratively demote the largest non-summarized
   files (ties broken by `path` ascending) with a distinct marker
   `[summarized: status=<S> +<add> -<del>, demoted by global cap]` until the total is
   under the cap.
3. Extend `BuildPrdDiffResult` with `globalBudgetBytes`, `summarizedByPerFileBudget`,
   and `summarizedByGlobalCap`. `summarizedCount` stays and equals the sum.
4. Pass `summarizedByPerFileBudget` and `summarizedByGlobalCap` through
   `prdSpan.setInput(...)` in `packages/engine/src/eforge.ts`.
5. Add a short paragraph near the top of the diff section of the prd-validator prompt
   template (`packages/engine/src/prompts/prd-validator.md`) explaining the
   `[summarized: ...]` marker and permitting (but not encouraging) targeted `Read`
   against the working directory.
6. Add a focused test in `test/prd-validator-diff.test.ts` exercising the global cap
   path.

### Key Decisions

1. **Demotion ordering: largest body first, `path` asc for ties.** Deterministic and
   test-stable. Matches the PRD's explicit direction.
2. **Track demotion reason via two counters, not an enum on `DiffFile`.** Keeps the
   `DiffFile` shape backward-compatible for callers that pattern-match on
   `summarized`. The marker string is the source of truth for the mechanism; the
   counters are for tracing.
3. **Marker string carries the reason.** `[summarized: ..., per-file diff omitted (<bytes> bytes)]`
   vs. `[summarized: ..., demoted by global cap]` — the validator and log readers can
   tell why any given file was summarized.
4. **Prompt wording is permissive, not prescriptive.** Avoids reflex `Read` calls on
   every lockfile while giving an escape hatch for the one-big-file case.
5. **No `maxTurns` bump.** Per the PRD, keep it at 15 so a real ceiling breach shows
   up as a turn-budget signal instead of being silently absorbed.

## Scope

### In Scope
- Add `globalBudgetBytes` option and cap-enforcement pass to `buildPrdValidatorDiff`.
- Extend `BuildPrdDiffResult` with the three new fields.
- Wire the two new counters into `prdSpan.setInput` at the `eforge.ts` call site.
- Edit `prd-validator.md` prompt template to document the `[summarized: ...]` marker
  and permit targeted `Read`.
- Add one new vitest for the global cap demotion path.

### Out of Scope
- Changes to `maxChangedLinesBeforeSummary`, `perFileBudgetBytes`, or the per-file
  render path.
- Bumping `maxTurns` for the prd-validator agent.
- Adding new tools to the validator (it already has `coding`).
- Restructuring the validator into a multi-step / tool-use-driven agent.
- Any change to how the validator parses its JSON output.

## Files

### Create
- (none)

### Modify
- `packages/engine/src/prd-validator-diff.ts` — add `globalBudgetBytes` to
  `BuildPrdDiffOptions` (default `500_000`); after the per-file pass, compute
  `totalBytes` and demote largest non-summarized files (ties by `path` asc) with
  `[summarized: status=<S> +<add> -<del>, demoted by global cap]` until total
  `renderedText` byte length is `<= globalBudgetBytes`; extend
  `BuildPrdDiffResult` with `globalBudgetBytes`, `summarizedByPerFileBudget`,
  `summarizedByGlobalCap`; compute `summarizedCount` as the sum.
- `packages/engine/src/eforge.ts` — in the `prdValidator` closure around line 649,
  add `summarizedByPerFileBudget` and `summarizedByGlobalCap` (and
  `globalBudgetBytes`) to the `prdSpan.setInput({...})` object so tracing shows the
  breakdown. No behavior change.
- `packages/engine/src/prompts/prd-validator.md` — insert a short paragraph near
  the top of the "Implementation Diff" section (after the `{{diff}}` section header
  but before the numbered "Instructions"), wording:
  > Some files appear with a marker of the form `[summarized: ...]` instead of a
  > full diff, either because the individual file exceeded the per-file budget or
  > because the total diff exceeded the global cap. The files are present in your
  > working directory. If understanding a specific summarized file is necessary to
  > assess PRD coverage, you may Read it directly; otherwise prefer the summary.
- `test/prd-validator-diff.test.ts` — add a test that constructs a fixture repo /
  invokes the builder such that N files are each below `perFileBudgetBytes` but
  together exceed a small `globalBudgetBytes`; assert: (a) largest-body files are
  demoted first with the `demoted by global cap` marker; (b) the smallest files
  remain verbatim; (c) `result.totalBytes <= globalBudgetBytes`;
  (d) `summarizedByPerFileBudget + summarizedByGlobalCap === summarizedCount`.

## Verification

- [ ] `pnpm type-check` exits 0.
- [ ] `pnpm test` exits 0, including the existing v1 tests (per-file budget, binary
      handling, no-changes short-circuit, alphabetical-cliff regression) and the new
      global-cap test.
- [ ] `BuildPrdDiffOptions.globalBudgetBytes` defaults to `500_000` when omitted
      (verified in the new test by asserting on `result.globalBudgetBytes`).
- [ ] New test passes and asserts `result.totalBytes <= globalBudgetBytes` after
      demotion for a fixture where the raw total exceeds the cap.
- [ ] New test asserts the demoted files carry the exact substring
      `demoted by global cap` in their `body`, and non-demoted files retain their
      full `git diff` body.
- [ ] `summarizedByPerFileBudget + summarizedByGlobalCap === summarizedCount` holds
      in the new test.
- [ ] `git grep "summarizedByPerFileBudget" packages/engine/src/eforge.ts` returns
      at least one match inside the `prdSpan.setInput(...)` argument.
- [ ] `packages/engine/src/prompts/prd-validator.md` contains the substring
      `[summarized: ...]` followed by the permissive `Read` guidance paragraph, and
      the paragraph appears inside the Implementation Diff section (not at the top
      of the prompt).
