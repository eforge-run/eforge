---
title: EXTEND_05: Phase-1 Extension Docs and Examples
created: 2026-05-16
depends_on: ["update-eforge-docs-to-recommend-pi-harness-and-caveat-claude-agent-sdk-pricing"]
profile: pi-codex-5-5
---

# EXTEND_05: Phase-1 Extension Docs and Examples

## Problem / Motivation

Evidence reviewed:
- Product source: `docs/prd/typescript-extensibility.md` defines EXTEND_05 as the phase-1 docs/examples sweep and says future examples should ship with the feature epic that introduces the API.
- Schaake OS epic `97517154-a67e-4afe-b696-c43aa8714550` is in progress, high priority, unblocked, and depends on the SDK/loader/event-runtime/management MVP epics. Acceptance criteria emphasize docs, event-oriented examples/templates, scopes/config/trust/lifecycle/validation/testing/management commands/limitations, toolbelt relationship, future-API marking, and example validation.
- Roadmap: `docs/roadmap.md` includes Native TypeScript extensions under Extensibility, with multi-phase rollout from typed event hooks.
- Current docs already exist: `docs/extensions.md`, `docs/extensions-api.md`, and `packages/extension-sdk/README.md`.
- Current examples exist: `examples/extensions/minimal-event-logger.ts`, `agent-context.ts`, `profile-router.ts`, and `protected-paths.ts`, with `examples/extensions/README.md` documenting them.
- Current scaffold templates are only `event-logger` and `blank` in `packages/engine/src/extensions/scaffold.ts`.
- `test/extension-sdk-example.test.ts` imports extension examples for SDK surface/type-check smoke coverage, currently including `minimal-event-logger`, `protected-paths`, and `profile-router`.
- Search did not find a current `/eforge:extend` skill in `packages/pi-eforge/skills` or `eforge-plugin`; the PRD assigns that to EXTEND_06. Phase-1 docs should not imply the authoring slash command exists yet unless implementation is added in a later epic.

Current-state observations:
- Documentation appears partially ahead of the original EXTEND_05 phase-1 boundaries: `docs/extensions.md` and SDK README already document runtime-supported `onAgentRun` and `registerProfileRouter`, while EXTEND_05's description names only initial-delivery capabilities plus the authoring workflow. This is acceptable only if those capabilities have actually landed; otherwise docs need clearer “runtime status” labeling.
- Existing examples include non-event examples (`agent-context.ts`, `profile-router.ts`, `protected-paths.ts`). These need explicit runtime-status labels so users know which examples execute today and which are provenance/type-contract-only.
- The required Slack notifier example/template from the epic acceptance criteria is not present in `examples/extensions/` by filename. It may need to be added as an event-oriented example or the acceptance criteria should be interpreted as “event logger plus supported notifier-style example.”
- Public docs generation references extension docs via `packages/docs-gen/src/manifest.ts` and `packages/docs-gen/src/generators/llms.ts`; if source docs change, generated public/reference artifacts may need regeneration or drift checks.

Current drift/evidence:
- `cmp` shows `docs/extensions*.md` differ from `web/content/docs/extensions*.md`; `web/content` and `web/public` are currently equal. The diff includes expected web frontmatter/link transformations, but also meaningful runtime-status drift for `registerProfileRouter` in `web/content/docs/extensions.md`. A docs-generation pass or deliberate source/content sync is needed.
- `docs/extensions.md` links to `./hooks.md`, but search did not validate that `docs/hooks.md` exists; generated web content links to `/reference/config#hooks`. The implementation should run docs link checks or adjust the source link to a valid canonical target.
- Existing docs already include profile router and agent-context content. The build should either keep these because implementation/tests are present, or explicitly downgrade them if the current code is not considered shipped for EXTEND_05.

## Goal

Bring phase-1 native extension documentation, examples, scaffold-template documentation, generated docs artifacts, and validation tests into a coherent, agent-readable state that accurately reflects the capabilities currently shipped in the repository.

The result should clearly distinguish runtime-supported extension capabilities from deferred/future APIs, avoid implying `/eforge:extend` or other unavailable workflows exist, and keep public docs and example validation in sync.

## Approach

High-level implementation approach:
- Update or verify the primary docs/examples:
  - `docs/extensions.md` — conceptual guide: scopes, config, discovery/precedence, loader strategy, statuses/diagnostics/provenance, management commands, replay testing, runtime support matrix, toolbelt relationship, trust/security, deferred capability boundaries.
  - `docs/extensions-api.md` — API reference: type signatures and runtime status for SDK methods, especially exact support/deferred status for `onEvent`, `onAgentRun`, `registerProfileRouter`, `beforePlanMerge`, custom tools, input sources, reviewer perspectives, and validation providers.
  - `packages/extension-sdk/README.md` — package-facing quick start and runtime support summary; must stay aligned with `docs/extensions*.md`.
  - `examples/extensions/README.md` — example catalog and validation instructions; should list all examples and clearly mark runtime-supported versus deferred/provenance-only behavior.
  - `examples/extensions/*.ts` — example headers/comments may need updates; add a Slack/webhook notifier example if acceptance criteria require it and keep it safe/testable without real Slack credentials.
  - `packages/engine/src/extensions/scaffold.ts` comments/templates only if docs discover a mismatch with scaffold behavior; do not broaden templates unless intentionally in scope.
  - Generated public docs artifacts: `web/content/docs/extensions.md`, `web/content/docs/extensions-api.md`, `web/public/docs/extensions.md`, `web/public/docs/extensions-api.md`, and generated `web/public/llms*.txt` if changed by `pnpm docs:generate`.
- Keep documentation aligned with code/tests for SDK/loader/discovery/config, `onEvent` runtime + replay, management commands (`list`, `show`, `validate`, `test`, `new`, `reload`), `onAgentRun` prompt-context support, and pre-build `registerProfileRouter` if the implementation/tests remain present.
- Add or update supported event-oriented examples/templates. At minimum preserve/validate `minimal-event-logger.ts`, document scaffold templates (`event-logger`, `blank`), and add a Slack/webhook-style notifier example if feasible without requiring secrets at test time.
- Ensure examples clearly distinguish runtime-supported examples from deferred/provenance-only examples such as policy gates/custom tools/input sources/reviewer perspectives/validation providers.
- Mark future APIs/capabilities as deferred until their epics land, without implying `/eforge:extend` exists before EXTEND_06.
- Ensure generated docs artifacts stay in sync by running or accounting for `pnpm docs:generate` and `pnpm docs:check`.
- Ensure examples are covered by tests or document/run the appropriate validation commands.

Assumptions/unknowns to validate or carry:
- Need to verify whether generated docs under `web/` / public docs are currently in sync and whether docs-gen must be run in this build.
- Need to verify whether `agent-context` and `profile-router` are intentionally in scope for EXTEND_05 because their epics have already landed, or whether this plan should constrain itself to phase-1/event docs and mark those examples as future/deferred.
- Need to verify exact test commands that should be acceptance gates for examples and docs drift.

Assumptions and validation:

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| This is a docs-focused build, not a runtime feature build. | Schaake OS EXTEND_05 title/description/acceptance criteria are documentation/examples only; PRD separates `/eforge:extend` into EXTEND_06 and runtime feature families into later epics. | High | Low | Re-check Schaake OS epic/dependencies if requirements changed. | Scope creep into runtime implementation could make the build too large and conflict with epic boundaries. |
| `/eforge:extend` is not implemented yet and should be documented as future/deferred, not available. | `rg "eforge:extend|extend" packages/pi-eforge/skills eforge-plugin README.md docs` found only PRD mentions, no skill implementation. | High | Low | Search package manifests/skill registries again before implementation. | Docs could instruct users to run a command that does not exist. |
| Scaffold templates are only `event-logger` and `blank`. | `packages/engine/src/extensions/scaffold.ts` exports `SUPPORTED_EXTENSION_SCAFFOLD_TEMPLATES = ['event-logger', 'blank']`. | High | Low | Re-run search or inspect scaffold implementation after concurrent changes. | Docs/examples could advertise unavailable templates. |
| Profile router and agent-context docs may be legitimate current-state content even though they are later than the original phase-1 PRD boundaries. | Code and docs include `packages/engine/src/extensions/agent-context-runtime.ts`, `profile-router-runtime.ts`; `test/extension-tooling-wiring.test.ts` asserts `onAgentRun` and `registerProfileRouter` runtime status; `examples/extensions/agent-context.ts` and `profile-router.ts` exist. | Medium-high | Low | Run targeted tests; inspect git/epic state if deciding whether EXTEND_08A/09 have landed. | If not actually shipped, docs would overpromise runtime support; if removed, docs would underdocument current behavior. |
| A Slack/webhook notifier example can be added safely without live credentials by guarding on an env var or extracting pure payload logic. | Not yet implemented; existing examples are type-checked by import. Event-oriented notifier examples are common and can be made no-op without configuration. | Medium | Low | Add example and import it in `test/extension-sdk-example.test.ts`; optionally unit-test pure payload formatting if added. | If implemented with real network calls unguarded, tests or replay could perform unwanted external requests. |
| Generated docs are currently out of sync in a meaningful way. | `cmp` showed `docs/extensions*.md` differ from `web/content/docs/extensions*.md`; diff shows profile-router runtime-status drift in `web/content/docs/extensions.md`, beyond expected frontmatter/link differences. | High | Low | Run `pnpm docs:generate` then `pnpm docs:check`; inspect git diff. | Public docs/LLM artifacts could remain stale even if source docs are fixed. |
| Existing example validation path is `test/extension-sdk-example.test.ts`. | Test imports `minimal-event-logger`, `protected-paths`, and `profile-router`, and SDK surface types; `examples/extensions/README.md` documents this. | High | Low | Add any new example import to the test and run targeted vitest. | New examples might compile in docs but fail TypeScript in real usage. |
| The canonical event-type reference link in source docs may need adjustment. | `docs/extensions.md` links to `./hooks.md`; `find docs` did not surface a `docs/hooks.md` file during extension-doc search, and generated web content uses `/reference/config#hooks`. | Medium | Low | `test -f docs/hooks.md` or run docs link check; update source link if missing. | Docs link checks or user navigation could fail. |

Assumption review:
- All material assumptions have cheap validation paths.
- No low-confidence/high-impact assumption remains unresolved.
- The main medium-confidence item is whether to keep post-phase-1 runtime content, and local code/tests strongly suggest it should be kept unless the user/epic owner says otherwise.

Profile signal:
- Recommended eforge profile: **excursion**.
- Rationale: this is a cohesive docs/examples/test-alignment task that one planner can fully enumerate. It spans multiple docs surfaces plus generated artifacts and test wiring, so it is larger than an Errand. It does not require delegated subsystem planning or independent module planners, so Expedition would be unnecessary.

## Scope

In scope:
- Bring phase-1 native extension documentation into a coherent, agent-readable state across `docs/extensions.md`, `docs/extensions-api.md`, `packages/extension-sdk/README.md`, `examples/extensions/README.md`, and generated web/public docs artifacts.
- Document the capabilities that currently exist in this repository, with explicit runtime-status boundaries for each registration family. Based on code/tests, this includes SDK/loader/discovery/config, `onEvent` runtime + replay, management commands (`list`, `show`, `validate`, `test`, `new`, `reload`), `onAgentRun` prompt-context support, and pre-build `registerProfileRouter` if the implementation/tests remain present.
- Add or update supported event-oriented examples/templates. At minimum preserve/validate `minimal-event-logger.ts`, document scaffold templates (`event-logger`, `blank`), and add a Slack/webhook-style notifier example if feasible without requiring secrets at test time.
- Ensure examples clearly distinguish runtime-supported examples from deferred/provenance-only examples such as policy gates/custom tools/input sources/reviewer perspectives/validation providers.
- Explain extension scopes, config, trust/security, lifecycle/loading, validation/testing/replay, management commands, limitations, and relationship to profile toolbelts.
- Mark future APIs/capabilities as deferred until their epics land, without implying `/eforge:extend` exists before EXTEND_06.
- Ensure docs-generation artifacts stay in sync (`web/content/docs/*`, `web/public/docs/*`, `llms` outputs as generated by `pnpm docs:generate`).
- Ensure examples are covered by tests or document/run the appropriate validation commands.

Out of scope:
- Implementing new runtime capability beyond documentation/examples: no new policy-gate enforcement, custom tool injection, input transformers, reviewer perspectives, validation providers, or `/eforge:extend` skill.
- Adding `extension enable/disable/promote/demote` command behavior; docs should continue to mark those deferred.
- Changing the trust model, loader, SDK contracts, daemon API, or CLI behavior except for small doc/example-test wiring required by examples.

Evidence:
- EXTEND_05 epic acceptance criteria are docs/examples focused.
- `packages/engine/src/extensions/scaffold.ts` currently supports only `event-logger` and `blank` templates.
- Search did not find `/eforge:extend` skill implementation; PRD assigns that to EXTEND_06.
- Existing `test/extension-tooling-wiring.test.ts` asserts documentation runtime-status language and command coverage.
- Existing `test/extension-sdk-example.test.ts` type-checks examples.

No user-facing runtime behavior docs should be added for `/eforge:extend` beyond noting it is future/deferred until EXTEND_06 unless the skill actually lands in this build.

## Acceptance Criteria

Functional/documentation completeness:
- `docs/extensions.md` and `docs/extensions-api.md` accurately describe the currently shipped native extension capabilities and are internally consistent with `packages/extension-sdk/README.md`.
- Docs cover scopes, config fields, discovery precedence, loader strategy, trust/security, lifecycle/loading, statuses/diagnostics/provenance, management commands, validation, event replay testing, runtime limitations, and examples.
- Docs explicitly explain native TypeScript extensions versus profile toolbelts: toolbelts are declarative MCP capability bundles selected by profiles; extensions are imperative TypeScript modules observing/influencing eforge lifecycle behavior; toolbelt filtering must not be presented as filtering extension-contributed tools or engine-internal tools.
- Future/deferred capabilities are clearly labelled, including policy gates, custom agent tools/tool availability, input transformers, reviewer perspectives, validation providers, enable/disable/promote/demote workflows, package/install support, and `/eforge:extend` authoring UX if not yet implemented.
- Runtime-supported capabilities that already exist in code/tests (`onEvent`, event replay, management MVP, `onAgentRun` prompt append, and `registerProfileRouter` pre-build dispatch if retained) are documented with accurate fail-open/timeout/provenance behavior.
- `examples/extensions/README.md` lists all current examples and includes a clear validation section.
- Examples/templates include supported event-oriented examples. `minimal-event-logger.ts` remains valid; add a Slack/webhook notifier example or equivalent notifier-style event example if needed to satisfy the epic, without requiring live credentials during tests.
- Scaffold templates (`event-logger`, `blank`) used by `eforge extension new` are documented exactly as implemented.
- Generated docs artifacts are regenerated or otherwise brought into intentional sync; `pnpm docs:check` should pass after changes.

Validation criteria:
- `pnpm test -- test/extension-sdk-example.test.ts test/extension-tooling-wiring.test.ts` or equivalent targeted vitest invocation passes after example/doc wording updates.
- `pnpm docs:check` passes, or the build records why docs generation/check is deferred and what command remains for the user.
- If a new example is added, it is imported/type-checked by `test/extension-sdk-example.test.ts` or covered by an equally explicit validation path.
- Link checks/reference-content tests pass as part of `pnpm test` or targeted docs tests.

Non-regression criteria:
- No docs claim `eforge extension enable`, `disable`, `promote`, or `demote` is available.
- No docs claim `/eforge:extend` exists unless this build also implements the skill in both Pi and Claude Code surfaces.
- No example implies policy gates/custom tools/input transformers/reviewer perspectives/validation providers execute at runtime before their runtime epics land.
