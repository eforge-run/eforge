---
id: plan-01-recovery-engine-core
name: "Recovery engine core: summary, agent, schema, sidecar, events"
depends_on: []
branch: build-failure-recovery-agent/engine-core
agents:
  builder:
    effort: high
    rationale: Net-new agent role plus a forensic summary builder that has to handle
      missing/partial inputs (failed mid-build state). Mirrors
      staleness-assessor but introduces several new types that must line up with
      consumers in plan-02.
  reviewer:
    effort: high
    rationale: Schema and event shape are the stable contract a future auto-executor
      will consume; getting field names and discriminants right matters.
---

# Recovery engine core: summary, agent, schema, sidecar, events

## Architecture Context

The recovery analyst is modeled directly on `packages/engine/src/agents/staleness-assessor.ts`: a closed-prompt, `tools: 'none'` agent that emits a single structured verdict. Inputs are forensic — failed PRDs already park at `eforge/queue/failed/<prdId>.md` (`packages/engine/src/prd-queue.ts:299-309`), and the orchestrator's `finally` block (`packages/engine/src/orchestrator.ts:184-188`) tears down worktrees + plan branches but preserves the feature branch unless merged. The summary therefore reads only what survives: event log, plan state JSON under `.eforge/session-plans/<setName>/`, and `git log` / `git diff --stat` against the feature branch. Recovery is read-only and does not consume a build permit (`packages/engine/src/concurrency.ts` is untouched).

This plan builds the engine-internal pieces only. The CLI subcommand, MCP tool, daemon trigger, monitor UI, and Pi extension parity are wired in plan-02 — they import the types and functions added here.

## Implementation

### Overview

1. Add `recoveryVerdictSchema` (Zod) + `getRecoveryVerdictSchemaYaml()` to `packages/engine/src/schemas.ts`, mirroring the staleness pattern (`schemas.ts` lines 137-141 and 211-240, 323).
2. Add `parseRecoveryVerdictBlock(text)` to `packages/engine/src/agents/common.ts`, mirroring `parseStalenessBlock` (`common.ts:113-138`).
3. Add `recovery:start | recovery:summary | recovery:complete | recovery:error` to the event union in `packages/engine/src/events.ts` and add `'recovery-analyst'` to `AgentRole`.
4. Register `recovery-analyst` in `packages/engine/src/agent-runtime-registry.ts` and the `AGENT_ROLES` array in `packages/engine/src/config.ts` so model/effort/thinking flow from `agentRuntimes` (closed-prompts rule).
5. Build `BuildFailureSummary` assembler at `packages/engine/src/recovery/failure-summary.ts`. Reads plan state via `loadState` from `state.ts`, the per-session event log, and the surviving feature branch (commit list + `git diff --stat <baseBranch>...HEAD`) using promisified `execFile` from `git.ts` (do not introduce new git wrappers).
6. Build the agent at `packages/engine/src/agents/recovery-analyst.ts` mirroring `staleness-assessor.ts` shape: async-generator over `harness.run()`, `tools: 'none'`, calls `parseRecoveryVerdictBlock`, emits the new events.
7. Add the closed prompt at `packages/engine/src/prompts/recovery-analyst.md` with `{{summary}}`, `{{prdContent}}`, `{{recovery_schema}}`, `{{cwd}}` placeholders and a final `<recovery>` XML block instruction. No tool references.
8. Build the sidecar writer at `packages/engine/src/recovery/sidecar.ts` that emits `<prdId>.recovery.md` (human, includes summary + verdict + rationale + risks + completed/remaining work + optional successor PRD) and `<prdId>.recovery.json` (machine-readable twin: full summary + verdict object).
9. Add `test/recovery.test.ts` using `StubHarness` (`test/stub-harness.ts`) to cover all four verdicts plus schema round-trip and sidecar formatting.

### Key Decisions

1. **Mirror staleness-assessor exactly.** Same `tools: 'none'`, same parser pattern, same schema-injection. The recovery agent is a near-clone with a different verdict shape — keeping the mechanics identical reduces review surface and onboards future agents.
2. **`manual` is the default verdict.** The schema enum is `retry | split | abandon | manual`. The prompt instructs the agent to default to `manual` whenever the evidence is ambiguous and to justify any other verdict with concrete cites from the summary.
3. **Worktree paths are deliberately omitted from the summary.** They are gone by the time recovery runs; including them would invite the agent to hallucinate.
4. **Reuse `git.ts` exec primitives, do not add new git wrappers.** The summary calls `git log --pretty=format:%H%x09%s <base>..<featureBranch>` and `git diff --stat <base>...<featureBranch>` via the promisified `execFile` already exported.
5. **JSON twin is the stable contract.** A future auto-executor PRD will read `<prdId>.recovery.json`. Field names in the schema are chosen for that consumer (`verdict`, `confidence`, `completedWork`, `remainingWork`, `risks`, `suggestedSuccessorPrd`).
6. **Sidecar files live next to the failed PRD** — same dir (`eforge/queue/failed/`), same git ownership, no new storage path. Monitor UI already lists this directory.

## Scope

### In Scope
- Zod schema + YAML emitter for the recovery verdict.
- `parseRecoveryVerdictBlock` parser + tests.
- Four new event types in the engine union.
- `recovery-analyst` role registration in `AGENT_ROLES` and `agent-runtime-registry.ts` with config-driven model/effort/thinking.
- `BuildFailureSummary` assembler reading plan state, event log, and feature-branch git data.
- `recovery-analyst` agent (`tools: 'none'`, closed prompt) emitting events and a parsed `RecoveryVerdict`.
- Sidecar writer (markdown + JSON twin) targeting `eforge/queue/failed/`.
- `test/recovery.test.ts` covering all four verdicts, schema round-trip, and sidecar formatting via StubHarness.

### Out of Scope
- Any CLI, MCP, daemon trigger, monitor UI, or Pi extension wiring (plan-02 owns these).
- Any code that *reads* a verdict and acts on it (deferred follow-up PRD).
- Changes to the failed-PRD lifecycle in `prd-queue.ts`.
- Changes to `concurrency.ts`. Recovery does not claim a build permit.
- Mid-pipeline resume / re-enqueue / queue mutation. Sidecar is the only artifact.

## Files

### Create
- `packages/engine/src/recovery/failure-summary.ts` — assemble `BuildFailureSummary` from event log + plan state + feature-branch git data.
- `packages/engine/src/recovery/sidecar.ts` — render markdown + JSON twin sidecar files into `eforge/queue/failed/`.
- `packages/engine/src/agents/recovery-analyst.ts` — agent body mirroring `staleness-assessor.ts`; `tools: 'none'`, schema-driven verdict, parser via `common.ts`.
- `packages/engine/src/prompts/recovery-analyst.md` — closed prompt; placeholders `{{summary}}`, `{{prdContent}}`, `{{recovery_schema}}`, `{{cwd}}`. Final `<recovery>` XML block instruction. Zero tool references.
- `test/recovery.test.ts` — StubHarness-driven verdict assembly + sidecar formatting across all four verdicts.

### Modify
- `packages/engine/src/schemas.ts` — add `recoveryVerdictSchema` (fields: `verdict: 'retry'|'split'|'abandon'|'manual'`, `confidence: 'low'|'medium'|'high'`, `rationale: string`, `completedWork: string[]`, `remainingWork: string[]`, `risks: string[]`, `suggestedSuccessorPrd?: string`) and `getRecoveryVerdictSchemaYaml()` cached emitter.
- `packages/engine/src/agents/common.ts` — add `parseRecoveryVerdictBlock(text)` mirroring `parseStalenessBlock`.
- `packages/engine/src/events.ts` — add `recovery:start`, `recovery:summary`, `recovery:complete`, `recovery:error` to the event union; add `'recovery-analyst'` to `AgentRole` (line 11).
- `packages/engine/src/config.ts` — add `'recovery-analyst'` to the `AGENT_ROLES` array (line 26) so config validation accepts it.
- `packages/engine/src/agent-runtime-registry.ts` — register the role so `forRole('recovery-analyst')` resolves an `agentRuntimes` entry; default the role to whatever the singleton/test path uses for staleness-assessor (no model/effort hardcoded in the prompt).

## Verification

- [ ] `pnpm type-check` passes with no new errors.
- [ ] `pnpm test` passes, including a new `test/recovery.test.ts` with at least one test per verdict (retry, split, abandon, manual) plus a schema round-trip test (`recoveryVerdictSchema.parse()` accepts every produced verdict).
- [ ] `getRecoveryVerdictSchemaYaml()` returns a non-empty string and is parseable as YAML in test.
- [ ] `parseRecoveryVerdictBlock` returns `null` for input lacking a `<recovery>` block and returns a typed `RecoveryVerdict` for a well-formed block, with the same XML conventions as `parseStalenessBlock`.
- [ ] `BuildFailureSummary` assembler returns a populated object given a fixture event log + plan state JSON + a fixture git repo with a feature branch (commit list and diff stat present in output).
- [ ] Sidecar writer produces both `<prdId>.recovery.md` and `<prdId>.recovery.json` in the target directory; the JSON file `JSON.parse`s into an object containing the full summary plus the verdict.
- [ ] Recovery agent prompt (`packages/engine/src/prompts/recovery-analyst.md`) contains zero references to tool names (`Bash`, `Write`, `Read`, etc.).
- [ ] Recovery agent invokes `harness.run()` with `tools: 'none'` (asserted in StubHarness test).
- [ ] `recovery-analyst` appears in `AGENT_ROLES` (`config.ts`) and `forRole('recovery-analyst')` returns a runtime entry.
- [ ] `events.ts` exports the four new event types and `AgentRole` union includes `'recovery-analyst'`.
