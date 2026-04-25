---
title: Build Failure Recovery Agent
created: 2026-04-25
---

# Build Failure Recovery Agent

## Problem / Motivation

When an eforge build fails today, the durable state needed to reason about recovery survives, but the volatile state does not:

**Survives a failure** (this is what the recovery agent reads):
- The PRD, moved to `eforge/queue/failed/<prdId>.md` by `prd-queue.ts:299-309`.
- The **feature branch** with every commit landed before the crash (only deleted if merged - see `orchestrator.ts:187`).
- Plan state JSON under `.eforge/session-plans/<setName>/`.
- The event log for the session.

**Does NOT survive** - worktrees and plan branches are cleaned up unconditionally in the orchestrator's `finally` block (`orchestrator.ts:184-187`: `wm.cleanupAll()` plus `git branch -D <plan.branch>` for every plan). So there is no partial worktree to inspect or resume from. This is intentional and we don't fight it.

What does *not* survive is the user's attention - long-running builds fail at unpredictable moments, and the recovery work (figuring out from git log + event log what got done, what didn't, whether to retry / split / abandon) is manual forensic work each time.

## Goal

Provide an automatic, *advisory* recovery analyst: when a build fails, a tightly-bounded agent reads the surviving artifacts and writes a structured recommendation next to the failed PRD. The user retains all authority - the agent never re-enqueues, never edits code, never modifies the queue. v1 is purely advisory; the schema and sidecar format are designed so a later iteration can opt into auto-execution on high-confidence verdicts.

The agent is constrained by design (modeled on `staleness-assessor.ts`): `tools: 'none'`, single structured output, closed prompt, no side effects beyond writing one sidecar file.

## Approach

Three components ship together in one PRD:

1. **`BuildFailureSummary`** - a typed, machine-readable consolidation of post-failure state. Read-only forensics: which plans completed, which agent failed and why, which commits landed on the feature branch (commit list + `git diff --stat` against base), feature branch name, model usage. Worktree paths are *not* part of the summary - they're gone by the time recovery runs. Useful on its own (humans read it too).
2. **`recovery-analyst` agent** - consumes the summary + PRD content, emits a structured `RecoveryVerdict` (one of `retry | split | abandon | manual` plus rationale, confidence, completed/remaining work, optional successor PRD draft).
3. **Daemon trigger + sidecar writer** - daemon listens for `plan:build:failed`, spawns recovery via a new CLI subcommand (clean subprocess; the eforge process that just failed is *not* reused), writes `eforge/queue/failed/<prdId>.recovery.md` plus a JSON twin for machine consumption.

### Verdict surface (deliberately small)

| Verdict | Meaning | What the user does next |
|---|---|---|
| `retry` | Failure looks transient; PRD is still coherent | `mv` PRD back to `queue/` (deterministic, optionally one-line CLI helper later) |
| `split` | Partial work landed and is salvageable; remaining scope should be a successor PRD | Sidecar includes a draft successor PRD that carries the *full* original Acceptance Criteria (per the `prd-completeness` rule) |
| `abandon` | Feature branch should be torn down; PRD needs human disposition | User runs `git branch -D <featureBranch>` (worktrees are already gone), decides whether to revise PRD or drop it |
| `manual` | Default when confidence is not high; surface findings, defer | Human reads sidecar and decides |

`manual` is the safe default. The agent must justify any verdict other than `manual` with concrete evidence drawn from the summary.

### Why this fits eforge's grain

- Same shape as `staleness-assessor`: one structured output, no tools, closed prompt.
- Read-only ⇒ no build-permit consumption, no concurrency interaction with running builds.
- Sidecar is a normal file in `eforge/queue/failed/` ⇒ visible in monitor UI without bespoke storage.
- Failed PRDs are already parked there by `prd-queue.ts:299-309` ⇒ no queue lifecycle changes.

### Files to add

- `packages/engine/src/recovery/failure-summary.ts` - assemble `BuildFailureSummary` from event log + plan state JSON + `git log` / `git diff --stat` on the surviving feature branch.
- `packages/engine/src/recovery/sidecar.ts` - serialize summary + verdict to `<prdId>.recovery.md` (human) and `<prdId>.recovery.json` (machine).
- `packages/engine/src/agents/recovery-analyst.ts` - mirror `staleness-assessor.ts` (tools: `'none'`, schema-driven verdict, parser via `common.ts`).
- `packages/engine/src/prompts/recovery-analyst.md` - closed prompt; engine injects summary, PRD content, verdict schema YAML.
- `test/recovery.test.ts` - StubHarness-driven verdict assembly + sidecar formatting.

### Files to modify

- `packages/engine/src/schemas.ts` - add `recoveryVerdictSchema` (Zod) + `getRecoveryVerdictSchemaYaml()`. Schema fields: `verdict`, `confidence: 'low'|'medium'|'high'`, `rationale`, `completedWork[]`, `remainingWork[]`, `risks[]`, `suggestedSuccessorPrd?` (markdown, only for `split`).
- `packages/engine/src/agents/common.ts` - add `parseRecoveryVerdictBlock(text)` mirroring `parseStalenessBlock`.
- `packages/engine/src/events.ts` - add `recovery:start`, `recovery:summary`, `recovery:complete`, `recovery:error` event types. Extend `EforgeState`-related types if needed (probably not - sidecar is the artifact).
- `packages/engine/src/agent-runtime-registry.ts` + `packages/engine/src/config.ts` - register `recovery-analyst` role; default runtime entry in `agentRuntimes`. Honor the closed-prompts rule: model/effort/thinking come from config, not the prompt.
- `packages/eforge/src/cli/index.ts` - new `eforge recover <setName> <prdId>` subcommand. Args resolve the failed PRD path, build the summary, run the agent, write sidecars. Exits non-zero only on infrastructural error - a `manual` verdict is success.
- `packages/eforge/src/cli/mcp-proxy.ts` + `packages/eforge/src/cli/mcp-tool-factory.ts` - expose `eforge_recover` MCP tool (parity with other CLI subcommands).
- `packages/monitor/src/server.ts` - on `plan:build:failed`, spawn `eforge recover ...` as a subprocess (do *not* run inside the failed engine process). Subprocess does its own agent invocation; events stream back via the existing event channel. Recovery does not consume a build permit (`concurrency.ts` is for build slots).
- `packages/monitor-ui/src/...` - failed-build view shows verdict + confidence chip and links to the sidecar markdown. Read the JSON twin for typed display fields.
- `packages/pi-eforge/extensions/...` - mirror the CLI/MCP surface in the Pi extension per the AGENTS.md sync rule. At minimum: an MCP tool that triggers recovery and one that reads the sidecar.
- `eforge-plugin/.claude-plugin/plugin.json` - bump version (parity-of-surface change).

### Files to reuse (do not reinvent)

- `packages/engine/src/agents/staleness-assessor.ts` - structural template for the agent body.
- `packages/engine/src/schemas.ts:getSchemaYaml` - Zod → YAML for prompt injection.
- `packages/engine/src/prompts.ts:loadPrompt` - templated prompt loader.
- `packages/engine/src/state.ts:loadState` + `.eforge/session-plans/<setName>/` - source for plan-level outcomes inside the summary.
- `packages/engine/src/git.ts` (commit log helpers) - source for landed-commits inside the summary; do *not* introduce new git wrappers.
- `packages/engine/src/concurrency.ts` - leave untouched; recovery is read-only and outside the build semaphore.

### Forward-compatibility for future auto-execute (option 3)

The verdict schema includes `confidence` and a verdict-specific structured payload (e.g. `suggestedSuccessorPrd` for `split`). The JSON sidecar is the stable contract a future executor would consume. **Out of scope here:** any code that *reads* a verdict and acts on it. v1 ends at writing the sidecar. The follow-up PRD adds an executor gated on `confidence === 'high'` and a configured allowlist of verdicts.

## Scope

### In scope

- `BuildFailureSummary` assembly from event log, plan state JSON, and surviving feature branch git data.
- `recovery-analyst` agent (tools: `'none'`, structured output, closed prompt) emitting a `RecoveryVerdict`.
- Verdict schema with fields: `verdict`, `confidence: 'low'|'medium'|'high'`, `rationale`, `completedWork[]`, `remainingWork[]`, `risks[]`, `suggestedSuccessorPrd?`.
- Four-verdict surface: `retry | split | abandon | manual`, with `manual` as the safe default.
- Daemon trigger on `plan:build:failed` that spawns `eforge recover` as a clean subprocess (not reusing the failed engine process).
- Sidecar writer producing `<prdId>.recovery.md` (human) and `<prdId>.recovery.json` (machine) in `eforge/queue/failed/`.
- New `eforge recover <setName> <prdId>` CLI subcommand.
- `eforge_recover` MCP tool exposed via `mcp-proxy.ts` and `mcp-tool-factory.ts`.
- Pi extension parity: at minimum an MCP tool to trigger recovery and one to read the sidecar.
- Monitor UI surface: verdict + confidence chip and link to sidecar markdown on the failed-build view; typed display fields read from JSON twin.
- New events: `recovery:start`, `recovery:summary`, `recovery:complete`, `recovery:error`.
- Successor PRD draft (for `split` verdict) carries the *full* original Acceptance Criteria per the `prd-completeness` rule.
- Plugin version bump in `eforge-plugin/.claude-plugin/plugin.json`.

### Out of scope

- Auto-execution of any verdict.
- Mid-pipeline resume / "continue from partial state" - infeasible anyway; worktrees are already torn down by `orchestrator.ts:185` before recovery runs.
- Feature-branch cleanup automation triggered by `abandon`. Sidecar recommends `git branch -D <featureBranch>`; user runs it.
- Changes to the existing `failed/` lifecycle in `prd-queue.ts`.
- Any change to auto-build behavior (the `dont_retry_builds` rule stands).
- Any code that *reads* a verdict and acts on it (deferred to follow-up PRD).

## Acceptance Criteria

1. **Unit (StubHarness):** `test/recovery.test.ts` constructs a fake `BuildFailureSummary`, runs the agent through StubHarness with a canned verdict in its output, asserts the parsed `RecoveryVerdict` and rendered sidecar match expectations across all four verdicts.
2. **Schema round-trip:** assert `recoveryVerdictSchema` accepts every produced verdict and that `getRecoveryVerdictSchemaYaml()` is non-empty valid YAML.
3. **CLI smoke:** `pnpm build && node packages/eforge/dist/cli.js recover <setName> <prdId>` against a fixture failed PRD writes both sidecar files; exit code 0 even on `manual` verdict.
4. **Daemon integration:** in a dev daemon, force a plan failure (a PRD that intentionally errors); confirm `recovery:complete` event arrives and `<prdId>.recovery.md` appears next to the failed PRD.
5. **Monitor UI:** open the failed build's row; verdict chip and sidecar link render.
6. **Concurrency invariant:** trigger a failure while a second build is queued; confirm recovery runs *and* the queued build still claims its permit on schedule (recovery did not consume a build slot).
7. **Type-check + lint:** `pnpm type-check && pnpm test` clean.
8. CLI exits non-zero only on infrastructural error; a `manual` verdict is treated as success.
9. Recovery runs in a clean subprocess spawned by the daemon, not within the failed engine process.
10. The recovery agent makes no side effects beyond writing the sidecar file (no re-enqueue, no code edits, no queue modifications).
11. Agent model/effort/thinking come from config (via `agent-runtime-registry.ts` + `config.ts`), not the prompt, honoring the closed-prompts rule.
