---
id: plan-02-consumers-and-docs
name: Surface profile metadata in MCP, Pi, skills, and docs
branch: add-profile-metadata-fields-toolbelts-02/plan-02-consumers-and-docs
---

---
id: plan-02-consumers-and-docs
name: Surface profile metadata in MCP, Pi, skills, and docs
depends_on: [plan-01-engine-and-api]
---

# Surface profile metadata in MCP, Pi, skills, and docs

## Architecture Context

The daemon's profile list/show/create routes (extended in plan-01) are consumed by two integrations that must remain in sync:

- **Claude Code plugin**: `packages/eforge/src/cli/mcp-proxy.ts` exposes the `eforge_profile` MCP tool; user-facing skill docs live at `eforge-plugin/skills/profile/profile.md` and `eforge-plugin/skills/profile-new/profile-new.md`. The plugin manifest at `eforge-plugin/.claude-plugin/plugin.json` must be version-bumped on any plugin change (per `AGENTS.md`).
- **Pi extension**: `packages/pi-eforge/extensions/eforge/index.ts` registers the same `eforge_profile` tool. Native interactive commands live in `packages/pi-eforge/extensions/eforge/profile-commands.ts`, with a pure helper at `packages/pi-eforge/extensions/eforge/profile-payload.ts`. Fallback skill docs mirror Claude's at `packages/pi-eforge/skills/eforge-profile/SKILL.md` and `packages/pi-eforge/skills/eforge-profile-new/SKILL.md`. Per `AGENTS.md`, do NOT bump `packages/pi-eforge/package.json`.

This plan threads the typed metadata wire fields from plan-01 into both integrations, updates user-facing UX/docs to display and (optionally) collect metadata, and adds documentation in `docs/config.md`.

## Implementation

### Overview

Extend the `eforge_profile` create schema in both the Claude MCP proxy and the Pi extension to accept optional `description`, `whenToUse`, and `tags`. Forward those values in the daemon create body. Update the Pi `buildProfileCreatePayload()` helper to carry optional metadata. Update profile list/show display in skill docs (Claude + Pi) to surface metadata. Update the Pi native overlay (`profile-commands.ts`) to display each profile's `description` in the list overlay item description and to render full metadata in the per-profile detail overlay. Update `eforge-plugin/skills/profile-new/profile-new.md` and `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` to mention that metadata can be passed in the create payload (interactive prompting is optional and lightweight). Add a profile metadata section to `docs/config.md` with a YAML example and an explicit "descriptive only" note. Bump the Claude plugin version. Add wiring tests for tool-schema parity and a payload-helper test for metadata pass-through.

### Key Decisions

1. **Tool schemas accept a typed `metadata` object, not flattened fields.** Both MCP proxy (`z.object({ description: z.string().optional(), whenToUse: z.array(z.string()).optional(), tags: z.array(z.string()).optional() }).optional()`) and Pi (`Type.Optional(Type.Object({ description: Type.Optional(Type.String()), whenToUse: Type.Optional(Type.Array(Type.String())), tags: Type.Optional(Type.Array(Type.String())) }))`) carry the same nested shape, matching the wire `metadata` field added in plan-01.
2. **Pi wizard does not strictly prompt for metadata in this slice.** Per the source PRD's medium-confidence assumption, the wizard remains lightweight: the YAML preview rendered by `buildYamlPreview()` shows metadata when present in the payload, and the docs explain how to set metadata, but the four-tier picker does not gain three new screens. Metadata can still be supplied programmatically via the create tool and is preserved in `buildProfileCreatePayload()`. (If implementer time permits, an optional pre-tier overlay can be added — but it is not required to satisfy acceptance criteria.)
3. **Pi list overlay surfaces description in the existing `description` slot.** The current item description is `"${scopeBadge} - ${harnessType}"`. Append `description` from metadata when present, separated by a hyphen, so users skimming the overlay see what each profile is for. The per-profile detail overlay gains a metadata block (description / use when / tags) before the action buttons.
4. **Skill docs update the list table to add a `Description` column (truncated) and document the inspect view.** Both Claude and Pi skill docs gain a `Description` column in the example list table and a metadata section in the inspect-mode output. The create skill docs add an optional `metadata` argument to the example payload.
5. **`docs/config.md` places metadata in a new "Profile metadata" subsection under Profiles, NOT in the global config example.** This avoids the assumption that `eforge/config.yaml` could carry metadata that drives behavior.
6. **Plugin version bump.** Bump `eforge-plugin/.claude-plugin/plugin.json` minor or patch (e.g., `0.23.5` -> `0.24.0`) per `AGENTS.md` rule that any plugin change requires a version bump.

## Scope

### In Scope
- Extend `eforge_profile` MCP tool schema in `packages/eforge/src/cli/mcp-proxy.ts` to accept optional `metadata: { description?, whenToUse?, tags? }`. Forward `metadata` in the create-action body to `API_ROUTES.profileCreate`.
- Extend `eforge_profile` Pi tool schema in `packages/pi-eforge/extensions/eforge/index.ts` to accept the same optional `metadata` parameter. Forward it in the create body.
- Extend `ProfileCreateInput`, `ProfileCreatePayload`, and `buildProfileCreatePayload()` in `packages/pi-eforge/extensions/eforge/profile-payload.ts` to carry optional `metadata`.
- Update Pi native overlay (`packages/pi-eforge/extensions/eforge/profile-commands.ts`):
  - Update `ProfileEntry` inline type to include optional `metadata`.
  - In list overlay, append metadata.description to the existing item description when present.
  - In per-profile detail overlay, render metadata block (description / use when / tags) using `showInfoOverlay` BEFORE presenting the action items, when metadata is present.
  - Update `buildYamlPreview()` to render a metadata block at the top when present in the payload.
- Update Claude skill docs:
  - `eforge-plugin/skills/profile/profile.md`: add a `Description` column to the list table example; add a metadata section to inspect-mode output (description, use when, tags).
  - `eforge-plugin/skills/profile-new/profile-new.md`: document the optional `metadata` argument in the create payload example; explain that metadata is descriptive only and prompting it during creation is optional (the user can edit YAML directly).
- Update Pi fallback skill docs:
  - `packages/pi-eforge/skills/eforge-profile/SKILL.md`: mirror the Claude skill's list/show metadata display.
  - `packages/pi-eforge/skills/eforge-profile-new/SKILL.md`: mirror the Claude skill's create-payload metadata example.
- Bump `eforge-plugin/.claude-plugin/plugin.json` `version` (e.g., `0.23.5` -> `0.24.0`).
- Update `docs/config.md`:
  - Add a `### Profile metadata` subsection (within the existing Profiles section, around line 293-322) with a YAML example showing all three fields and a sentence stating: "Profile metadata is descriptive only. It surfaces in profile list/show UX and `eforge_profile` create payloads but does not affect active profile selection or runtime behavior."
  - Show the example payload for `POST /api/profile/create` carrying `metadata`.
- Add tests:
  - `test/profile-payload.test.ts`: add `describe('metadata pass-through')` group with tests that `buildProfileCreatePayload({ ..., metadata })` includes `metadata` in the payload at the expected location, and that omitting metadata leaves the payload free of a `metadata` key.
  - `test/profile-wiring.test.ts`: extend the existing `describe('eforge_profile scope field parity')` and add a new `describe('eforge_profile metadata field parity')` that:
    - Asserts the MCP proxy schema declares an optional `metadata` zod object with `description`, `whenToUse`, `tags`.
    - Asserts the Pi extension schema declares the equivalent `Type.Optional(Type.Object({...}))`.
    - Asserts both implementations forward `metadata` into the create body (`body.metadata = metadata`).
    - Asserts each plugin/Pi profile skill doc references metadata (greps for `description`, `whenToUse` or `useWhen`/`use when`, `tags`).
    - Asserts the plugin manifest's version is greater than `0.23.5` (semver-aware: major > 0, or minor > 23, or minor === 23 && patch > 5).

### Out of Scope
- Engine schema changes (already in plan-01).
- Daemon route changes (already in plan-01).
- Bumping `packages/pi-eforge/package.json` (per repo rule: do not bump Pi npm package).
- Bumping `DAEMON_API_VERSION`.
- Pi wizard prompting for metadata interactively (deferred; only YAML preview rendering is required here).
- Toolbelt or MCP server filtering features.

## Files

### Modify
- `packages/eforge/src/cli/mcp-proxy.ts` — extend `eforge_profile` schema's `z.object({ ... })` parameters with optional `metadata`. In the create-action handler, attach `metadata` to `body` when defined. Update the tool description to mention metadata briefly.
- `packages/pi-eforge/extensions/eforge/index.ts` — extend the `eforge_profile` `parameters: Type.Object({ ... })` with optional `metadata`. In the create-action branch, attach `metadata` to `body` when defined. Update the tool description likewise.
- `packages/pi-eforge/extensions/eforge/profile-payload.ts` — add optional `metadata?: { description?: string; whenToUse?: string[]; tags?: string[] }` to `ProfileCreateInput` and `ProfileCreatePayload`; preserve it in `buildProfileCreatePayload()`.
- `packages/pi-eforge/extensions/eforge/profile-commands.ts` — extend inline `ProfileEntry` type with `metadata?`; update list-overlay item construction to append metadata.description; add a metadata pre-display step before action items in the per-profile detail; update `buildYamlPreview()` to emit metadata when present in the payload.
- `eforge-plugin/skills/profile/profile.md` — add `Description` column to list table example; add metadata section to inspect-mode display; document that the show response now includes `resolved.metadata`.
- `eforge-plugin/skills/profile-new/profile-new.md` — document the optional `metadata` argument in the create payload example; explain that metadata is descriptive only.
- `eforge-plugin/.claude-plugin/plugin.json` — bump `version` (current `0.23.5`) per `AGENTS.md`.
- `packages/pi-eforge/skills/eforge-profile/SKILL.md` — mirror Claude skill metadata display in fallback docs.
- `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` — mirror Claude skill metadata create-payload example.
- `docs/config.md` — add `### Profile metadata` subsection inside the Profiles area with YAML example and "descriptive only" note; include the create payload example carrying metadata.
- `test/profile-payload.test.ts` — add `describe('metadata pass-through')` group covering presence, absence, and partial-metadata cases.
- `test/profile-wiring.test.ts` — add `describe('eforge_profile metadata field parity')` group asserting tool schema parity, body forwarding, skill doc mentions, and plugin version bump.

## Verification

- [ ] `pnpm type-check` passes with no new errors.
- [ ] `pnpm test test/profile-payload.test.ts test/profile-wiring.test.ts` passes including all new metadata cases.
- [ ] `pnpm test` (full suite) passes.
- [ ] MCP proxy `eforge_profile` schema includes a `metadata` zod object with `description`, `whenToUse`, and `tags` fields, all optional.
- [ ] Pi extension `eforge_profile` schema includes the equivalent `Type.Optional(Type.Object({ description, whenToUse, tags }))`.
- [ ] Both integrations forward `metadata` to the daemon create body when supplied (verified by source-grep tests asserting `body.metadata = metadata`).
- [ ] `buildProfileCreatePayload({ ..., metadata: { description: 'foo', whenToUse: ['a'], tags: ['b'] } })` returns a payload whose top-level shape is `{ name, scope, agents, metadata: { ... } }`; calling without `metadata` returns a payload that has no `metadata` key.
- [ ] Pi `buildYamlPreview()` renders a `description: ...` / `whenToUse:` / `tags:` block when the input payload carries metadata, and emits no metadata block otherwise.
- [ ] `eforge-plugin/skills/profile/profile.md` mentions `description`, `whenToUse` (or "use when"), and `tags` in either the table example or inspect-mode docs.
- [ ] `eforge-plugin/skills/profile-new/profile-new.md` includes `metadata` in the example create payload.
- [ ] `packages/pi-eforge/skills/eforge-profile/SKILL.md` and `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` mirror the Claude skill metadata mentions.
- [ ] `eforge-plugin/.claude-plugin/plugin.json` `version` is greater than `0.23.5`.
- [ ] `docs/config.md` contains a `### Profile metadata` heading inside the Profiles section, a YAML example showing all three fields, and the explicit statement that metadata is descriptive only and does not affect runtime behavior.
- [ ] No reference to `description`, `whenToUse`, or `tags` is added under config.yaml examples in `docs/config.md`.
