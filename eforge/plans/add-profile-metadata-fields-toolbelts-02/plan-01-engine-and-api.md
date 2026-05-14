---
id: plan-01-engine-and-api
name: Profile metadata schema, parsing, and daemon API
branch: add-profile-metadata-fields-toolbelts-02/plan-01-engine-and-api
---

---
id: plan-01-engine-and-api
name: Profile metadata schema, parsing, and daemon API
depends_on: []
---

# Profile metadata schema, parsing, and daemon API

## Architecture Context

Agent runtime profiles are YAML files under `.eforge/profiles/`, `eforge/profiles/`, and `~/.config/eforge/profiles/`. They are parsed by `parseRawConfig(data, 'profile')` in `packages/engine/src/config.ts`, which derives them from `partialEforgeConfigSchema` (a `.partial()` of `eforgeConfigBaseSchema`). The daemon HTTP boundary is owned by `@eforge-build/client` (`packages/client/src/types.ts` and `packages/client/src/api/profile.ts`); the daemon implementation in `packages/monitor/src/server.ts` constructs the wire responses.

This plan introduces a new top-level **profile metadata** concept — three optional descriptive fields (`description`, `whenToUse`, `tags`) — and threads them through engine parsing/listing/creation and the daemon's profile list/show/create routes. Metadata is descriptive only: it is preserved on read, accepted on create, and surfaced in wire responses, but it must NOT participate in active profile resolution, tier resolution, or runtime config (`EforgeConfig`) construction.

## Implementation

### Overview

Add an optional `ProfileMetadata` type with three fields (`description?: string`, `whenToUse?: string[]`, `tags?: string[]`). Allow profile YAML files to carry these fields at the top level. Preserve metadata when scanning/listing/loading profiles. Accept metadata on `createAgentRuntimeProfile()` and round-trip it. Extend the daemon `/api/profile/list`, `/api/profile/show`, and `/api/profile/create` shapes to carry metadata. Block metadata from `config.yaml` (it is profile-only). Add unit/integration tests in `test/config-backend-profile.test.ts` covering parsing, listing, creation, and the no-metadata compatibility path.

### Key Decisions

1. **Metadata is profile-only, not runtime config.** Add the three fields to a new `profileMetadataSchema` and extend `partialEforgeConfigSchema` (which is what `parseRawConfig(..., 'profile')` validates against) to accept them at the top level. Do NOT add metadata to `eforgeConfigBaseSchema` itself — that schema drives `EforgeConfig` (the merged runtime config), and metadata must not become a runtime-config field. Achieve this by introducing the metadata fields on a separate `profileFileSchema = partialEforgeConfigSchema.extend({ description, whenToUse, tags })` used ONLY in `loadProfileFromPath()` / `parseRawConfig(..., 'profile')`. Keep `partialEforgeConfigSchema` unchanged so config.yaml continues to reject metadata via `configYamlSchema`'s passthrough+superRefine `knownConfigYamlKeys` check.
2. **Field validation is strict at parse time.** `description` must be a string; `whenToUse` and `tags` must be arrays of strings. Empty arrays are accepted and treated as absent in display (no `.optional().default([])` — keep them genuinely optional so absent stays distinguishable from empty in the wire payload).
3. **Wire shape: typed metadata object, not flattened fields.** Add a `metadata?: ProfileMetadata` field to `AgentRuntimeProfileInfo`, `ProfileShowResponse.resolved`, and `ProfileCreateRequest`. This keeps typed responses self-describing and avoids forcing each consumer to inspect the opaque `resolved.profile`.
4. **No DAEMON_API_VERSION bump.** Adding optional response fields is explicitly non-breaking per `packages/client/src/api-version.ts`.
5. **Active profile resolution is untouched.** `resolveActiveProfileName`, `setActiveProfile`, `mergePartialConfigs`, and `loadConfig` continue to ignore metadata. Add a regression test that asserts metadata never appears in the merged `EforgeConfig` or affects active resolution.

## Scope

### In Scope
- Add `profileMetadataSchema` and `ProfileMetadata` type in `packages/engine/src/config.ts`.
- Extend the schema used by `loadProfileFromPath()` (and `parseRawConfig(..., 'profile')`) to accept optional `description`, `whenToUse`, `tags`. Keep `configYamlSchema` (config.yaml validator) unchanged so config.yaml still rejects these keys.
- Update `ScannedProfileEntry` and `scanProfilesDir()` to extract metadata from each profile YAML and include it on each entry.
- Update `listProfiles()` and `listUserProfiles()` return types so each entry carries `metadata?: ProfileMetadata`.
- Update `loadProfile()` and `loadUserProfile()` so callers can read metadata from the returned profile partial (already preserved through `parseRawConfig`).
- Update `CreateProfileInput` and `createAgentRuntimeProfile()` to accept optional `metadata` and write it to the profile YAML alongside `agents`.
- Add a top-level helper `extractProfileMetadata(profile: unknown): ProfileMetadata | undefined` in `packages/engine/src/config.ts` (export it) so the daemon can lift metadata out of opaque profile partials without re-parsing YAML.
- Update `packages/client/src/types.ts`:
  - Add `export interface ProfileMetadata { description?: string; whenToUse?: string[]; tags?: string[] }`.
  - Add `metadata?: ProfileMetadata` to `AgentRuntimeProfileInfo`.
  - Add `metadata?: ProfileMetadata` to `ProfileShowResponse.resolved`.
  - Add `metadata?: ProfileMetadata` to `ProfileCreateRequest`.
- Update daemon route handlers in `packages/monitor/src/server.ts` for `profileList`, `profileShow`, and `profileCreate` to populate `metadata` using the new helper. Forward `body.metadata` from create requests through to `createAgentRuntimeProfile()`.
- Tests in `test/config-backend-profile.test.ts`:
  - Parsing: a profile with all three metadata fields parses with values preserved.
  - Compatibility: a profile with no metadata parses as before.
  - Validation errors: `description: 123`, `whenToUse: "single string"`, and `tags: [1, 2]` each throw `ConfigValidationError` with a clear message.
  - Listing: `listProfiles()` and `listUserProfiles()` include `metadata` on entries that have it and omit it on those that do not.
  - Creation: `createAgentRuntimeProfile()` round-trips metadata to disk; profile re-read with `loadProfile()` returns the same metadata.
  - Resolution invariance: when an active-profile marker points at a profile carrying metadata, the merged `EforgeConfig` returned by `loadConfig()` does NOT contain `description`, `whenToUse`, or `tags` anywhere; `resolveActiveProfileName` selection is unchanged by metadata.
  - Config.yaml rejection: a `config.yaml` containing top-level `description:` is rejected by `configYamlSchema` with the existing "Unrecognized key" path.

### Out of Scope
- MCP/Pi tool schema changes (handled in plan-02).
- Skill docs, Pi native overlay UX changes, plugin version bump, `docs/config.md` updates (all in plan-02).
- Any toolbelt logic, MCP server filtering, or routing/recommendation behavior.
- Bumping `DAEMON_API_VERSION` — this is an additive optional response field change.

## Files

### Modify
- `packages/engine/src/config.ts` — add `profileMetadataSchema` and `ProfileMetadata` type; introduce a profile-only schema used by `loadProfileFromPath()` (extend `partialEforgeConfigSchema` rather than mutating it); update `ScannedProfileEntry`, `scanProfilesDir()`, `listProfiles()`, `listUserProfiles()` to carry metadata; update `CreateProfileInput` and `createAgentRuntimeProfile()` to accept and persist metadata; export `extractProfileMetadata()`.
- `packages/client/src/types.ts` — add `ProfileMetadata` interface; add `metadata?` to `AgentRuntimeProfileInfo`, `ProfileShowResponse.resolved`, and `ProfileCreateRequest`.
- `packages/monitor/src/server.ts` — in the `profileList` handler, attach `metadata` to each entry (already on the engine return value once `listProfiles()` includes it). In the `profileShow` handler, attach `metadata` to `resolved` using `extractProfileMetadata(profile)`. In the `profileCreate` handler, accept `body.metadata` (validate it is an object with the right field shapes or let the engine validator throw) and forward it to `createAgentRuntimeProfile()`.
- `test/config-backend-profile.test.ts` — add the test cases enumerated above. Group as: `describe('profile metadata: parsing')`, `describe('profile metadata: listing')`, `describe('profile metadata: creation')`, `describe('profile metadata: resolution invariance')`.

## Verification

- [ ] `pnpm type-check` passes with no new errors.
- [ ] `pnpm test test/config-backend-profile.test.ts` passes including all new metadata cases.
- [ ] A profile YAML with `description: "foo"`, `whenToUse: ["a", "b"]`, `tags: ["x"]` parses with metadata preserved on `loadProfile()` and `listProfiles()`.
- [ ] A profile YAML with no metadata fields parses with zero behavior change (existing tests still pass).
- [ ] Invalid metadata shapes (`description: 123`, `whenToUse: "single"`, `tags: [1, 2]`) each throw `ConfigValidationError` whose message names the offending field path.
- [ ] `createAgentRuntimeProfile({ name, metadata: { description, whenToUse, tags } })` writes a YAML file whose round-trip parse returns the same metadata object.
- [ ] `extractProfileMetadata(profile)` returns the metadata object for a profile partial that has it; returns `undefined` for one that does not.
- [ ] Calling `loadConfig()` against a project whose active profile carries `description`/`whenToUse`/`tags` returns an `EforgeConfig` whose JSON serialization contains none of those keys at any depth.
- [ ] A `config.yaml` containing top-level `description:` is rejected by `configYamlSchema` with the existing unknown-key error.
- [ ] `GET /api/profile/list` returns each entry with a `metadata` field when the profile YAML has it (verified via daemon route response shape; covered by an engine-level integration test if no monitor route test exists, otherwise add one).
- [ ] `GET /api/profile/show` returns `resolved.metadata` when the active profile carries metadata, and returns no `metadata` key (or `undefined`) when it does not.
- [ ] `POST /api/profile/create` with `metadata: { description, whenToUse, tags }` writes a profile file whose contents include the metadata block.
