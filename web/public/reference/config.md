<!-- Generated file. Do not edit. -->
<!-- eforge version: 0.7.12 -->
<!-- Commit: 27605ba6 -->
<!-- Source: packages/engine/src/config.ts -->

# eforge Configuration Reference

eforge merges configuration from three tiers (highest precedence first):

1. `.eforge/config.yaml` — project-local, gitignored, developer-personal
2. `eforge/config.yaml` — project-level, committed
3. `~/.config/eforge/config.yaml` — user-global

## Top-level fields

| Field | Description |
|-------|-------------|
| `agents` |  |
| `build` |  |
| `daemon` |  |
| `hooks` |  |
| `langfuse` |  |
| `maxConcurrentBuilds` |  |
| `monitor` |  |
| `plan` |  |
| `plugins` |  |
| `prdQueue` |  |
| `tools` |  |

## JSON Schema

The complete machine-readable schema is at [`/schemas/config.schema.json`](/schemas/config.schema.json).
