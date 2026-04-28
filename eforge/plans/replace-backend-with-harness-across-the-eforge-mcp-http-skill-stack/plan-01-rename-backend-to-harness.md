---
id: plan-01-rename-backend-to-harness
name: Rename backend → harness across MCP, HTTP, client types, engine helpers,
  and skills
branch: replace-backend-with-harness-across-the-eforge-mcp-http-skill-stack/plan-01-rename-backend-to-harness
agents:
  builder:
    effort: high
    rationale: "Cross-package coordinated rename touching ~18 files. Mechanical but
      unforgiving: a missed callsite breaks pnpm type-check. Sharded across
      three parallel scope groups (types/engine/monitor, MCP tools,
      skills+tests) so each shard has tight focus while the merged result must
      compile coherently."
    shards:
      - id: shard-types-engine-monitor
        roots:
          - packages/client/
        files:
          - packages/engine/src/config.ts
          - packages/monitor/src/server.ts
      - id: shard-mcp
        files:
          - packages/eforge/src/cli/mcp-proxy.ts
          - packages/pi-eforge/extensions/eforge/index.ts
      - id: shard-skills-tests
        roots:
          - eforge-plugin/skills/
          - packages/pi-eforge/skills/
        files:
          - test/config-backend-profile.test.ts
  reviewer:
    effort: high
    rationale: Reviewer must catch any missed callsite or stale 'backend' reference
      outside the legitimate-leftover allowlist (legacy YAML field, plan
      codename comment, parseRawConfigLegacy). Acceptance criterion 8 mandates a
      clean grep audit.
---

# Rename backend → harness across MCP, HTTP, client types, engine helpers, and skills

## Architecture Context

eforge has shifted its runtime config model into agent-runtime profiles. Each profile entry under `agentRuntimes:` already declares `harness: claude-sdk | pi` — the engine speaks "harness". But every public layer above the engine still says "backend":

- MCP tools (`eforge_profile`, `eforge_models`, `eforge_init`) take `backend:` Zod params.
- Daemon HTTP API sends `{ backend: ... }` request/response bodies and `?backend=...` query strings.
- Client types (`@eforge-build/client`) export `BackendProfileInfo`, `BackendCreateRequest`, etc.
- Engine helpers `createBackendProfile` / `deleteBackendProfile` keep the old name even though their parameter is already `harness:`.
- Skill markdown copy still asks "Which backend?".

This plan eliminates the divergence in one coordinated pass. After it ships, the entire stack speaks **harness**, with one narrow exception: legitimate references to the **legacy YAML field** `backend:` in pre-overhaul `config.yaml` files (parsed only in migrate-mode) stay as-is, because they describe a historical literal key.

This is a breaking API change — the daemon HTTP body shape and query strings change. We bump `DAEMON_API_VERSION` from 9 to 10 so that older clients receive a clean version-mismatch error instead of silent breakage. There is no compat shim — per repo convention ("no backward compatibility cruft"), old field names are removed cleanly.

## Implementation

### Overview

Mechanical rename across three concurrent shards:

1. **shard-types-engine-monitor** — Renames the type interfaces, the engine helper functions, and the daemon HTTP handlers. This shard owns the breaking surface (DAEMON_API_VERSION bump, request/response shapes, engine function signatures).
2. **shard-mcp** — Renames Zod params, descriptions, elicitation form fields, error strings, and request/response field references in both the Plugin MCP proxy and the Pi extension. Both consumers must move in lockstep with the daemon API.
3. **shard-skills-tests** — Updates user-facing skill copy (init, profile-new, profile, config — both Plugin and Pi parity) plus the test file that exercises the renamed engine helpers.

All three shards land on the same branch; `pnpm build` and `pnpm test` validate the merged result.

### Key Decisions

1. **Single plan, no split.** Type renames break all consumers immediately. Splitting into multiple ordered plans would leave an interim plan with a broken build. The repo rule ("never split a type change from the updates to its consumers") applies.
2. **Sharded builder.** The work is mechanical, file-disjoint, and well-specified. Three parallel shards finish faster than one serial pass.
3. **Breaking change, version bump.** No dual-name shim. `DAEMON_API_VERSION = 10`, with a one-line comment explaining the rename. Older clients hit the version-mismatch path.
4. **Legacy YAML key stays.** `parseRawConfigLegacy` still reads `profile.backend` from pre-overhaul `config.yaml`. The literal `backend:` YAML key is not the public API — it is a historical artifact that migrate-mode reads in. Surrounding sentences are reworded but the key itself is preserved.
5. **Status-footer reword in Pi extension.** The current `eforge: name (claude-sdk)` footer reads ambiguously. New form: `eforge: name (harness: claude-sdk)` is explicit and avoids "backend" baggage.

## Scope

### In Scope

- Rename engine helpers `createBackendProfile` → `createAgentRuntimeProfile` and `deleteBackendProfile` → `deleteAgentRuntimeProfile`.
- Rename client interfaces (`BackendProfileInfo` → `AgentRuntimeProfileInfo`, `BackendListResponse` → `ProfileListResponse`, `BackendShowResponse` → `ProfileShowResponse`, `BackendListRequest` → `ProfileListRequest`, `BackendUseRequest` → `ProfileUseRequest`, `BackendUseResponse` → `ProfileUseResponse`, `BackendCreateRequest` → `ProfileCreateRequest`, `BackendCreateResponse` → `ProfileCreateResponse`, `BackendDeleteRequest` → `ProfileDeleteRequest`, `BackendDeleteResponse` → `ProfileDeleteResponse`, `BackendProfileSource` → `AgentRuntimeProfileSource`).
- Rename body field `backend:` → `harness:` and query param `?backend=` → `?harness=` on the daemon HTTP API.
- Bump `DAEMON_API_VERSION` from 9 to 10.
- Rename Zod params, elicitation labels, internal vars, and error strings in `eforge_profile`, `eforge_models`, and `eforge_init` MCP tools (Plugin + Pi parity).
- Update Pi extension status footer to `(harness: <kind>)` form.
- Update `/eforge:init`, `/eforge:profile-new`, `/eforge:profile`, `/eforge:config` skill copy (Plugin + Pi) to use harness/profile language. Add hand-off pointer to mixed-harness setup in init and profile-new.
- Update `test/config-backend-profile.test.ts` to import the renamed engine helpers and reference them under the new names.

### Out of Scope (deliberate)

- The legacy YAML field `backend:` literal in pre-overhaul `config.yaml` files. Error messages and migrate-mode parsing legitimately reference the literal historical key.
- The plan-codename comment `// --- eforge:region plan-01-backend-apply-recovery ---` (codename, not user-facing).
- `parseRawConfigLegacy` return shape `{ profile: { backend?: string } }` — describes legacy YAML, not the new API.
- Renaming the file `test/config-backend-profile.test.ts` itself (preserves git history; only contents change).
- Documentation files outside skills (e.g., `docs/`, `README.md`) — none reference these specific type names.
- The monitor UI (`packages/monitor-ui/`) — confirmed no references to the renamed types via grep.
- Other test files that use "backend" in unrelated senses (harness-as-execution-backend, the literal `claude-sdk-backend.test.ts` filename testing the SDK harness, etc.).

## Files

### Modify

#### Engine helpers and daemon HTTP API (shard-types-engine-monitor)

- `packages/engine/src/config.ts` — Rename `createBackendProfile` (L1425) → `createAgentRuntimeProfile`. Rename `deleteBackendProfile` (L1538) → `deleteAgentRuntimeProfile`. Update JSDoc and inline comments at L1198, L1248, L1418, L1530 from "backend profile" → "agent runtime profile". Parameter shape unchanged (already `harness:`).
- `packages/client/src/api-version.ts` — Bump `DAEMON_API_VERSION` from 9 to 10. Add a one-line trailing comment: `// v10: rename of backend → harness on /api/profile/create body and /api/models/* query string`.
- `packages/client/src/types.ts` — Rename all `Backend*` interfaces to the new names listed in **In Scope** above. Inside each, rename field `backend: 'claude-sdk' | 'pi'` → `harness: 'claude-sdk' | 'pi'` (L200 in `AgentRuntimeProfileInfo`, L221 in `ProfileShowResponse`, L246 in `ProfileCreateRequest`). Update section header comments at L193-194 and L269-270 from "Backend profile management" → "Agent runtime profile management". Update path comments at L273 and L287 to use `?harness=pi|claude-sdk`.
- `packages/client/src/index.ts` — Update re-exports (L131-141) to match the new type names.
- `packages/client/src/api/profile.ts` — Update imports and all type-parameter references in `apiListProfiles`, `apiShowProfile`, `apiUseProfile`, `apiCreateProfile`, `apiDeleteProfile` (L8-16, L19-38). Update the file header comment from "backend profile management" → "agent runtime profile management".
- `packages/client/src/profile-utils.ts` — Rename first param of `sanitizeProfileName` from `backend: string` → `harness: string` (L18). Update the JSDoc at L8 to say "from harness, provider, and model ID." Inside `parseRawConfigLegacy` (L33, L40, L74), keep the legacy YAML field name `backend?:` in the return type, but add a JSDoc note that this describes the legacy `config.yaml` shape. At any extraction site that assigns out (e.g., `const harness = profile.backend as string;`), use the new local name.
- `packages/monitor/src/server.ts` — Rename request body field and local var `backend` → `harness` at L1098, L1164-1167. Change error string "Invalid field: backend" → "Invalid field: harness". Change `harness: body.backend` → `harness: body.harness` at L1179. Change `resolved.backend` → `resolved.harness` at L1084. Search the file for any remaining `?backend=` query parsing on `/api/models/providers` and `/api/models/list` and rename to `?harness=`. Update the dynamic imports `createBackendProfile` → `createAgentRuntimeProfile` (L1169) and `deleteBackendProfile` → `deleteAgentRuntimeProfile` (L1218), and update both call sites (L1177, L1226).

#### MCP tools (shard-mcp)

- `packages/eforge/src/cli/mcp-proxy.ts` — In `eforge_profile` (L418-477): rewrite description to use "harness" ("the resolved active profile with harness"); rename Zod param `backend: z.enum(...)` → `harness: z.enum(['claude-sdk', 'pi']).optional().describe('Harness kind (required for "create")')`; rename destructured var; rewrite the create-action validation throw to reference `"harness"`; send body `{ name, harness }` to the daemon. In `eforge_models` (L482-498): rewrite description to use "harness"; rename Zod param to `harness: z.enum(['claude-sdk', 'pi']).describe('Which harness to query')`; rename destructured var; change query string to `?harness=...` at both L490 and L494. In `eforge_init` (L578-851): rewrite description ("creates a single-entry agent runtime profile", "elicitation form for harness, provider, and model", reword the migrate description to "Extract legacy harness config (top-level `backend:`/`pi:`/`agents.*` fields)"); reword surrounding sentences in the migrate-mode error strings (L600, L616, L674) while preserving the literal `"backend:"` YAML key reference; in the elicitation form (L682-718), rename form key `backend` → `harness`, title "Backend" → "Harness", description to mention mixed-harness setup is available via `/eforge:profile-new`; rename the internal `backend` var → `harness` at L683 and L712; in the provider-fetch branch (L722-756), pass `?harness=pi`; in the `profileCreate` body (L791-810), send `{ name, harness, agents: ..., ... }`; drop the now-stale dual-term comment; in the response shape (L840-849), use response key `harness:`.
- `packages/pi-eforge/extensions/eforge/index.ts` — Mirror every MCP rename from above. Specifically: status-footer logic at L165, L168, L174-177 — rename `resolved.backend` → `resolved.harness`, change UI string to `eforge: ${name} (harness: ${harness})` so users used to "backend" see explicit harness language; `eforge_profile` (L604, L616, L653, L689-691, L694) — same edits as Plugin; the verbose log line at L730 — `eforge backend ${action}` → `eforge profile ${action}`; the response display (L760, L765-766) — `resolved.backend` → `resolved.harness`, footer label "backend:" → "harness:"; `eforge_models` (L791, L797-798, L812, L816, L828, L834) — same edits; `eforge_init` (L983, L1000, L1006, L1012) — full reword, including "Backend is hardcoded to 'pi'." → "Harness is hardcoded to 'pi' for this Pi-only init flow."; migrate + fresh-init handlers (L1043-1166) — rename internal `backend` var → `harness`, send `harness` in profileCreate body.

#### Skills + tests (shard-skills-tests)

- `eforge-plugin/skills/init/init.md` — L9 intro: "select a backend, provider, and model" → "select a harness, provider, and model for the starter profile". Step 1.5 heading and bullets: "Backend kind" → "Harness". Sub-bullets — ask for harness; mention profiles can later mix multiple harnesses via `/eforge:profile-new`; provider call uses `eforge_models { action: "providers", harness: "pi" }`; model call uses `harness: "<chosen>"`. Step 2: reword to "creates a single-entry agent runtime profile". Step 2.5 (migrate): keep the literal `backend:` YAML field reference; reword the surrounding sentence to "extracts the legacy `backend:`/`pi:`/`agents.*` fields into a single-entry agent runtime profile". Step 4 (Report): append a hand-off pointer for mixed-harness setup ("To mix multiple harnesses across agent roles (e.g. `claude-sdk` planners + `pi` builders), use `/eforge:profile-new` or edit `eforge/profiles/<profileName>.yaml` directly — `agentRuntimes` accepts multiple named entries.").
- `eforge-plugin/skills/profile-new/profile-new.md` — Add a one-line note at the top of the workflow about multiple agentRuntimes entries. Description: "selects a backend kind" → "selects a harness". Step 2 heading "Pick the backend kind" → "Pick the harness". Body "Which backend?" → "Which harness?". Smart-default rules reworded ("Names starting with `pi-` default to harness `pi`", etc.). Step 3 (provider): `eforge_models` example uses `harness: "pi"`. Step 4 (models): `harness: "claude-sdk"` / `harness: "pi"`. "All backends" bullet: "All harnesses". Step 6 synthesis snippet: top-level `backend:` field → `harness:`. Sample YAML: `backend: pi` → `harness: pi`. Step 7 `eforge_profile create` body: `harness:` not `backend:`.
- `eforge-plugin/skills/profile/profile.md` — Shape comment: `{ active, source, resolved: { backend, profile } }` → `{ active, source, resolved: { harness, profile } }`. Bullet: "Resolved backend" → "Resolved harness", `{resolved.backend}` → `{resolved.harness}`. Success message: "resolved backend" → "resolved harness".
- `eforge-plugin/skills/config/config.md` — `resolved.backend` → `resolved.harness` everywhere it refers to the response shape. Inline `eforge_models` call: `backend: "<resolved-backend>"` → `harness: "<resolved-harness>"`. References to the **legacy YAML key** `backend:` (warning users that `backend:` does not belong at the top of the new `config.yaml`) stay as literal references but reword surrounding prose where it talks about "the backend" as a concept (e.g., "switching backend kind" → "switching harness").
- `packages/pi-eforge/skills/eforge-init/SKILL.md` — Mirror Plugin init.md changes. Reword "Since Pi is the backend" → "Since this skill targets the Pi harness". Sub-bullet 1 of Step 1.5 uses `harness: "pi"`. Add the same mixed-harness hand-off pointer at Step 4. Migrate paragraph: keep the literal `backend:` legacy field reference, reword the surrounding sentence.
- `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` — Mirror Plugin profile-new.md changes one-for-one.
- `packages/pi-eforge/skills/eforge-profile/SKILL.md` — Mirror Plugin profile.md changes.
- `packages/pi-eforge/skills/eforge-config/SKILL.md` — Mirror Plugin config.md changes (preserve legacy `backend:` literal references while rewording surrounding prose).
- `test/config-backend-profile.test.ts` — Update imports from `createBackendProfile, deleteBackendProfile` → `createAgentRuntimeProfile, deleteAgentRuntimeProfile`. Update `describe` block titles to use the new function names. Update all call sites. Do **not** rename the test file itself — preserves git history.

### Create

None.

## Database Migration

None.

## Verification

- [ ] `pnpm type-check` from repo root exits 0.
- [ ] `pnpm build` from repo root exits 0.
- [ ] `pnpm test` from repo root exits 0 (vitest passes including the renamed `config-backend-profile.test.ts`).
- [ ] `packages/client/src/api-version.ts` exports `DAEMON_API_VERSION = 10` with the breaking-change comment.
- [ ] `grep -rn "createBackendProfile\|deleteBackendProfile" packages/ test/` returns zero hits.
- [ ] `grep -rn "BackendProfileInfo\|BackendListResponse\|BackendShowResponse\|BackendCreateRequest\|BackendCreateResponse\|BackendUseRequest\|BackendUseResponse\|BackendDeleteRequest\|BackendDeleteResponse\|BackendListRequest\|BackendProfileSource" packages/` returns zero hits.
- [ ] `grep -rn "\\bbackend\\b" packages/eforge/src packages/pi-eforge/extensions packages/monitor/src packages/client/src` returns hits only in: (a) legacy-YAML field references inside migrate-mode error messages and `parseRawConfigLegacy`, (b) the `// plan-01-backend-apply-recovery` codename comment, (c) the `parseRawConfigLegacy.profile.backend` field name describing the legacy shape.
- [ ] `eforge_profile` MCP tool accepts `{ action: "create", name: "x", harness: "claude-sdk" }` and rejects a `backend:` key with a Zod error mentioning `harness`.
- [ ] `eforge_models` MCP tool accepts `{ action: "providers", harness: "pi" }` and rejects a `backend:` key.
- [ ] `POST /api/profile/create` request body uses `harness:`, response shape uses `harness:`. `GET /api/profile/show` response field is `resolved.harness`. `GET /api/models/providers` and `/api/models/list` accept `?harness=` (not `?backend=`).
- [ ] Plugin elicitation form for `/eforge:init` shows title "Harness" with the new mixed-harness description.
- [ ] Pi extension status footer renders as `eforge: <name> (harness: <kind>)` (not `(claude-sdk)` or `(pi)` standalone).
- [ ] Skill files `eforge-plugin/skills/{init,profile-new,profile,config}/*.md` and `packages/pi-eforge/skills/eforge-{init,profile-new,profile,config}/SKILL.md` use "harness" in user-facing copy (literal `backend:` YAML legacy references preserved with reworded prose).
- [ ] `test/config-backend-profile.test.ts` imports `createAgentRuntimeProfile` and `deleteAgentRuntimeProfile`; describe blocks reference the new names.
