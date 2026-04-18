---
title: Improve Pi-native UX and fix consumer-facing docs drift
created: 2026-04-18
---

# Improve Pi-native UX and fix consumer-facing docs drift

## Problem / Motivation

The Pi extension (`packages/pi-eforge/extensions/eforge/index.ts`) already exposes eforge daemon operations as tools with some custom renderers and one interactive TUI overlay, but most higher-level workflows still route through slash-command aliases that delegate to Markdown skills via `pi.sendUserMessage("/skill:...")`. Pi is being used as a transport layer with renderer polish rather than leveraging its native persistent status, widgets, richer overlay flows, or wizard-like command UX.

Meanwhile, user-facing documentation has drifted from the source of truth in multiple places:

- `packages/engine/src/config.ts` defines `piThinkingLevelSchema` as `off | low | medium | high | xhigh`, and `test/config.test.ts` explicitly asserts `xhigh` is accepted, but consumer-facing docs in Pi skills, Claude plugin skills, and `docs/config.md` still describe only `off | medium | high`.
- A similar drift likely exists for `agents.effort`, where source supports `xhigh` but some skills document only `low | medium | high | max`.
- The backend-profile overhaul has landed on `main` (commit `e688b9b`), moving backend selection out of `eforge/config.yaml` into `eforge/backends/*.yaml` with marker-based activation via `eforge/.active-backend`, but some docs/skills still frame backend management as part of config editing.

An older planning artifact at `.eforge/session-plans/2026-04-05-improve-pi-package-ui.md` gathered context about Pi-native opportunities but never advanced beyond that stage. This work supersedes it.

This effort aligns with the roadmap under **Integration & Maturity** - Pi extension SSE event streaming, plugin skill coverage, and shared tool registry - as a user-facing maturity/polish effort rather than a new subsystem.

## Goal

Make `packages/pi-eforge` feel substantially more Pi-native by replacing key conversational skill flows with native Pi command UX (overlays, pickers, previews, loaders, ambient status), and fix all confirmed consumer-facing docs/skill drift around Pi thinking levels, effort levels, and post-backend-profile-overhaul wording across both the Pi package and the Claude plugin.

## Approach

### Pi becomes native-command-first for interactive flows

The primary UX for `/eforge:backend`, `/eforge:backend:new`, and `/eforge:config` in Pi should be implemented directly in the extension using Pi-native UI components (`ctx.ui.custom()`, `SelectList`, `DynamicBorder`, `BorderedLoader`, `SettingsList`, `ctx.ui.setStatus()`, `ctx.ui.setWidget()`). These are the highest-friction conversational flows today, and Pi offers a much richer TUI surface than plain skill text.

### Pi skills remain as fallback/documentation assets

Existing Pi skills stay for discoverability, fallback behavior, or model-readable documentation, but the polished user path lives in extension commands. The implementation should make the native command path clearly primary in Pi to avoid confusing users with two conceptual paths for the same job.

### Native `/eforge:config` excludes backend/profile management

With the backend-profile overhaul landed, backend selection and profile tuning are no longer part of `eforge/config.yaml`. The Pi-native `/eforge:config` UX manages only the remaining project/team config concerns and routes users to `/eforge:backend` or `/eforge:backend:new` for backend/profile concerns. A polished common-case flow plus an advanced YAML escape hatch is the safer target - avoid overbuilding a form system for every config subtree at once.

### Claude plugin changes are drift-only, not parity-driven

Claude Code plugin changes are limited to confirmed shared-concept drift (stale Pi thinking-level values, stale init/config/backend wording). It is not a goal to reproduce Pi-native UX in the Claude plugin since the platforms have different affordances. If any file under `eforge-plugin/` changes, bump `eforge-plugin/.claude-plugin/plugin.json` per repo policy.

### Implementation surface and maintainability

The primary implementation surface is `packages/pi-eforge/extensions/eforge/index.ts`. Because it already contains tool definitions, renderers, init logic, and command aliasing, adding native backend/config wizards plus ambient UI risks creating a single-file monolith. The implementation should introduce local helper functions or adjacent modules for reusable picker/wizard/preview logic.

### Ambient status design

The landed footer already shows the active backend. Additional ambient UI (queue/build/config state) should be selective and concise - prefer minimal always-on status with deeper detail available in overlays or tool results. Avoid cluttering the Pi footer/editor area.

### Post-overhaul baseline

All implementation is based on the landed init/profile split and marker-based backend resolution (commit `e688b9b`). No pre-overhaul assumptions should linger. Docs and command copy must consistently route backend/profile concerns to `/eforge:backend` and `/eforge:backend:new`, reserving `/eforge:config` for remaining project/team settings.

### Risks and edge cases

1. **Pi command vs skill coexistence could confuse users and future maintainers.** Make the native command path clearly primary in Pi; docs should explain that skills remain as fallback/documentation assets.
2. **`index.ts` may become too large.** Introduce local helper functions or adjacent modules rather than piling everything into one command block.
3. **Native `/eforge:config` can easily become an overbuilt form system.** Target a polished common-case flow plus an advanced YAML escape hatch.
4. **Post-overhaul wording drift is easy to reintroduce.** UX copy must not casually talk about "choosing a backend in config."
5. **Plugin drift cleanup must stay narrowly scoped.** Limit to confirmed shared-concept drift; do not accidentally start editing for parity instead of accuracy.
6. **Existing static tests may encode the old skill-forwarding mental model.** Tests (`test/backend-profile-wiring.test.ts`, `test/skills-docs-wiring.test.ts`) will need updates to verify new extension behavior without overfitting to implementation details.
7. **Ambient status can become noisy.** Design for concise ambient state.
8. **Sequencing dependency on the landed init/profile overhaul.** Implementation must use the post-landing baseline only.

## Scope

### In Scope

- Supersede and remove the older planning artifact at `.eforge/session-plans/2026-04-05-improve-pi-package-ui.md`
- Make `packages/pi-eforge` feel substantially more Pi-native rather than primarily skill-driven
- Add persistent Pi UI affordances for ambient eforge state (widgets above the editor, footer/status polish extending upstream footer-status work)
- Replace key conversational skill flows with native Pi command UX using overlays, pickers, previews, and loaders:
  - Native `/eforge:backend` inspection/switch UX
  - Native `/eforge:backend:new` creation wizard
  - Native `/eforge:config` project-config UX for non-backend `config.yaml` concerns
- Improve inline tool rendering where it materially improves readability for Pi users
- Fix consumer-facing docs/skill drift around Pi thinking levels (`off | low | medium | high | xhigh`) and effort levels (include `xhigh` where applicable), reconciled with the landed backend-profile-overhaul changes
- Keep `eforge-plugin/` and `packages/pi-eforge/` in sync for docs/skills and user-facing behavior where technically feasible
- Update or extend test assertions for new native Pi command registrations and changed skill/docs wording (`test/backend-profile-wiring.test.ts`, `test/skills-docs-wiring.test.ts`)
- Update shared user-facing docs: `docs/config.md`, `docs/architecture.md`, repo-root `README.md`, `packages/pi-eforge/README.md`

### Out of Scope

- Daemon HTTP/API changes
- SSE/live-streaming daemon events into Pi
- Shared tool-registry refactors or schema-library unification
- Reworking the standalone Claude plugin into an equivalent Pi-style UI system (Claude Code does not expose the same TUI surface)
- Restarting the daemon or rollout/migration work
- Expanding into unrelated roadmap items like queue reordering, re-guidance, or multimodal input

## Acceptance Criteria

1. **Native `/eforge:backend` command** exists in the Pi extension and provides a picker/inspection flow using Pi-native UI components (`SelectList`, overlays, previews) for viewing and switching backend profiles - not just a skill forwarder.
2. **Native `/eforge:backend:new` command** exists in the Pi extension and provides a wizard-style creation flow using Pi-native UI components for creating new backend profiles under `eforge/backends/`.
3. **Native `/eforge:config` command** exists in the Pi extension for managing non-backend project/team config in `eforge/config.yaml`, with an advanced YAML escape hatch. It does not include backend/profile management and routes users to `/eforge:backend` or `/eforge:backend:new` for those concerns.
4. **Persistent ambient UI** is added via `ctx.ui.setStatus()` and/or `ctx.ui.setWidget()` to surface eforge state (queue/build status, etc.), extending the already-landed footer-status work. Ambient status is concise and not noisy.
5. **Pi thinking-level values** are documented as `off | low | medium | high | xhigh` in all consumer-facing docs and skills:
   - `packages/pi-eforge/skills/eforge-backend-new/SKILL.md`
   - `packages/pi-eforge/skills/eforge-config/SKILL.md`
   - `eforge-plugin/skills/backend-new/backend-new.md` (if confirmed stale)
   - `eforge-plugin/skills/config/config.md` (if confirmed stale)
   - `docs/config.md`
6. **Effort-level values** are reviewed and updated to include `xhigh` wherever that setting is user-facing and currently stale.
7. **Backend/config ownership** is correctly described post-overhaul in all affected docs: backend profiles live in `eforge/backends/*.yaml`, activation tracked by `eforge/.active-backend`, `eforge/config.yaml` contains only non-backend project/team settings, migration via `/eforge:init --migrate`.
8. **Pi package architecture description** in `docs/architecture.md` and `packages/pi-eforge/README.md` reflects native extension with tool, command, and TUI-based workflows - not primarily skill-based slash commands over native tools.
9. **Pi skills** (`eforge-backend`, `eforge-backend-new`, `eforge-config`) are repositioned as fallback/documentation assets with clear indication that native commands are the primary UX path.
10. **Extension file maintainability**: native command logic is organized into local helper functions or adjacent modules rather than inlined entirely in `packages/pi-eforge/extensions/eforge/index.ts`.
11. **Plugin version bump** in `eforge-plugin/.claude-plugin/plugin.json` if and only if any file under `eforge-plugin/` is changed.
12. **Tests pass** with updated expectations in `test/backend-profile-wiring.test.ts` and `test/skills-docs-wiring.test.ts` reflecting changed skill wording, docs content, and native command registrations.
13. **Older planning artifact removed**: `.eforge/session-plans/2026-04-05-improve-pi-package-ui.md` is deleted and any references to it are cleaned up.
