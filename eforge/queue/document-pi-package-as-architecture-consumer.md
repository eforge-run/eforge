---
title: Document Pi package as architecture consumer
created: 2026-04-03
---



# Document Pi package as architecture consumer

## Problem / Motivation

The `docs/architecture.md` file lists the thin consumers of the eforge engine but omits the Pi package (`pi-package/`). This makes the architecture documentation incomplete and misleading - anyone reading it would not know the Pi integration exists or how it fits into the system.

## Goal

Update `docs/architecture.md` so the Pi package is documented as a first-class consumer alongside the CLI, web monitor, and Claude Code plugin.

## Approach

Three targeted edits to `docs/architecture.md`:

1. **Opening paragraph (line 3):** Add "Pi package" to the list of thin consumers. The sentence currently reads "CLI, web monitor, and Claude Code plugin" and should also mention the Pi integration.

2. **System Layers mermaid diagram:** Add a `PiPkg` node in the Consumers subgraph for `pi-package/`, with an arrow to `EforgeEngine`. The arrow label should read "native Pi tools" or similar, mirroring the Plugin's "MCP tools" label.

3. **New `### Pi Package` section** inserted after the existing `### Plugin` section: Describe `pi-package/` as the Pi integration - a native Pi extension that registers tools and slash commands communicating with the daemon via its HTTP API. It provides the same operational surface as the Claude Code plugin (init, build, queue, status, config, daemon management) plus skill-based slash commands (`/eforge:build`, `/eforge:status`, etc.).

## Scope

**In scope:**
- Editing the opening paragraph to include "Pi package"
- Adding `PiPkg` node and arrow in the System Layers mermaid diagram
- Adding a new `### Pi Package` section after `### Plugin`

**Out of scope:**
- Any code changes to `pi-package/` itself
- Changes to any other documentation files
- Modifications to any other sections of `docs/architecture.md`

## Acceptance Criteria

- The opening paragraph on line 3 lists the Pi package alongside the CLI, web monitor, and Claude Code plugin as thin consumers.
- The System Layers mermaid diagram contains a `PiPkg` node in the Consumers subgraph representing `pi-package/`, with an arrow to `EforgeEngine` labeled with "native Pi tools" or equivalent.
- A `### Pi Package` section exists after the `### Plugin` section describing `pi-package/` as a native Pi extension that registers tools and slash commands, communicates with the daemon via HTTP API, provides the same operational surface as the Claude Code plugin (init, build, queue, status, config, daemon management), and supports skill-based slash commands (`/eforge:build`, `/eforge:status`, etc.).
