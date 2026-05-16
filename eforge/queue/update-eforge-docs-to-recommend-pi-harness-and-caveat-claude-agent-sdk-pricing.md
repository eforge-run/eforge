---
title: Update eforge docs to recommend Pi harness and caveat Claude Agent SDK pricing
created: 2026-05-16
profile: pi-codex-5-5
---

# Update eforge docs to recommend Pi harness and caveat Claude Agent SDK pricing

## Problem / Motivation

eforge documentation currently contains stale or ambiguous guidance around execution harness selection. Existing docs already indicate a Pi-centric direction, but several public docs, configuration examples, plugin skills, Pi integration docs, and UI strings still present `claude-sdk` as primary or equivalent without caveating Anthropic’s Claude Agent SDK subscription/API pricing changes.

### Context and evidence gathered

- Project conventions (`AGENTS.md`) require user-facing docs to stay in sync across:
  - root `README.md`
  - public docs under `web/content/`
  - generated reference artifacts
  - Claude Code plugin skills under `eforge-plugin/`
  - Pi integration docs/skills under `packages/pi-eforge/`
- Consumer-facing integration changes should check both `eforge-plugin/` and `packages/pi-eforge/`.
- Roadmap (`docs/roadmap.md`) emphasizes provider flexibility under Integration & Maturity.
  - This docs update aligns with that direction.
  - This docs update does not add new engine/runtime behavior.
- Root docs already state eforge's direction is Pi-centric:
  - `README.md:10` says runtime choice, cost, and token efficiency should stay visible.
  - `README.md:42` says Claude Agent SDK can be used when the tradeoff makes sense.
- Getting started docs already recommend Pi:
  - `web/content/docs/getting-started.md` has "Pi package (recommended)".
  - It says Pi is the direction eforge is heading.
- Marketing pages already contain API-economics language:
  - `web/app/page.tsx` has "No subscription wrapper" copy.
  - `web/app/why/page.tsx` has a "Built for API economics" section.
- High-impact stale/ambiguous spots found by search:
  - `README.md:72`, `web/content/docs/getting-started.md:14` describe credentials for `pi` vs `claude-sdk` but do not mention the June 15 Claude Agent SDK API-pricing/subscription change.
  - `README.md:97` says Claude Code init lets users choose between `claude-sdk` and `pi`; this should steer toward Pi while preserving Claude SDK as supported.
  - `README.md:118-145` leads standalone users with a minimal Claude Agent SDK profile; this should be replaced or preceded by a Pi profile example.
  - `README.md:192-194` references Consumer Terms / Free / Pro / Max users and OAuth tokens; this is the most policy-sensitive area and should be caveated or reframed.
  - `web/content/docs/concepts.md:51-54`, `web/content/docs/glossary.md:42` describe both harnesses without explaining the changed economics.
  - `web/content/docs/configuration.md` and `docs/config.md` use Claude SDK as the primary examples; docs should make Pi examples primary while honestly noting current code fallback defaults where relevant.
  - `eforge-plugin/skills/init/init.md` presents `claude-sdk` and `pi` equally and describes Claude SDK as "Claude Code's built-in SDK"; it should recommend Pi first and include the economics caveat.
  - `eforge-plugin/skills/profile-new/profile-new.md` and `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` use example names like `claude-max` and all-claude-sdk examples; these should be deprioritized in favor of `pi-anthropic`, `pi-openrouter`, or local-provider examples.
  - `packages/pi-eforge/extensions/eforge/profile-commands.ts` has UI copy that labels Claude SDK as "Claude Code's built-in SDK" and orders it first when the default harness is `claude-sdk`; this may be a code/UI-copy change rather than strictly docs.
  - `docs/prd/typescript-extensibility.md:327` refers to "subscription/OAuth providers" in future quota usage notes; adjust wording to avoid implying subscription quota is reliable execution capacity.
- Generated docs:
  - `web/public/**` is generated from source.
  - Update source docs/generators and then run `pnpm docs:generate` and `pnpm docs:check` rather than editing generated files directly.

### Early assumptions / unknowns

- Authoritative source verified:
  - Anthropic Help Center, "Use the Claude Agent SDK with your Claude plan"
  - `https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan`
  - Modified 2026-05-15.
- Relevant statements extracted from the page:
  - Starting June 15, 2026, Claude Agent SDK and `claude -p` usage no longer count toward Claude plan usage limits.
  - Eligible Pro/Max/Team/Enterprise users can claim a separate monthly Agent SDK credit.
  - Usage beyond the credit moves to extra usage at standard API rates if extra usage is enabled.
  - Otherwise requests stop until credit refresh.
  - API-key users continue pay-as-you-go and do not receive the subscription-plan credit.
- The engine's built-in `DEFAULT_CONFIG` currently still defaults tiers to `claude-sdk` (`packages/engine/src/config.ts`).
  - This planning session is documentation-focused.
  - Changing runtime defaults is out of scope unless explicitly added.
- Generated reference config examples come from `packages/docs-gen/src/generators/config.ts`.
  - Updating those examples may be necessary so `web/content/reference/config.md` and generated public docs do not drift.

### Assumptions and validation

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| Anthropic's Claude Agent SDK usage should be documented as credit-limited/API-priced rather than subscription-usage-backed after June 15, 2026. | Verified against Anthropic Help Center article "Use the Claude Agent SDK with your Claude plan". The article says Agent SDK and `claude -p` usage no longer count toward Claude plan usage limits starting June 15, 2026; eligible subscription users receive a separate monthly Agent SDK credit; after credit depletion usage moves to extra usage at standard API rates if enabled, otherwise requests stop; API-key users remain pay-as-you-go and do not receive the credit. Repository search found no existing caveat. | High | Low | During implementation, quote/paraphrase the Help Center article conservatively and include the link where useful. | High — inaccurate docs could mislead users on cost/legal expectations. |
| Docs-only update is sufficient for this plan; runtime defaults and harness support do not need to change. | User explicitly asked to investigate/propose docs updates, and current request invoked planning for docs direction. `packages/engine/src/config.ts` still has `claude-sdk` defaults; changing that would be product/runtime behavior beyond docs. | High | Low | Ask user if they want a follow-up runtime-default change. | Medium — if product direction requires code defaults, docs-only may leave onboarding behavior inconsistent. |
| Pi should be positioned as recommended primary path for new users. | Existing docs already say Pi package is recommended and eforge direction is Pi-centric (`README.md`, `web/content/docs/getting-started.md`, `web/app/why/page.tsx`). User explicitly asked to steer users to Pi. | High | Low | None needed beyond final review of wording. | Medium — weak steering would fail user intent. |
| Generated docs must be regenerated from source rather than edited directly. | Project conventions and repository layout show `web/public/**` generated; public content lives in `web/content/**` and generators under `packages/docs-gen/**`. | High | Low | Run `pnpm docs:generate` and `pnpm docs:check`. | Medium — generated artifact drift or direct generated edits could fail docs check. |
| Skill docs are part of user-facing docs and should be updated when setup guidance changes. | AGENTS.md says keep `eforge-plugin/` and `packages/pi-eforge/` in sync for user-facing behavior. Search found init/profile guidance in both integration packages. | High | Low | Review `eforge-plugin/skills/**` and `packages/pi-eforge/skills/**` during implementation. | Medium — users following slash-command guidance would still see stale recommendations. |
| Updating Pi extension overlay strings may be necessary despite being code, because the strings are user-facing setup copy. | Search found `packages/pi-eforge/extensions/eforge/profile-commands.ts` descriptions/order for Claude SDK and Pi. | Medium | Low | Inspect UI behavior and decide whether copy-only code changes are within the docs PRD. | Low/Medium — stale overlay copy could undercut docs, but skill/docs can still be correct. |

## Goal

Update eforge documentation and user-facing setup guidance so new users are steered toward the `pi` harness as the recommended execution path, while preserving `claude-sdk` as a supported secondary Anthropic-specific option.

The final docs should accurately caveat Claude Agent SDK usage as credit-limited/API-priced according to Anthropic’s Help Center article, without changing runtime defaults or removing Claude SDK support.

## Approach

- Update source documentation, not generated `web/public/**` artifacts directly.
- Make Pi harness/profile examples primary across public docs, config docs, generated config snippets, plugin skills, and Pi integration skills.
- Keep Claude SDK examples available only as secondary, optional, advanced, or Anthropic-specific examples.
- Add conservative caveats anywhere docs mention:
  - Claude subscriptions
  - Free/Pro/Max
  - Consumer Terms
  - OAuth tokens
  - Claude Code built-in SDK
  - Claude Agent SDK economics
- Keep current runtime behavior accurate where mentioned:
  - `packages/engine/src/config.ts` currently still has `claude-sdk` defaults.
  - Runtime default changes are out of scope unless explicitly added.
- Keep Claude Code and Pi integration documentation in sync where profile/init user-facing behavior is described.
- Use the verified Anthropic Help Center article for precise date/credit/API-rate claims, while avoiding broader legal interpretation beyond that source.
- Regenerate and check generated docs after source updates:
  ```bash
  pnpm docs:generate
  pnpm docs:check
  ```

### Documentation impact

#### Primary public docs

- `README.md`
  - Add a concise Claude Agent SDK economics/policy caveat near the introductory harness discussion or Install prerequisites.
  - Make the standalone profile example Pi-first instead of Claude-SDK-first.
  - Revise `/eforge:init` description so Claude Code users are steered toward Pi unless they intentionally choose `claude-sdk`.
  - Revise third-party harness license note around Consumer Terms / Free/Pro/Max / OAuth tokens so it does not imply subscription usage is a stable primary execution path.
- `web/content/docs/getting-started.md`
  - Keep Pi package recommended.
  - Add Claude Agent SDK API-pricing caveat to prerequisites / Claude Code plugin section.
  - Clarify that Claude Code host surface and Pi execution harness can be combined.
- `web/content/docs/concepts.md`
  - In Harnesses, explain `pi` is recommended/default docs path and `claude-sdk` is secondary/Anthropic-only/API-priced.
- `web/content/docs/configuration.md`
  - Change the first tier example to Pi harness.
  - Keep a separate Claude SDK section/example with caveat.
  - Update toolbelt UI example if it remains all `claude-sdk`.
- `web/content/docs/glossary.md`
  - Update Harness definition to mention Pi as provider-flexible recommended path and Claude SDK as supported Anthropic-specific path.

#### Source/reference docs

- `docs/config.md`
  - Update examples and explanatory text to make Pi primary.
  - Keep the Built-in Tier Defaults table accurate if runtime code is unchanged, with a compatibility note rather than implying initialized projects should rely on fallback defaults.
  - Add Claude SDK caveat in `### Claude SDK Tiers`.
- `docs/config-migration.md`
  - Where it says unset tiers fall back to `claude-sdk`, add a short compatibility caveat and recommend explicit Pi tiers/profiles for new configs.
- `docs/prd/typescript-extensibility.md`
  - Replace "subscription/OAuth providers" with safer wording such as "OAuth, credit-limited, or provider-metered accounts".
- `docs/prd/profile-toolbelts.md`
  - If examples are user-facing enough to matter, consider making at least one toolbelt example Pi-based or adding a note that harness choice is independent.
- `packages/docs-gen/src/generators/config.ts`
  - Update generated config reference snippets currently hard-coded to `harness: claude-sdk`.
  - Regenerate docs afterward.

#### Integration/skill docs and UI copy

- `eforge-plugin/skills/init/init.md`
  - Present Pi first and recommended in the Claude Code `/eforge:init` flow.
  - Add economics caveat before the user chooses `claude-sdk`.
  - Keep `claude-sdk` available but no longer equally promoted.
- `eforge-plugin/skills/profile-new/profile-new.md`
  - Replace example names like `claude-max` with Pi-first examples.
  - Move all-claude-sdk example into secondary/advanced caveat section or replace with Pi primary + mixed secondary.
- `packages/pi-eforge/skills/eforge-profile-new/SKILL.md`
  - Keep in parity with profile-new guidance.
  - It is fallback documentation, but it still currently uses `claude-max` and all-claude examples.
- `packages/pi-eforge/extensions/eforge/profile-commands.ts`
  - UI strings/order may need a small user-facing copy change:
    - Descriptions currently say "Claude Code's built-in SDK".
    - The UI can present Claude SDK first when default is `claude-sdk`.
  - This is a code/UI-copy change.
  - Include only if the docs update is allowed to touch integration copy.

#### Generated artifacts

- Run:
  ```bash
  pnpm docs:generate
  ```
- Run:
  ```bash
  pnpm docs:check
  ```
- Do not directly edit generated `web/public/**` without corresponding source/generator changes.

### Profile signal

Recommended eforge build profile: **Excursion**.

Rationale:

- The work is documentation-focused and cohesive: update a consistent product-positioning message across docs, generated docs sources, and setup skill docs.
- It touches multiple files and integrations, so Errand is too small; a planning/review cycle is valuable to catch contradictory copy.
- It does not require delegated module planning or architecture decomposition. A single plan can enumerate the affected docs and source-generator changes, so Expedition would be unnecessary overhead.

Suggested build prompt emphasis:

- Keep Pi as the recommended path, not the only path.
- Preserve factual current behavior: `claude-sdk` remains supported and current engine fallback defaults may still be Claude SDK unless runtime code is changed.
- Use the verified Anthropic Help Center article for precise date/credit/API-rate claims; still avoid broader legal interpretation beyond that source.

## Scope

### In scope

- Update user-facing documentation to reflect that the Claude Agent SDK harness should be treated as API-priced/credit-limited rather than a primary subscription-backed path.
- Steer new users toward the `pi` harness as the recommended eforge execution path because it supports:
  - provider-flexible API access
  - OAuth-backed providers where supported by Pi
  - local models
- Preserve `claude-sdk` as a supported secondary harness for users who explicitly want Anthropic Claude Agent SDK behavior.
- Rework examples so Pi harness/profile examples are primary and Claude SDK examples are secondary/advanced.
- Add caveats anywhere docs mention:
  - Claude subscriptions
  - Free/Pro/Max
  - Consumer Terms
  - OAuth tokens
  - Claude Code built-in SDK
  - Claude Agent SDK economics
- Keep Claude Code and Pi integration documentation in sync where profile/init user-facing behavior is described.
- Regenerate/check generated public docs after source updates.

### Out of scope

- Changing runtime defaults in `packages/engine/src/config.ts`.
  - Current engine fallback defaults to `claude-sdk` should be documented honestly if mentioned.
- Removing `claude-sdk` support.
- Implementing quota routing, automatic profile fallback, or other provider-economics runtime logic.
- Making legal claims beyond conservative caveats.
  - Exact Anthropic policy wording should be verified before final copy states a precise date or contractual interpretation.

### Roadmap relation

- Aligns with the roadmap's Integration & Maturity theme around provider flexibility.
- Does not implement roadmap functionality; it is a documentation and user-guidance update.

## Acceptance Criteria

- Root `README.md` clearly states that Pi is the recommended eforge execution harness and Claude Agent SDK is a supported secondary Anthropic-specific option.
- Any README language about Claude subscriptions, Free/Pro/Max, Consumer Terms, OAuth tokens, or Claude Agent SDK economics is caveated so users are not led to believe eforge can rely on unmetered subscription usage after the announced policy change.
- Public docs are consistent:
  - `web/content/docs/getting-started.md`
  - `web/content/docs/concepts.md`
  - `web/content/docs/configuration.md`
  - `web/content/docs/glossary.md`
- Public docs consistently state:
  - Pi is recommended.
  - Claude Code may still be used as a host surface while builds execute through Pi.
  - `claude-sdk` remains supported but secondary/API-priced.
- Configuration docs keep current runtime defaults accurate while recommending explicit Pi profiles for new projects:
  - `docs/config.md`
  - `docs/config-migration.md`
- Primary examples for new-user setup and profiles are Pi-first.
- Claude SDK examples, where kept, are explicitly marked as optional/secondary.
- Claude Code plugin skill docs and Pi fallback skill docs that guide profile/init flows are updated so user-facing setup guidance is not contradictory.
- Generated config/reference snippets are updated at the source generator where applicable, not only in generated output.
- Generated docs are refreshed with:
  ```bash
  pnpm docs:generate
  ```
- Docs drift check passes with:
  ```bash
  pnpm docs:check
  ```
- The final diff contains no direct edits to `web/public/**` without corresponding source/generator changes.
- The final copy cites or is consistent with Anthropic's Help Center article:
  - `https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan`
