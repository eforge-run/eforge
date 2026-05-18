---
title: EXTEND_11 Successor: Docs, Issue-Tracker Example, and Skill Updates
created: 2026-05-18
---

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
