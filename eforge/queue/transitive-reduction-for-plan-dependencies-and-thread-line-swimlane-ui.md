---
title: Transitive reduction for plan dependencies and thread-line swimlane UI
created: 2026-04-01
---



# Transitive reduction for plan dependencies and thread-line swimlane UI

## Problem / Motivation

Plan dependencies in orchestration configs include redundant transitive edges (e.g., Plan 03 lists both Plan 01 and Plan 02 when Plan 02 already depends on Plan 01). This clutters the dependency graph visualization and makes the swimlane layout misleading - plans at different depths appear at the same level. The current binary indentation (`pl-4` if any deps exist) doesn't communicate dependency chain depth.

## Goal

Clean, minimal dependency data throughout the system and a swimlane UI that visually communicates dependency depth without wasting horizontal space.

## Approach

1. Apply transitive reduction in `parseOrchestrationConfig()` so that `dependsOn` arrays only contain direct (non-implied) dependencies from the point of loading. All downstream consumers - engine scheduling, graph visualization, swimlane tooltips - benefit automatically.
2. Replace the binary `pl-4` swimlane indentation with thread-line indicators: a narrow left-side column with vertical lines (like Reddit/GitHub comment threading) that show dependency depth. Minimal horizontal indentation per level so deep chains don't run out of room.

## Scope

**In scope:**
- Transitive reduction applied at parse time in the engine (affects all consumers)
- Swimlane thread-line UI in the monitor
- Graph tab edges will naturally reflect reduced deps

**Out of scope:**
- Changing orchestration.yaml file format or how users author dependencies

## Acceptance Criteria

- When Plan 02 depends on Plan 01, and Plan 03 depends on Plan 02, Plan 03's `dependsOn` does not include Plan 01 after parsing
- Swimlane rows show vertical thread lines on the left indicating dependency depth
- Deep dependency chains (3+ levels) remain visually readable without excessive indentation
- Execution semantics unchanged - greedy "run as soon as deps finish" behavior is preserved
- Dependency graph tab renders only direct (reduced) edges
