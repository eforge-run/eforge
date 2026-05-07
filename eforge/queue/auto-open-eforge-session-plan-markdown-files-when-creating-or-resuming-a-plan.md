---
title: Auto-open eforge session plan markdown files when creating or resuming a plan
created: 2026-05-07
---

# Auto-open eforge session plan markdown files when creating or resuming a plan

## Problem / Motivation

Users planning work with `/eforge:plan` currently have to manually locate and open the generated/resumed Markdown file in `.eforge/session-plans/`. This makes the planning workflow less friendly, especially because the file is the durable artifact the user may want to inspect or edit directly while the conversation proceeds.

Evidence:

- The current Pi and Claude planning skills call `eforge_session_plan` / `mcp__eforge__eforge_session_plan` with `create` or `show` only; current tool implementations simply call daemon routes and return JSON, with no local file-opening step.
- Project conventions in `AGENTS.md` require keeping `eforge-plugin/` and `packages/pi-eforge/` in sync for consumer-facing tool/skill behavior, and require shared daemon HTTP client/route helpers from `@eforge-build/client` rather than inline route literals.
- `README.md` describes session plans as reusable input artifacts in `.eforge/session-plans/` handled by `@eforge-build/input`, with the engine consuming normalized build source and not knowing whether input originated from a session plan. This supports keeping desktop-open behavior out of the engine.
- `docs/roadmap.md` has a boundary guardrail: scheduling/triggers/notifications/workflow orchestration belong in wrappers on stable APIs, not in the engine. This supports implementing best-effort local file opening in Pi/MCP integration wrappers, not in core engine orchestration. The roadmap also calls out future shared tool registry work, but it is not yet available, so duplicated Pi/MCP tool changes are expected for now.
- Current Pi tool implementation is in `packages/pi-eforge/extensions/eforge/index.ts`. The `eforge_session_plan` tool supports actions including `create` and `show`; `create` calls `daemonRequest(ctx.cwd, "POST", API_ROUTES.sessionPlanCreate, body)` and returns daemon data. `show` calls `GET API_ROUTES.sessionPlanShow?...` and returns daemon data.
- Current Claude Code MCP implementation is in `packages/eforge/src/cli/mcp-proxy.ts`. It mirrors the Pi `eforge_session_plan` tool using `createDaemonTool`, with the same `create` and `show` paths.
- Current daemon route implementation in `packages/monitor/src/server.ts` handles `POST /api/session-plan/create`, validates session/topic/type/depth/profile, writes the plan via `@eforge-build/input`, resolves the path, and returns `{ session, path }`. `GET /api/session-plan/show` currently returns `{ plan, readiness }` and does not include a top-level `path`.
- Wire types and typed helpers live in `packages/client/src/routes.ts` and `packages/client/src/api/session-plan.ts`. `SessionPlanCreateResponse` already includes `path`; `SessionPlanShowResponse` does not currently expose it.
- Planning skill docs exist in both `packages/pi-eforge/skills/eforge-plan/SKILL.md` and `eforge-plugin/skills/plan/plan.md`. Both currently instruct `create` and `show` without an `open` option.

## Goal

When a plan file is created, and when an existing plan is resumed after selection, eforge should best-effort open the Markdown file in the user's default application/editor. Opening is a convenience and must not block or fail the planning workflow if the host environment cannot launch a desktop opener.

## Approach

### Profile signal

Recommended profile: **Excursion**.

Rationale: This is a user-facing integration feature spanning daemon route wire shape, shared client types, Pi and Claude MCP wrapper behavior, skill docs, and tests. It is not large enough to require delegated module planning: one cohesive plan can cover the route/type change, wrapper helper, skill updates, and validation. It is more than an Errand because it touches multiple consumer surfaces and has cross-package behavior synchronization requirements.

### Early decisions

- Add a best-effort `open: true` affordance to the user-facing tool interface, used by the `/eforge:plan` skill for both create and resume/show flows.
- Do not make failure to open the file fail session creation/resume.
- Prefer local integration wrappers (Pi extension and MCP proxy) to perform desktop opening rather than putting GUI side effects in the daemon/engine.
- Opening should happen on resume as well as initial create: after a single plan is selected, call `show` with `open: true`.

### Assumptions / decisions

- Assumption: both Pi and Claude Code MCP proxy processes run close enough to the user's interactive desktop session for `open`/`xdg-open` to work. Confidence: medium. Validation path: implement best-effort open status and test manually on macOS/Pi and, if practical, Linux.
- Assumption: adding an optional `open` tool parameter is acceptable even though it is not a daemon route field. Confidence: high; the tool handlers already adapt tool calls into daemon requests and return JSON.
- Decision: `show` should gain a daemon-provided `path` field. Since path resolution logic is security-sensitive and already exists in `@eforge-build/input`, exposing `path` from the daemon `show` response avoids duplicate path derivation in wrappers and matches the existing `create` response shape.

### Design decisions

1. **Expose daemon-resolved path on `show`.**
   - Decision: extend `SessionPlanShowResponse` and the daemon show route to include `path`.
   - Rationale: `create` already returns the authoritative path; `show` should provide the same data for resumed plans. This avoids duplicating path derivation in Pi/MCP wrappers and keeps path constraints centralized in `@eforge-build/input`'s `resolveSessionPlanPath`.
   - Trade-off: this is a daemon wire-shape addition, but it is additive and low risk.

2. **Keep desktop launching out of the daemon.**
   - Decision: daemon returns path; Pi/MCP wrappers decide whether to launch the local opener based on tool parameter `open`.
   - Rationale: the daemon can run headless/background/remote. Launching GUI apps is an interactive-client concern. This aligns with the roadmap boundary guardrail that wrapper apps should own user workflow conveniences.

3. **Add `open?: boolean` to the `eforge_session_plan` tool surface.**
   - Decision: document it in tool descriptions as optional, but have the `/eforge:plan` skill be the primary caller that uses it.
   - Rationale: adding a boolean is a clean extension and keeps behavior explicit. Manual callers can opt in if useful; existing callers are unchanged because default is false.

4. **Open only on user-visible create/resume events.**
   - Decision: `create + open: true` opens the newly created file. `show + open: true` opens the selected resumed file. `list-active` never opens anything.
   - Rationale: `list-active` may return multiple candidates; opening before selection would be surprising.

5. **Treat opening as best-effort metadata, not control flow.**
   - Decision: failed opener launch returns an `open` status object but does not throw or fail the tool action.
   - Rationale: planning should continue in headless/SSH/CI/missing-`xdg-open` environments.

6. **Use safe process spawning.**
   - Decision: avoid shell interpolation; pass the file path as an argv element to `spawn`/equivalent. Prefer non-blocking detached spawn with ignored stdio.
   - Rationale: session plan paths are internally constrained, but process-spawning should still avoid shell parsing hazards and avoid blocking the agent conversation.

### Code/doc impact

- `packages/client/src/routes.ts`
  - Add `path: string` to `SessionPlanShowResponse` so consumers can use the daemon-resolved file path for resumed plans, matching `SessionPlanCreateResponse`.
  - This is a non-breaking additive wire-field change.
- `packages/client/src/api/session-plan.ts`
  - No route helper behavior likely changes; the return type update flows through from `routes.ts`.
- `packages/client/src/index.ts` / `packages/client/src/browser.ts`
  - Type re-exports already include `SessionPlanShowResponse`; likely no change except type propagation, but type-check will confirm.
- `packages/monitor/src/server.ts`
  - In the `GET /api/session-plan/show` route, resolve the session plan path with `resolveSessionPlanPath({ cwd, session })` and return it in the response alongside `{ plan, readiness }`.
  - Existing `create` route already returns `path`.
- `packages/pi-eforge/extensions/eforge/index.ts`
  - Add optional `open?: boolean` parameter to `eforge_session_plan` tool schema.
  - Add a local helper for best-effort opening of returned session plan paths. Use platform-aware commands (`open` on darwin, `xdg-open`/fallbacks on linux, optionally Windows support) with `spawn`/`spawnSync` avoiding shell interpolation. The helper should never throw to callers; it returns status.
  - On `create`, after daemon response, if `open: true`, open `data.path`.
  - On `show`, after daemon response, if `open: true`, open `data.path` from the new daemon show response.
  - Include open status in the JSON result when requested, without changing success/failure of the underlying action.
- `packages/eforge/src/cli/mcp-proxy.ts`
  - Mirror the Pi tool changes: optional `open?: boolean`, best-effort opener helper, open after `create`/`show` when requested, return open status.
- `packages/pi-eforge/skills/eforge-plan/SKILL.md`
  - New session path: call `create` with `open: true`.
  - Resume path: call `show` with `open: true` after the session is selected (single active plan or user choice). Migration reload may call `show` again; it is acceptable to avoid re-opening on the second reload unless simpler to keep `open: true` only on the user-visible selected show.
- `eforge-plugin/skills/plan/plan.md`
  - Mirror the Pi skill updates with MCP tool naming.
- `eforge-plugin/.claude-plugin/plugin.json`
  - Bump plugin version because plugin-facing behavior/docs change.
- Tests:
  - Update `test/daemon-session-plan-routes.test.ts` show-route success test to assert returned `path` contains `.eforge/session-plans/{session}.md`.
  - Add focused unit tests for opener command selection/status if a helper is extracted into a testable module, or at minimum cover TypeScript compile paths. Avoid actually launching desktop apps in tests.

Evidence:

- Existing daemon `show` route currently returns `{ plan, readiness }` only.
- Existing daemon `create` route already resolves and returns `path`.
- Existing route tests cover create path and show content/readiness, so adding a show path assertion is straightforward.
- Repo policy requires consumer-facing changes to keep Pi and Claude plugin in sync and bump Claude plugin version when plugin changes.

### Assumptions and validation

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| `show` is daemon-backed, so adding `path` to the daemon response is the clean way to support resume opening. | Verified Pi and MCP tool handlers call `GET API_ROUTES.sessionPlanShow`; daemon route currently loads plan and returns `{ plan, readiness }`; create already returns `path`. | high | low | Implement type/route/test change and run route tests. | If wrong, wrappers might need to derive paths locally, increasing duplication. |
| Desktop opening belongs in Pi/MCP wrappers, not daemon/engine. | Supported by README architecture and roadmap boundary guardrail; daemon may run headless/background/remote. | high | low | Code review plus manual test in interactive Pi/Claude session. | If wrong, behavior might be implemented too low in the stack and surprise daemon users. |
| Optional `open?: boolean` is a clean/free extension to expose on the raw tool surface while being primarily used by `/eforge:plan`. | Existing tool schemas are simple action unions with optional fields; default omitted behavior remains unchanged. | high | low | Type-check tool schemas and use skills to call with `open: true`. | If wrong, tool API could feel cluttered; fallback is internal skill-only behavior if the wrapper command could detect skill context, but that is less clean. |
| `open` on macOS and `xdg-open` or similar on Linux are sufficient for the first version. | User cited `open`; common Linux desktop convention is `xdg-open`. | medium | medium | Manual tests on macOS and Linux; return failure status for unsupported/headless cases. | Some users may not get auto-open, but planning still succeeds and path is shown. |
| Non-blocking detached process launch is preferable to waiting for the opener. | Planning conversation should continue; external app lifetime should not hold the agent/tool call open. | high | low | Implement helper and unit-test command selection/behavior with injected spawn function if practical. | If blocking is accidentally used, tool calls may hang until editor/app exits. |

No unresolved low-confidence/high-impact assumptions. The main environment-dependent risk is opener availability, mitigated by best-effort status and non-failing behavior.

## Scope

### In scope

- Add best-effort file opening for session-plan Markdown files when the planning skill creates a new plan.
- Add best-effort file opening when the planning skill resumes a selected existing plan.
- Implement the desktop-opening side effect in the user-facing integration wrappers, not in the daemon route or engine.
- Keep both integration surfaces in sync:
  - Pi extension: `packages/pi-eforge/extensions/eforge/index.ts`
  - Claude Code MCP proxy: `packages/eforge/src/cli/mcp-proxy.ts`
- Add an optional `open?: boolean` parameter to the `eforge_session_plan` tool surface if it stays clean and simple; the `/eforge:plan` skills will use it on `create` and selected `show` calls.
- Update both planning skill docs so new-session and resume flows request opening where appropriate.
- Return best-effort open status in tool results when `open: true` is used, without failing the underlying create/show operation if opening fails.

### Out of scope

- Do not make the daemon/engine responsible for launching desktop applications.
- Do not open a file from `list-active`; when multiple plans exist, open only after the user chooses one and the skill calls `show` for the selected session.
- Do not add broader editor management, file-watching, or bi-directional sync.
- Do not make file opening mandatory or blocking.

### Clarification

The daemon is involved in `show` today. The Pi extension and Claude MCP proxy `eforge_session_plan` handlers call daemon HTTP route `GET /api/session-plan/show?session=...` and return the daemon response. The proposed behavior keeps that read path intact, then performs the desktop-open step locally in the wrapper after the daemon returns. The daemon itself does not need to launch an app.

## Acceptance Criteria

- Creating a plan via the planning skill calls the session-plan tool with `open: true` and best-effort opens the returned `.eforge/session-plans/{session}.md` file.
- Resuming a plan opens the Markdown file only after a concrete session is selected:
  - if exactly one active session exists, the `show` call for that session uses `open: true`;
  - if multiple active sessions exist, no file opens during listing, and only the chosen session's `show` call uses `open: true`.
- `GET /api/session-plan/show` returns a `path` field pointing to the resolved session plan Markdown file, and the shared `SessionPlanShowResponse` type reflects it.
- The daemon does not launch external applications; it only returns session-plan data and paths.
- Pi and Claude Code MCP tool surfaces both accept optional `open?: boolean` for `eforge_session_plan`.
- `open: false` or omitted preserves existing behavior.
- Opener failure (missing command, headless environment, spawn error) does not fail `create` or `show`; the tool result includes best-effort status when opening was requested.
- Process launch avoids shell interpolation and passes the path as an argument.
- Both planning skill docs are updated in sync.
- Claude Code plugin version in `eforge-plugin/.claude-plugin/plugin.json` is bumped.
- Validation passes at least:
  - `pnpm type-check`
  - relevant test(s), including session-plan daemon route tests asserting `show` includes `path`
  - preferably a focused opener-helper test that does not invoke real desktop apps.
