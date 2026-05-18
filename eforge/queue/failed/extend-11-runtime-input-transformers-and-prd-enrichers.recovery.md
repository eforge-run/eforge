# Recovery Analysis: extend-11-runtime-input-transformers-and-prd-enrichers

**Generated:** 2026-05-18T14:18:54.315Z
**Set:** extend-11-runtime-input-transformers-and-prd-enrichers
**Feature Branch:** `eforge/extend-11-runtime-input-transformers-and-prd-enrichers`
**Base Branch:** `main`
**Failed At:** 2026-05-18T04:47:34.697Z

## Verdict

**SPLIT** (confidence: high)

## Rationale

Two of three plans landed successfully with substantive commits on the feature branch. plan-01 (Extension Input and Enricher Contracts) and plan-02 (Enqueue Preprocessing Runtime) both merged — evidenced by three commits totaling 2,885 insertions across 52 files, including the full SDK contracts, `packages/input/src/extension-normalize.ts` (582 lines), CLI preprocessing wiring, daemon route adjustments, client event schemas, and extensive test coverage. plan-03 (Docs / Issue Tracker Example) never ran because the orchestrator marked plan-02 as a failed dependency — likely due to a post-commit validation step failing after the "fix test issues" commit, even though implementation code landed. All heavy implementation work is preserved. The remaining work is narrowly scoped to documentation, the issue-tracker example, and skill doc updates — a clean successor PRD can cover it without re-doing any implementation.

## Plans

| Plan | Status | Error |
|------|--------|-------|
| plan-03-docs-issue-tracker-example | failed | Blocked by failed dependency: plan-02-enqueue-preprocessing-runtime |

## Failing Plan

**Plan ID:** plan-03-docs-issue-tracker-example
**Error:** Blocked by failed dependency: plan-02-enqueue-preprocessing-runtime

## Landed Commits

| SHA | Subject | Author | Date |
|-----|---------|--------|------|
| `1496e677` | test(plan-02-enqueue-preprocessing-runtime): fix test issues | Mark Schaake | 2026-05-17T21:33:38-07:00 |
| `ebd6aad2` | feat(plan-02-enqueue-preprocessing-runtime): Enqueue Preprocessing Runtime | Mark Schaake | 2026-05-17T21:30:54-07:00 |
| `a6f25658` | feat(plan-01-extension-input-contracts): Extension Input and Enricher Contracts | Mark Schaake | 2026-05-17T21:14:11-07:00 |
| `84b7d865` | plan(extend-11-runtime-input-transformers-and-prd-enrichers): initial planning artifacts | Mark Schaake | 2026-05-17T20:33:39-07:00 |

## Models Used

- claude-sonnet-4-6
- gpt-5.5

## Completed Work

- plan-01-extension-input-contracts: SDK contracts implemented — `registerPrdEnricher` added to `EforgeExtensionAPI`; `InputSourceAdapter` extended with optional `canHandle`, context param, and result type; `PrdEnricher`/`PrdEnrichmentInput`/`PrdEnrichmentResult`/`InputTransformContext` types added; barrel exports updated in `packages/extension-sdk/src/index.ts`.
- plan-01-extension-input-contracts: Engine extension registry updated — `PrdEnricherSpec`/`PrdEnricherRegistration` types in `packages/engine/src/extensions/types.ts`; recorder validates `registerPrdEnricher` with duplicate detection; loader, projector, replay, and index include the new registration family in counts/projection/deferred summaries.
- plan-01-extension-input-contracts: Client event schemas updated — `extension:input-source:fetched`, `extension:input-source:failed`, `extension:prd-enricher:applied`, `extension:prd-enricher:failed` event variants added to `packages/client/src/events.schemas.ts` and `event-registry.ts`; `DAEMON_API_VERSION` bumped; events-schemas and events-wire-parity tests updated.
- plan-02-enqueue-preprocessing-runtime: Async extension-aware normalization helper implemented in `packages/input/src/extension-normalize.ts` (582 lines); `eforge://input/<adapter>/<id>` URI syntax supported; session-plan normalization runs before enrichers; provenance/diagnostics returned as structured data.
- plan-02-enqueue-preprocessing-runtime: CLI `eforge enqueue` command wired to run preprocessing before `EforgeEngine.enqueue()` — `packages/eforge/src/cli/index.ts` updated; `@eforge-build/input` added to CLI package dependencies.
- plan-02-enqueue-preprocessing-runtime: Daemon `/api/enqueue` route adjusted to preserve extension provenance — route retains session-plan prevalidation for 400 behavior but defers extension execution to the worker path; `packages/monitor/src/server.ts` updated.
- plan-02-enqueue-preprocessing-runtime: Monitor UI reducer updated for new event families; auto-build route test added.
- plan-02-enqueue-preprocessing-runtime: Extensive test coverage added — `test/input-extension-normalization.test.ts` (664 lines), `test/extension-loader.test.ts`, `test/extension-replay.test.ts`, `test/extension-tooling-wiring.test.ts`, `test/extension-cli-commands.test.ts`, `test/extension-sdk-example.test.ts` all updated or added; existing session-plan and daemon route tests updated to account for new behavior.
- plan-02-enqueue-preprocessing-runtime: Generated reference docs updated — `web/content/reference/events.md`, `web/public/reference/events.md`, `web/public/schemas/events.schema.json`, `web/public/llms-full.txt`, `web/public/llms.txt` all reflect new event variants.

## Remaining Work

- plan-03-docs-issue-tracker-example: Add `examples/extensions/issue-tracker.ts` (or equivalent) demonstrating GitHub, Linear, and Jira input adapter/enricher patterns — token-gated via environment variables, safe no-token behavior, per-provider adapter branches.
- plan-03-docs-issue-tracker-example: Add or update `examples/extensions/README.md` to document the new issue-tracker example, required env vars, and safe-by-default behavior.
- plan-03-docs-issue-tracker-example: Update `docs/extensions.md` and `docs/extensions-api.md` — mark `registerInputSource` runtime-supported (not deferred), document `registerPrdEnricher`, `eforge://input/` URI syntax, failure policy, and provenance events.
- plan-03-docs-issue-tracker-example: Update `packages/extension-sdk/README.md` to document new enricher API, context parameter, and source URI syntax.
- plan-03-docs-issue-tracker-example: Update Pi extension skill (`packages/pi-eforge/skills/eforge-extend/SKILL.md`) and Claude Code plugin skill (`eforge-plugin/skills/extend/extend.md`) to reflect runtime support for input sources and enrichers.
- plan-03-docs-issue-tracker-example: Ensure the example compiles — add static validation or a compile test (e.g. extend `test/extension-sdk-example.test.ts`) that loads the issue-tracker example.
- plan-03-docs-issue-tracker-example: Run `pnpm docs:check` to confirm generated reference docs are not out of date after prose changes.

## Risks

- plan-02 was marked as a failed dependency despite landing commits — there may be a lingering test or type-check failure on the feature branch that must be verified before the successor session begins. Run `pnpm type-check` and the targeted test suite on the branch before enqueuing the successor.
- The generated reference docs (`web/content/reference/`, `web/public/reference/`, schema JSON, llms*.txt) were already updated by plan-02. The successor must run `pnpm docs:check` at the end to confirm no drift was introduced by prose-only doc changes in plan-03.
- The issue-tracker example must not introduce network-dependent tests. Any compile/load validation should be entirely static or use stub tokens to remain safe in CI.

## Suggested Successor PRD

```markdown
# EXTEND_11 Successor: Docs, Issue-Tracker Example, and Skill Updates

## Overview

This is the successor to the EXTEND_11 build session. All implementation work is complete on branch `eforge/extend-11-runtime-input-transformers-and-prd-enrichers`:

- Extension SDK contracts (`registerInputSource` runtime-wired, `registerPrdEnricher` added, `InputTransformContext`, result types).
- Async extension-aware normalization helper in `packages/input/src/extension-normalize.ts` with `eforge://input/<adapter>/<id>` URI support.
- CLI and daemon enqueue paths wired to preprocess sources before `EforgeEngine.enqueue()`.
- Typed provenance events (`extension:input-source:fetched/failed`, `extension:prd-enricher:applied/failed`) in client schemas with test coverage.
- Full test suite for input normalization, extension registry, CLI, and daemon routes.

What remains is: the issue-tracker example, documentation prose updates, and integration skill updates. No implementation code changes are needed.

**Before enqueueing this successor**, confirm the feature branch passes `pnpm type-check` and the targeted test commands below — plan-02 was marked as a failed dependency despite its commits landing, so a residual test failure may need a small fix first.

## Goal

Ship the documentation, issue-tracker example, and skill updates that complete the EXTEND_11 acceptance criteria.

## Approach

### Issue-tracker example

Add `examples/extensions/issue-tracker.ts` (and update `examples/extensions/README.md`) with a single extension that registers three input source adapters — one each for GitHub issues, Linear issues, and Jira issues — using the `registerInputSource` API with `canHandle` and context-aware `fetch`. Requirements:

- Use environment variables for tokens/base URLs (`GITHUB_TOKEN`, `LINEAR_API_KEY`, `JIRA_BASE_URL` + `JIRA_TOKEN`).
- Return helpful markdown explaining configuration when a token is absent, rather than throwing.
- Each adapter's `canHandle` function matches the appropriate `eforge://input/<adapter-name>/<id>` URI.
- Example should be self-documenting: clear comments explaining how to customize endpoints.
- No network-dependent test code — add a static compilation check (import + type assertion) in `test/extension-sdk-example.test.ts` or a companion test file.

### Documentation updates

Update the following files to move input sources and enrichers from "deferred" to "runtime-supported":

- `docs/extensions.md` — add section on `registerInputSource` runtime behavior, `registerPrdEnricher` API, `eforge://input/<adapter>/<id>` URI syntax, failure policy (adapter failures are fatal to enqueue; enricher failures are fail-open with diagnostics), and provenance events.
- `docs/extensions-api.md` — update `registerInputSource` entry from deferred note to runtime-supported; add `registerPrdEnricher` entry with `PrdEnricher` contract, `appliesTo`, `enrich`, and context parameter docs.
- `packages/extension-sdk/README.md` — add enricher registration example, source URI syntax, and `InputTransformContext` fields.
- `examples/extensions/README.md` — add entry for the issue-tracker example with required env vars and safe-by-default note.

### Skill doc updates

- `eforge-plugin/skills/extend/extend.md` — remove the "runtime-deferred" label from input sources; add a line about `registerPrdEnricher` and `eforge://input/` URI.
- `packages/pi-eforge/skills/eforge-extend/SKILL.md` — same update as above; keep Pi-specific UX notes intact.

### Validation

Run after all changes:

```bash
pnpm type-check
pnpm test -- test/extension-sdk-example.test.ts
pnpm docs:check
```

Also confirm the full targeted suite still passes:

```bash
pnpm test -- test/normalize-build-source.test.ts test/extension-loader.test.ts test/extension-tooling-routes.test.ts test/extension-cli-commands.test.ts test/extension-sdk-example.test.ts packages/client/src/__tests__/events-schemas.test.ts packages/client/src/__tests__/events-wire-parity.test.ts
```

## Acceptance Criteria

1. **Issue-tracker example ships.**
   - `examples/extensions/issue-tracker.ts` exists and covers GitHub, Linear, and Jira adapter patterns.
   - Credentials are loaded from environment variables; the example is safe to load without secrets.
   - Required env vars are documented in `examples/extensions/README.md`.
   - A static compile/load check in the test suite confirms the example is valid TypeScript.

2. **Documentation is updated.**
   - `docs/extensions.md` documents runtime `registerInputSource`, `registerPrdEnricher`, `eforge://input/` URI syntax, failure policy, and provenance events.
   - `docs/extensions-api.md` covers `registerPrdEnricher` and removes the deferred-runtime note from `registerInputSource`.
   - `packages/extension-sdk/README.md` shows enricher registration and source URI syntax.
   - `examples/extensions/README.md` lists the issue-tracker example.

3. **Skill docs are updated.**
   - Both `eforge-plugin/skills/extend/extend.md` and `packages/pi-eforge/skills/eforge-extend/SKILL.md` no longer label input sources as runtime-deferred.
   - Both docs mention `registerPrdEnricher`.

4. **Validation passes.**
   - `pnpm type-check` passes.
   - Targeted test commands above pass.
   - `pnpm docs:check` passes (no generated doc drift).

## Out of Scope

The following are **already complete** on the feature branch and must not be re-implemented:

- Extension SDK type contracts (`registerInputSource`, `registerPrdEnricher`, `InputTransformContext`, result types).
- Engine extension registry (`PrdEnricherSpec`, recorder, loader, projector, replay).
- Input layer async normalization helper and `eforge://input/` URI parsing (`packages/input/src/extension-normalize.ts`).
- CLI and daemon enqueue preprocessing wiring.
- Client event schemas and provenance event variants.
- All existing tests for the above.
- Generated reference docs for events/API/CLI/config/tools.
```

## Diff Stat

```
.../orchestration.yaml                             | 137 +++++
 .../plan-01-extension-input-contracts.md           |  94 +++
 .../plan-02-enqueue-preprocessing-runtime.md       |  96 +++
 .../plan-03-docs-issue-tracker-example.md          |  82 +++
 .../client/src/__tests__/events-schemas.test.ts    | 206 +++++++
 .../src/__tests__/events-wire-parity.test.ts       |  55 ++
 packages/client/src/api-version.ts                 |   2 +-
 packages/client/src/event-registry.ts              |  30 +
 packages/client/src/events.schemas.ts              |  53 ++
 packages/client/src/types.ts                       |   4 +-
 packages/eforge/package.json                       |   1 +
 packages/eforge/src/cli/display.ts                 |  22 +
 packages/eforge/src/cli/index.ts                   |  48 +-
 packages/engine/src/eforge.ts                      |   2 +-
 packages/engine/src/extensions/index.ts            |   1 +
 packages/engine/src/extensions/loader.ts           |   3 +
 packages/engine/src/extensions/projector.ts        |   2 +
 packages/engine/src/extensions/recorder.ts         |  10 +
 packages/engine/src/extensions/replay.ts           |   3 +
 packages/engine/src/extensions/types.ts            |   5 +
 packages/extension-sdk/src/api.ts                  |  34 +-
 packages/extension-sdk/src/context.ts              |  38 ++
 packages/extension-sdk/src/hooks.ts                |  85 ++-
 packages/extension-sdk/src/index.ts                |   5 +
 packages/input/src/extension-normalize.ts          | 582 ++++++++++++++++++
 packages/input/src/index.ts                        |  36 ++
 packages/monitor-ui/src/lib/reducer/index.ts       |   8 +
 .../monitor/src/__tests__/auto-build-route.test.ts |  88 +++
 packages/monitor/src/server.ts                     |  26 +-
 pnpm-lock.yaml                                     |   3 +
 test/daemon-recovery.test.ts                       |   6 +-
 test/daemon-session-plan-routes.test.ts            |  14 +-
 test/extension-cli-commands.test.ts                |  21 +
 test/extension-loader.test.ts                      |  88 ++-
 test/extension-replay.test.ts                      |  35 ++
 test/extension-sdk-example.test.ts                 |  62 ++
 test/extension-tooling-routes.test.ts              |   4 +-
 test/extension-tooling-wiring.test.ts              |  43 ++
 test/input-extension-normalization.test.ts         | 664 +++++++++++++++++++++
 web/content/reference/api.md                       |   2 +-
 web/content/reference/cli.md                       |   2 +-
 web/content/reference/config.md                    |   2 +-
 web/content/reference/events.md                    |   8 +-
 web/content/reference/tools.md                     |   2 +-
 web/public/llms-full.txt                           |  16 +-
 web/public/llms.txt                                |   2 +-
 web/public/reference/api.md                        |   2 +-
 web/public/reference/cli.md                        |   2 +-
 web/public/reference/config.md                     |   2 +-
 web/public/reference/events.md                     |   8 +-
 web/public/reference/tools.md                      |   2 +-
 web/public/schemas/events.schema.json              | 191 ++++++
 52 files changed, 2885 insertions(+), 54 deletions(-)
```
