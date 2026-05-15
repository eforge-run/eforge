---
id: plan-02-extension-management-surfaces-docs
name: Extension Management CLI, MCP/Pi Tooling, and Documentation
branch: extend-04-extension-management-surface-mvp/plan-02-extension-management-surfaces-docs
---

# Extension Management CLI, MCP/Pi Tooling, and Documentation

## Architecture Context

Plan 01 adds the daemon/client primitives for new/scaffold, reload, and explicit enablement state. This plan exposes those primitives through the human CLI, Claude Code MCP proxy, Pi extension tool, tests, help text, and docs. Consumer-facing behavior must stay in sync between `packages/eforge/src/cli/mcp-proxy.ts` and `packages/pi-eforge/extensions/eforge/index.ts`; both must import shared helpers from `@eforge-build/client`.

## Implementation

### Overview

Add `eforge extension new` and `eforge extension reload`, render `enabled` in list/show output, extend the shared `eforge_extension` tool action enum to include `new` and `reload`, and update docs/generated references. Keep event replay/testing and enable/disable workflows deferred.

### Key Decisions

1. CLI defaults: `eforge extension new <name>` uses `--scope local`, `--template event-logger`, and no overwrite unless `--force` is passed.
2. CLI scope values are `local | project | user`; daemon responses display the canonical scope returned by plan 01.
3. `eforge_extension` remains a single tool in both MCP and Pi. Add actions rather than creating separate tools so the current parity tests and user model remain simple.
4. Do not modify `packages/pi-eforge/package.json`.
5. Do not modify `eforge-plugin/` unless implementation discovers a plugin-owned extension skill/tool file. The Claude Code plugin uses `eforge-plugin/bin/eforge-mcp-proxy.mjs`, so MCP proxy changes provide the Claude Code tool surface. If any plugin file is changed, bump `eforge-plugin/.claude-plugin/plugin.json` in the same commit.

## Scope

### In Scope

- Add CLI subcommands:
  - `eforge extension new <name> [--scope local|project|user] [--template <template>] [--force] [--json]`
  - `eforge extension reload [--json]`
- Update CLI list/show rendering to include `enabled`.
- Extend MCP proxy `eforge_extension` action enum and handler for `new` and `reload`.
- Extend Pi `eforge_extension` action enum and handler for `new` and `reload`.
- Add CLI/static parity tests for commands, helper usage, parameter validation, and no inline daemon routes.
- Update docs, README/help text, and generated public docs/reference artifacts.

### Out of Scope

- `/eforge:extend` assisted authoring skill.
- Event replay testing or `extension test`.
- `extension enable`, `extension disable`, `extension promote`, or `extension demote`.
- New templates for deferred runtime capability families.

## Files

### Create

- `test/extension-cli-commands.test.ts` — CLI command tests for `extension new`, `extension reload`, JSON output, default scope/template, and non-overwrite behavior.

### Modify

- `packages/eforge/src/cli/index.ts` — Import new helpers/types, add `new` and `reload` subcommands, include `enabled` in table/detail output, and update extension command description.
- `packages/eforge/src/cli/run-or-delegate.ts` — Verify delegated extension command behavior uses the updated CLI/client-helper path; update only if delegated handling bypasses `createProgram`.
- `packages/eforge/src/cli/mcp-proxy.ts` — Import new helpers, extend `eforge_extension` schema/action handling, validate action-specific params, and keep the tool block free of inline `/api/...` route literals.
- `packages/pi-eforge/extensions/eforge/index.ts` — Mirror MCP action enum, parameter schema, helper imports, handler behavior, and descriptions for `new` and `reload`.
- `test/extension-tooling-wiring.test.ts` — Update exact command list, route/helper checks, MCP/Pi parity assertions, docs expectations, and action enum checks for `new` and `reload`.
- `test/extension-tooling-routes.test.ts` — Add or update CLI-through-daemon coverage if shared setup makes this lower-duplication than the new CLI test file.
- `README.md` — Mention the extension management MVP commands alongside native extension overview.
- `docs/extensions.md` — Document command set, scope mapping, templates, overwrite behavior, derived `enabled`, reload semantics, trust caveat, and deferred replay/enable/promote workflows.
- `docs/extensions-api.md` — Update runtime/management wording so it no longer implies only list/show/validate exist.
- `docs/config.md` — Update native extension management references if command lists appear there.
- `packages/extension-sdk/README.md` — Add quick-start guidance using `eforge extension new` before manual authoring examples.
- `web/content/docs/extensions.md` and `web/public/docs/extensions.md` — Regenerated docs guide mirrors.
- `web/content/docs/extensions-api.md` and `web/public/docs/extensions-api.md` — Regenerated API guide mirrors if `docs/extensions-api.md` changes.
- `web/content/docs/configuration.md` and `web/public/docs/configuration.md` — Regenerated configuration docs if native extension management wording changes.
- `web/content/reference/api.md` and `web/public/reference/api.md` — Regenerated API route reference including `extensionNew` and `extensionReload`.
- `web/public/llms-full.txt` and `web/public/llms.txt` — Regenerated LLM docs artifacts if `pnpm docs:generate` updates them.

## Implementation Notes

- CLI `new` must pass `{ name, scope, template, force }` to `apiNewExtension`; omit undefined options so daemon defaults remain authoritative.
- CLI `reload` must call `apiReloadExtensions` and print watcher restart state plus diagnostic counts. JSON mode must print the raw response.
- Check `packages/eforge/src/cli/run-or-delegate.ts`; if it intercepts `extension` commands, route `new` and `reload` through the same client-helper path as direct CLI. If it only delegates to `createProgram`, cover that delegated path in the CLI tests.
- Non-JSON `new` output must include the path, canonical scope, template, whether a file was overwritten, and at least one next-step line such as running `eforge extension validate <name>` and `eforge extension reload`.
- For MCP/Pi action validation:
  - `list`: reject `name`, `path`, `scope`, `template`, and `force`.
  - `show`: require `name`, reject `path`, `scope`, `template`, and `force`.
  - `validate`: allow one of `name` or `path`, reject `scope`, `template`, and `force`.
  - `new`: require `name`, allow `scope`, `template`, and `force`, reject `path`.
  - `reload`: reject all action-specific params.
- Use client helpers (`apiNewExtension`, `apiReloadExtensions`) in MCP/Pi; do not call `daemonRequest` with extension route constants for these actions.
- Run `pnpm docs:generate` after docs/source changes and commit any generated artifacts.

## Verification

- [ ] `createProgram(undefined, 'test')` exposes extension subcommands `list`, `show`, `validate`, `new`, and `reload`.
- [ ] Delegated CLI execution either reaches `createProgram` for `extension new`/`reload` or has tests showing those delegated commands call `apiNewExtension`/`apiReloadExtensions`.
- [ ] `eforge extension new audit --json` against an in-process daemon creates `.eforge/extensions/audit.ts` and prints JSON with `name: "audit"`, `template: "event-logger"`, and the created path.
- [ ] `eforge extension new audit` a second time exits non-zero and leaves the first file content unchanged.
- [ ] `eforge extension reload --json` prints the raw reload response with watcher metadata.
- [ ] CLI list/show non-JSON renderers include an `enabled` value.
- [ ] MCP proxy `eforge_extension` action enum contains `list`, `show`, `validate`, `new`, and `reload` and its tool block contains no literal `'/api/` or `"/api/` strings.
- [ ] Pi `eforge_extension` action enum contains `list`, `show`, `validate`, `new`, and `reload` and its tool block contains no literal `'/api/` or `"/api/` strings.
- [ ] MCP and Pi `new` actions call `apiNewExtension`; `reload` actions call `apiReloadExtensions`.
- [ ] `docs/extensions.md` contains `eforge extension new <name>` and `eforge extension reload`, explains `local -> .eforge/extensions/`, `project -> eforge/extensions/`, and `user -> ~/.config/eforge/extensions/` by default (`$XDG_CONFIG_HOME/eforge/extensions/` when configured), and states event replay testing is deferred.
- [ ] `pnpm vitest run test/extension-cli-commands.test.ts test/extension-tooling-wiring.test.ts test/extension-tooling-routes.test.ts` passes.
- [ ] `pnpm docs:check` passes after generated docs are committed.
