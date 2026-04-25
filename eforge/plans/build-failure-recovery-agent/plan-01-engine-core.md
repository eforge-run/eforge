---
id: plan-01-engine-core
name: "Engine Core: Schema, Agent, Summary, Sidecar"
depends_on: []
branch: build-failure-recovery-agent/engine-core
agents:
  builder:
    effort: high
    rationale: Introduces a new agent role end-to-end (schema, parser, prompt, agent
      body, summary builder, sidecar writer). Requires careful mirroring of
      staleness-assessor patterns and integration with config + runtime
      registry.
---

# Engine Core: Schema, Agent, Summary, Sidecar

## Architecture Context

This plan establishes the foundation for the build-failure recovery agent. It mirrors the existing `staleness-assessor` flow: a closed-prompt agent with `tools: 'none'` that emits a single structured XML block, parsed into a typed verdict. The agent body, prompt, schema, parser, summary builder, sidecar writer, and runtime registration all land here so subsequent plans (CLI, daemon, UI) have a stable contract to consume.

Key constraints:
- **Closed prompt rule**: model/effort/thinking come from `agentRuntimes` config via `agent-runtime-registry.ts`. The prompt template never references model identity or runtime knobs.
- **No side effects from agent**: `tools: 'none'`. Read-only forensics only.
- **Worktrees are gone** by the time recovery runs (orchestrator finally block at `orchestrator.ts:184-187`). Summary draws solely from event log + plan state JSON + git on the surviving feature branch.
- **Sidecar JSON is a stable contract** for a future executor (option-3 follow-up). Schema must be additive-friendly.

## Implementation

### Overview

Add:
1. `recoveryVerdictSchema` (Zod) + `getRecoveryVerdictSchemaYaml()` in `schemas.ts`.
2. `parseRecoveryVerdictBlock(text)` in `agents/common.ts`, mirroring `parseStalenessBlock` (regex over `<recovery verdict="..." confidence="...">...</recovery>` block with nested `<rationale>`, `<completedWork>`, `<remainingWork>`, `<risks>`, `<suggestedSuccessorPrd>` children).
3. `recovery:start | recovery:summary | recovery:complete | recovery:error` event variants in `events.ts`.
4. `'recovery-analyst'` role in `AGENT_ROLES` (`config.ts`) and a default `agentRuntimes` entry, wired through `agent-runtime-registry.ts` so `forRole('recovery-analyst')` resolves.
5. `packages/engine/src/recovery/failure-summary.ts`: pure function `buildFailureSummary({ setName, prdId, cwd })` returning a typed `BuildFailureSummary`. Reads `.eforge/state.json` (via `loadState`), reads event log entries for the session, and runs `git log <baseBranch>..<featureBranch>` + `git diff --stat <baseBranch>...<featureBranch>` via existing helpers in `git.ts`. Returns: `{ prdId, setName, featureBranch, baseBranch, plans: [{ planId, status, mergedAt?, error?, terminalSubtype? }], failingPlan: { planId, agentId, agentRole, errorMessage, terminalSubtype }, landedCommits: [{ sha, subject, author, date }], diffStat: string, modelsUsed: string[], failedAt: string }`. Worktree paths intentionally absent.
6. `packages/engine/src/recovery/sidecar.ts`: `writeRecoverySidecar({ failedPrdDir, prdId, summary, verdict })` writes `<prdId>.recovery.md` (human, with summary tables + verdict + rationale + suggested successor PRD if `split`) and `<prdId>.recovery.json` (machine: `{ schemaVersion: 1, summary, verdict, generatedAt }`). Atomic write-then-rename like `state.ts` does.
7. `packages/engine/src/agents/recovery-analyst.ts`: async-generator `runRecoveryAnalyst({ harness, prdContent, summary, cwd, verbose?, abortController?, ...sdkPassthrough })`. Loads prompt via `loadPrompt('recovery-analyst', { prdContent, summary: JSON.stringify(summary, null, 2), recovery_schema: getRecoveryVerdictSchemaYaml() })`. Calls `harness.run({ prompt, cwd, maxTurns: 20, tools: 'none', ...pickSdkOptions(options) })`. Accumulates `agent:message` text, parses with `parseRecoveryVerdictBlock`, yields `recovery:summary` then `recovery:complete` (carrying the parsed verdict). On parse failure yields `recovery:error` with the raw text excerpt; caller defaults to `manual` verdict at the CLI layer.
8. `packages/engine/src/prompts/recovery-analyst.md`: closed prompt. Sections: Role (advisory analyst, never acts), Inputs (PRD, BuildFailureSummary), Verdict semantics (retry | split | abandon | manual; manual is the safe default; require concrete evidence to pick anything else), Output format (single `<recovery>` XML block matching `{{recovery_schema}}`), `prd-completeness` rule for `split`. No tool references, no model references.

### Key Decisions

1. **Mirror staleness-assessor exactly** for agent body, parser, and prompt structure. This minimizes review surface and keeps the harness invocation identical.
2. **JSON sidecar is the stable contract.** Markdown is for humans; JSON is what a future executor consumes. Schema includes a `schemaVersion: 1` field so additive changes are non-breaking.
3. **Default verdict on parse failure is `manual`.** Recovery never fails the daemon; the CLI emits a `manual` verdict sidecar with a `parseError` field in the summary block when the agent output is unparsable. Implemented at the CLI layer in plan-02; plan-01 only needs to emit the `recovery:error` event.
4. **`buildFailureSummary` reads only `.eforge/state.json` + git on the surviving feature branch.** No event-log replay beyond what state already captures. State already records terminal subtypes and merged plans, so the summary is straightforward to assemble.
5. **`tools: 'none'`** is enforced at the harness call site, not via prompt instructions.

## Scope

### In Scope
- New Zod schema `recoveryVerdictSchema` and YAML emitter.
- New parser `parseRecoveryVerdictBlock`.
- New events: `recovery:start`, `recovery:summary`, `recovery:complete`, `recovery:error`.
- New role `'recovery-analyst'` in `AGENT_ROLES`, default `agentRuntimes` entry, registry resolution.
- New `recovery/failure-summary.ts` and `recovery/sidecar.ts` modules.
- New `agents/recovery-analyst.ts` and `prompts/recovery-analyst.md`.
- StubHarness-driven unit tests in `test/recovery.test.ts` covering: parser round-trip per verdict (retry/split/abandon/manual), schema acceptance per verdict, agent wiring (canned harness output → expected events), sidecar markdown + JSON formatting per verdict, summary builder against fixture state JSON.

### Out of Scope
- CLI subcommand and `EforgeEngine.recover` public method (plan-02).
- Daemon trigger / subprocess spawning (plan-03).
- MCP/Pi tools (plan-03).
- Monitor UI changes (plan-04).
- Auto-execution of any verdict (deferred per PRD).

## Files

### Create
- `packages/engine/src/recovery/failure-summary.ts` — assembles `BuildFailureSummary` from state JSON + git on feature branch.
- `packages/engine/src/recovery/sidecar.ts` — writes `<prdId>.recovery.md` and `<prdId>.recovery.json` atomically.
- `packages/engine/src/agents/recovery-analyst.ts` — async-generator agent wrapper mirroring `staleness-assessor.ts`.
- `packages/engine/src/prompts/recovery-analyst.md` — closed prompt template with `{{prdContent}}`, `{{summary}}`, `{{recovery_schema}}` placeholders.
- `test/recovery.test.ts` — vitest suite covering parser, schema, sidecar, summary, agent wiring.
- `test/fixtures/recovery/state.json` — fixture EforgeState used by summary-builder test.
- `test/fixtures/recovery/sample-prd.md` — fixture PRD used by agent-wiring test.

### Modify
- `packages/engine/src/schemas.ts` — add `recoveryVerdictSchema` + `getRecoveryVerdictSchemaYaml()`. Schema fields: `verdict: 'retry'|'split'|'abandon'|'manual'`, `confidence: 'low'|'medium'|'high'`, `rationale: string`, `completedWork: string[]`, `remainingWork: string[]`, `risks: string[]`, `suggestedSuccessorPrd?: string`.
- `packages/engine/src/agents/common.ts` — add `parseRecoveryVerdictBlock(text)` returning `RecoveryVerdict | null`. Use the same regex shape as `parseStalenessBlock`.
- `packages/engine/src/events.ts` — add four event variants to the `EforgeEvent` union: `recovery:start { prdId; setName }`, `recovery:summary { prdId; summary }`, `recovery:complete { prdId; verdict; sidecarMdPath; sidecarJsonPath }`, `recovery:error { prdId; error; rawOutput? }`.
- `packages/engine/src/config.ts` — add `'recovery-analyst'` to `AGENT_ROLES`. Provide a default `agentRuntimes` entry resolution so `nameForRole('recovery-analyst')` works without user config.
- `packages/engine/src/agent-runtime-registry.ts` — wire role-to-runtime resolution for `'recovery-analyst'` (mirror how `'staleness-assessor'` is resolved).

### Files to reuse (do not reinvent)
- `packages/engine/src/agents/staleness-assessor.ts` — structural template.
- `packages/engine/src/prompts.ts` `loadPrompt` — template loader.
- `packages/engine/src/state.ts` `loadState` — state JSON reader.
- `packages/engine/src/git.ts` commit/log helpers — git inspection on the surviving feature branch.
- `packages/engine/src/agents/sdk-passthrough.ts` `pickSdkOptions` — passes effort/thinking through.

## Verification

- [ ] `pnpm type-check` passes in the engine package.
- [ ] `pnpm test` passes; `test/recovery.test.ts` covers all four verdicts (retry/split/abandon/manual) for parser, schema, sidecar, and agent-wiring.
- [ ] `getRecoveryVerdictSchemaYaml()` emits non-empty YAML containing the literal string `verdict` and an enum array including `manual`.
- [ ] `parseRecoveryVerdictBlock` returns `null` for malformed input and a fully-typed object for each valid verdict.
- [ ] `writeRecoverySidecar` produces both `.recovery.md` and `.recovery.json` files; the JSON includes `schemaVersion: 1`, `summary`, `verdict`, `generatedAt`.
- [ ] `buildFailureSummary` against the fixture state.json returns a summary with the correct `failingPlan.planId` and `landedCommits` length matching fixture git history (test uses a temp git repo seeded with known commits).
- [ ] `runRecoveryAnalyst` invoked with a `StubHarness` returning a canned `<recovery verdict="split" confidence="medium">...</recovery>` block emits `recovery:summary` followed by `recovery:complete` with `verdict.verdict === 'split'`.
- [ ] No new git wrappers introduced; summary builder calls existing helpers in `packages/engine/src/git.ts`.
- [ ] Recovery agent is invoked with `tools: 'none'` (asserted via StubHarness recording the call args).
