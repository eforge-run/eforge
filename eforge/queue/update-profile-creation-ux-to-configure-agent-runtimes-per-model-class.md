---
title: Update profile creation UX to configure agent runtimes per model class
created: 2026-05-01
---

# Update profile creation UX to configure agent runtimes per model class

## Problem / Motivation

`/eforge:profile:new` has a broken multi-runtime UX: it selects one harness/provider before model selection, which limits every model class to that runtime's model list. Users need to express preferences per model class, e.g. max on one agent runtime and balanced/fast on another.

The current Pi native flow lives in `packages/pi-eforge/extensions/eforge/profile-commands.ts`. `handleProfileNewCommand()` currently asks for one harness near the start, optionally one Pi provider, then loads models for only that runtime and asks for `max`, `balanced`, and `fast` models from that same list. This prevents creating a profile where max uses one runtime and balanced/fast use another.

The Pi fallback skill docs in `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` and the Claude plugin skill docs in `eforge-plugin/skills/profile-new/profile-new.md` describe the same single-runtime flow and include optional global tuning (`agents.effort`, `pi.thinkingLevel`) that the user does not want in this wizard. The plugin skill matters if keeping consumer-facing flows aligned, though the Pi native extension does not use the MCP proxy for its native command.

The user clarified that "agent runtime" is the right concept: a runtime is effectively harness plus provider/config, while model class (`max`, `balanced`, `fast`) represents capability/cost model slots.

Existing config concepts appear sufficient: `agentRuntimes` declares named runtimes, `defaultAgentRuntime` selects the default runtime, `agents.models.{max,balanced,fast}` selects model IDs by model class, and existing `agents.tiers.<planning|implementation|review|evaluation>.agentRuntime` / `agents.roles.<role>.agentRuntime` can route workloads where runtime routing is needed. The wizard must not emit invalid `agents.tiers.max|balanced|fast` keys; `agents.tiers` is keyed by workload tier names.

Roadmap alignment: this fits the "Integration & Maturity" theme, especially provider flexibility and future shared tool registry work, but it is not explicitly listed as a roadmap item.

## Goal

Update the `/eforge:profile:new` UX (Pi native, Pi fallback skill, and Claude plugin skill) so that agent runtime selection happens per model class (`max`, `balanced`, `fast`) rather than once globally, while emitting only valid existing profile config and removing global tuning prompts from the wizard.

## Approach

- Use **agent runtime** terminology in the UX. A runtime is `claude-sdk` or `pi` plus provider-specific config; avoid saying "harness+provider" to users except as explanatory detail.
- Configure model classes in order: `max`, `balanced`, then `fast`.
- For `max`, require explicit runtime and model selection.
- For `balanced`, preselect the `max` runtime and model, but offer a different runtime.
- For `fast`, if max and balanced share a runtime, preselect that runtime; if they differ, offer either existing runtime or a third/different runtime.
- Do not offer global profile tuning (`agents.effort`, top-level `pi.thinkingLevel`) in this wizard.
- Do not add advanced workload-tier tuning or routing in this change; keep the profile-new wizard focused on model/runtime selection.
- Emit only valid existing config. Do not create invalid `agents.tiers.max|balanced|fast` keys.
- Default routing should use existing defaults: `defaultAgentRuntime` backs max-like work, while `agents.tiers.implementation.agentRuntime` can route implementation/balanced work when balanced uses a different runtime.
- Treat `fast` carefully: eforge has a `fast` model class, but no built-in workload tier currently defaults to it. If the user chooses a fast model/runtime, clearly mention in the preview/docs that fast is declared for future/manual use but is not currently used by default.

### Code Impact

Primary implementation files:

- `packages/pi-eforge/extensions/eforge/profile-commands.ts` — replace the current single harness/provider selection with a per-model-class agent runtime/model wizard.
- `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` — update fallback skill instructions to match the native Pi flow.
- `eforge-plugin/skills/profile-new/profile-new.md` — update Claude plugin skill instructions to match the same flow.

Likely supporting checks:

- `packages/pi-eforge/extensions/eforge/index.ts` may need review only to confirm the Pi `eforge_profile` tool can already pass daemon-supported profile create payloads. Avoid changes unless required by the existing native command payload.
- `eforge-plugin/.claude-plugin/plugin.json` version must be bumped if the Claude plugin skill doc changes, per project instructions.

Existing helper APIs to reuse:

- `showSelectOverlay`, `showSearchableSelectOverlay`, `showInfoOverlay`, `withLoader` from `packages/pi-eforge/extensions/eforge/ui-helpers.ts`.
- daemon model endpoints via `API_ROUTES.modelProviders` and `API_ROUTES.modelList`.
- profile creation via `API_ROUTES.profileCreate`.

### Profile Signal

Recommended profile: **Excursion**.

Rationale: this is a focused consumer-facing feature touching the Pi native command plus two documentation/skill surfaces. It is not an errand because the UX has multi-step state and valid-config translation concerns. It is not an expedition because it should not change engine schema, model resolution, or architecture.

## Scope

### In scope

- Update Pi native `/eforge:profile:new` in `packages/pi-eforge/extensions/eforge/profile-commands.ts` so agent runtime selection happens per model class (`max`, `balanced`, `fast`) rather than once globally.
- Update `packages/pi-eforge/skills/eforge-profile-new/SKILL.md`, the Pi fallback/model-readable skill doc, so non-native fallback behavior matches the native flow.
- Update `eforge-plugin/skills/profile-new/profile-new.md` so the Claude Code plugin skill presents the same agent-runtime-per-model-class workflow and produces valid existing profile config.
- Remove global tuning prompts from profile creation. Do not add an advanced workload-tier routing/tuning step in this change.
- Ensure generated profiles use existing valid schema concepts: `agentRuntimes`, `defaultAgentRuntime`, `agents.models`, and workload-tier or role runtime overrides where needed.

### Out of scope

- Engine schema changes, including adding a new `agents.modelRuntimes` concept.
- MCP proxy implementation changes unless a documented plugin flow cannot express a daemon-supported profile creation payload through existing tools.
- Changing model resolution semantics or agent tier definitions.

## Acceptance Criteria

- Pi native `/eforge:profile:new <name>` no longer asks for one global harness/runtime before all model choices.
- The native flow asks for an agent runtime and model for `max`, `balanced`, and `fast` in order.
- `balanced` defaults to the max runtime/model but allows a different runtime/model.
- `fast` offers previously selected runtimes and, when appropriate, an option to configure a third/different runtime.
- The created profile contains valid existing schema only: `agentRuntimes`, `defaultAgentRuntime`, `agents.models`, and optional valid `agents.tiers.<planning|implementation|review|evaluation>` overrides.
- The flow does not write provider fields into `agents.models.*`; Pi provider remains on the relevant `agentRuntimes.<name>.pi.provider` entry.
- The wizard does not offer or write global `agents.effort` or top-level/global Pi thinking defaults.
- The wizard does not include advanced workload-tier tuning/routing.
- The preview/docs mention that the `fast` model class is not currently used by default in eforge.
- Pi fallback skill docs and Claude plugin profile-new skill docs describe the same runtime-per-model-class flow.
- Claude plugin version is bumped because plugin skill docs changed.
- No engine schema or model/runtime resolution changes are made.
