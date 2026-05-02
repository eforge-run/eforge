# AGENTS.md

Project overview and user-facing docs are in `README.md` at the repo root.

## Commands

```bash
pnpm build        # Bundle all workspace packages (tsup); CLI lands at packages/eforge/dist/cli.js
pnpm test         # Run tests (vitest)
pnpm test:watch   # Watch mode
pnpm type-check   # Type check without emitting
```

## Key principles

- **Engine emits, consumers render.** The engine never writes to stdout - all communication flows through `EforgeEvent`s.
- **Engine vs plugin boundary.** The engine runs without Claude Code. The plugin is a thin launcher/facilitator - requirement refinement, subprocess delegation, status rendering.

## Conventions

- All engine commits use `forgeCommit()` from `packages/engine/src/git.ts` - this appends the `Co-Authored-By: forged-by-eforge` trailer. The helper accepts `(cwd, message, options?)` where `options` carries `paths?: string[]` (stage-and-commit subset) and `reuseMessage?: boolean` (rewrites `.git/MERGE_MSG` to include the trailer, then runs `git commit --no-edit` - used after merge-conflict resolution to preserve Git's preserved merge message). Do not use raw `exec('git', ['commit', ...])` in engine code outside of `git.ts`.
- All engine commits produced during a build session also carry a `Models-Used: <model-id>, <model-id>` trailer (sorted lexicographically, no backend prefix, placed before the `Co-Authored-By: forged-by-eforge` trailer) when one or more agents were invoked. Emitted via `composeCommitMessage(body, modelTracker)` from `packages/engine/src/model-tracker.ts`. When no models were recorded (e.g. admin commits like enqueue, cleanup, retry), the trailer is omitted.
- Provider SDK imports (`@anthropic-ai/claude-agent-sdk`, `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`) are restricted to `packages/engine/src/harnesses/` - agent code uses the `AgentHarness` interface.
- **Always bump the plugin version** in `eforge-plugin/.claude-plugin/plugin.json` when changing anything in the plugin. Plugin and npm package versions are independent.
- **Do not bump the Pi package version** in `packages/pi-eforge/package.json`. It will be versioned with the npm package at publish time.
- **Keep `eforge-plugin/` (Claude Code) and `packages/pi-eforge/` (Pi) in sync.** These are the two consumer-facing integration packages. When adding or changing CLI commands, MCP tools, skills, or user-facing behavior, update *both* packages. Pi extensions are more capable than Claude Code plugins, so `packages/pi-eforge/` may have additional features — but every capability exposed in one should be exposed in the other when technically feasible. Always check both directories before considering a consumer-facing change complete. Daemon HTTP client code is shared via `@eforge-build/client` (`packages/client/`) - do not inline it.
- **Daemon HTTP client, SSE subscriber, route contract, and response types live in `@eforge-build/client` (`packages/client/`).** Do not inline lockfile, daemon-request, or per-session SSE subscribe helpers in the CLI, MCP proxy, Pi extension, or anywhere else - import them from the shared package (`subscribeToSession` for single-session event streams). Do not inline `/api/...` path literals either: call the typed per-route helpers (`apiEnqueue`, `apiCancel`, `apiHealth`, etc.) from `packages/client/src/api/*`, or - for SSE/EventSource and the browser `fetch` transport in `packages/monitor-ui/src/lib/api.ts` - reference `API_ROUTES` + `buildPath()` from `@eforge-build/client`. The daemon itself (`packages/monitor/src/server.ts`) also dispatches off `API_ROUTES`, so a renamed route surfaces as a type error rather than silent drift. Bump `DAEMON_API_VERSION` in `packages/client/src/api-version.ts` when making breaking changes to the HTTP API surface.
- The monitor UI (`packages/monitor-ui/`) uses **shadcn/ui components** rather than custom UI primitives.
- **Workspace layout**: The repo uses pnpm workspaces with packages in `packages/` (engine, eforge, monitor, monitor-ui, client, pi-eforge, scopes, input) and the Claude Code plugin in `eforge-plugin/`.
- **`.eforge/` is developer-facing**: the daemon writes runtime state here (`monitor.db`, `state.json`, lock files, session logs) and project-local config lives here too (`config.yaml`, `profiles/`). The directory is gitignored - do not commit it.
- Use Mermaid diagrams instead of ASCII art in documentation.
- Exclude `node_modules/` and `dist/` from file searches.

## Testing

Tests live in `test/` and use vitest.

- **Group by logical unit**, not source file.
- **No mocks.** Test real code. For SDK types, hand-craft data objects cast through `unknown`.
- **Fixtures for I/O tests only.** Everything else constructs inputs inline.
- **Agent wiring tests use `StubHarness`** (`test/stub-harness.ts`). See `test/agent-wiring.test.ts`.
- **Don't test harness implementations or infra.** `ClaudeSDKHarness`, `EforgeEngine` orchestration, worktree/git ops, and tracing are integration-level.

## Roadmap

`docs/roadmap.md` captures direction (what and why), not implementation details (how).

- **Read it** before proposing new features or architectural changes
- **Future only** - remove items once they ship
- **Delete PRDs after implementation** - `docs/` should reflect current state and planned work only
