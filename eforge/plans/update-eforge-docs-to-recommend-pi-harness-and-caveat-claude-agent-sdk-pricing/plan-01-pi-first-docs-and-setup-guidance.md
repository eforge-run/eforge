---
id: plan-01-pi-first-docs-and-setup-guidance
name: Pi-first Docs and Setup Guidance
branch: update-eforge-docs-to-recommend-pi-harness-and-caveat-claude-agent-sdk-pricing/plan-01-pi-first-docs-and-setup-guidance
agents:
  builder:
    effort: high
    rationale: Policy-sensitive copy must stay consistent across public docs,
      generated reference sources, plugin skills, Pi skill docs, and a small Pi
      setup UI copy change.
  reviewer:
    effort: high
    rationale: Review needs to check cross-document consistency, generated artifact
      discipline, and conservative Anthropic pricing language.
---

# Pi-first Docs and Setup Guidance

## Architecture Context

eforge has a harness abstraction with two supported execution backends: `pi` and `claude-sdk`. The engine runtime defaults in `packages/engine/src/config.ts` still default tiers to `claude-sdk`; this plan is limited to documentation and setup-guidance copy, with a small user-facing Pi extension profile wizard copy/default-order adjustment. Public reference docs are generated through `packages/docs-gen/src/generators/*`, and raw public mirrors under `web/public/**` are generated artifacts.

The docs must steer new users toward Pi as the recommended execution harness while preserving `claude-sdk` as a supported Anthropic-specific secondary path. Claude Agent SDK pricing language must be conservative and match Anthropic's Help Center article: <https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan>.

## Implementation

### Overview

Update the root README, public docs, configuration docs, generated config-reference generator, Claude Code plugin skills, Pi fallback skill docs, and Pi profile wizard UI copy so the same product message appears everywhere:

- Pi is the recommended eforge execution harness for new users.
- Claude Code can remain the host surface while builds execute through a Pi profile.
- `claude-sdk` remains supported for users who intentionally want the Anthropic Claude Agent SDK.
- Claude Agent SDK usage must be described as credit-limited/API-priced according to Anthropic's June 15, 2026 policy article, not as unmetered Claude plan usage.
- Current engine fallback defaults remain documented as compatibility behavior, not as a recommendation for new configs.

Run `pnpm docs:generate` after source updates and commit the generated changes it produces.

### Key Decisions

1. **Use Pi-first examples.** First examples for profiles and tiers use `harness: pi` with `pi.provider`. Claude SDK snippets move to explicit secondary/optional sections.
2. **Use one conservative Anthropic caveat.** Reuse a short paraphrase of the Help Center article where needed: starting June 15, 2026, Claude Agent SDK and `claude -p` usage no longer count toward Claude plan limits; eligible plans may receive a separate monthly Agent SDK credit; usage beyond that credit is billed at standard API rates when extra usage is enabled, otherwise requests stop; API-key users remain pay-as-you-go.
3. **Separate host surface from execution harness.** Keep repeating that Claude Code or Pi can drive eforge, and the active profile chooses the execution harness.
4. **Keep runtime truth intact.** Do not edit `packages/engine/src/config.ts`; where built-in tier defaults are shown, label the `claude-sdk` defaults as current engine compatibility fallback and recommend explicit Pi profiles for new projects.
5. **Regenerate rather than hand-edit generated artifacts.** Edit `packages/docs-gen/src/generators/config.ts` and `web/content/docs/**`; then run `pnpm docs:generate` for generated references and public mirrors.
6. **Integration parity matters.** Keep paired Claude Code and Pi skill docs synchronized outside intentional `parity-skip` regions. Bump the Claude Code plugin version because plugin files change; do not bump the Pi package version.

## Scope

### In Scope

- Update public and source documentation to recommend the `pi` harness for new eforge setup.
- Add Anthropic Claude Agent SDK pricing/credit caveats using the verified Help Center URL.
- Rework new-user examples from Claude-SDK-first to Pi-first.
- Keep Claude SDK examples in secondary/optional sections with the pricing caveat.
- Update generated config reference source and regenerate committed generated docs.
- Update Claude Code plugin skill docs and Pi fallback skill docs for init/profile guidance.
- Adjust Pi profile wizard copy/default ordering so the first custom tier starts Pi-first, while still allowing `claude-sdk`.
- Bump `eforge-plugin/.claude-plugin/plugin.json` patch version from `0.25.4` to `0.25.5` unless the version has already advanced, in which case increment the current patch version once.

### Out of Scope

- Runtime default changes in `packages/engine/src/config.ts`.
- Removal of `claude-sdk` support.
- Quota routing, profile fallback, pricing enforcement, or provider-economics runtime logic.
- Legal analysis beyond a conservative paraphrase of Anthropic's Help Center article.
- Pi package version changes in `packages/pi-eforge/package.json`.
- Direct edits to `web/public/**` without source or generator changes.

## Files

### Create

- None.

### Modify

- `README.md` — Add a concise Claude Agent SDK economics caveat near the intro/prerequisites, revise `/eforge:init` copy to steer Claude Code users toward Pi profiles, replace the standalone Claude-SDK-first profile example with a Pi-first profile example using current `model: <id>` and `pi.provider` syntax, and reframe third-party harness license/pricing notes so Free/Pro/Max/OAuth language does not imply unmetered build capacity.
- `web/content/docs/getting-started.md` — Keep Pi package recommended, add the Claude Agent SDK policy caveat, and state that Claude Code can host the workflow while a Pi profile executes builds.
- `web/content/docs/concepts.md` — Update the Harnesses section so `pi` is recommended/provider-flexible and `claude-sdk` is supported secondary Anthropic-specific/API-priced.
- `web/content/docs/configuration.md` — Change the first tier example and the profile-toolbelt UI example to Pi-first, add a secondary Claude SDK example/caveat, and keep current engine fallback defaults honest where mentioned.
- `web/content/docs/glossary.md` — Update the Harness definition with Pi as provider-flexible recommended path and Claude SDK as supported Anthropic-specific path.
- `docs/config.md` — Make top examples Pi-first; keep the built-in default table unchanged but add a compatibility note; add a Claude SDK caveat in `### Claude SDK Tiers`; update backend profile and toolbelt examples away from `claude-max`/Claude-first naming unless a section specifically documents Claude SDK.
- `docs/config-migration.md` — Expand the fallback-default note so users know omitted tiers still fall back to current `claude-sdk` engine defaults, but new and migrated Pi configs need explicit Pi tier entries.
- `docs/prd/typescript-extensibility.md` — Replace `subscription/OAuth providers` with safer wording such as `OAuth, credit-limited, or provider-metered accounts`.
- `docs/prd/profile-toolbelts.md` — Make the main profile/toolbelt example Pi-based or add a direct note that toolbelts are harness-independent and new profile examples use Pi first.
- `packages/docs-gen/src/generators/config.ts` — Update the generated Toolbelts config reference snippet from `harness: claude-sdk` to a Pi-first example with `pi.provider`, and keep generated Markdown coherent with the source docs.
- `eforge-plugin/skills/init/init.md` — Present Pi as the recommended Quick setup path in Claude Code, add the Anthropic pricing caveat before a `claude-sdk` choice, remove the phrase `Claude Code's built-in SDK`, keep `claude-sdk` available as secondary, and keep tool-call examples aligned with the current profile shape used by the daemon docs.
- `packages/pi-eforge/skills/eforge-init/SKILL.md` — Review the Pi init fallback docs for consistency with the new Pi-first message; add a caveat only where it mentions using existing `claude-sdk` profiles or Claude SDK as an option.
- `eforge-plugin/skills/profile-new/profile-new.md` — Replace `claude-max` and all-claude primary examples with Pi-first names such as `pi-anthropic`, `pi-openrouter`, or a local-provider example. Present `claude-sdk` as optional/secondary with the pricing caveat.
- `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` — Mirror the profile-new guidance changes from the plugin skill outside intentional Pi-only note blocks so `pnpm docs:check-parity` passes.
- `packages/pi-eforge/extensions/eforge/profile-commands.ts` — Change harness picker descriptions to remove `Claude Code's built-in SDK`, label Pi as recommended/provider-flexible, label Claude SDK as Anthropic-specific/API-priced or credit-limited, and make the first custom tier default to Pi unless the user already selected `claude-sdk` on an earlier tier. Do not remove the `claude-sdk` option.
- `eforge-plugin/.claude-plugin/plugin.json` — Bump patch version because plugin skill docs change.
- `web/content/reference/config.md` — Regenerated by `pnpm docs:generate` from `packages/docs-gen/src/generators/config.ts`; do not hand-edit.
- `web/public/docs/getting-started.md` — Regenerated public mirror from `web/content/docs/getting-started.md`; do not hand-edit.
- `web/public/docs/concepts.md` — Regenerated public mirror from `web/content/docs/concepts.md`; do not hand-edit.
- `web/public/docs/configuration.md` — Regenerated public mirror from `web/content/docs/configuration.md`; do not hand-edit.
- `web/public/docs/glossary.md` — Regenerated public mirror from `web/content/docs/glossary.md`; do not hand-edit.
- `web/public/reference/config.md` — Regenerated config reference mirror; do not hand-edit.
- `web/public/llms.txt` and `web/public/llms-full.txt` — Regenerated agent-readable bundles if `pnpm docs:generate` changes them; do not hand-edit.

## Implementation Notes

- Use the verified Anthropic Help Center URL in at least README and Getting Started. Other docs can refer back to the caveat without duplicating the full paragraph.
- Keep caveat wording factual and narrow. Avoid statements about legality beyond Anthropic's own terms/policy links.
- Use current tier YAML syntax in docs and examples:
  - `model: <model-id>` as a plain string in profile/config YAML.
  - `pi:` sub-block with `provider: <provider>` for Pi tiers.
  - `claudeSdk:` sub-block only for Claude SDK-specific options.
- In skill docs that describe JSON payloads, use the daemon's current `agents.tiers` shape and include `pi: { provider: "..." }` for Pi tiers. Avoid introducing legacy `agentRuntimes`, `backend`, or `agents.models` examples except in migration-only sections.
- Preserve intentional differences inside existing `parity-skip` blocks, but keep paired skill docs byte-equivalent after the parity script's normalization.
- After editing source docs/generator files, run `pnpm docs:generate` and include all generated changes in the commit.

## Verification

- [ ] `README.md` contains the Help Center URL `https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan` and states that Pi is the recommended eforge execution harness.
- [ ] `web/content/docs/getting-started.md`, `web/content/docs/concepts.md`, `web/content/docs/configuration.md`, and `web/content/docs/glossary.md` each distinguish Pi as recommended from `claude-sdk` as supported secondary.
- [ ] `docs/config.md` still lists current built-in tier defaults as `claude-sdk`, and the text around the table recommends explicit Pi profiles for new projects.
- [ ] `docs/config-migration.md` contains a fallback-default caveat that tells Pi users to list all four Pi tiers when migrating.
- [ ] `rg -n "Claude Code's built-in SDK|claude-max|Example for an all-claude-sdk profile|subscription/OAuth providers" README.md web/content docs eforge-plugin packages/pi-eforge packages/docs-gen/src/generators/config.ts` returns no stale source-doc matches.
- [ ] `packages/engine/src/config.ts` has no diff.
- [ ] `packages/pi-eforge/package.json` has no diff.
- [ ] `eforge-plugin/.claude-plugin/plugin.json` version is greater than `0.25.4`.
- [ ] `pnpm docs:generate` has been run and its generated changes are committed.
- [ ] `pnpm docs:check-parity` passes.
- [ ] `pnpm type-check` passes.
- [ ] `pnpm docs:check` passes.
