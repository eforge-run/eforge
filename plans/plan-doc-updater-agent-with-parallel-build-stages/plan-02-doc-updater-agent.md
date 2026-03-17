---
id: plan-02-doc-updater-agent
name: Doc-Updater Agent with Events and Lane Awareness
depends_on: [plan-01-parallel-stage-groups]
branch: plan-doc-updater-agent-with-parallel-build-stages/doc-updater-agent
---

# Doc-Updater Agent with Events and Lane Awareness

## Architecture Context

With parallel stage groups landed (plan-01), this plan adds the doc-updater agent, its prompt, event types, build stage registration, CLI/monitor rendering, lane awareness in planner/builder prompts, and tests. The agent follows the `validation-fixer.ts` pattern - one-shot coding agent that receives the plan content and updates existing documentation.

## Implementation

### Overview

Five areas of work, all wired together:

1. **Doc-updater agent** - new one-shot coding agent at `src/engine/agents/doc-updater.ts`
2. **Event types** - new `AgentRole` entry and two event variants for doc-update lifecycle
3. **Build stage + config** - register `doc-update` stage, add `doc-updater` to `AGENT_ROLES`
4. **CLI/monitor rendering** - handle new event types in display and reducer
5. **Lane awareness** - template variable in planner and builder prompts for parallel execution notice

### Key Decisions

1. **Plan-based, not diff-based** - The agent reads the plan content, not the git diff. This lets it run in parallel with the builder since it doesn't need to wait for implementation to finish.
2. **Non-fatal errors** - Doc-update failure never breaks the build. Errors are caught (except `AbortError`), and the complete event is always yielded.
3. **No git operations** - The agent only edits files. The pipeline runner (from plan-01) handles committing after the parallel group completes.
4. **Generic prompt** - The doc-updater prompt works on any repo regardless of documentation conventions. It discovers docs by searching, not by assuming structure.
5. **Lane awareness via template variables** - `{{parallelLanes}}` in planner and builder prompts. When the profile has no parallel groups, the variable resolves to empty string. When it does, it tells the builder to use targeted `git add` and not touch docs.

## Scope

### In Scope
- Doc-updater agent (`src/engine/agents/doc-updater.ts`)
- Doc-updater prompt (`src/engine/prompts/doc-updater.md`)
- `'doc-updater'` added to `AgentRole` union and `AGENT_ROLES` array
- `build:doc-update:start` and `build:doc-update:complete` event variants
- `doc-update` build stage registration in `pipeline.ts`
- `'doc-updater': 20` in `AGENT_MAX_TURNS_DEFAULTS`
- CLI display rendering for new events in `display.ts`
- Monitor reducer handling for new events
- Lane awareness helpers and template variables in planner and builder
- `DEFAULT_BUILD_STAGES` update to `[['implement', 'doc-update'], 'review', 'review-fix', 'evaluate']`
- Barrel exports for `runDocUpdater` and `DocUpdaterOptions`
- Tests: doc-updater wiring, lane awareness helpers

### Out of Scope
- Diff-based doc updating
- New documentation file creation (agent only updates existing)
- Changelogs, release notes, version file updates
- Per-agent MCP server filtering
- New concurrency primitives

## Files

### Create
- `src/engine/agents/doc-updater.ts` — One-shot coding agent following `validation-fixer.ts` pattern. Exports `DocUpdaterOptions` interface and `runDocUpdater` async generator. Yields `build:doc-update:start`, runs backend with `tools: 'coding'` and `maxTurns: 20`, parses `<doc-update-summary count="N">` from output, yields `build:doc-update:complete` with `docsUpdated` count. Non-fatal error handling (catch non-abort errors, still yield complete). Private `parseDocUpdateSummary(text): number` function.
- `src/engine/prompts/doc-updater.md` — Generic doc-updater prompt. Template variables: `{{plan_id}}`, `{{plan_content}}`. Structure: role definition, plan context injection, discovery phase (search for README, docs/, .md files, API docs, doc comments), analysis phase (check references to changed files/APIs/configs), update phase (targeted factual edits, preserve style), constraints (no new docs, no changelogs, no generated docs, no git commands, no unrelated docs), output format (`<doc-update-summary count="N">`).
- `test/doc-updater-wiring.test.ts` — Tests using `StubBackend`: lifecycle events emitted, prompt composition with `plan_id` and `plan_content`, backend options (`tools: 'coding'`, `maxTurns: 20`), XML parsing for `docsUpdated` count, zero updates (`count="0"` yields 0), missing summary defaults to 0, verbose gating via `isAlwaysYieldedAgentEvent`, error handling (non-abort errors swallowed, complete event still yielded), abort propagation (AbortError re-thrown).
- `test/lane-awareness.test.ts` — Tests for `formatParallelLanes` and `formatBuilderParallelNotice`: returns empty string when no parallel groups, returns formatted section when parallel groups exist, `formatBuilderParallelNotice` returns empty string when builder isn't in a parallel group, lists parallel stage names when builder is in a parallel group.

### Modify
- `src/engine/events.ts` — Add `'doc-updater'` to `AgentRole` union (line 9). Add two event variants after `build:evaluate:complete` (line 164): `{ type: 'build:doc-update:start'; planId: string }` and `{ type: 'build:doc-update:complete'; planId: string; docsUpdated: number }`.
- `src/engine/config.ts` — Add `'doc-updater'` to `AGENT_ROLES` array (line 14-18). Update `DEFAULT_BUILD_STAGES` to `[['implement', 'doc-update'], 'review', 'review-fix', 'evaluate']` (uses the parallel group syntax from plan-01). All three built-in profiles inherit this change since they reference `DEFAULT_BUILD_STAGES`.
- `src/engine/pipeline.ts` — Add `'doc-updater': 20` to `AGENT_MAX_TURNS_DEFAULTS` (line 213-217). Register `'doc-update'` build stage: resolve agent config for `'doc-updater'`, create tracing span, iterate `runDocUpdater()` events with tool tracking, non-fatal error handling (catch and end span on error). Import `runDocUpdater` from `./agents/doc-updater.js`.
- `src/engine/agents/planner.ts` — Add `formatParallelLanes(profile: ResolvedProfileConfig): string` helper that inspects `profile.build` for array entries and formats a markdown section about parallel build lanes. Accept `profile` in `PlannerOptions` or pass through existing `profiles` context. Pass `parallelLanes: formatParallelLanes(...)` to `loadPrompt('planner', { ... })` in `buildPrompt()`.
- `src/engine/prompts/planner.md` — Add `{{parallelLanes}}` template variable after the Profile Selection section. When populated, shows a "Parallel Build Lanes" section explaining that doc updates are handled by a separate agent and the builder should not modify documentation files.
- `src/engine/agents/builder.ts` — Add `formatBuilderParallelNotice(parallelStages: string[][]): string` helper. Accept optional `parallelStages` in `BuilderOptions`. Pass `parallelLanes: formatBuilderParallelNotice(...)` to `loadPrompt('builder', { ... })`.
- `src/engine/prompts/builder.md` — Add `{{parallelLanes}}` template variable after the Implementation Rules section. When populated, shows a "Parallel Execution Notice" instructing the builder to stay in its lane (code only, no docs, use targeted `git add`).
- `src/engine/index.ts` — Add barrel exports for `runDocUpdater` and `DocUpdaterOptions` from `./agents/doc-updater.js`. Export `formatParallelLanes` from `./agents/planner.js`. Export `formatBuilderParallelNotice` from `./agents/builder.js`.
- `src/cli/display.ts` — Add cases before `build:complete` for `build:doc-update:start` (update spinner text to "updating docs...") and `build:doc-update:complete` (update spinner text to show docs updated count when > 0).
- `src/monitor/ui/src/lib/reducer.ts` — Add case for `build:doc-update:start` to set plan status to `'doc-update'` (or keep as `'implement'` since they run in parallel). Add `'doc-update'` to the `PipelineStage` type in `types.ts` if a distinct stage indicator is desired, or leave plan status unchanged since doc-update runs alongside implement.
- `src/monitor/ui/src/lib/types.ts` — Optionally add `'doc-update'` to `PipelineStage` union if the monitor should show a distinct stage for doc updates.
- `test/pipeline.test.ts` — Update `'all built-in build stages are registered'` to include `'doc-update'`. Update `'excursion profile build stages match today's hardcoded sequence'` (or equivalent) to expect `[['implement', 'doc-update'], 'review', 'review-fix', 'evaluate']`. Update `'calls all four default build stages in order'` test to reflect new default stages.
- `test/config-profiles.test.ts` — Add test that `'doc-updater'` is in `AGENT_ROLES` (indirectly via schema validation accepting `doc-updater` as an agent role).

## Verification

- [ ] `pnpm type-check` passes with zero errors from new event types, agent role, and all wiring
- [ ] `pnpm build` bundles with zero errors
- [ ] `pnpm test` passes - all existing tests pass, all new tests pass
- [ ] `'doc-updater'` appears in `AgentRole` union and `AGENT_ROLES` array
- [ ] `DEFAULT_BUILD_STAGES` contains `['implement', 'doc-update']` as a parallel group
- [ ] All three built-in profiles include the parallel group via `DEFAULT_BUILD_STAGES`
- [ ] `'doc-update'` is a registered build stage (retrievable via `getBuildStage('doc-update')`)
- [ ] `build:doc-update:start` and `build:doc-update:complete` are valid `EforgeEvent` variants
- [ ] `runDocUpdater` yields lifecycle events in order: `build:doc-update:start` then `build:doc-update:complete`
- [ ] `runDocUpdater` parses `<doc-update-summary count="3">` and yields `docsUpdated: 3`
- [ ] `runDocUpdater` yields `docsUpdated: 0` when no summary XML is present
- [ ] `runDocUpdater` catches non-abort errors and still yields `build:doc-update:complete`
- [ ] `runDocUpdater` re-throws `AbortError`
- [ ] `formatParallelLanes` returns empty string when profile has no parallel groups
- [ ] `formatParallelLanes` returns a formatted markdown section when parallel groups exist
- [ ] `formatBuilderParallelNotice` returns empty string when builder is not in a parallel group
- [ ] `formatBuilderParallelNotice` returns notice with parallel stage names when builder is in a parallel group
- [ ] CLI display renders `build:doc-update:start` and `build:doc-update:complete` events without crashing
- [ ] Exhaustive switch in `display.ts` compiles (no `never` fallthrough for new events)
