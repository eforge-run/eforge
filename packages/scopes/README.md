# @eforge-build/scopes

Canonical scope names, directory helpers, named-set resolution, and layered-singleton lookup for the three eforge configuration tiers.

## Consumers

- `@eforge-build/engine` - scope directory lookup and config merge order
- `@eforge-build/input` - playbook and session-plan path resolution
- Future wrapper apps that need to read or write eforge-scoped files directly

## Canonical scopes

| Scope | Directory | Purpose |
|-------|-----------|---------|
| `user` | `~/.config/eforge/` (XDG-aware) | Cross-project, personal; lowest precedence |
| `project-team` | `<configDir>/` (e.g. `eforge/`) | Team-canonical; committed to the repository |
| `project-local` | `[project]/.eforge/` | Dev-personal override; gitignored; highest precedence |

Precedence order: `project-local > project-team > user`

## What's included

- `Scope` - canonical scope type (`'user' | 'project-team' | 'project-local'`)
- `SCOPES` - ordered array of all canonical scope values
- `getScopeDirectory(scope, opts)` - resolves the root directory for a given scope
- `resolveLayeredSingletons(filename, opts)` - returns all existing copies of a singleton file in merge order (`user -> project-team -> project-local`)
- `resolveNamedSet(subdir, opts)` - resolves a named-set directory across tiers, returning the highest-precedence entry per name with shadow metadata
- `listNamedSet(subdir, opts)` - lists all entries in a named-set directory with source scope and shadow chain annotations

## Lookup modes

**Layered singleton** - all existing scope files are returned in canonical merge order (`user -> project-team -> project-local`). Used for `config.yaml`. The caller owns parsing and merge semantics.

**Named set** - directory entries are unique by name across tiers; same-name entries at higher-precedence tiers shadow lower-precedence ones. Used for `profiles/` and `playbooks/`. The highest-precedence copy wins.

See [docs/config.md](../../docs/config.md) for how the engine applies these primitives to config layers, profiles, and playbooks.

## Out of scope

This package has no config schema, no playbook or profile schema, no daemon knowledge, no queue knowledge, and no engine concepts. It is a pure path and file-resolution utility.

## Stability

- Public exports are stability-promised within a major version.
- Breaking changes bump the major version and are noted in the release.
