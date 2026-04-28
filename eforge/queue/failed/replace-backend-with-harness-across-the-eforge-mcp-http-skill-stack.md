---
title: Replace "backend" with "harness" across the eforge MCP/HTTP/skill stack
created: 2026-04-28
---

# Replace "backend" with "harness" across the eforge MCP/HTTP/skill stack

## Problem / Motivation

eforge has shifted its config model: the runtime selection lives inside an **agent runtime profile** under `eforge/profiles/<name>.yaml`. Each entry in `agentRuntimes` declares a `harness` (`claude-sdk` or `pi`) plus its config, and a single profile can mix multiple harnesses across agent roles (`packages/engine/src/config.ts:164` — `agentRuntimeEntrySchema` with required `harness:` field).

The engine already speaks "harness" — but every layer above it still says "backend":

| Layer | What still says "backend" |
|---|---|
| `/eforge:init` skill (Plugin + Pi) | "Pick backend, provider, and model"; elicitation form titled "Backend" |
| `/eforge:profile-new` skill (Plugin + Pi) | "Pick the backend kind"; backend in synthesis snippet |
| `eforge_init` MCP tool (`packages/eforge/src/cli/mcp-proxy.ts:578`) | `migrate` description, elicitation form, error strings |
| `eforge_profile` MCP tool (`packages/eforge/src/cli/mcp-proxy.ts:418`) | `backend` Zod param, "Backend kind (required for create)" desc, `body.backend` to daemon |
| `eforge_models` MCP tool (`packages/eforge/src/cli/mcp-proxy.ts:482`) | `backend` Zod param, "Which backend to query", `?backend=` query string |
| Pi extension equivalents (`packages/pi-eforge/extensions/eforge/index.ts:604,791,983`) | Identical `backend` shape — Pi parity |
| Daemon HTTP API (`packages/monitor/src/server.ts:1098,1164,1179`) | `body.backend` on `POST /api/profile/create`; `?backend=` on `/api/models/providers` and `/api/models/list`; `resolved.backend` field on `GET /api/profile/show` |
| Client types (`packages/client/src/types.ts:194-267`) | `BackendProfileInfo`, `BackendListResponse`, `BackendShowResponse`, `BackendUseRequest`, `BackendCreateRequest`, etc. — both the type names and the `backend:` fields |
| Client utility (`packages/client/src/profile-utils.ts`) | `sanitizeProfileName(backend, …)` (legitimate — operates on legacy YAML), `parseRawConfigLegacy` returns `{ backend?: string }` (legitimate — describes legacy YAML shape) |
| Engine helper functions (`packages/engine/src/config.ts:1425,1538`) | `createBackendProfile()`, `deleteBackendProfile()` function names (param is already `harness:`) |

User intent: the public surface — MCP tools, daemon API, client types — must speak **harness** because that is what the schema says we are managing. "Backend" is a leftover term from when a profile was tied to a single execution backend. Today profiles can mix harnesses, so the singular framing is wrong.

## Goal

Rename "backend" to "harness" across the public surface (MCP tools, daemon HTTP API, client types, engine helpers, and skills) so the entire stack consistently uses the term that matches the schema and the mixed-harness reality of agent runtime profiles.

## Approach

- Rename Zod params, descriptions, elicitation labels, internal vars, and error strings in MCP tools (Plugin + Pi parity).
- Rename request/response field `backend` → `harness` and query param `backend` → `harness` on the daemon HTTP API; bump `DAEMON_API_VERSION` from 9 to 10 (breaking change).
- Rename client interface names (`BackendProfileInfo` → `AgentRuntimeProfileInfo`, etc.) and field names; update `apiCreateProfile` callers.
- Rename engine helpers `createBackendProfile` → `createAgentRuntimeProfile` and `deleteBackendProfile` → `deleteAgentRuntimeProfile` (param shape unchanged — still takes `harness`).
- Update `/eforge:init` and `/eforge:profile-new` skills (both Plugin and Pi) to use harness/profile language and add a hand-off pointer to mixed-harness setup.
- Preserve legitimate references to the legacy YAML field `backend:` in error messages and migrate-mode parsing.

## Scope

### In scope — full rename across the public surface

1. **MCP tools** (Plugin + Pi parity) — rename Zod params, descriptions, elicitation labels, internal vars, error strings.
2. **Daemon HTTP API** — rename request/response field `backend` → `harness`, rename query param `backend` → `harness`, bump `DAEMON_API_VERSION` from 9 to 10 (breaking change).
3. **Client types** — rename interface names (`BackendProfileInfo` → `AgentRuntimeProfileInfo`, etc.) and field names. Update `apiCreateProfile` callers.
4. **Engine helpers** — rename `createBackendProfile` → `createAgentRuntimeProfile`, `deleteBackendProfile` → `deleteAgentRuntimeProfile` for consistency. (Param shape unchanged — still takes `harness`.)
5. **Skills** — `/eforge:init` (both) and `/eforge:profile-new` (both) updated to use harness/profile language and add a hand-off pointer to mixed-harness setup.

### Out of scope / unchanged

- The legacy YAML field `backend:` in pre-overhaul `config.yaml` files — error messages and migrate-mode parsing legitimately reference this literal historical key. Strings like `config.yaml has no top-level "backend:" field` stay.
- `sanitizeProfileName(backend, provider, model)` — the parameter name describes a legacy field; rename to `(harness, …)` because the function is also called from new-init flow with the harness value (the names already coincide).
- API region tags `// --- eforge:region plan-01-backend-apply-recovery ---` — these are codenames from a past plan, not user-facing.
- `pi-eforge` extension status footer wording (`eforge: name (claude-sdk)`) — this displays a harness name; reword to drop "(claude-sdk)" as a "backend" label, just show `name (harness: claude-sdk)`.

### Files to modify

#### A. Engine helpers — rename for consistency

`packages/engine/src/config.ts`
- L1198, L1248, L1418, L1530 — comment/JSDoc wording: "backend profile" → "agent runtime profile".
- L1425: `export async function createBackendProfile` → `createAgentRuntimeProfile`.
- L1538: `export async function deleteBackendProfile` → `deleteAgentRuntimeProfile`.
- Update the two callers in `packages/monitor/src/server.ts` (the dynamic import sites — search for both names).

#### B. Daemon HTTP API + client types (breaking — bump DAEMON_API_VERSION)

`packages/client/src/api-version.ts`
- L17: `export const DAEMON_API_VERSION = 9;` → `10` with a one-line comment explaining "rename of backend → harness on /api/profile/create body and /api/models/* query string".

`packages/client/src/types.ts`
- Section headers L193-194, L269-270: "Backend profile management" → "Agent runtime profile management".
- L198 `BackendProfileInfo` → `AgentRuntimeProfileInfo`. Field L200 `backend:` → `harness:`.
- L207 `BackendProfileSource` → `AgentRuntimeProfileSource`.
- L210 `BackendListResponse` → `ProfileListResponse`. Field on L211 stays `profiles:` but item type renamed.
- L217 `BackendShowResponse` → `ProfileShowResponse`. Field on L221 `backend:` → `harness:`.
- L229 `BackendListRequest` → `ProfileListRequest`.
- L234 `BackendUseRequest` → `ProfileUseRequest`.
- L239 `BackendUseResponse` → `ProfileUseResponse`.
- L244 `BackendCreateRequest` → `ProfileCreateRequest`. Field L246 `backend:` → `harness:`.
- L255 `BackendCreateResponse` → `ProfileCreateResponse`.
- L260 `BackendDeleteRequest` → `ProfileDeleteRequest`.
- L265 `BackendDeleteResponse` → `ProfileDeleteResponse`.
- L273 path comment: `?backend=pi|claude-sdk` → `?harness=pi|claude-sdk`.
- L287 path comment: same.

`packages/client/src/index.ts`
- Update re-exports to match the new type names.

`packages/client/src/api/profile.ts`
- File header comment: "backend profile management" → "agent runtime profile management".
- Update type imports to the new names.

`packages/client/src/profile-utils.ts`
- L8 JSDoc: "Compute a deterministic profile name from backend, provider, and model ID." → "from harness, provider, and model ID."
- L18: `export function sanitizeProfileName(backend: string, …)` → `(harness: string, …)`. The implementation just slug-joins; rename local for clarity. Update all callers.
- L33, L40, L74: `parseRawConfigLegacy` operates on legacy `config.yaml` and returns `{ profile: { backend?: string, … } }`. Keep the field name `backend?:` because it describes the legacy YAML shape; add a JSDoc note that this is the legacy field. Rename the variable on L48-49 (extraction site in mcp-proxy / pi-extension migrate path) only when assigning out — `const harness = profile.backend as string;`.

`packages/monitor/src/server.ts`
- L1098, L1164-1167: rename `backend` local var and the parsed body field to `harness`. The error message "Invalid field: backend" → "Invalid field: harness".
- L1179: `harness: body.backend` → `harness: body.harness` (no longer a translation; same name end-to-end).
- L1084 `resolved.backend` → `resolved.harness` (response shape change — covered by API version bump).
- Search the file for any remaining `?backend=` query parsing on the models endpoints and rename to `?harness=`.
- Update import: `createBackendProfile` → `createAgentRuntimeProfile`, `deleteBackendProfile` → `deleteAgentRuntimeProfile` (matches A).

#### C. MCP tools — Plugin

`packages/eforge/src/cli/mcp-proxy.ts`

`eforge_profile` (L418-477):
- L418 description: "the resolved active profile with backend" → "the resolved active profile with harness".
- L424: `backend: z.enum(...)` → `harness: z.enum(['claude-sdk', 'pi']).optional().describe('Harness kind (required for "create")')`.
- L433 destructure → `harness`. L457-458 → `if (harness !== 'claude-sdk' && harness !== 'pi') throw new Error('"harness" is required when action is "create" (must be "claude-sdk" or "pi")')`.
- L460: `body: { name, harness }` (was `backend`). Daemon now expects `harness` (matches B).

`eforge_models` (L482-498):
- L482 description: "available for a given backend" → "available for a given harness".
- L485: `backend: z.enum(...)` → `harness: z.enum(['claude-sdk', 'pi']).describe('Which harness to query')`.
- L488 destructure → `harness`. L490: `?backend=...` → `?harness=...`. L494: same.

`eforge_init` (L578-851):
- L581 description: "creates a named backend profile" → "creates a single-entry agent runtime profile". "elicitation form for backend, provider, and model" → "elicitation form for harness, provider, and model". "extracts backend config from an existing pre-overhaul config.yaml" → "extracts the legacy `backend:`/`pi:`/`agents.*` fields from a pre-overhaul config.yaml".
- L585 migrate description: "Extract backend config" → "Extract legacy harness config (top-level `backend:`/`pi:`/`agents.*` fields)".
- L600, L616, L674: error string wording — keep references to the literal `"backend:"` YAML key (legitimate), but reword the surrounding sentence: "Use … migrate: true to extract legacy harness config into a profile."
- L682-718 elicitation form: rename form key `backend` → `harness`, title "Backend" → "Harness", description → "Which agent harness to use for the starter profile. The profile can later mix multiple harnesses across agent roles (see `/eforge:profile-new`)." Internal var L683 `let harness: string`. L712 `harness = result.content.harness as string`.
- L722-756: branch `if (harness === 'pi')` and pass `?harness=pi` query.
- L791-810 profileCreate body: send `{ name, harness, agents: …, … }` (was `backend`).
- L798-810: drop the comment that hinted at the dual term — no longer needed.
- L840-849 response shape: response key `harness:` (was `backend:`).

#### D. MCP tools — Pi extension parity

`packages/pi-eforge/extensions/eforge/index.ts`

Mirror every change from C in the Pi extension. Spots:
- L165, L168, L174-177 status-footer logic: `resolved.backend` → `resolved.harness`. UI string → `eforge: ${name} (harness: ${harness})` to be explicit and avoid ambiguity for users used to "backend".
- L604 `eforge_profile` description: same edit as C.
- L616 `backend` Type → `harness`.
- L653, L689-691, L694: rename param.
- L730 `eforge backend ${action}` → `eforge profile ${action}`.
- L760, L765-766: response `resolved.backend` → `resolved.harness`; "backend:" footer label → "harness:".
- L791 `eforge_models` description: same as C.
- L797-798: `backend` Type → `harness`.
- L812, L816, L828, L834: query string + display reflect `harness`.
- L983 `eforge_init` description: full reword. Note: "Backend is hardcoded to 'pi'." → "Harness is hardcoded to 'pi' for this Pi-only init flow."
- L1000, L1006, L1012: parameter doc strings — use harness/legacy phrasing.
- L1043-1166 migrate + fresh-init handlers: same renames as C. Variable `backend` → `harness`. Pass `harness` in profileCreate body.

#### E. Skill files

`eforge-plugin/skills/init/init.md`
- Line 9 intro: "select a backend, provider, and model" → "select a harness, provider, and model for the starter profile".
- Step 1.5 heading and bullets: "Backend kind" → "Harness". Sub-bullet 1 — Ask for harness; mention that profiles can later mix multiple harnesses via `/eforge:profile-new`. Sub-bullet 2 — provider call now uses `eforge_models { action: "providers", harness: "pi" }`. Sub-bullet 3 — model call uses `harness: "<chosen>"`.
- Step 2: reword as "creates a single-entry agent runtime profile".
- Step 2.5 (migrate): keep references to the legacy `backend:` YAML field (literal). Reword surrounding sentence: "extracts the legacy `backend:`/`pi:`/`agents.*` fields into a single-entry agent runtime profile".
- Step 4 (Report): append: "To mix multiple harnesses across agent roles (e.g. `claude-sdk` planners + `pi` builders), use `/eforge:profile-new` or edit `eforge/profiles/<profileName>.yaml` directly — `agentRuntimes` accepts multiple named entries."

`packages/pi-eforge/skills/eforge-init/SKILL.md`
- Mirror the above. The Pi skill is hardcoded to the Pi harness — reword "Since Pi is the backend" → "Since this skill targets the Pi harness". Sub-bullet 1 of Step 1.5 uses `harness: "pi"` arg. Add the same Step 4 hand-off pointer.

`eforge-plugin/skills/profile-new/profile-new.md`
- Add a one-line note at the top of the workflow: "Profiles can contain multiple `agentRuntimes` entries (one harness per entry). This skill creates a single-entry profile; to add additional entries afterward, edit the resulting YAML."
- Step 2 heading "Pick the backend kind" → "Pick the harness". Body — "Which backend?" → "Which harness?". Smart-default rules unchanged but reword them ("Names starting with `pi-` default to harness `pi`", etc.).
- Step 3 (provider): the `eforge_models` call now uses `harness: "pi"` — update the example.
- Step 4 (models): same — `harness: "claude-sdk"` / `harness: "pi"`.
- Step 6 synthesis snippet: rename top-level `backend:` field to `harness:`. (This matches the new daemon API body shape.)
- Step 7 `eforge_profile create` body: same — `harness:` not `backend:`.

`packages/pi-eforge/skills/eforge-profile-new/SKILL.md`
- Mirror.

## Acceptance Criteria

1. **Build + types:** `pnpm build` and `pnpm type-check` from repo root pass. The rename ripples through TypeScript types — anything that was using `BackendCreateRequest.backend` will fail to compile until updated, which is the desired safety net.
2. **Tests:** `pnpm test` passes. Update any test fixtures that send `{ backend: 'pi' }` to the profileCreate endpoint or to engine helpers — search `test/` for `BackendProfile|backend:.*claude-sdk|backend:.*pi` and update.
3. **API version mismatch check:** Restart the daemon (rebuild via `pnpm build`, then bounce). Confirm `GET /api/version` returns `10` and old clients get a clean version-mismatch error rather than a silent breakage.
4. **Init smoke test:** in a scratch project, run `/eforge:init`. Confirm:
   - Elicitation form titled **"Harness"** with the new description.
   - Selecting `claude-sdk` or `pi` writes a profile with `agentRuntimes.main.harness:` set correctly.
   - The success message references `/eforge:profile-new` and the YAML path.
5. **Migrate smoke test:** in a project with a legacy `eforge/config.yaml` containing top-level `backend:`/`pi:`/`agents.*`, run `/eforge:init --migrate`. Confirm the new profile is created and the strings still correctly call the legacy YAML field `backend:`.
6. **Profile + models tools smoke test:** call `eforge_profile { action: "create", name: "x", harness: "claude-sdk" }` and `eforge_models { action: "providers", harness: "pi" }` directly — confirm the renamed param name works end-to-end through MCP → daemon → engine.
7. **Pi extension parity:** repeat 4–6 against the Pi extension to confirm both consumer paths see the rename.
8. **Grep audit:** after the rename, run `grep -rn "\bbackend\b" packages/eforge/src packages/pi-eforge/extensions packages/monitor/src packages/client/src` and verify the only remaining hits are: (a) legacy-YAML field references in migrate paths, (b) the `// plan-01-backend-apply-recovery` codename comment, (c) `parseRawConfigLegacy.profile.backend` (legacy shape).
