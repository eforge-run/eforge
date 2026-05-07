---
id: plan-01-auto-open-session-plan
name: Auto-open session plan markdown on create and resume
branch: auto-open-eforge-session-plan-markdown-files-when-creating-or-resuming-a-plan/plan-01-auto-open-session-plan
---

# Auto-open session plan markdown on create and resume

## Architecture Context

Session plans are durable Markdown artifacts in `.eforge/session-plans/{session}.md` produced by the `/eforge:plan` skill. The daemon owns reading and writing these files via `@eforge-build/input`; consumer-facing tools (`eforge_session_plan` in the Pi extension and the Claude Code MCP proxy) are thin HTTP wrappers around daemon routes. The engine never sees these files directly.

The roadmap guardrail keeps scheduling/triggers/notifications/workflow conveniences out of the engine and inside the consumer wrappers. Desktop file launching is exactly such a convenience: the daemon may run headless or remote, but the Pi extension and Claude Code MCP proxy run alongside the user's interactive session, so they are the right place to spawn `open` (macOS), `xdg-open` (Linux), or `start` (Windows). The daemon itself only needs to surface the resolved path so wrappers do not duplicate path-resolution logic.

Daemon wire types live in `packages/client/src/routes.ts`. `SessionPlanCreateResponse` already returns `{ session, path }`; `SessionPlanShowResponse` currently only returns `{ plan, readiness }`. Adding `path` to `show` is additive and non-breaking, so `DAEMON_API_VERSION` does not need to bump (per the contract documented in `packages/client/src/api-version.ts`).

The Pi and Claude planning skills (`packages/pi-eforge/skills/eforge-plan/SKILL.md` and `eforge-plugin/skills/plan/plan.md`) must stay in sync; `scripts/check-skill-parity.mjs` runs as part of `pnpm test` and fails CI if they diverge after tool-reference normalization. Anywhere this plan touches one skill, it must touch the other.

## Implementation

### Overview

Add a best-effort "open the file in the user's default app" affordance to the `eforge_session_plan` tool surface, used by `/eforge:plan` for both creating new plans and resuming a single selected plan. The affordance is implemented in the consumer wrappers; the daemon's only contribution is exposing the resolved path on `show` (it already does so on `create`).

### Key Decisions

1. **Expose path on `show`, not just `create`.** `loadSessionPlan` already validates the session id; resolving the path on the daemon side via `resolveSessionPlanPath({ cwd, session })` keeps path constraints centralized in `@eforge-build/input` and matches the `create` response shape. Wrappers should not derive paths locally.
2. **Desktop launching lives in the wrappers, not the daemon.** The daemon may run remote/headless. The Pi extension and Claude MCP proxy are interactive-client surfaces that already share the user's session; they are the correct layer.
3. **Add `open?: boolean` (default false/omitted) to the tool surface.** Default behavior is unchanged. The `/eforge:plan` skill is the primary caller that opts in. `open: true` is only meaningful for `create` and `show`; other actions ignore it.
4. **Open only on user-visible events.** `create + open: true` opens the new file. `show + open: true` opens the resumed file - but only after the user has selected a single session (the skill never sets `open: true` on the `show` call that follows `list-active` until a concrete session is chosen). `list-active` itself never opens anything.
5. **Best-effort, never blocking, never throwing.** A failed opener launch returns an `open` status object on the tool result but does not fail `create` or `show`. Headless/SSH/CI/missing-`xdg-open` environments must keep planning working.
6. **Safe spawn semantics.** Use Node's `child_process.spawn` with the path passed as an argv element (no shell interpolation). Detach the child, ignore stdio, and `unref()` so the tool call resolves immediately and the child outlives the agent without holding stdio open. Validate the path is an absolute path under the cwd's `.eforge/session-plans/` directory before spawning - the daemon already constrains it, but the wrapper enforces a defense-in-depth check before invoking a system command.

### Opener helper shape

Extract a small, testable helper module (one per consumer to keep package boundaries clean):

- `packages/pi-eforge/extensions/eforge/open-session-plan.ts`
- `packages/eforge/src/cli/open-session-plan.ts`

Each module exports the same shape:

```ts
export interface OpenStatus {
  attempted: boolean;
  ok: boolean;
  command?: string;
  error?: string;
}

export interface OpenSessionPlanOptions {
  /** Absolute path to the .eforge/session-plans/{session}.md file. */
  path: string;
  /** Project working directory; used to enforce path containment. */
  cwd: string;
  /** For testing: override platform detection. */
  platform?: NodeJS.Platform;
  /** For testing: inject a spawn function. */
  spawn?: (command: string, args: string[], options: object) => { unref?: () => void };
}

export function openSessionPlanFile(opts: OpenSessionPlanOptions): OpenStatus;
```

Behavior:

- If `path` is not absolute, or its normalized form does not start with `path.resolve(cwd, '.eforge/session-plans/')`, return `{ attempted: false, ok: false, error: 'path-out-of-scope' }`.
- Pick command by platform:
  - `darwin` -> `open` with `[path]`
  - `linux` -> `xdg-open` with `[path]`
  - `win32` -> `cmd` with `['/c', 'start', '""', path]`
  - other -> return `{ attempted: false, ok: false, error: 'unsupported-platform' }`
- Spawn detached with `stdio: 'ignore'` and call `unref()` if available. Wrap the call in `try/catch` - any error returns `{ attempted: true, ok: false, command, error: String(err) }`.
- On successful spawn, return `{ attempted: true, ok: true, command }`.

The two helpers are intentionally duplicated rather than added to a shared package: this matches the existing pattern where Pi extension and MCP proxy each own their tool implementation. The roadmap calls out a future shared tool registry; until that lands, parity is enforced by code review and the parity check on the skill docs.

### Tool surface change

In both `packages/pi-eforge/extensions/eforge/index.ts` and `packages/eforge/src/cli/mcp-proxy.ts`:

- Add an optional `open` parameter to the `eforge_session_plan` tool schema:
  - Pi (TypeBox): `open: Type.Optional(Type.Boolean({ description: 'When true, best-effort opens the resulting session plan file in the user\'s default application. Used by the /eforge:plan skill on create and on show after a session is selected.' }))`
  - MCP (Zod): `open: z.boolean().optional().describe(...)`
- Update the tool description string to mention the new option in one short sentence.
- In the handler:
  - For `create`: after the daemon returns `{ session, path }`, if `open === true`, call `openSessionPlanFile({ path: data.path, cwd: ctx.cwd })` and merge `{ open: status }` into the JSON result.
  - For `show`: after the daemon returns `{ plan, readiness, path }`, if `open === true`, call the helper with `data.path` and merge `{ open: status }` into the JSON result.
  - For all other actions, the `open` parameter is silently ignored (no helper call, no `open` field in the result).
- Underlying tool result shape on success stays identical when `open` is omitted or `false`: no new fields appear.

### Daemon route change

In `packages/monitor/src/server.ts` `GET /api/session-plan/show` handler (around lines 2174-2205):

- After loading the plan and computing readiness, also call `resolveSessionPlanPath({ cwd, session })` (already imported alongside `loadSessionPlan` and `getReadinessDetail`).
- Include `path` in the JSON response: `sendJson(res, { plan: { ...frontmatter, body }, readiness, path });`
- Path resolution must succeed because the plan was just loaded; if it throws, fall through to the existing error handler.

In `packages/client/src/routes.ts`:

- Extend `SessionPlanShowResponse` to add `path: string`.
- Do not bump `DAEMON_API_VERSION` - this is an additive optional response field per the contract documented in `packages/client/src/api-version.ts`.

### Skill doc updates

Update both `packages/pi-eforge/skills/eforge-plan/SKILL.md` and `eforge-plugin/skills/plan/plan.md` so that the narrative outside YAML frontmatter remains identical after the parity-script normalization (Pi-form `eforge_session_plan` vs plugin-form `mcp__eforge__eforge_session_plan`).

Changes to apply identically in both files (apart from tool naming):

- **Step 1 - New session path, item 3**: change the `create` call to include `open: true`, e.g. `eforge_session_plan { action: 'create', session: '{session-id}', topic: '{topic}', open: true }`. Add a one-line note: "The wrapper best-effort opens the new session plan file in your default Markdown app; planning continues whether or not the open succeeds."
- **Step 1 - Resume path, item 2**: change the single-active-session show call to `{ action: 'show', session, open: true }`.
- **Step 1 - Resume path, item 3**: keep `list-active` and the user-choice prompt unchanged (no `open: true` here). After the user picks one, the subsequent show call uses `{ action: 'show', session, open: true }`.
- **Step 1 - Resume path, item 5 (legacy migration reload)**: do **not** add `open: true` on the post-migration reload (`{ action: 'show', session }`). The user-visible open already happened on the initial selected `show`; the migration reload is internal data refresh and re-opening would be noisy.
- Keep the **Session File Updates** section accurate: no behavioral change to which milestones write to the file.

Where a one-line rationale or note differs purely in tool-naming form, that is normalized by the parity script. Outside of tool-name normalization, the two narratives must match. Run `node scripts/check-skill-parity.mjs` locally to confirm.

### Plugin version bump

Bump `eforge-plugin/.claude-plugin/plugin.json` `version` from `0.23.3` to `0.23.4`. This is required by repo policy whenever plugin-facing behavior or docs change.

### Tests

1. **`test/daemon-session-plan-routes.test.ts`** - in the existing `describe('GET /api/session-plan/show')` block, extend the success-path test (`returns frontmatter, body, and readiness detail for existing plan`) to also assert that the response body contains a `path` string ending with `.eforge/session-plans/2026-01-01-add-feature.md`. Update the inline response type to include `path: string`.

2. **New focused test for the opener helper** - add `test/open-session-plan-helper.test.ts` covering the Pi helper (the MCP proxy helper is structurally identical and is exercised by parity in code review). The test must not launch real desktop apps. Inject a stub `spawn` function and a stub `platform`. Cover:
   - `darwin` -> command `open`, args `[path]`, `attempted: true`, `ok: true`.
   - `linux` -> command `xdg-open`, args `[path]`, `ok: true`.
   - `win32` -> command `cmd`, args contain `start` and the path, `ok: true`.
   - Unsupported platform (e.g. `freebsd`) -> `attempted: false`, `ok: false`, `error: 'unsupported-platform'`.
   - Path outside `cwd/.eforge/session-plans/` -> `attempted: false`, `ok: false`, `error: 'path-out-of-scope'`.
   - Spawn throws -> `attempted: true`, `ok: false`, `error` captured.
   - Successful spawn calls `unref()` when present (use a stub child object with a recorded `unref`).

3. The Claude MCP proxy helper module is small enough that the equivalent test would duplicate; keep the test surface to one helper. If the duplication grows, either helper can be promoted to a shared package in a follow-up.

## Scope

### In Scope
- Add `path: string` to `SessionPlanShowResponse` in `packages/client/src/routes.ts`.
- Return `path` from `GET /api/session-plan/show` in `packages/monitor/src/server.ts`.
- Add an optional `open?: boolean` parameter to the `eforge_session_plan` tool in the Pi extension and the Claude Code MCP proxy.
- Add a best-effort opener helper in each consumer (`packages/pi-eforge/extensions/eforge/open-session-plan.ts` and `packages/eforge/src/cli/open-session-plan.ts`).
- Wire the helper into `create` and `show` handlers behind the `open: true` flag and surface its status in the tool result.
- Update both planning skill docs (`packages/pi-eforge/skills/eforge-plan/SKILL.md` and `eforge-plugin/skills/plan/plan.md`) to call `create` with `open: true` and the selected `show` with `open: true`. Keep parity per `scripts/check-skill-parity.mjs`.
- Bump `eforge-plugin/.claude-plugin/plugin.json` to `0.23.4`.
- Extend `test/daemon-session-plan-routes.test.ts` to assert the new `path` field on `show`.
- Add `test/open-session-plan-helper.test.ts` with stubbed spawn and platform.

### Out of Scope
- Daemon-side desktop launching.
- Opening any file from `list-active` before a single session is selected.
- File watching, editor management, bi-directional sync, or any persistent process.
- Bumping `DAEMON_API_VERSION` (the change is additive and non-breaking).
- A shared tool-registry package consolidating Pi and MCP tool definitions (tracked separately on the roadmap).
- Modifying `packages/pi-eforge/package.json` version (versioned at npm publish time per AGENTS.md).

## Files

### Create
- `packages/pi-eforge/extensions/eforge/open-session-plan.ts` - Pi-side best-effort opener helper with platform detection, path containment check, and injectable spawn for tests.
- `packages/eforge/src/cli/open-session-plan.ts` - Claude MCP proxy mirror of the Pi opener helper.
- `test/open-session-plan-helper.test.ts` - Vitest covering platform branches, path containment, spawn-error capture, and `unref()` invocation using injected stubs.

### Modify
- `packages/client/src/routes.ts` - Add `path: string` to `SessionPlanShowResponse`.
- `packages/monitor/src/server.ts` - In the `GET /api/session-plan/show` handler, call `resolveSessionPlanPath({ cwd, session })` and include `path` in the JSON response alongside `plan` and `readiness`.
- `packages/pi-eforge/extensions/eforge/index.ts` - Add `open?: boolean` to the `eforge_session_plan` tool schema and tool description; in the `create` and `show` handler branches, after the daemon response, call `openSessionPlanFile` when `open === true` and merge the resulting `OpenStatus` into the JSON result under key `open`.
- `packages/eforge/src/cli/mcp-proxy.ts` - Mirror the Pi schema/handler changes using Zod and the local opener helper.
- `packages/pi-eforge/skills/eforge-plan/SKILL.md` - Step 1 new-session path uses `{ action: 'create', open: true, ... }`; resume path uses `open: true` only on the selected `show` call (single-active or post-choice); legacy-migration reload `show` does not pass `open: true`.
- `eforge-plugin/skills/plan/plan.md` - Same edits as the Pi skill, using `mcp__eforge__eforge_session_plan` tool naming. Must remain parity-equivalent under `scripts/check-skill-parity.mjs`.
- `eforge-plugin/.claude-plugin/plugin.json` - Bump `version` from `0.23.3` to `0.23.4`.
- `test/daemon-session-plan-routes.test.ts` - In the existing `describe('GET /api/session-plan/show')` success test, extend the response type and assertions to include `path` ending in `.eforge/session-plans/2026-01-01-add-feature.md`.

## Verification

- [ ] `pnpm type-check` exits 0.
- [ ] `pnpm build` exits 0 (covers tsup bundling for all workspace packages, including the CLI bundle that ships the MCP proxy).
- [ ] `pnpm test` exits 0, including `node scripts/check-skill-parity.mjs` (parity gate) and the new `test/open-session-plan-helper.test.ts`.
- [ ] `vitest run test/daemon-session-plan-routes.test.ts` exits 0 and the `GET /api/session-plan/show` success test asserts `data.path` is a non-empty string ending with `.eforge/session-plans/2026-01-01-add-feature.md`.
- [ ] `vitest run test/open-session-plan-helper.test.ts` exits 0 and covers all six branches: darwin command/args, linux command/args, win32 command/args, unsupported-platform error, path-out-of-scope error, spawn-throws error capture, and `unref()` is called on a successful spawn.
- [ ] `grep -n "open?" packages/pi-eforge/extensions/eforge/index.ts` returns at least one hit inside the `eforge_session_plan` schema; same check on `packages/eforge/src/cli/mcp-proxy.ts`.
- [ ] `grep -n "open: true" packages/pi-eforge/skills/eforge-plan/SKILL.md eforge-plugin/skills/plan/plan.md` returns at least 2 hits per file (one for create, one for the selected show) and zero hits inside the legacy-migration reload paragraph.
- [ ] `eforge-plugin/.claude-plugin/plugin.json` version field equals `0.23.4`.
- [ ] `packages/client/src/routes.ts` `SessionPlanShowResponse` declares `path: string` and `DAEMON_API_VERSION` in `packages/client/src/api-version.ts` is unchanged.
- [ ] `packages/monitor/src/server.ts` `GET /api/session-plan/show` handler emits `path` in its `sendJson` payload.
- [ ] When `open` is omitted or `false`, the JSON returned by `eforge_session_plan` for `create` and `show` does not include an `open` field (verified by reading the handler branches; no test required because the field is purely additive on the response).
- [ ] When the opener helper returns `{ ok: false }`, the underlying `create`/`show` action still resolves with its normal payload plus an `open: { ok: false, ... }` entry; no exception bubbles out of the tool handler (verified by the helper-test stubbing a spawn that throws and inspecting the merged result shape - this can be a small additional test case in `test/open-session-plan-helper.test.ts` exercising the merge by calling a thin wrapper, OR a code review check confirming the tool handler wraps the helper call in a manner consistent with `OpenStatus`).
