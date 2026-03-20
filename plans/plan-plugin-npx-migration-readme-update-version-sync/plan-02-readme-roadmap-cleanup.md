---
id: plan-02-readme-roadmap-cleanup
name: README Restructure, Roadmap Update, and Plans Cleanup
depends_on: [plan-01-plugin-skills-version-sync]
branch: plan-plugin-npx-migration-readme-update-version-sync/readme-roadmap-cleanup
---

# README Restructure, Roadmap Update, and Plans Cleanup

## Architecture Context

With eforge published on npm and plugin skills using npx fallback (plan-01), the README and roadmap need to reflect the new reality. The README currently leads with git clone + build from source as the only install path. The roadmap still lists npm distribution as future work. The `plans/distribution/` directory contains completed PRDs that should be deleted per project conventions.

## Implementation

### Overview

Three changes:

1. Restructure README's Getting Started / Install section to lead with the Claude Code plugin as the primary path (npx downloads eforge automatically on first use, no global install needed). Standalone CLI via npx/npm is the secondary path. The existing git clone instructions move to the Development / Dogfooding section where they already belong.
2. Remove the "npm distribution" bullet from `docs/roadmap.md` since it shipped.
3. Delete the `plans/distribution/` directory (4 files: overview.md, migrate-to-node-sqlite.md, npm-publish.md, plugin-npx-invocations.md).

### Key Decisions

1. Plugin-first install ordering because the plugin is the zero-friction path - npx handles CLI download transparently. Users who want standalone CLI use get a secondary section.
2. The separate "Claude Code Plugin (recommended)" subsection (currently lines 95-114) merges into the main Install section as the primary path. No duplicate plugin content.
3. git clone instructions are removed from Install entirely - they only apply to development/contribution, which is already covered in the Development section.

## Scope

### In Scope
- `README.md` - Restructure Install section
- `docs/roadmap.md` - Remove shipped npm distribution item
- `plans/distribution/` - Delete entire directory

### Out of Scope
- README sections beyond Install/Getting Started (CLI Usage, Configuration, Architecture, etc. stay as-is)
- Dogfooding section in README (stays as-is)
- Any code changes

## Files

### Modify
- `README.md` — Restructure the Getting Started section (currently lines 82-166). The new Install section leads with "Claude Code Plugin (recommended)" explaining that first invocation downloads eforge via npx - no global install needed. Below that, "Standalone CLI" shows `npx eforge run my-feature.md` for one-off use and `npm install -g eforge` for global install. Remove the git clone block from Install (it lives in Development/Dogfooding already). Remove the separate "Claude Code Plugin (recommended)" subsection that currently follows Install. The plugin skill table, CLI Usage section, and everything below remain unchanged.
- `docs/roadmap.md` — Remove the "npm distribution" bullet (`- **npm distribution** — Publish CLI + library to npm, configure exports and files field`) from the Integration & Maturity section. If the section becomes empty after removal, remove the section header too. Currently the section has three bullets (OpenRouter backend, Monorepo, npm distribution) so only the bullet is removed.

### Delete
- `plans/distribution/overview.md`
- `plans/distribution/migrate-to-node-sqlite.md`
- `plans/distribution/npm-publish.md`
- `plans/distribution/plugin-npx-invocations.md`

## Verification

- [ ] README Install section's first subsection is "Claude Code Plugin" (not git clone)
- [ ] README Install section mentions that npx downloads eforge automatically on first invocation
- [ ] README has a "Standalone CLI" subsection showing `npx eforge run` and `npm install -g eforge`
- [ ] README does NOT contain `git clone` in the Install section (only in Development/Dogfooding)
- [ ] README does NOT have a separate "Claude Code Plugin (recommended)" subsection after the Install section (merged into Install)
- [ ] `docs/roadmap.md` does NOT contain the string "npm distribution"
- [ ] `plans/distribution/` directory does not exist
- [ ] The plugin skill table in README still lists all four skills (`/eforge:enqueue`, `/eforge:run`, `/eforge:status`, `/eforge:config`)
