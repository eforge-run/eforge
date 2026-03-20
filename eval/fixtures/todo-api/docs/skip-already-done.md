# Add In-Memory Todo Store

## Overview

Implement an in-memory data store for managing todos. The store should support basic CRUD operations with auto-incrementing string IDs.

## Requirements

1. Define a `Todo` interface in `src/db.ts` with the following fields:
   - `id` (string) - auto-incrementing string ID
   - `title` (string) - the todo title
   - `completed` (boolean) - whether the todo is done
   - `createdAt` (string) - ISO 8601 timestamp of creation

2. Implement the following functions in `src/db.ts`:
   - `getAllTodos(): Todo[]` - returns a shallow copy of all todos
   - `getTodoById(id: string): Todo | undefined` - finds a todo by ID
   - `createTodo(title: string): Todo` - creates a new todo with `completed: false` and the current timestamp, assigns the next auto-incremented string ID
   - `updateTodo(id: string, updates: Partial<Pick<Todo, 'title' | 'completed'>>): Todo | undefined` - updates title and/or completed status, returns undefined if not found
   - `deleteTodo(id: string): boolean` - removes a todo by ID, returns false if not found
   - `clearTodos(): void` - resets the store, clearing all todos and resetting the ID counter

3. The store must use module-level state (an array and an ID counter) - no class needed.

## Non-goals

- No database or persistence layer
- No validation logic in the store (that belongs in routes)
- No user association or multi-tenancy
