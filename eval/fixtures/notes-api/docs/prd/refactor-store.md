# Refactor Store with Generic EntityStore

## Overview

`src/store.ts` has two nearly identical blocks of code - one for notes and one for tags. Both follow the same pattern: a module-level array, an ID counter, and CRUD functions (`getAll`, `getById`, `create`, `update`, `delete`, `clearAll`). The duplication means every new entity type requires copy-pasting the same boilerplate.

Extract a generic `EntityStore<T>` class that encapsulates the shared pattern, then rewrite the notes and tags stores on top of it.

## Requirements

1. Create `src/entity-store.ts` exporting a generic `EntityStore<T extends { id: string }>` class with:
   - `getAll(): T[]` - returns a shallow copy of all entities
   - `getById(id: string): T | undefined` - finds by ID
   - `create(build: (id: string) => T): T` - accepts a builder function that receives the next auto-incremented string ID, pushes the result, and returns it
   - `update(id: string, apply: (entity: T) => void): T | undefined` - finds by ID, calls the mutator, returns the entity (or undefined if not found)
   - `delete(id: string): boolean` - removes by ID
   - `clear(): void` - resets the array and ID counter

2. Rewrite `src/store.ts` to use `EntityStore<Note>` and `EntityStore<Tag>` internally. All existing exported function signatures must remain identical - this is a pure refactor with no API changes.

3. All existing tests must pass without modification.

## Non-goals

- No new features or endpoints
- No changes to routes, types, or test files
- No additional test coverage for EntityStore itself (existing tests cover it transitively)
