---
id: plan-02-mcp-skills-wiring
name: MCP tools, skills for both integrations, init updates, plugin version bump
depends_on:
  - plan-01-engine-daemon
branch: backend-profiles-arbitrary-named-profiles-smart-creator/mcp-skills-wiring
---

# MCP tools, skills for both integrations, init updates, plugin version bump

## Architecture Context

The eforge plugin (`eforge-plugin/`) and the Pi extension (`packages/pi-eforge/`) are the two consumer-facing integration packages. Per `AGENTS.md`: every capability exposed in one should be exposed in the other when technically feasible, and the plugin version must be bumped whenever anything in `eforge-plugin/` changes. Daemon HTTP client code is shared via `@eforge-build/client`; both packages call `daemonRequest` rather than inlining HTTP logic.

This plan wires the already-landed engine/daemon surface (from plan-01) up to end users through two MCP tools (`eforge_backend`, `eforge_models`), two new skills (`/eforge:backend`, `/eforge:backend:new`) with matching `packages/pi-eforge/skills/` counterparts, an init-flow update to gitignore the `.active-backend` marker, and the plugin version bump.

MCP tool registration in the Claude Code plugin happens in `packages/eforge/src/cli/mcp-proxy.ts` via `server.tool(name, description, paramsSchema, handler)`. In the Pi extension, tools register via `pi.registerTool(...)` in `packages/pi-eforge/extensions/eforge/index.ts`, and skill aliases register via `pi.registerCommand(...)`. Both handlers dispatch to the daemon through `daemonRequest` from `@eforge-build/client`.

The creator skill is LLM-guided (skills are prompts, not coded wizards): it chains `eforge_models` -> `eforge_models` -> `eforge_backend create` -> optional `eforge_backend use`, with sensible defaults and clear questioning order.

## Implementation

### Overview

1. Register `eforge_backend` (actions: `list`, `show`, `use`, `create`, `delete`) and `eforge_models` (actions: `providers`, `list`) in the MCP proxy; each action maps to a daemon endpoint via `daemonRequest`.
2. Write `/eforge:backend` and `/eforge:backend:new` skills for the Claude Code plugin; mirror them in `packages/pi-eforge/skills/`.
3. Register the two tools and both skill aliases in the Pi extension.
4. Update both init skills to ensure `eforge/.active-backend` lands in `.gitignore` during `eforge_init`, and update the init tool handler if it writes the gitignore rules itself.
5. Add `.active-backend` to the repo-root `.gitignore` (so this repo's own scratch profiles never leak).
6. Bump `eforge-plugin/.claude-plugin/plugin.json` `version` and extend its `commands` array to register the new skills.

### Key Decisions

1. **Single tool with an `action` param, not five tools.** `eforge_backend` takes `{ action: 'list' | 'show' | 'use' | 'create' | 'delete', ...action-specific fields }`. Keeps the MCP surface tight and matches the spec table. Same for `eforge_models` with `{ action: 'providers' | 'list', ... }`. Zod discriminated unions where supported; otherwise a single flat schema with optional fields that the handler validates per-action.
2. **Tools dispatch to the daemon. Full stop.** No engine imports from MCP handlers; that matches the pattern used by every other `eforge_*` tool and keeps daemon vs. direct-call parity.
3. **Skill parity is mechanical.** The skill body is the same prompt in both integrations; only the frontmatter (`description`, `argument-hint`) and Pi's `disable-model-invocation: true` differ. Tool references: `mcp__eforge__eforge_backend` vs. `eforge_backend`.
4. **Creator skill defaults to newest model.** After `eforge_models list` returns results, the skill presents the top entry (first in list) as the default. For lists with 10+ entries, it shows the top 10 with a 'see all' affordance.
5. **Init skill behavior is additive.** `.active-backend` is appended to the managed gitignore section; existing rules are left intact. If the init tool implementation already manages a block of gitignore lines, add the entry there; otherwise the skill text instructs the user-facing agent to append it.
6. **Plugin version bump: 0.5.25 -> 0.5.26.** Patch bump because the plugin gains two new skills and two new MCP tools but breaks no existing behavior.

## Scope

### In Scope
- `eforge_backend` and `eforge_models` registered in the MCP proxy.
- `eforge_backend` and `eforge_models` registered in the Pi extension, plus two skill-alias commands.
- Four skill files (two per integration): `/eforge:backend` inspect+switch and `/eforge:backend:new` creator.
- Init-skill updates in both integrations to manage `eforge/.active-backend` in `.gitignore`.
- Repo-root `.gitignore` entry for `eforge/.active-backend`.
- `eforge-plugin/.claude-plugin/plugin.json` version bump and `commands` list extension.
- Manual end-to-end verification steps run against a rebuilt daemon (no automated integration tests required; MCP tools are thin dispatchers already exercised by plan-01's endpoint tests).

### Out of Scope
- Engine, daemon, or client changes (owned by plan-01).
- Monitor UI affordances.
- Any `eforge/config.yaml` edits as part of swapping or creating profiles.
- Automated integration tests hitting a live daemon; end-to-end smoke is manual per Acceptance Criteria in the source.
- Pi npm package version bump (per `AGENTS.md`, release flow handles it).

## Files

### Create
- `eforge-plugin/skills/backend/backend.md` — `/eforge:backend` skill. Frontmatter with `description: 'List, inspect, and switch backend profiles'` and `argument-hint: '[name]'`. Body: when no arg, call `mcp__eforge__eforge_backend({ action: 'show' })` and summarize `{ active, source, resolved.backend }`; when an arg is present, call `mcp__eforge__eforge_backend({ action: 'use', name })` and report the new active profile plus resolved backend; includes a '## Related Skills' table pointing at `/eforge:backend:new` and `/eforge:config`.
- `eforge-plugin/skills/backend-new/backend-new.md` — `/eforge:backend:new` creator skill. Step-by-step LLM flow: (1) determine the profile name from the argument or ask; (2) ask claude-sdk vs. pi, defaulting based on the name hint (e.g. 'pi-*' -> pi); (3) for pi, call `mcp__eforge__eforge_models({ action: 'providers', backend: 'pi' })` and let the user pick; (4) call `mcp__eforge__eforge_models({ action: 'list', backend, provider })` and present the top 10 newest models, defaulting to the first; (5) optionally ask about `pi.thinkingLevel` and `agents.effort` with sensible defaults; (6) synthesize the profile YAML; (7) call `mcp__eforge__eforge_backend({ action: 'create', name, backend, pi?, agents? })`; (8) offer to activate via `mcp__eforge__eforge_backend({ action: 'use', name })`.
- `packages/pi-eforge/skills/eforge-backend/SKILL.md` — same body as the plugin `backend.md` but uses bare tool names (`eforge_backend`, `eforge_models`) and includes the Pi `disable-model-invocation: true` frontmatter line used by sibling Pi skills.
- `packages/pi-eforge/skills/eforge-backend-new/SKILL.md` — same body as the plugin `backend-new.md` adapted for Pi tool naming.

### Modify
- `packages/eforge/src/cli/mcp-proxy.ts` —
  - Register `eforge_backend` with a zod schema `{ action: z.enum(['list', 'show', 'use', 'create', 'delete']), name: z.string().optional(), backend: z.enum(['claude-sdk', 'pi']).optional(), pi: z.record(z.any()).optional(), agents: z.record(z.any()).optional(), overwrite: z.boolean().optional(), force: z.boolean().optional() }`. Handler branches on `action` and dispatches to `GET /api/backend/list`, `GET /api/backend/show`, `POST /api/backend/use`, `POST /api/backend/create`, or `DELETE /api/backend/:name` using `daemonRequest`.
  - Register `eforge_models` with a schema `{ action: z.enum(['providers', 'list']), backend: z.enum(['claude-sdk', 'pi']), provider: z.string().optional() }`. Handler dispatches to `GET /api/models/providers?backend=...` or `GET /api/models/list?backend=...&provider=...`.
  - Response shape returns `{ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }` matching the existing tool convention.
- `packages/pi-eforge/extensions/eforge/index.ts` —
  - `pi.registerTool(...)` for both `eforge_backend` and `eforge_models` using `Type.Object` parameter shapes mirroring the MCP zod schemas. Implement `renderCall` and `renderResult` in the same style as `eforge_status` (string lines with a theme).
  - `pi.registerCommand(...)` entries aliasing `/eforge:backend` -> `/skill:eforge-backend` and `/eforge:backend:new` -> `/skill:eforge-backend-new`.
- `eforge-plugin/skills/init/init.md` — append a step (or extend an existing gitignore step) that ensures `eforge/.active-backend` is added to the project `.gitignore` during init, and briefly mention the option to run `/eforge:backend:new` afterward.
- `packages/pi-eforge/skills/eforge-init/SKILL.md` — same update as the plugin init skill.
- `packages/eforge/src/cli/mcp-proxy.ts` `eforge_init` handler (only if it writes gitignore lines itself — verify at implementation time). If it does, add `eforge/.active-backend` to its managed gitignore block. If the init tool delegates gitignore writes to the skill, no code change is needed there.
- `.gitignore` (repo root) — append `eforge/.active-backend` to the existing list so this repo's own scratch marker is never committed.
- `eforge-plugin/.claude-plugin/plugin.json` — bump `version` from `0.5.25` to `0.5.26`. Append `./skills/backend/backend.md` and `./skills/backend-new/backend-new.md` to the `commands` array.

## Verification

- [ ] `pnpm type-check` succeeds across the monorepo.
- [ ] `pnpm build` succeeds (verifies MCP proxy tool schemas, Pi extension types, and that both skill files are valid markdown — no parsing stage fails).
- [ ] `pnpm test` passes (unchanged from plan-01 because this plan adds no new unit-testable logic).
- [ ] Manual smoke in a scratch project containing only `eforge/config.yaml` with `backend: pi`: run `eforge-daemon-restart`, then invoke `/eforge:backend` with no args -> output shows `active: null`, `source: 'none'`, resolved `backend: pi`.
- [ ] Manual smoke: invoke `/eforge:backend:new pi-anthropic` -> skill walks through pi -> anthropic -> top model -> writes `eforge/backends/pi-anthropic.yaml` -> activates. Next build logs `PiBackend` with the selected model id.
- [ ] Manual smoke: invoke `/eforge:backend:new pi-glm` -> pi -> zai -> glm-4.6 -> writes profile. Invoke `/eforge:backend pi-glm` -> marker written; `/eforge:config show` resolves `backend: pi` with zai provider and glm-4.6 model.
- [ ] Manual smoke: invoke `/eforge:backend pi-anthropic` -> marker flips; next build uses the anthropic model.
- [ ] Manual smoke: delete `eforge/.active-backend` -> `/eforge:backend` reports fallback to team default per `config.yaml`.
- [ ] Manual smoke: invoke `/eforge:backend bogus` -> tool returns an error and the marker is unchanged.
- [ ] Manual smoke: invoke `/eforge:backend:new pi-anthropic` a second time without `overwrite: true` -> refused with a clear error.
- [ ] Parity: each scenario above produces equivalent output when run through the Pi extension (`eforge_backend`, `eforge_models`, `/eforge:backend`, `/eforge:backend:new`).
- [ ] Back-compat: a project with no `eforge/backends/` directory builds exactly as before.
- [ ] `eforge-plugin/.claude-plugin/plugin.json` reports `version: '0.5.26'` and the new skills are listed under `commands`.
- [ ] `.gitignore` (repo root) contains a line for `eforge/.active-backend`.
