# AGENTS.md

Project overview and user-facing docs are in `README.md` at the repo root.

## Commands

```bash
pnpm build        # Bundle with tsup → dist/cli.js
pnpm dev          # Run via tsx (e.g. pnpm dev -- build foo.md)
pnpm test         # Run tests (vitest)
pnpm test:watch   # Watch mode
pnpm type-check   # Type check without emitting
```

## Key principles

- **Engine emits, consumers render.** The engine never writes to stdout - all communication flows through `EforgeEvent`s.
- **Engine vs plugin boundary.** The engine runs without Claude Code. The plugin is a thin launcher/facilitator - requirement refinement, subprocess delegation, status rendering.

## Conventions

- All engine commits use `forgeCommit()` from `packages/engine/src/git.ts` - this appends the `Co-Authored-By: forged-by-eforge` trailer. Do not use raw `exec('git', ['commit', ...])` in engine code outside of `git.ts` and `worktree.ts`.
- Provider SDK imports (`@anthropic-ai/claude-agent-sdk`, `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`) are restricted to `packages/engine/src/backends/` - agent code uses the `AgentBackend` interface.
- **Always bump the plugin version** in `eforge-plugin/.claude-plugin/plugin.json` when changing anything in the plugin. Plugin and npm package versions are independent.
- **Do not bump the Pi package version** in `packages/pi-eforge/package.json`. It will be versioned with the npm package at publish time.
- **Keep `eforge-plugin/` (Claude Code) and `packages/pi-eforge/` (Pi) in sync.** These are the two consumer-facing integration packages. When adding or changing CLI commands, MCP tools, skills, or user-facing behavior, update *both* packages. Pi extensions are more capable than Claude Code plugins, so `packages/pi-eforge/` may have additional features — but every capability exposed in one should be exposed in the other when technically feasible. Always check both directories before considering a consumer-facing change complete. Daemon HTTP client code is shared via `@eforge-build/client` (`packages/client/`) - do not inline it.
- **Daemon HTTP client and response types live in `@eforge-build/client` (`packages/client/`).** Do not inline lockfile or daemon-request helpers in the CLI, MCP proxy, Pi extension, or anywhere else - import them from the shared package. Bump `DAEMON_API_VERSION` in `packages/client/src/api-version.ts` when making breaking changes to the HTTP API surface.
- The monitor UI (`packages/monitor-ui/`) uses **shadcn/ui components** rather than custom UI primitives.
- **Workspace layout**: The repo uses pnpm workspaces with packages in `packages/` (engine, eforge, monitor, monitor-ui, client, pi-eforge) and the Claude Code plugin in `eforge-plugin/`.
- Use Mermaid diagrams instead of ASCII art in documentation.
- Exclude `node_modules/` and `dist/` from file searches.

## Testing

Tests live in `test/` and use vitest.

- **Group by logical unit**, not source file.
- **No mocks.** Test real code. For SDK types, hand-craft data objects cast through `unknown`.
- **Fixtures for I/O tests only.** Everything else constructs inputs inline.
- **Agent wiring tests use `StubBackend`** (`test/stub-backend.ts`). See `test/agent-wiring.test.ts`.
- **Don't test backend implementations or infra.** `ClaudeSDKBackend`, `EforgeEngine` orchestration, worktree/git ops, and tracing are integration-level.

## Roadmap

`docs/roadmap.md` captures direction (what and why), not implementation details (how).

- **Read it** before proposing new features or architectural changes
- **Future only** - remove items once they ship
- **Delete PRDs after implementation** - `docs/` should reflect current state and planned work only
