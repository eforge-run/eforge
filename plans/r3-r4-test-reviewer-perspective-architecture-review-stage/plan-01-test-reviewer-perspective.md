---
id: plan-01-test-reviewer-perspective
name: Test Reviewer Perspective
depends_on: []
branch: r3-r4-test-reviewer-perspective-architecture-review-stage/test-reviewer-perspective
---

# Test Reviewer Perspective

## Architecture Context

The parallel reviewer system categorizes changed files into buckets (code, api, docs, config, deps) and triggers specialist review perspectives based on which buckets have files. Test files currently fall into the `code` bucket because `isCode()` matches `.ts`/`.js` extensions before any test-specific check runs. This plan adds a `test` bucket and perspective so test quality issues get dedicated review.

The pattern is well-established: each perspective has a category schema in `schemas.ts`, a prompt in `prompts/`, and entries in the `PERSPECTIVE_PROMPTS` and `PERSPECTIVE_SCHEMA_YAML` maps in `parallel-reviewer.ts`. The generic infrastructure (`ReviewIssue`, `parseReviewIssues()`, `review-fixer`, CLI display, monitor UI) already handles arbitrary perspectives and categories - no changes needed there.

## Implementation

### Overview

Add a `test` perspective to the parallel reviewer that detects test files and reviews them for coverage gaps, flaky patterns, assertion quality, test isolation, and fixture design issues.

### Key Decisions

1. `isTest()` runs before `isCode()` in `categorizeFiles()` so test files land in the `test` bucket exclusively - they never also appear in `code`. This matches the "first match wins" pattern already used by the categorizer.
2. Test file detection covers common conventions: `*.test.{ts,tsx,js,jsx}`, `*.spec.{ts,tsx,js,jsx}`, and files under `test/`, `tests/`, or `__tests__/` directories.
3. The `test` perspective triggers independently - it does not also trigger `security` (unlike `code`), since test files rarely have security implications.

## Scope

### In Scope
- `test` addition to `ReviewPerspective` union and `FileCategories` interface
- `isTest()` pattern matcher function
- `categorizeFiles()` update to call `isTest()` before `isCode()`
- `determineApplicableReviews()` update to trigger `'test'` when `categories.test.length > 0`
- `testCategorySchema` and `getTestsReviewIssueSchemaYaml()` in schemas
- `PERSPECTIVE_PROMPTS` and `PERSPECTIVE_SCHEMA_YAML` entries for `'test'`
- `reviewer-tests.md` prompt file
- Tests for categorization and perspective triggering

### Out of Scope
- Changes to generic infrastructure (events.ts, reviewer.ts, review-fixer.ts, CLI display, monitor UI)
- Any build-phase pipeline changes

## Files

### Create
- `src/engine/prompts/reviewer-tests.md` — Test quality specialist prompt following the existing reviewer prompt template (role, context, scope, triage, categories, severity, fix instructions, schema, output, constraints)

### Modify
- `src/engine/review-heuristics.ts` — Add `'test'` to `ReviewPerspective` union, add `test: string[]` to `FileCategories`, add `isTest()` function, update `categorizeFiles()` to insert `isTest()` check before the `isApi()` check (after config, before api/code), update `determineApplicableReviews()` to add `'test'` perspective when `categories.test.length > 0`
- `src/engine/schemas.ts` — Define `testCategorySchema` with categories `'coverage-gaps'`, `'test-quality'`, `'test-isolation'`, `'fixtures'`, `'assertions'`, `'flaky-patterns'`, `'test-design'`. Create `testReviewIssueSchema` via `makeReviewIssueSchemaWithCategory(testCategorySchema)`. Export `getTestsReviewIssueSchemaYaml()` getter
- `src/engine/agents/parallel-reviewer.ts` — Add `test: 'reviewer-tests'` to `PERSPECTIVE_PROMPTS`, add `test: getTestsReviewIssueSchemaYaml` to `PERSPECTIVE_SCHEMA_YAML`, import `getTestsReviewIssueSchemaYaml` from `../schemas.js`
- `test/review-heuristics.test.ts` — Add test cases: `*.test.ts`/`*.spec.ts`/`test/**` files categorize into `test` bucket; test files trigger `'test'` perspective; test files do not appear in `code` bucket

## Verification

- [ ] `pnpm type-check` exits with code 0
- [ ] `pnpm test` exits with code 0
- [ ] `categorizeFiles(['src/foo.test.ts'])` returns `{ test: ['src/foo.test.ts'], code: [], ... }`
- [ ] `categorizeFiles(['test/helpers.ts'])` returns `{ test: ['test/helpers.ts'], code: [], ... }`
- [ ] `categorizeFiles(['src/foo.ts'])` returns `{ code: ['src/foo.ts'], test: [], ... }`
- [ ] `determineApplicableReviews({ test: ['x.test.ts'], code: [], api: [], docs: [], config: [], deps: [] })` includes `'test'`
- [ ] `PERSPECTIVE_PROMPTS.test` equals `'reviewer-tests'`
- [ ] `PERSPECTIVE_SCHEMA_YAML.test` returns a non-empty YAML string
- [ ] `reviewer-tests.md` exists and contains role, categories, severity, and schema sections
