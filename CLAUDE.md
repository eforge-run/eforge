# CLAUDE.md

@AGENTS.md

## Plugin candidate skills

New plugin skills are dogfooded as project-level skills (`.claude/skills/eforge-plugin-<name>/SKILL.md`) before promotion to `eforge-plugin/skills/`.

- **Must be project-generic** - work in any project, not just this repo.
- **Delegate to eforge** - analyze, compose a prompt, enqueue via MCP. The pipeline does the work.
- **Promote when proven** - move to `eforge-plugin/skills/` and bump the plugin version.
