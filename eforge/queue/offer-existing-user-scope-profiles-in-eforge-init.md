---
title: Offer existing user-scope profiles in `/eforge:init`
created: 2026-04-29
depends_on: ["improve-eforge-init-quick-path-smarter-tier-defaults-per-harness"]
---

# Offer existing user-scope profiles in `/eforge:init`

## Problem / Motivation

The `/eforge:init` skill always walks the user through harness + provider + model selection from scratch, even when the user already has user-scope profiles in `~/.config/eforge/profiles/`. Users who routinely set up new projects with the same personal preferences (e.g. their go-to claude-sdk + opus/sonnet/haiku profile, or a preferred Pi provider) re-answer the same form every time. We already support user-scope profiles end-to-end — `eforge_profile list --scope user` lists them and `eforge_profile use --scope user` activates one for a project — but the init skills don't surface this option.

## Goal

When a user runs `/eforge:init` and already has one or more user-scope profiles, the skill should offer to activate one of those as the project's active profile instead of building a fresh project profile from scratch. If the user declines (or has no user-scope profiles), the existing flow runs unchanged.

## Approach

Add a new step at the start of the interactive flow (after Step 1 postMergeCommands resolution, before the existing Step 2 setup-mode question), in BOTH skill files:

1. `eforge-plugin/skills/init/init.md` (Claude Code plugin)
2. `packages/pi-eforge/skills/eforge-init/SKILL.md` (Pi extension)

The new step:

1. Call `eforge_profile { action: "list", scope: "user" }` to fetch user-scope profiles.
2. If the response is empty, skip the new step entirely and continue to the existing Step 2 (setup mode).
3. If one or more user-scope profiles exist, present them with a brief summary (name, harness, max-tier model id) and ask:
   > Use an existing user-scope profile, or create a new project profile?
   > 1. <name> (<harness>, max=<id>)
   > 2. <name> (<harness>, max=<id>)
   > N. Create a new project profile

4. If the user picks an existing profile:
   - Call `eforge_profile { action: "use", name: "<chosen>", scope: "user" }` to activate it for this project.
   - Still write `eforge/config.yaml` with the resolved `postMergeCommands` from Step 1 (postMergeCommands is project-scoped team config, independent of the agent runtime profile).
   - Skip the existing Steps 2–5 (setup mode, Quick/Mix-and-match assembly, profile name, persist via `eforge_init`).
   - Jump to a Step 7-equivalent report: "eforge initialized with user-scope profile `<name>` activated."
5. If the user picks "create a new project profile", fall through to the existing Step 2 (setup mode) and continue unchanged.

For the postMergeCommands write in step 4: if there is no existing `eforge_init`-style entry point that accepts "activate this user-scope profile + write only postMergeCommands", check whether `eforge_config` (or a thin extension of `eforge_init`) can be used. If neither fits cleanly, add the smallest reasonable entry point — preferred approach is to extend `eforge_init` to accept an `existingProfile: { name, scope }` field that, when present, causes the tool to skip profile assembly/creation, call the daemon's profile-use endpoint, and still write `eforge/config.yaml` with `postMergeCommands`.

Both skill files must stay in lockstep — pi-eforge's version skips the harness question (always pi) but otherwise has the same new-step shape.

## Scope

**In scope:**
- New "select existing user-scope profile" step in both `eforge:init` skill files.
- Whatever minimal MCP/daemon surface is needed to activate an existing user-scope profile while still writing project-scope `postMergeCommands` (extend `eforge_init` if needed; do not duplicate the logic in two MCP tools).
- Plugin version bump in `eforge-plugin/.claude-plugin/plugin.json`.

**Out of scope:**
- Changing the existing Quick / Mix-and-match flow (that is its own already-shipped change).
- Adding a "create user-scope profile from this project" loop here (covered by `/eforge:profile-new --scope user`).
- Surfacing project-scope existing profiles (the user is running init, which implies no project profile yet — and if one does exist, `--force` is already the documented path).
- Migrating legacy configs (`--migrate` path stays unchanged).

## Acceptance Criteria

1. In a project where `~/.config/eforge/profiles/` contains at least one profile, running `/eforge:init` lists those profiles after the postMergeCommands step and lets the user pick one. Picking it writes/updates `.active-profile` and `eforge/config.yaml` with the postMergeCommands but does NOT create anything under `eforge/profiles/`.
2. After selecting an existing user-scope profile, `eforge_profile { action: "show" }` reports the activated profile with `scope: "user"` and `source` set to user-scope.
3. In a project where `~/.config/eforge/profiles/` is empty, `/eforge:init` behavior is identical to today (Step 1 → Step 2 setup mode → existing flow).
4. The "create a new project profile" branch from the new step produces the same output as today's flow (a project-scope profile under `eforge/profiles/<name>.yaml` with the same default-derived name).
5. Both `eforge-plugin/skills/init/init.md` and `packages/pi-eforge/skills/eforge-init/SKILL.md` are updated coherently — pi-eforge's variant simply omits the harness question if it has to ask anything, since its harness is always `pi`.
6. `eforge-plugin/.claude-plugin/plugin.json` version is bumped.
7. Existing `/eforge:init --migrate` and `/eforge:init --force` flows are unaffected.
