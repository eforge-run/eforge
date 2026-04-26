---
title: Surface tiers within `/eforge:config`
created: 2026-04-26
---

# Surface tiers within `/eforge:config`

## Problem / Motivation

The recent config refactor introduced **agent tiers** (`planning` / `implementation` / `review` / `evaluation`) as a layer between global agent settings and per-role overrides. Tiers ship with sensible built-in defaults (e.g. implementation → `effort=medium, modelClass=balanced`; planning/review/evaluation → `effort=high, modelClass=max`) and can be overridden via `agents.tiers.<tier>` in `eforge/config.yaml`. The full resolution chain is now: plan override → role → **tier** → global → built-in role default → built-in tier default (`packages/engine/src/pipeline/agent-config.ts:419-463`).

The `/eforge:config` skill in both consumer integrations (`eforge-plugin/` and `packages/pi-eforge/`) was written before tiers existed. Today it:

- Mentions `modelClass` only as a per-role override field, with no explanation that classes resolve through a tier layer.
- Says "Eight roles default to `balanced`; all others default to `max`" — this narrative is now wrong; tier defaults drive that mapping.
- Describes the resolution order as "per-role model > global model > user class override > backend class default > fallback chain" — missing the tier step.
- Has no interview question about tier-level tuning.

User directive: keep the skill surface minimal — no new `/eforge:tiers` skill. Instead, fold tier guidance into `/eforge:config` so users get walked through tiers as one of the major config dimensions when they ask to edit config.

## Goal

Update both `/eforge:config` skill bodies (Claude Code plugin + Pi extension) so that users editing config are walked through agent tiers as a first-class config dimension, and the skill copy accurately reflects the new tier-aware resolution chain and defaults.

## Approach

Edit both `/eforge:config` skill bodies (Claude Code plugin + Pi extension) so they:

1. **Frame agent config as three layers of granularity** (global → tier → per-role) instead of just global + per-role. Introduce this framing once at the top of the agent-config sections; the user doesn't need to memorise the word "tier" — the interview just asks "want to tune agents by group (planning, building, reviewing, evaluating)?"
2. **Add a tier-tuning interview step** between the current global-agent and per-role steps. Explain the four tiers conversationally with their default behavior, list which roles fall in each, and offer per-tier `effort` / `modelClass` overrides.
3. **Fix the stale resolution-order narrative** to include tier.
4. **Fix the stale "eight roles default to balanced" statement** — replace with the tier-defaults framing.
5. **Add tier examples to the Configuration Reference YAML block** alongside the existing `roles:` example.
6. Keep wording aligned between the two SKILL.md files (per AGENTS.md "keep eforge-plugin and pi-eforge in sync").
7. Bump `eforge-plugin/.claude-plugin/plugin.json` version (per AGENTS.md "always bump the plugin version when changing anything in the plugin"). Do **not** bump `packages/pi-eforge/package.json` (per AGENTS.md "do not bump the Pi package version").

### Skill-body edits in detail

#### A. Replace the "Sections to cover" list

The current list bundles all agent tuning into "Model & thinking tuning" (#2) + "Per-role agent overrides" (#4). Restructure the agent-related sections to walk granularity from broad to narrow:

- **Global agent defaults** (renamed from "Model & thinking tuning") — global `agents.model` / `agents.thinking` / `agents.effort` / `agents.models.{max,balanced,fast}` (model-class mapping).
- **Tier tuning** (NEW, opt-in) — phrased as "Would you like to tune agents by group? eforge organises agents into four groups by what they do: planning, implementation, review, and evaluation. You can give each group its own effort level or model class without touching individual roles."
  - Briefly list role membership per tier (small inline table or comma-list — copy from `AGENT_ROLE_TIERS` in `packages/engine/src/pipeline/agent-config.ts:29-58` at edit time to avoid drift).
  - Note built-in defaults (implementation: `effort=medium, modelClass=balanced`; planning/review/evaluation: `effort=high, modelClass=max`) so the user knows what a "no-op" tier override looks like.
  - Available knobs per tier: `effort`, `modelClass`, `model`, `thinking`, `maxTurns`, `maxBudgetUsd`, `allowedTools`, `disallowedTools`, `agentRuntime`.
- **Per-role overrides** (existing, opt-in) — keep as the finest-grained option. Add one sentence noting that `roles.<role>.tier` reassigns a role to a different tier (rare but supported).

#### B. Fix the resolution-order narrative

Replace the current "per-role model > global model > user class override > backend class default > fallback chain" line with the full chain:

> Resolution order (highest → lowest): plan override → per-role config → per-tier config → global config → built-in per-role default → built-in per-tier default. Model resolution adds a sub-chain: explicit `model` at any layer wins over `modelClass`, and `modelClass` resolves to a model ID via `agents.models.<class>` (with backend defaults and fallback walking if unset).

#### C. Fix the role-default narrative

Replace "Eight roles (`builder`, `review-fixer`, ...) default to `balanced`; all others default to `max`" with tier-driven framing:

> Built-in defaults come from each role's tier: planning, review, and evaluation roles default to `effort=high, modelClass=max`; implementation roles (builder, fixers, tester, doc-updater, etc.) default to `effort=medium, modelClass=balanced`. Setting `agents.tiers.<tier>.modelClass` shifts a whole tier; setting `agents.roles.<role>.modelClass` shifts a single role.

The implementor must verify the exact role lists at edit time by reading `AGENT_ROLE_TIERS` in `packages/engine/src/pipeline/agent-config.ts:29-58` — do not copy from this plan, since it could be stale.

#### D. Extend the YAML Configuration Reference

Inside the `agents:` block in the example, add a `tiers:` subsection alongside the existing `roles:` example. Sketch:

```yaml
agents:
  # ... existing global + models + roles examples ...
  # --- Tier tuning ---
  # tiers:
  #   planning:
  #     effort: high           # default; lower this to save tokens on planning
  #     modelClass: max        # default
  #   implementation:
  #     effort: medium         # default
  #     modelClass: balanced   # default; raise to `max` for tougher codebases
  #   review:
  #     effort: high
  #     modelClass: max
  #   evaluation:
  #     effort: high
  #     modelClass: max
```

#### E. Pi-specific tweak

The Pi SKILL.md has a top-of-file note: "In Pi, the native `/eforge:config` command provides a richer interactive experience with a structured config viewer overlay. This skill serves as a fallback for non-interactive contexts and as model-readable documentation." Leave this note intact — the skill body still needs to be accurate as a fallback and as documentation.

If the Pi native overlay (outside this skill) renders config sections, that overlay code may also need a tier section — but that's out of scope for this plan, which is skill-body only. Flag it in the implementation PR for follow-up if relevant.

## Scope

### In scope

| File | Change |
|---|---|
| `eforge-plugin/skills/config/config.md` | Add tier framing + new interview section; fix stale resolution chain + role-default narrative; extend Configuration Reference YAML |
| `packages/pi-eforge/skills/eforge-config/SKILL.md` | Mirror the same edits |
| `eforge-plugin/.claude-plugin/plugin.json` | Patch-bump `version` |

### Out of scope

- No other files.
- Source-of-truth (`packages/engine/src/pipeline/agent-config.ts`) is already correct; this plan only updates user-facing skill copy.
- No code (TS) changes; no `pnpm test` / `pnpm type-check` needed.
- Do **not** bump `packages/pi-eforge/package.json`.
- Pi native `/eforge:config` overlay code (outside the skill body) is out of scope; flag for follow-up if relevant.

## Acceptance Criteria

1. **Read both edited skill files end-to-end** to confirm: parity between the two, no stale "8 roles default to balanced" copy left behind, resolution chain mentions tier, YAML reference includes a `tiers:` block.
2. **Confirm role lists match source** — diff the role groupings in the new tier section against `AGENT_ROLE_TIERS` in `packages/engine/src/pipeline/agent-config.ts:29-58`.
3. **Hand-author a small test config** with a tier override (e.g. `agents.tiers.planning.modelClass: balanced`) and run `eforge_config` MCP tool with `{ action: "validate" }` to confirm the schema accepts it. (Schema lives at `packages/engine/src/config.ts:171-230`.)
4. **Dry-run the interview mentally**: a user typing `/eforge:config` in init mode should now hit a tier section that explains tiers in plain English without requiring them to know the term in advance.
5. **Confirm the plugin version bump** in `eforge-plugin/.claude-plugin/plugin.json` (current: `0.9.0` → `0.9.1`).
6. The Pi SKILL.md top-of-file note about the native `/eforge:config` overlay remains intact.
7. Both skill files include:
   - The three-layer granularity framing (global → tier → per-role) introduced once at the top of agent-config sections.
   - A new tier-tuning interview step between global-agent and per-role steps, phrased conversationally and listing role membership per tier plus built-in defaults.
   - Available per-tier knobs documented: `effort`, `modelClass`, `model`, `thinking`, `maxTurns`, `maxBudgetUsd`, `allowedTools`, `disallowedTools`, `agentRuntime`.
   - The full resolution-order narrative (plan override → per-role → per-tier → global → built-in role default → built-in tier default), including the model sub-chain (explicit `model` wins over `modelClass`; `modelClass` resolves via `agents.models.<class>`).
   - Tier-driven role-default framing replacing the stale "eight roles default to balanced" narrative.
   - One sentence in the per-role section noting that `roles.<role>.tier` reassigns a role to a different tier.
   - A `tiers:` subsection in the YAML Configuration Reference alongside the existing `roles:` example.
