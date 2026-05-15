---
id: plan-02-cli-mcp-pi-docs-extension-test
name: CLI, MCP, Pi, and Docs Extension Test Surface
branch: extend-07-extension-validation-and-replay-test-harness/plan-02-cli-mcp-pi-docs-extension-test
agents:
  builder:
    effort: high
    rationale: Updates multiple user-facing surfaces that must remain in parity
      while consuming the new client route contract.
  reviewer:
    effort: high
    rationale: Review must verify CLI exit semantics, MCP/Pi parameter parity,
      documentation accuracy, and no inline daemon route literals.
  tester:
    effort: high
    rationale: CLI and static parity tests need coverage for JSON/non-JSON output
      and nonzero failure behavior.
  doc-author:
    effort: medium
    rationale: Docs need focused updates to remove deferred replay language and
      document command/API behavior.
---

# CLI, MCP, Pi, and Docs Extension Test Surface

## Architecture Context

Plan-01 provides the reusable engine replay harness and `@eforge-build/client` daemon route contract. This plan exposes that capability to extension authors and authoring agents through the CLI, Claude Code MCP proxy, Pi extension tool, and documentation. The Pi and Claude Code MCP surfaces must stay in sync and must consume `apiTestExtension` rather than inlining daemon paths.

## Implementation

### Overview

Add `eforge extension test [nameOrPath]` to the CLI with fixture, run, event filter, and JSON options. Extend the existing `eforge_extension` tool in both `packages/eforge/src/cli/mcp-proxy.ts` and `packages/pi-eforge/extensions/eforge/index.ts` with `action: "test"` and matching parameters. Update docs that currently state replay testing is deferred. Extend existing CLI and wiring tests to lock down command registration, output, exit behavior, route-helper usage, and MCP/Pi parity.

### Key Decisions

1. **CLI delegates to the daemon helper.** The command must call `apiTestExtension` so daemon route constants and wire types remain owned by `@eforge-build/client`.
2. **Path/name detection matches validate.** Reuse `isExtensionPathArg` so `eforge extension test ./path/to/ext.ts` is treated as an ad-hoc path and `eforge extension test build-notifier` is treated as a configured extension name.
3. **Non-JSON output is summary-first.** Print validity, source, event counts, match count, emitted diagnostic count, deferred family counts, and diagnostic details. No-match replays must print a clear zero-match message and exit 0 when `valid` is true.
4. **Exit behavior follows the response.** Exit 1 when `data.valid === false`; exit 0 when `data.valid === true`, including zero-match replay and static-only test output.
5. **MCP/Pi parameter rules are symmetric.** `test` accepts optional `name` or `path`, optional `fixture`, optional `run`, and optional `event`; it rejects `scope`, `template`, and `force`. Other actions reject the new test-only parameters.

## Scope

### In Scope

- CLI command:

  ```bash
  eforge extension test [nameOrPath] [--run latest|<sessionId-or-runId>] [--event <type>] [--fixture <path>] [--json]
  ```

  Behavior:
  - No `nameOrPath` tests configured extensions.
  - Name tests a selected configured extension.
  - Path tests one ad-hoc extension file/directory.
  - `--fixture` reads project-local fixture events through the daemon route.
  - `--run latest` and `--run <sessionId-or-runId>` replay monitor DB events through the daemon route.
  - `--event` filters by exact event type.
  - `--json` prints raw `ExtensionTestResponse`.
  - Non-JSON output includes validity, source, replay counts, matches, diagnostics, and deferred registration families.
  - Process exit code is 1 when `valid` is false.
- MCP proxy `eforge_extension` tool updates:
  - Add `test` to the action enum.
  - Add optional `fixture`, `run`, and `event` parameters.
  - Route through `apiTestExtension`.
  - Preserve validation messages for existing actions while rejecting test-only parameters outside `test`.
- Pi extension `eforge_extension` tool updates matching the MCP proxy:
  - Add `test` to `StringEnum`.
  - Add optional `fixture`, `run`, and `event` parameters.
  - Route through `apiTestExtension`.
  - Keep parameter validation messages in parity with MCP.
- Documentation updates:
  - `docs/extensions.md` management command list, replay usage examples, output semantics, and security note for dry-run execution.
  - `docs/extensions-api.md` runtime/status language to state event replay testing is supported for `onEvent` only and non-event registrations remain deferred.
  - `packages/extension-sdk/README.md` quick-start loop to include `eforge extension test ... --fixture ...` or `--run latest` after validation.
- Tests for CLI and MCP/Pi parity.

### Out of Scope

- New `/eforge:extend` natural-language authoring skill.
- Engine harness, client route contract, and daemon route implementation; plan-01 owns those.
- Runtime execution for non-event registration families.
- Changes to `packages/pi-eforge/package.json` version.
- Changes to `eforge-plugin/.claude-plugin/plugin.json` unless this plan edits files under `eforge-plugin/`; if plugin files are edited, bump that plugin version in the same commit.

## Files

### Modify

- `packages/eforge/src/cli/index.ts` — import `apiTestExtension` and response types; add `renderExtensionTestResult`; register `extension test [nameOrPath]`; implement request construction, non-JSON rendering, and exit behavior.
- `packages/eforge/src/cli/mcp-proxy.ts` — import `apiTestExtension`; extend `eforge_extension` action enum, schema, validation, and handler for `test`.
- `packages/pi-eforge/extensions/eforge/index.ts` — import `apiTestExtension`; extend the Pi `eforge_extension` tool parameters, validation, and handler for `test`.
- `docs/extensions.md` — document `eforge extension test`, fixture/run/event options, supported fixture formats, replay summary fields, dry-run security posture, and the fact that event replay is no longer deferred.
- `docs/extensions-api.md` — document that replay executes only `onEvent` hooks and summarizes non-event registrations as deferred.
- `packages/extension-sdk/README.md` — update the extension author loop to include the replay test command.
- `test/extension-cli-commands.test.ts` — add command registration, JSON output, non-JSON output, fixture/run option request behavior, and invalid/replay-diagnostic exit-code coverage.
- `test/extension-tooling-wiring.test.ts` — update route/helper assertions, CLI command assertions, docs drift assertions, and MCP/Pi parity checks for `test`.

## Verification

- [ ] CLI registration tests show `extension` subcommands sorted as `['list', 'new', 'reload', 'show', 'test', 'validate']`.
- [ ] CLI JSON test proves `eforge extension test loaded --fixture events.json --json` prints an `ExtensionTestResponse` with `source.kind === 'fixture'` and a non-empty `matches` array for a matching fixture.
- [ ] CLI non-JSON test proves output contains `Extensions test passed`, source, replayed event count, match count, and deferred registration family lines.
- [ ] CLI failure test proves `process.exit(1)` occurs when the daemon response has `valid: false` from an invalid fixture or handler diagnostic.
- [ ] CLI no-match test proves `process.exit` is not called when `valid: true` and `matches.length === 0`.
- [ ] MCP wiring tests prove `z.enum(['list', 'show', 'validate', 'test', 'new', 'reload'])` is present and the `eforge_extension` block calls `apiTestExtension` without inline `/api/` literals.
- [ ] Pi wiring tests prove `StringEnum(["list", "show", "validate", "test", "new", "reload"] as const` is present and the `eforge_extension` block calls `apiTestExtension` without inline `/api/` literals.
- [ ] MCP/Pi parity tests prove both surfaces reject `scope`, `template`, and `force` for `test`, reject `fixture`, `run`, and `event` for non-test actions, and enforce only one of `name` or `path` for `test`.
- [ ] Docs tests no longer assert `Event replay testing is deferred`; they assert `eforge extension test` and `--run latest` are documented.
- [ ] `pnpm type-check` passes after plan-02.