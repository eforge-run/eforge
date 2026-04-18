---
id: plan-02-native-pi-ux
name: Native Pi command UX, module extraction, and ambient status
depends_on:
  - plan-01-docs-drift-fix
branch: improve-pi-native-ux-and-fix-consumer-facing-docs-drift/native-pi-ux
agents:
  builder:
    effort: xhigh
    rationale: Complex multi-module TUI overlay implementation with Pi SDK
      primitives requiring careful coordination across 10 files
  reviewer:
    effort: high
    rationale: Native Pi command code needs thorough review for UX quality, error
      handling, and module boundaries
---

# Native Pi command UX, module extraction, and ambient status

## Architecture Context

The Pi extension (`packages/pi-eforge/extensions/eforge/index.ts`, ~1126 lines) already has native tools that call the daemon HTTP API and one interactive TUI overlay (`eforge_confirm_build`) demonstrating the `ctx.ui.custom()` pattern with `Container`, `SelectList`, `DynamicBorder`, `Markdown`, and `Text` components. However, all 9 slash commands delegate to skills via `pi.sendUserMessage("/skill:...")`. This plan replaces three key command handlers (`/eforge:backend`, `/eforge:backend:new`, `/eforge:config`) with native Pi UX and extracts reusable logic into adjacent modules to prevent `index.ts` from becoming a monolith.

The existing `eforge_confirm_build` overlay (lines 967-1056 in index.ts) serves as the canonical pattern for building TUI overlays - Container composition, SelectList with theme callbacks, DynamicBorder framing, and `done()` callback resolution.

The daemon client in `@eforge-build/client` already provides all needed HTTP endpoints:
- `GET /api/backend/list?scope=all` - list profiles with active/scope info
- `GET /api/backend/show` - active profile with resolution details
- `POST /api/backend/use` - activate a profile
- `POST /api/backend/create` - create a profile
- `GET /api/models/providers?backend=...` - list providers
- `GET /api/models/list?backend=...&provider=...` - list models
- `GET /api/config/show` - resolved config
- `GET /api/config/validate` - validate config
- `GET /api/auto-build` - watcher state
- `GET /api/queue` - queue items
- `GET /api/latest-run` + `GET /api/run-summary/:id` - build status

## Implementation

### Overview

Extract three new modules adjacent to `index.ts`, implement native command handlers for backend inspection/switching, backend creation wizard, and config viewing, add concise ambient status widgets, update architecture docs and Pi README, reposition Pi skills as fallback assets, and add test assertions for native command registrations.

### Key Decisions

1. **Module extraction pattern**: Each new module exports an `async` handler function that receives the Pi extension context (`ctx`) and daemon client helpers. The modules import from `@eforge-build/client`, `@mariozechner/pi-tui`, and `@mariozechner/pi-coding-agent` directly - they are peers of `index.ts`, not sub-libraries.
2. **`ui-helpers.ts`** provides shared overlay utilities: a reusable `showSelectOverlay()` function (wrapping the Container/SelectList/DynamicBorder pattern), a `showInfoOverlay()` for read-only previews, and a `withLoader()` wrapper for async operations that shows a loading indicator.
3. **Native `/eforge:backend` command** fetches profile list via daemon API, displays a SelectList overlay with profile name, scope badge (`project`/`user`), backend type, and active indicator (`●`/`○`). Selecting a profile shows a detail preview overlay with the profile YAML content. A "Switch to this profile" action calls `POST /api/backend/use`. Falls back to `pi.sendUserMessage("/skill:eforge-backend")` if `ctx.hasUI` is false.
4. **Native `/eforge:backend:new` command** implements a multi-step wizard overlay: (1) scope picker (project/user), (2) name input via the agent (prompt user for name), (3) backend type picker (claude-sdk/pi), (4) for Pi: provider picker from `GET /api/models/providers`, (5) model pickers for max/balanced/fast classes from `GET /api/models/list`, (6) optional tuning (effort level, thinkingLevel for Pi), (7) confirmation preview of the assembled YAML, (8) create via `POST /api/backend/create` and offer activation. Steps that need text input (name) use `pi.sendUserMessage()` to ask the agent; picker steps use SelectList overlays. Falls back to skill forwarding when `ctx.hasUI` is false.
5. **Native `/eforge:config` command** fetches resolved config via `GET /api/config/show`, displays a structured read-only overview using a multi-line Text overlay with section headers (postMergeCommands, hooks, daemon, agents defaults). For editing, it notes the `eforge/config.yaml` file path for manual editing (YAML escape hatch). For backend/profile concerns, it displays a clear routing message: "Use `/eforge:backend` to manage backend profiles." Falls back to skill forwarding when `ctx.hasUI` is false.
6. **Ambient status** extends the existing `session_start` listener. On session start and after backend/build operations, fetch queue count (`GET /api/queue`) and latest run status (`GET /api/latest-run` + `GET /api/run-summary/:id`). Display via `ctx.ui.setStatus()` keys: `eforge-queue` showing queue item count (hidden when 0), `eforge-build` showing current build status with phase/agent info (hidden when idle). Keep the existing `eforge` key for active backend display.
7. **Command handler replacement**: For the three commands (`eforge:backend`, `eforge:backend:new`, `eforge:config`), replace `pi.sendUserMessage("/skill:...")` with direct calls to the module handler functions. The remaining 6 commands keep their skill-forwarding behavior.
8. **Skill fallback notes**: Add a brief note at the top of each of the three Pi skill files indicating that the native `/eforge:backend` (or `:new` or `:config`) command is the primary UX path in Pi, and the skill serves as a fallback for non-interactive contexts and as model-readable documentation.

## Scope

### In Scope
- Extract `ui-helpers.ts`, `backend-commands.ts`, `config-command.ts` adjacent to `index.ts`
- Implement native overlay/picker/wizard UX for `/eforge:backend`, `/eforge:backend:new`, `/eforge:config`
- Add ambient queue/build status via `ctx.ui.setStatus()`
- Replace skill-forwarding for 3 commands with native handlers in `index.ts`
- Add fallback notes to 3 Pi skill files
- Update `docs/architecture.md` Pi Package section to describe native commands instead of "skill-based slash commands"
- Update `packages/pi-eforge/README.md` to describe native command UX
- Add test assertions for native command handler registrations

### Out of Scope
- Enum value drift fixes (done in plan-01)
- Claude Code plugin UX changes (different platform affordances)
- SSE/live-streaming from daemon
- Daemon API changes
- Native commands for the remaining 6 slash commands (build, status, init, plan, restart, update) - these keep skill-forwarding

## Files

### Create
- `packages/pi-eforge/extensions/eforge/ui-helpers.ts` - Shared overlay utilities: `showSelectOverlay()` wrapping Container/SelectList/DynamicBorder pattern, `showInfoOverlay()` for read-only previews, `withLoader()` for async loading states. Imports from `@mariozechner/pi-tui` and `@mariozechner/pi-coding-agent`.
- `packages/pi-eforge/extensions/eforge/backend-commands.ts` - Native handlers for `/eforge:backend` (profile list/inspect/switch overlay) and `/eforge:backend:new` (multi-step creation wizard). Imports from `@eforge-build/client` for daemon API calls and from `./ui-helpers` for overlay primitives.
- `packages/pi-eforge/extensions/eforge/config-command.ts` - Native handler for `/eforge:config` (structured config viewer with YAML escape hatch routing). Imports from `@eforge-build/client` and `./ui-helpers`.

### Modify
- `packages/pi-eforge/extensions/eforge/index.ts` - Import handlers from new modules. Replace `pi.sendUserMessage("/skill:eforge-backend")` in the `eforge:backend` command with a call to `handleBackendCommand()` from `./backend-commands`. Same for `eforge:backend:new` → `handleBackendNewCommand()` and `eforge:config` → `handleConfigCommand()`. Add ambient status refresh logic to the `session_start` listener (fetch queue count and latest build status, set `eforge-queue` and `eforge-build` status keys). Extract `refreshStatus()` to also update queue/build status alongside the existing backend status.
- `packages/pi-eforge/skills/eforge-backend/SKILL.md` - Add a note at the top (after frontmatter, before Step 1): "Note: In Pi, the native `/eforge:backend` command provides a richer interactive experience with overlay-based profile browsing and switching. This skill serves as a fallback for non-interactive contexts and as model-readable documentation."
- `packages/pi-eforge/skills/eforge-backend-new/SKILL.md` - Add similar fallback note referencing `/eforge:backend:new` native command.
- `packages/pi-eforge/skills/eforge-config/SKILL.md` - Add similar fallback note referencing `/eforge:config` native command.
- `packages/pi-eforge/README.md` - Update the "What this package provides" section: change "Slash commands including..." to describe native Pi commands for backend/config management and slash commands for remaining operations. Add a brief section on ambient status display.
- `docs/architecture.md` - Update the Pi Package paragraph (line 67): replace "Skill-based slash commands (`/eforge:build`, `/eforge:config`, `/eforge:init`, `/eforge:restart`, `/eforge:status`, `/eforge:update`) provide the same operational surface" with wording that describes native Pi overlay commands for backend and config management plus skill-based commands for remaining operations.
- `test/backend-profile-wiring.test.ts` - Add assertions that verify: (a) `backend-commands.ts` exists as a file; (b) `config-command.ts` exists as a file; (c) `ui-helpers.ts` exists as a file; (d) `index.ts` imports from `./backend-commands` and `./config-command`; (e) the three Pi skill files each contain a fallback note mentioning the native command.

## Verification

- [ ] `packages/pi-eforge/extensions/eforge/ui-helpers.ts` exists and exports `showSelectOverlay`
- [ ] `packages/pi-eforge/extensions/eforge/backend-commands.ts` exists and exports `handleBackendCommand` and `handleBackendNewCommand`
- [ ] `packages/pi-eforge/extensions/eforge/config-command.ts` exists and exports `handleConfigCommand`
- [ ] `index.ts` imports from `./backend-commands` and `./config-command` (grep confirms import statements)
- [ ] The `eforge:backend` command handler in `index.ts` does NOT contain `sendUserMessage("/skill:eforge-backend")` - it calls the native handler instead
- [ ] The `eforge:backend:new` command handler does NOT contain `sendUserMessage("/skill:eforge-backend-new")`
- [ ] The `eforge:config` command handler does NOT contain `sendUserMessage("/skill:eforge-config")`
- [ ] The remaining 6 commands (`build`, `status`, `init`, `plan`, `restart`, `update`) still forward to skills via `sendUserMessage`
- [ ] Each of the 3 Pi skill files (`eforge-backend`, `eforge-backend-new`, `eforge-config`) contains the word "fallback" indicating native command is primary
- [ ] `docs/architecture.md` Pi Package section mentions "native" commands and does not describe the surface as purely "skill-based"
- [ ] `packages/pi-eforge/README.md` mentions native commands for backend and config
- [ ] `ctx.ui.setStatus` is called with keys `eforge-queue` and `eforge-build` somewhere in the extension code
- [ ] `pnpm type-check` passes
- [ ] `pnpm test` passes with updated assertions in `test/backend-profile-wiring.test.ts`