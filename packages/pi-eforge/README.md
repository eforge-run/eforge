# @eforge-build/pi-eforge

Pi package for [eforge](https://eforge.build).

Install in Pi:

```bash
pi install npm:@eforge-build/pi-eforge
```

Or install for the current project only:

```bash
pi install -l npm:@eforge-build/pi-eforge
```

Then, in your project:

```text
/eforge:init
```

## What this package provides

- Native Pi tools for eforge daemon operations
- Native Pi commands for agent runtime profile management (`/eforge:profile`, `/eforge:profile-new`) and config viewing (`/eforge:config`) with interactive overlay UX
- Slash commands for build operations (`/eforge:build`, `/eforge:init`, `/eforge:status`, `/eforge:restart`, `/eforge:update`)
- The `/eforge:plan` skill for structured handoff planning before build execution
- The `/eforge:playbook` skill for creating, editing, running, and managing reusable automation playbooks
- The `/eforge:recover` skill for reviewing and acting on failed-PRD recovery verdicts
- Ambient status display showing active profile, queue count, and build progress
- Orchestrator decision events (`plan:build:decision`) flow through the Pi extension unchanged. `eforge_follow` surfaces them via the shared `eventToProgress` registry in `@eforge-build/client` (rendered as `"Plan <planId>: decision (<kind>)"`), so no Pi-specific UI work is needed for v1. Richer rendering (timeline track, hover detail) lives in the monitor UI.

## Requirements

- Node.js 22+
- [Pi](https://github.com/nicories/pi-mono)
- An LLM provider credential supported by your chosen eforge harness

## Relationship to the `@eforge-build/eforge` npm package

`@eforge-build/pi-eforge` is the Pi integration package.

The main [`@eforge-build/eforge`](https://www.npmjs.com/package/@eforge-build/eforge) npm package is the standalone CLI and daemon runtime that this Pi package invokes via `npx -y @eforge-build/eforge`.

For project docs and full setup guidance, see the main repository:

- GitHub: https://github.com/eforge-build/eforge
- Docs: https://eforge.build
