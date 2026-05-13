---
title: Add profile metadata fields (TOOLBELTS_02)
created: 2026-05-13
profile: claude-sdk-4-7
---

# Add profile metadata fields (TOOLBELTS_02)

## Problem / Motivation

Agent runtime profiles can currently describe tier recipes (harness/model/effort), but they do not carry user-facing metadata explaining when a profile should be chosen. That makes `/eforge:profile` list/show output mostly technical and limits future recommendation/routing flows.

Affected users:

- Users choosing between multiple project, local, or user-scope profiles.
- Pi and Claude Code users relying on `/eforge:profile` UX and profile management tools.
- Future extension/router authors who need stable descriptive signals without triggering automatic selection in the engine.

Why now: this is the `TOOLBELTS_02` slice under the Profile Toolbelts roadmap. It should land before behavioral toolbelt filtering so profile UX can explain intended use independently of MCP behavior.

Evidence gathered:

- Schaake OS epic `27c1c66f-e2d3-46da-b285-2a74bcba7eb0` is in progress, high priority, and asks for optional `description`, `whenToUse`, and `tags` fields on agent runtime profiles, clearer profile list/show UX, compatibility for existing profiles, no automatic selection, Pi/Claude UX parity, and docs/examples.
- `docs/prd/profile-toolbelts.md` defines profile metadata as the first MVP addition for toolbelts. Metadata is explicitly descriptive only and should prepare list/show and future routing/recommendation flows.
- `docs/roadmap.md` includes "Profile toolbelts" under Extensibility; this work is a prerequisite slice before MCP-backed toolbelts.
- Profile parsing/loading lives primarily in `packages/engine/src/config.ts`: `parseRawConfig(..., 'profile')`, `loadProfile`, `loadUserProfile`, `scanProfilesDir`, `listProfiles`, `createAgentRuntimeProfile`, and active-profile resolution.
- Profile daemon routes live in `packages/monitor/src/server.ts` under `/api/profile/list`, `/api/profile/show`, `/api/profile/create`, `/api/profile/use`, and `/api/profile/:name` delete. Client wire types live in `packages/client/src/types.ts` and helpers in `packages/client/src/api/profile.ts`.
- Consumer UX exists in both integrations and must stay synced: Claude Code MCP proxy and skills under `packages/eforge/src/cli/mcp-proxy.ts` and `eforge-plugin/skills/profile*`; Pi native tools/commands and fallback skills under `packages/pi-eforge/extensions/eforge/{index.ts,profile-commands.ts,profile-payload.ts}` and `packages/pi-eforge/skills/eforge-profile*`.
- `docs/config.md` documents tier/profile configuration and should gain metadata examples. `docs/prd/profile-toolbelts.md` already provides the target model.
- Tests already cover profile parsing/listing/creation in `test/config-backend-profile.test.ts`, API/wiring parity in `test/profile-wiring.test.ts`, and Pi create payload behavior in `test/profile-payload.test.ts`.

Classification: this is a **feature / focused** change. It adds user-facing profile metadata and UX surfaces but should fit in one cohesive plan across config parsing, daemon/client types, integration UX, docs, and tests.

## Goal

Add optional descriptive metadata (`description`, `whenToUse`, `tags`) to agent runtime profiles and surface it through profile list/show and creation APIs across both Claude Code and Pi integrations, without affecting active profile selection or runtime behavior.

## Approach

Recommended build profile: **Excursion**. This is a cohesive feature slice across config parsing, daemon/client wire types, Pi/Claude profile UX, docs, and tests. It is multi-file and consumer-facing, so it is not an Errand. A single planner can enumerate the work and dependencies without delegated subsystem planning, so Expedition would be unnecessary.

Design decisions:

1. Represent metadata as a first-class profile metadata object/type, not as runtime agent behavior.
   - Proposed type shape: `{ description?: string; whenToUse?: string[]; tags?: string[] }`.
   - Rationale: keeps the semantics explicit and makes list/show wire responses typed instead of forcing consumers to inspect opaque `resolved.profile`.

2. Validate field shapes statically during profile parsing/creation.
   - `description` must be a string when present.
   - `whenToUse` and `tags` must be string arrays when present.
   - Empty arrays can be accepted but should render as absent/empty; no behavior should depend on values.
   - Rationale: catches typos and non-portable metadata early while preserving old profiles.

3. Preserve metadata on profile load/list/show/create, but do not include it in runtime resolution behavior.
   - `loadProfile()`/`loadUserProfile()` should return the parsed profile with metadata available.
   - `mergePartialConfigs()` and `resolveConfig()` should not use metadata to build `EforgeConfig`.
   - Active profile resolution should remain marker-based: local marker, project marker, user marker, none/missing.
   - Rationale: satisfies "metadata is descriptive only" and avoids accidental profile routing.

4. Prefer explicit wire metadata in client responses.
   - `AgentRuntimeProfileInfo` entries should include metadata or flattened fields for list UX.
   - `ProfileShowResponse.resolved` should include metadata for the active/resolved profile.
   - The opaque `resolved.profile` can still include the parsed profile for debugging/backward compatibility, but user-facing consumers should read typed metadata.
   - Rationale: avoids each consumer re-parsing unknown profile config shapes differently.

5. Profile creation APIs/tools should accept metadata, but interactive collection can stay lightweight.
   - Extend create request bodies and tool schemas with optional `description`, `whenToUse`, and `tags`.
   - Native Pi wizard may either prompt for metadata or document editing the YAML afterward; if not prompting, it should still render metadata correctly for existing profiles.
   - Rationale: support is necessary at the API level; prompting can be minimal to avoid inflating the wizard.

6. UX rendering should avoid backend/tool-name leakage.
   - Profile list: show `Name`, `Scope`, `Harness`, `Description` (and tags when concise), plus active marker.
   - Profile show: show active/source/harness plus description, use-when list, tags, and optionally raw profile/tier info.
   - Pi overlay: use description in item descriptions and a detail overlay/action for selected profile metadata when practical.
   - Rationale: aligns with `docs/prd/profile-toolbelts.md` and keeps Pi/Claude UX conceptually aligned even with different UI affordances.

7. Documentation should place metadata in the profile section, not global config examples.
   - Rationale: prevents users from assuming metadata in `eforge/config.yaml` drives behavior.

Likely code impact, with evidence:

1. **Engine config/profile parsing** - `packages/engine/src/config.ts`
   - Evidence: `loadProfileFromPath()` parses profile YAML through `parseRawConfig(data, 'profile')`; `loadProfile()`, `loadUserProfile()`, `loadConfig()`, `setActiveProfile()`, and `createAgentRuntimeProfile()` depend on the returned profile shape.
   - Add a profile metadata schema/type and make profile parsing preserve `description`, `whenToUse`, and `tags` while config parsing remains compatible.
   - Update `ScannedProfileEntry`, `scanProfilesDir()`, `listProfiles()`, and `listUserProfiles()` to include metadata in list entries.
   - Update `CreateProfileInput` / `createAgentRuntimeProfile()` to accept and write metadata.
   - Ensure metadata is not merged into the resolved runtime `EforgeConfig` or used for profile resolution.

2. **Daemon/client API** - `packages/monitor/src/server.ts`, `packages/client/src/types.ts`, `packages/client/src/api/profile.ts`
   - Evidence: profile list/show/create routes construct the current wire response and request bodies.
   - Extend `AgentRuntimeProfileInfo`, `ProfileShowResponse`, and `ProfileCreateRequest` with metadata fields or a typed `metadata` object.
   - Thread metadata through `/api/profile/list`, `/api/profile/show`, and `/api/profile/create`.
   - Avoid inline route shape drift; use existing shared route constants and client type ownership pattern.

3. **Claude Code integration** - `packages/eforge/src/cli/mcp-proxy.ts`, `eforge-plugin/skills/profile/profile.md`, `eforge-plugin/skills/profile-new/profile-new.md`
   - Evidence: MCP proxy registers `eforge_profile` and forwards create/list/show/use/delete; skills document table columns and create payload shape.
   - Add optional create parameters for `description`, `whenToUse`, and `tags`, and forward them to the daemon.
   - Update profile skill display instructions to show metadata in active show and list table.
   - Update profile-new skill docs so metadata can be collected or at least passed in the create payload.
   - Per repo instruction, bump `eforge-plugin/.claude-plugin/plugin.json` if plugin files change.

4. **Pi integration** - `packages/pi-eforge/extensions/eforge/index.ts`, `packages/pi-eforge/extensions/eforge/profile-commands.ts`, `packages/pi-eforge/extensions/eforge/profile-payload.ts`, `packages/pi-eforge/skills/eforge-profile*/SKILL.md`
   - Evidence: Pi registers an `eforge_profile` tool and native `/eforge:profile` + `/eforge:profile:new` commands; fallback skills mirror Claude skill docs.
   - Add optional metadata parameters to the Pi tool schema and forward them on create.
   - Update native profile list overlay to display description/tags/use-when summaries where space allows.
   - Optionally extend `buildProfileCreatePayload()` types to carry metadata when supplied; tests can cover pass-through.
   - Keep fallback skill docs in sync with Claude plugin skills.
   - Do not bump `packages/pi-eforge/package.json` per repo instructions.

5. **Documentation** - `docs/config.md` and possibly `docs/prd/profile-toolbelts.md`
   - Evidence: `docs/config.md` currently documents tiers/model references but not profile metadata. The PRD already contains the target metadata example.
   - Add a profile metadata section with YAML examples and a clear statement that metadata is descriptive only.

6. **Tests** - existing test files
   - `test/config-backend-profile.test.ts`: add load/list/create metadata cases and compatibility/no-metadata cases.
   - `test/profile-wiring.test.ts`: add parity checks that Claude MCP proxy and Pi tool schemas expose metadata fields and thread them into create bodies; optionally assert skill docs mention metadata columns.
   - `test/profile-payload.test.ts`: if `buildProfileCreatePayload()` supports metadata, add pass-through tests.
   - Add/adjust monitor route tests if there are existing profile API route-level tests nearby; otherwise unit coverage in config + wiring may be sufficient.

No heavy runtime validation is needed; this can be verified with type-check and targeted vitest tests.

Assumptions and validation:

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| Metadata belongs to profile files, not meaningful global `eforge/config.yaml` behavior. | Epic says "Profiles support"; `docs/prd/profile-toolbelts.md` labels these as profile metadata; current profile files are parsed by `loadProfileFromPath()` with context `'profile'`. | high | low | Keep config parsing/runtime merge free of metadata behavior; add tests that runtime config/active resolution does not use metadata. | Users may place metadata in the wrong file or metadata may accidentally appear as runtime config. |
| `description`, `whenToUse`, and `tags` are enough for the MVP. | Epic acceptance and design document name exactly these fields. | high | low | Implement only these fields; reject/defer extra fields unless existing parser behavior allows unrelated profile config keys. | Scope creep or incompatible future schema if additional fields are invented now. |
| List/show should expose typed metadata, not require consumers to inspect opaque profile config. | `packages/client/src/types.ts` owns `AgentRuntimeProfileInfo` and `ProfileShowResponse`; Pi/Claude consumers already use typed list/show route shapes. | medium | low | Add explicit metadata fields to response types/routes and update consumers to read them. | UX implementations may drift or duplicate parsing logic. |
| Profile creation should accept metadata parameters. | Acceptance says profiles support fields; create APIs currently write profile YAML via `createAgentRuntimeProfile()`, MCP proxy, and Pi extension. | medium | low | Add optional create fields to `CreateProfileInput`, daemon body, client request, MCP proxy, and Pi tool schema; test pass-through. | Users can only add metadata by hand-editing YAML, weakening support and parity. |
| Native Pi creation wizard does not strictly need to prompt for metadata in this slice. | Acceptance requires list/show surfacing and profile support; wizard currently already advises direct YAML editing for fine-tuning. | medium | low | If time allows, add optional prompts; otherwise ensure API/tool accepts metadata and docs explain examples. | If product expectation includes guided metadata capture, UX may feel incomplete though support exists. |
| Metadata must not trigger automatic profile selection. | Epic explicitly says descriptive only; roadmap future recommendation/routing is deferred. | high | low | Search implementation for metadata reads outside display/create/list/show; add a test or source-level assertion if practical. | Engine behavior could surprise users by changing active profile selection. |

No low-confidence/high-impact assumptions remain. The only medium-confidence points are UX/API shape choices with low-cost validation during implementation and tests.

## Scope

In scope:

- Add optional profile metadata fields:
  - `description?: string`
  - `whenToUse?: string[]`
  - `tags?: string[]`
- Accept and preserve these fields when parsing/loading profile YAML files from local, project, and user scopes.
- Preserve existing profile files without metadata; no migration required.
- Surface metadata in profile list/show daemon API responses through typed client wire shapes.
- Surface metadata in Claude Code MCP/skill UX and Pi tool/native-command/fallback-skill UX.
- Allow profile creation APIs/tools to write metadata when provided, so metadata can be managed without manually editing YAML.
- Update documentation with examples and explicitly state that metadata is descriptive only.
- Add tests for parsing, listing, creation, wire/tool parity, and docs/UX expectations.

Out of scope:

- No MCP toolbelt behavior, `toolbelt` tier fields, or MCP server filtering.
- No automatic profile selection/recommendation/routing based on metadata.
- No extension API/router implementation; metadata only prepares a future signal.
- No backend-visible MCP tool naming or tool allowlist changes.
- No live MCP server validation.

Roadmap relation: this advances the `Profile toolbelts` extensibility roadmap item by implementing the metadata portion described in `docs/prd/profile-toolbelts.md`, without implementing toolbelts themselves.

## Acceptance Criteria

- Profile YAML files in `.eforge/profiles/`, `eforge/profiles/`, and `~/.config/eforge/profiles/` accept optional top-level `description`, `whenToUse`, and `tags` fields.
- Existing profiles without these fields continue to parse, list, load, activate, and create exactly as before.
- Invalid metadata shapes fail with clear validation errors during profile parsing/creation.
- Profile list responses include metadata for each profile entry when present.
- Profile show responses include metadata for the active/resolved profile when present.
- Metadata does not affect active profile resolution, tier resolution, agent config resolution, orchestration, or automatic profile selection.
- `eforge_profile` create support in both the Claude Code MCP proxy and Pi extension can pass optional metadata through to the daemon.
- `/eforge:profile` UX in Claude skill docs, Pi native command, and Pi fallback skill surfaces description/use-when/tags clearly enough for users choosing profiles.
- Claude plugin and Pi extension docs/tool schemas remain in sync for metadata behavior.
- `docs/config.md` documents metadata fields with an example profile YAML and states that metadata is descriptive only.
- Relevant tests cover profile parsing/listing/creation with metadata, no-metadata compatibility, consumer/tool parity, and any changed payload helper behavior.
- Standard validation passes: at minimum `pnpm type-check` and targeted vitest tests for touched units; run full `pnpm test` if feasible.
