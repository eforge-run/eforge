---
id: plan-01-profile-metadata
name: Add profile metadata fields (description, whenToUse, tags)
branch: add-profile-metadata-fields-toolbelts-02/plan-01-profile-metadata
agents:
  builder:
    effort: high
    rationale: Cross-file feature touching engine config schema, wire types, daemon
      routes, two consumer integrations (Pi + Claude), docs, and tests. Requires
      careful coordination so metadata is descriptive-only and parity stays in
      sync. Not a refactor or novel architecture, but high enough surface area
      to warrant high effort over the default.
  reviewer:
    effort: high
    rationale: Must verify metadata does not leak into runtime resolution and that
      Pi/Claude wire/tool schemas stay in parity. Multi-file change with subtle
      semantics.
---


# Add profile metadata fields (description, whenToUse, tags)

## Architecture Context

Agent runtime profiles currently describe tier recipes (harness/model/effort) but carry no user-facing metadata explaining when a profile should be chosen. This plan adds optional descriptive metadata - `description`, `whenToUse`, `tags` - at the **profile level** and surfaces it through profile list/show and creation APIs across both Claude Code (`eforge-plugin/`, `packages/eforge`) and Pi (`packages/pi-eforge/`) integrations.

The core invariants from the source PRD:

1. **Metadata is descriptive only.** It must not influence active profile resolution, tier resolution, agent config resolution, orchestration, or automatic profile selection. Active profile selection remains marker-based (`.active-profile` in local/project/user scope).
2. **Backward compatibility.** Existing profiles without metadata must parse, list, load, activate, and create exactly as before.
3. **Parity between Pi and Claude Code consumer surfaces.** Both `eforge_profile` tool schemas, both `/eforge:profile*` UX surfaces, both fallback skill docs must stay in sync.
4. **Profile-level, not tier-level.** Metadata is a top-level profile field, not part of a tier recipe.
5. **No API version bump.** Adding optional response fields is non-breaking per `packages/client/src/api-version.ts` documentation comment.

Profile parsing flows through `packages/engine/src/config.ts` via `parseRawConfig(data, 'profile')`. Currently no profile-level metadata schema exists. The work begins there and propagates outward.

## Implementation

### Overview

Add a first-class `ProfileMetadata` type/schema. Make profile YAML parsing accept and preserve the new optional fields. Expose typed metadata through daemon list/show/create routes via `@eforge-build/client` wire types. Thread metadata through Claude Code MCP proxy and Pi extension tool schemas. Update list/show UX in Claude skill docs and Pi native command overlay (description + tags surfaced inline). Update docs/config.md with a profile metadata example that explicitly states the metadata is descriptive only. Add tests for parsing, listing, creation pass-through, no-metadata compatibility, and wiring parity.

### Key Decisions

1. **First-class typed metadata, not opaque blob.** Introduce a `ProfileMetadata` type with shape `{ description?: string; whenToUse?: string[]; tags?: string[] }` and a Zod (or matching) schema in `packages/engine/src/config.ts`. Both list and show responses expose typed metadata so consumers do not re-parse opaque profile YAML.

2. **Validate at parse time.** `description` must be a string when present; `whenToUse` and `tags` must be string arrays when present. Empty arrays render as absent/empty. Validation errors raise the same way other profile parse errors do today.

3. **Metadata lives on profile-level, not tier recipe.** Do **not** add metadata fields to `tierConfigSchema`. Profile YAML accepts top-level `description`, `whenToUse`, `tags` alongside the existing tier/agent structure.

4. **Preserved through load, ignored at resolve.** `loadProfile()`/`loadUserProfile()`/`loadProfileFromPath()` return the parsed profile with metadata attached. `mergePartialConfigs()`/`resolveConfig()`/`createAgentRuntimeProfile()` must not propagate metadata into the resolved `EforgeConfig` or use it for any selection logic. Active profile resolution remains marker-based.

5. **Wire types own metadata explicitly.** Extend `AgentRuntimeProfileInfo`, `ProfileShowResponse`, and `ProfileCreateRequest` in `packages/client/src/types.ts` with an optional `metadata?: ProfileMetadata` object. The opaque `resolved.profile` field on `ProfileShowResponse` may still carry the full parsed profile for debugging, but UX consumers must read the typed `metadata` field.

6. **Creation API accepts metadata; native Pi wizard does NOT prompt for it in this slice.** Extend `CreateProfileInput`, `POST /api/profile/create` body, `apiCreateProfile`, MCP `eforge_profile` schema, and Pi `eforge_profile` Type.Object schema with optional metadata fields. The native Pi creation wizard (`profile-commands.ts handleProfileNewCommand`) does NOT add interactive metadata prompts - users can edit the YAML afterward, and the API/tool accepts metadata when supplied (e.g., via the MCP tool). This keeps the wizard light while preserving full API support, matching the PRD's medium-confidence assumption.

7. **UX renders metadata where space allows.** Claude skill `profile.md` list table gains a `Description` column; show output adds description, use-when bullet list, and tags. Pi native overlay extends each item's `description` slot with the profile's description (truncated to fit) and tags summary; the detail overlay renders the full metadata block when present.

8. **Docs in profile section only.** `docs/config.md` gains a "Profile Metadata" subsection after the existing scope/precedence content. The example YAML shows top-level metadata and a clear statement that metadata is descriptive only. Do NOT add metadata to global `eforge/config.yaml` examples.

9. **No API version bump.** All new wire fields are optional and additive. Confirmed by the policy comment on `DAEMON_API_VERSION` in `packages/client/src/api-version.ts`.

10. **Plugin version bump.** Per AGENTS.md, bump `eforge-plugin/.claude-plugin/plugin.json` `version` because plugin skill files change. Do NOT bump `packages/pi-eforge/package.json`.

## Scope

### In Scope

- Add `ProfileMetadata` type + schema in `packages/engine/src/config.ts`.
- Accept and preserve `description`, `whenToUse`, `tags` when parsing profile YAML in local, project, and user scopes via `parseRawConfig(data, 'profile')` and `loadProfileFromPath()`.
- Update `ScannedProfileEntry`, `scanProfilesDir()`, `listProfiles()`, `listUserProfiles()` to include metadata in list entries.
- Update `CreateProfileInput` and `createAgentRuntimeProfile()` to accept and write metadata into the new profile YAML.
- Ensure `mergePartialConfigs()`, `resolveConfig()`, `setActiveProfile()`, active-profile resolution paths do not read or use metadata.
- Extend `AgentRuntimeProfileInfo`, `ProfileShowResponse`, `ProfileCreateRequest` in `packages/client/src/types.ts` with optional `metadata`.
- Thread metadata through `GET /api/profile/list`, `GET /api/profile/show`, `POST /api/profile/create` in `packages/monitor/src/server.ts`.
- Update `apiCreateProfile` request typing in `packages/client/src/api/profile.ts` (list/show already use the shared response types).
- Extend Claude Code MCP `eforge_profile` tool schema in `packages/eforge/src/cli/mcp-proxy.ts` with optional `description`, `whenToUse`, `tags` parameters and forward them on create.
- Update `eforge-plugin/skills/profile/profile.md` list table and show rendering to include metadata columns/sections.
- Update `eforge-plugin/skills/profile-new/profile-new.md` to mention metadata can be passed in the create payload.
- Bump `eforge-plugin/.claude-plugin/plugin.json` `version`.
- Extend Pi `eforge_profile` tool schema in `packages/pi-eforge/extensions/eforge/index.ts` with optional metadata parameters and forward them on create.
- Update Pi native `/eforge:profile` overlay in `packages/pi-eforge/extensions/eforge/profile-commands.ts` to render description/tags in the list overlay (inline summary) and the detail view.
- Extend `buildProfileCreatePayload()` in `packages/pi-eforge/extensions/eforge/profile-payload.ts` to carry optional metadata when supplied.
- Update Pi fallback skill docs `packages/pi-eforge/skills/eforge-profile/SKILL.md` and `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` to mirror metadata behavior.
- Add a "Profile Metadata" subsection to `docs/config.md` with YAML example and explicit "descriptive only" statement.
- Add tests covering parsing/listing/creation with metadata, no-metadata compatibility, MCP/Pi tool schema parity, payload helper pass-through.

### Out of Scope

- No `toolbelt` field on tier recipes, no MCP server filtering, no MCP toolbelt behavior.
- No automatic profile selection, recommendation, or routing based on metadata.
- No extension API or router implementation - metadata only prepares a future signal.
- No new top-level docs files; only updates to `docs/config.md`.
- No native Pi wizard prompts for metadata (deferred per design decision 6).
- No `DAEMON_API_VERSION` bump.
- No `packages/pi-eforge/package.json` version bump.

## Files

### Modify

- `packages/engine/src/config.ts` - Add `ProfileMetadata` type and Zod schema (e.g. `profileMetadataSchema`). Extend the profile-level schema referenced by `parseRawConfig(..., 'profile')` to accept optional `description`, `whenToUse`, `tags`. Update `ScannedProfileEntry` type to include `metadata?: ProfileMetadata`. Update `scanProfilesDir()`, `listProfiles()`, `listUserProfiles()` to read metadata into scanned entries. Update `loadProfileFromPath()`/`loadProfile()`/`loadUserProfile()` so the returned profile carries metadata. Update `CreateProfileInput` and `createAgentRuntimeProfile()` to accept optional metadata and write it into the YAML output. Verify `mergePartialConfigs()`, `resolveConfig()`, and active-profile resolution paths do not propagate metadata into `EforgeConfig`.

- `packages/client/src/types.ts` - Define and export `ProfileMetadata` interface (`{ description?: string; whenToUse?: string[]; tags?: string[] }`). Add optional `metadata?: ProfileMetadata` to `AgentRuntimeProfileInfo`. Add `metadata?: ProfileMetadata` to `ProfileShowResponse.resolved`. Add `metadata?: ProfileMetadata` to `ProfileCreateRequest`.

- `packages/client/src/api/profile.ts` - No request shape change needed beyond the type update in `types.ts`; verify that `apiCreateProfile`, `apiListProfiles`, `apiShowProfile` continue to compile and that `apiCreateProfile`'s body type now permits metadata.

- `packages/monitor/src/server.ts` - In the `GET /api/profile/list` handler, populate each entry's `metadata` from the scanned profile entry's metadata. In the `GET /api/profile/show` handler, attach metadata to `resolved` when an active profile is present. In the `POST /api/profile/create` handler, read optional `description`, `whenToUse`, `tags` from the request body and pass them through to `createAgentRuntimeProfile()` via `CreateProfileInput`.

- `packages/eforge/src/cli/mcp-proxy.ts` - Extend the `eforge_profile` tool's Zod schema with optional `description: z.string().optional()`, `whenToUse: z.array(z.string()).optional()`, `tags: z.array(z.string()).optional()`. When the `create` action runs, forward these to the daemon body.

- `eforge-plugin/skills/profile/profile.md` - Update the list table description to include a `Description` column (and tag chips if space allows). Update the show output description to render description, when-to-use bullets, and tags. Note that metadata is descriptive only.

- `eforge-plugin/skills/profile-new/profile-new.md` - Document that `description`, `whenToUse`, and `tags` may be passed in the create payload when invoking via the MCP tool; the interactive wizard does not prompt for them in this slice.

- `eforge-plugin/.claude-plugin/plugin.json` - Bump the plugin `version` (patch bump from current value).

- `packages/pi-eforge/extensions/eforge/index.ts` - Extend the `eforge_profile` `Type.Object` parameters with optional `description: Type.Optional(Type.String(...))`, `whenToUse: Type.Optional(Type.Array(Type.String(), ...))`, `tags: Type.Optional(Type.Array(Type.String(), ...))`. Forward them in the `create` action's daemon POST body.

- `packages/pi-eforge/extensions/eforge/profile-commands.ts` - In the list overlay (`handleProfileCommand`), include the profile description (truncated to overlay-row width) and a tag summary as part of the item description. In the detail overlay, render a metadata block (description, when-to-use bullets, tags) when present. Native creation wizard (`handleProfileNewCommand`) is NOT extended with metadata prompts in this slice - keep behavior unchanged.

- `packages/pi-eforge/extensions/eforge/profile-payload.ts` - Extend `ProfileCreateInput` with optional `metadata?: ProfileMetadata` (import the type from `@eforge-build/client`). Extend `ProfileCreatePayload` with optional top-level `metadata`. In `buildProfileCreatePayload()`, when `input.metadata` is present and non-empty, include it on the returned payload.

- `packages/pi-eforge/skills/eforge-profile/SKILL.md` - Mirror the Claude profile skill: document the metadata columns in list output and the metadata block in show output.

- `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` - Mirror `eforge-plugin/skills/profile-new/profile-new.md`: document that `description`, `whenToUse`, `tags` may be supplied in the create payload.

- `docs/config.md` - Add a "Profile Metadata" subsection in the existing Profiles area (after scope/precedence). Include a YAML example that shows top-level `description`, `whenToUse`, `tags`, plus a sentence noting metadata is descriptive only and does not influence profile resolution or runtime behavior. Cross-reference `docs/prd/profile-toolbelts.md` for the broader toolbelt direction.

- `test/config-backend-profile.test.ts` - Add cases: (a) profile with metadata parses, list/show surface metadata; (b) profile without metadata still parses and behaves identically; (c) invalid metadata shapes (e.g., `whenToUse: 'not an array'`) fail validation; (d) `createAgentRuntimeProfile()` writes metadata to YAML when supplied; (e) `resolveConfig()`/active-profile resolution outcomes are identical with and without metadata present (regression guard).

- `test/profile-wiring.test.ts` - Add: (a) Claude MCP `eforge_profile` tool schema declares `description`, `whenToUse`, `tags` optional fields; (b) Pi `eforge_profile` tool schema declares the same optional fields; (c) Both tools forward metadata to the daemon create body when supplied; (d) Skill docs (`profile.md`, `eforge-profile/SKILL.md`) mention metadata columns/fields (presence-of-keyword assertions are sufficient).

- `test/profile-payload.test.ts` - Add: (a) `buildProfileCreatePayload({ ..., metadata: { description, whenToUse, tags } })` returns a payload with top-level `metadata` containing exactly the provided fields; (b) when `metadata` is omitted, the payload has no `metadata` field (or it is undefined) and the rest of the payload shape is unchanged.

## Verification

- [ ] `pnpm type-check` exits 0 across all packages with the new `ProfileMetadata` type used in `packages/client/src/types.ts`, daemon routes, MCP proxy, and Pi extension.
- [ ] `pnpm test` exits 0, including new and existing cases in `test/config-backend-profile.test.ts`, `test/profile-wiring.test.ts`, and `test/profile-payload.test.ts`.
- [ ] A profile YAML with top-level `description: "x"`, `whenToUse: ["a", "b"]`, `tags: ["t1"]` is parsed by `loadProfileFromPath()` and the metadata is present on the returned profile.
- [ ] A profile YAML without any metadata fields parses without error and matches the pre-change `ScannedProfileEntry`/`loadProfile()` behavior byte-for-byte for runtime fields (only `metadata` field becomes optional/undefined).
- [ ] `GET /api/profile/list` returns each `AgentRuntimeProfileInfo` with the new `metadata` field populated when present in the YAML and absent otherwise.
- [ ] `GET /api/profile/show` returns `resolved.metadata` populated when the active profile has metadata.
- [ ] `POST /api/profile/create` with `{ name, agents, metadata: { description, whenToUse, tags } }` writes a YAML file that, when re-read by `loadProfileFromPath()`, exposes the same metadata fields.
- [ ] Calling the Claude `eforge_profile` MCP tool with `action: "create"`, `description`, `whenToUse`, `tags` produces a daemon POST body containing those fields (verified via unit test against the proxy forwarding logic).
- [ ] Calling the Pi `eforge_profile` tool with the same parameters produces an equivalent daemon POST body (parity test).
- [ ] `buildProfileCreatePayload({ ..., metadata })` returns a payload with top-level `metadata` containing the provided fields; omitting `metadata` returns a payload identical to the pre-change shape.
- [ ] `resolveConfig()` output for a profile with metadata equals `resolveConfig()` output for the same profile with metadata stripped - asserts metadata does not leak into runtime config (regression test).
- [ ] Searching `packages/engine/src/config.ts` for reads of `description`, `whenToUse`, or `tags` outside the new schema/parsing/list/create paths returns zero hits (manual check during review).
- [ ] `docs/config.md` contains a "Profile Metadata" subsection with a YAML example and an explicit statement that metadata is descriptive only.
- [ ] `eforge-plugin/.claude-plugin/plugin.json` `version` is bumped relative to the previous commit.
- [ ] `packages/pi-eforge/package.json` `version` is unchanged.
- [ ] `DAEMON_API_VERSION` in `packages/client/src/api-version.ts` is unchanged (only optional fields added).
