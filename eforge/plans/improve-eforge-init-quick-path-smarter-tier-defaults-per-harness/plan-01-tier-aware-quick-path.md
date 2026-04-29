---
id: plan-01-tier-aware-quick-path
name: Tier-aware Quick path in both init skills
branch: improve-eforge-init-quick-path-smarter-tier-defaults-per-harness/tier-aware-quick-path
---

# Tier-aware Quick path in both init skills

## Architecture Context

`/eforge:init` ships in two parity-tracked skill files: the Claude Code plugin (`eforge-plugin/skills/init/init.md`, supports both `claude-sdk` and `pi` harnesses) and the Pi extension (`packages/pi-eforge/skills/eforge-init/SKILL.md`, `pi` harness only). Harness-specific sections are wrapped in `<!-- parity-skip-start --> ... <!-- parity-skip-end -->` markers, and `scripts/check-skill-parity.mjs` (run as part of `pnpm test`) enforces that everything outside those markers stays in sync.

The Quick path today asks for a single model and pins it to all three tiers (`max`, `balanced`, `fast`). This wastes Claude Code's three-family lineup (Opus/Sonnet/Haiku) and discourages Pi users from picking a cheaper balanced-tier model. The fix is purely in skill instruction text — no engine, MCP tool, or schema changes.

Key existing infrastructure that this plan reuses unchanged:

- `mcp__eforge__eforge_models` with `{ action: "list", harness, provider? }` returns `ModelInfo[]` sorted newest-first by `releasedAt`. `ModelInfo` shape (`packages/engine/src/models.ts:15`): `{ id, provider?, contextWindow?, releasedAt?, deprecated? }`.
- `deriveProfileName()` in `packages/engine/src/config.ts:1613` already produces the names the new flows will land on (`claude-sdk` for the three-family Claude Quick result, sanitized model id for an all-same Pi Quick result, `pi-<provider>` for a split-max/balanced Pi Quick result).
- The `eforge_init` MCP tool already accepts a fully assembled `profile.models.{max,balanced,fast}.id` payload — no schema work required.

Family detection on the Claude side is by case-insensitive substring match on `id` (`opus`, `sonnet`, `haiku`), filtered to `!deprecated`, taking the first match (which is the newest because the list is pre-sorted).

## Implementation

### Overview

Replace the Quick-path Step 3a in both skill files with a harness-branched flow. Bump the plugin version because any plugin change requires a version bump per AGENTS.md.

### Key Decisions

1. **Skill-only change.** The PRD explicitly notes no engine/MCP/schema work is required; `eforge_models` already returns sorted, harness-filtered results, and `eforge_init` already accepts the resulting profile shape. Keep the change surface to three files.
2. **Family detection by substring.** The PRD specifies case-insensitive `id` substring matching for `opus`/`sonnet`/`haiku`, filtered to `!deprecated`. Take the first match in the newest-first list. This is simpler and more robust than parsing release dates client-side.
3. **Pi `fast = balanced` is automatic.** Do not prompt for fast on the Pi Quick path. Whatever value `balanced` ends up at (either the user's separate pick or the reused max id) becomes `fast.id`. This caps the Pi Quick path at two model questions while still surfacing tier-aware cost savings.
4. **Plugin uses runtime name `main`; pi-eforge uses `pi-<provider>`.** This naming inconsistency is pre-existing and explicitly out of scope per the PRD. Preserve it.
5. **Step 4 aside.** Add a single sentence under Step 4 in both skills clarifying the Claude SDK Quick path will typically land on the candidate name `claude-sdk` (since each tier picks a different family by default). Sets the user's expectation before the candidate name prompt.
6. **Parity is preserved.** All harness-branched edits stay inside the existing `<!-- parity-skip-start --> ... <!-- parity-skip-end -->` block in the plugin skill (the pi-eforge skill is single-harness with no claude-sdk branch to skip). The parity check (`pnpm test` runs `scripts/check-skill-parity.mjs`) must continue to pass.
7. **Plugin version bump.** Bump `eforge-plugin/.claude-plugin/plugin.json` from `0.14.0` to `0.15.0`. Plugin and npm package versions are independent (per AGENTS.md), and the pi-eforge package version is intentionally left untouched ("Do not bump the Pi package version").

## Scope

### In Scope

- Rewrite Step 3a (Quick path) in `eforge-plugin/skills/init/init.md` to branch on harness:
  - `claude-sdk`: one `eforge_models` list call → derive Opus/Sonnet/Haiku family defaults → present recommendation → accept `confirm | customize <tier> | customize all` → assemble single-runtime profile with three distinct tier model ids (no `tiers` block).
  - `pi`: provider pick (unchanged) → max model pick (unchanged) → new "pick a separate balanced?" prompt with reuse-max default → derive `fast = balanced` automatically (no prompt) → assemble single-runtime profile (`runtime: main`, harness `pi`, `pi.provider` set).
- Apply the equivalent Pi-only Quick-path treatment in `packages/pi-eforge/skills/eforge-init/SKILL.md` (steps 3a). Runtime name stays `pi-<provider>` per existing pi-eforge convention.
- Add a one-line aside under Step 4 in both skills explaining that Claude SDK Quick will typically land on `claude-sdk` as the candidate name.
- Bump `eforge-plugin/.claude-plugin/plugin.json` from `0.14.0` to `0.15.0`.

### Out of Scope

- Step 3b Mix-and-match path (already tier-by-tier with smart defaults).
- `eforge_init` MCP tool, `eforge_models` MCP tool, profile schemas, daemon endpoints.
- Step 1 (postMergeCommands), Step 5 (persist), Step 6 (`--migrate`), Step 7 (report).
- The pre-existing runtime-naming inconsistency between plugin (`main`) and pi-eforge (`pi-<provider>`).
- Any change to `packages/pi-eforge/package.json` version (explicit project rule: do not bump Pi package version).
- Any new model registry entries, family-detection unit tests, or engine code.

## Files

### Modify

- `eforge-plugin/skills/init/init.md` — replace Step 3a (Quick path) at lines ~35–62 with the harness-branched flow described under "Detailed changes A" in the source PRD. Keep the entire Step 3a section inside the existing `<!-- parity-skip-start --> ... <!-- parity-skip-end -->` block. Add a one-line aside under Step 4 (around line 113) noting that Claude SDK Quick typically lands on `claude-sdk` as the candidate name (place this aside inside the parity-skip block too, since it references the claude-sdk harness).
- `packages/pi-eforge/skills/eforge-init/SKILL.md` — replace Step 3a (Quick path) at lines ~36–60 with the Pi-only version: provider pick (unchanged) → max pick (unchanged) → new balanced-encouragement prompt with reuse-max default → derive `fast = balanced` automatically. Runtime name stays `pi-<provider>`. Step 4 aside is not needed here (no claude-sdk branch in this skill), but if added for parity-shaped symmetry, scope it strictly to Pi behavior.
- `eforge-plugin/.claude-plugin/plugin.json` — bump `version` from `0.14.0` to `0.15.0`.

### Create

None.

## Detailed Edit Specs

### A. `eforge-plugin/skills/init/init.md` Step 3a — Claude SDK branch

New block content (must live inside the `<!-- parity-skip-start --> ... <!-- parity-skip-end -->` markers that already wrap Steps 2–6):

1. "Harness" pick: unchanged — `claude-sdk` or `pi`, no default.
2. If harness = `claude-sdk`:
   - Call `mcp__eforge__eforge_models` once with `{ action: "list", harness: "claude-sdk" }`.
   - From the returned list (already sorted newest-first), select tier defaults by scanning for the first non-deprecated entry whose `id` contains, case-insensitively:
     - `opus` → `max` default
     - `sonnet` → `balanced` default
     - `haiku` → `fast` default
   - Present the three picks framed as a recommendation, e.g.:
     > Claude Code ships three model families. Latest of each:
     > - **max**: `claude-opus-4-7` (Opus — deepest reasoning)
     > - **balanced**: `claude-sonnet-4-6` (Sonnet — strong default)
     > - **fast**: `claude-haiku-4-5` (Haiku — cheapest, quickest)
     >
     > Use these, or customize a tier?
   - Accept one of: `confirm`, `customize <tier>`, `customize all`. For each tier the user wants to change, show the top 10 from the same already-fetched list (no extra `eforge_models` call) and let them pick a different id. Default at each per-tier prompt is the family-derived suggestion.
   - Assemble a single-runtime profile with no `tiers` block:
     ```yaml
     profile:
       agentRuntimes:
         main:
           harness: claude-sdk
       defaultAgentRuntime: main
       models:
         max:      { id: <picked> }
         balanced: { id: <picked> }
         fast:     { id: <picked> }
     ```

### B. `eforge-plugin/skills/init/init.md` Step 3a — Pi branch

3. If harness = `pi`:
   - **Provider** (unchanged): call `mcp__eforge__eforge_models` with `{ action: "providers", harness: "pi" }`, present list, ask user to pick.
   - **Max model** (unchanged): call `mcp__eforge__eforge_models` with `{ action: "list", harness: "pi", provider: "<chosen>" }`, show top 10, ask user to pick.
   - **Balanced model** (new, encouraged):
     > Pick a separate **balanced**-tier model? (Recommended — most build steps run at the balanced tier, so a cheaper/smaller model here saves a lot. Press enter to reuse `<max-id>`.)
     Show the same top-10 list with the user's max pick highlighted as the default. If the user accepts the default, set `balanced.id = max.id`.
   - **Fast model** (new, no prompt): set `fast.id = balanced.id`.
   - Assemble single-runtime profile (runtime named `main`, harness `pi`, with `pi.provider` set):
     ```yaml
     profile:
       agentRuntimes:
         main:
           harness: pi
           pi:
             provider: <chosen>
       defaultAgentRuntime: main
       models:
         max:      { id: <picked> }
         balanced: { id: <picked-or-max> }
         fast:     { id: <balanced> }
     ```

### C. `eforge-plugin/skills/init/init.md` Step 4 aside

Add a single sentence under Step 4 (inside the `parity-skip` block) such as:

> Note: the Claude SDK Quick path will typically land on the candidate name `claude-sdk` because each tier picks a different model family by default (single runtime, model varies across tiers).

### D. `packages/pi-eforge/skills/eforge-init/SKILL.md` Step 3a — Pi-only treatment

Replace lines ~36–60 with:

1. **Provider** (unchanged): call `eforge_models` with `{ action: "providers", harness: "pi" }`, present list, ask user to pick.
2. **Max model** (unchanged): call `eforge_models` with `{ action: "list", harness: "pi", provider: "<chosen>" }`, show top 10, ask user to pick.
3. **Balanced model** (new, encouraged): same prompt copy as the plugin skill:
   > Pick a separate **balanced**-tier model? (Recommended — most build steps run at the balanced tier, so a cheaper/smaller model here saves a lot. Press enter to reuse `<max-id>`.)
   Show the same top-10 list with the user's max pick as the default. If accepted, `balanced.id = max.id`.
4. **Fast model** (new): no prompt; set `fast.id = balanced.id`.
5. Runtime name stays `pi-<provider>` (existing pi-eforge convention — do not change in scope). Assemble:
   ```yaml
   profile:
     agentRuntimes:
       pi-<chosen>:
         harness: pi
         pi:
           provider: <chosen>
     defaultAgentRuntime: pi-<chosen>
     models:
       max:      { id: <picked> }
       balanced: { id: <picked-or-max> }
       fast:     { id: <balanced> }
   ```

### E. `eforge-plugin/.claude-plugin/plugin.json`

Bump `version` from `0.14.0` to `0.15.0`. No other changes.

## Parity check guidance

The parity check (`scripts/check-skill-parity.mjs`, run via `pnpm test`) compares the two skill files outside `<!-- parity-skip-start --> ... <!-- parity-skip-end -->` markers. The plugin skill's Quick path lives entirely inside an existing parity-skip block (currently spanning Steps 2–6), and the pi-eforge skill has its own parity-skip block over the same step range. New harness-branched content in the plugin file MUST stay inside that block. New Pi balanced-prompt copy in the pi-eforge file MUST stay inside that block. Do not introduce new parity-skip markers; reuse the existing ones.

After editing, run `pnpm test` (or just `node scripts/check-skill-parity.mjs`) to confirm parity still passes.

## Verification

- [ ] `eforge-plugin/skills/init/init.md` Step 3a branches on harness; the `claude-sdk` branch derives Opus/Sonnet/Haiku tier defaults from a single `eforge_models` `list` call by case-insensitive `id` substring match on `opus`/`sonnet`/`haiku` filtered to `!deprecated`, and accepts `confirm | customize <tier> | customize all`.
- [ ] `eforge-plugin/skills/init/init.md` Step 3a `pi` branch prompts for provider, then max, then a balanced-tier model with reuse-max default, and explicitly does NOT prompt for fast (sets `fast.id = balanced.id`).
- [ ] `eforge-plugin/skills/init/init.md` Step 3a Claude SDK branch's assembled profile contains `agentRuntimes.main.harness: claude-sdk`, `defaultAgentRuntime: main`, and three `models.{max,balanced,fast}.id` entries with no `tiers` block.
- [ ] `eforge-plugin/skills/init/init.md` Step 3a Pi branch's assembled profile contains `agentRuntimes.main.harness: pi`, `agentRuntimes.main.pi.provider`, `defaultAgentRuntime: main`, and three `models.{max,balanced,fast}.id` entries with no `tiers` block.
- [ ] `eforge-plugin/skills/init/init.md` Step 4 contains a one-sentence aside noting the Claude SDK Quick path typically lands on the candidate name `claude-sdk`.
- [ ] All harness-branched Step 3a content in `eforge-plugin/skills/init/init.md` is inside the existing `<!-- parity-skip-start --> ... <!-- parity-skip-end -->` block (no new parity markers added).
- [ ] `packages/pi-eforge/skills/eforge-init/SKILL.md` Step 3a prompts provider → max → balanced (with reuse-max default), does NOT prompt for fast, and sets `fast.id = balanced.id`.
- [ ] `packages/pi-eforge/skills/eforge-init/SKILL.md` Step 3a's assembled profile retains the runtime name `pi-<provider>` (existing convention preserved).
- [ ] `eforge-plugin/.claude-plugin/plugin.json` `version` field is `0.15.0` (bumped from `0.14.0`).
- [ ] `packages/pi-eforge/package.json` version is unchanged from its pre-edit value.
- [ ] `pnpm test` succeeds — in particular, `scripts/check-skill-parity.mjs` reports no parity violations.
- [ ] `pnpm type-check` succeeds (no source changes, but a regression check that no edit accidentally touched a typed file).
- [ ] No occurrences of the words `appropriate`, `properly`, `correctly`, `should`, `clean`, `well`, `adequate`, `reasonable`, `robust`, `seamless`, or `intuitive` were introduced into either skill file (style hygiene).