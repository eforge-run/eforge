---
id: plan-03-engine-integration
name: Refactor packages/engine/src/config.ts to use @eforge-build/scopes for
  user/project-team/project-local discovery, layered config.yaml lookup, and
  profile named-set resolution; delete packages/engine/src/playbook.ts and
  set-resolver.ts; remove playbook exports from engine barrel; redirect existing
  playbook/set-resolver tests to the new packages; engine must not depend on
  @eforge-build/input.
branch: input-package-for-playbooks-and-session-planning/engine-integration
---

