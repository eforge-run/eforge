# Add Extension Modules

## Overview

Add three independent feature modules to the workspace API: bookmarks, categories, and activity logging. Each module is a self-contained vertical with its own store, routes, types, and tests. The modules have no dependencies on each other and create only new files - no modifications to existing source files beyond wiring routers into `src/app.ts`.

This work is large enough to warrant parallel implementation across three independent workstreams.

## Requirements

### 1. Bookmarks Module

Let users bookmark messages for quick reference later.

1. Create `src/types/bookmarks.ts` with a `Bookmark` interface: `id` (string), `userId` (string), `messageId` (string), `channelId` (string), `note` (string | null), `createdAt` (string)
2. Create `src/stores/bookmarks.ts` with:
   - `addBookmark(userId: string, messageId: string, channelId: string, note?: string): Bookmark`
   - `removeBookmark(id: string): boolean`
   - `getBookmarksByUser(userId: string): Bookmark[]` - sorted by `createdAt` descending
   - `getBookmarkByUserAndMessage(userId: string, messageId: string): Bookmark | undefined`
   - `clearBookmarks(): void`
3. Create `src/routes/bookmarks.ts` with `bookmarksRouter`:
   - `POST /users/:userId/bookmarks` - accepts `{ messageId, channelId, note? }`, returns 201
   - `GET /users/:userId/bookmarks` - returns user's bookmarks
   - `DELETE /bookmarks/:id` - removes a bookmark, returns 204
4. Create `test/bookmarks.test.ts` with tests covering add, remove, list, and duplicate prevention
5. Wire `bookmarksRouter` into `src/app.ts` at `/bookmarks`

### 2. Categories Module

Let workspace admins organize channels into named categories.

1. Create `src/types/categories.ts` with a `Category` interface: `id` (string), `workspaceId` (string), `name` (string), `description` (string), `position` (number), `channelIds` (string[]), `createdAt` (string)
2. Create `src/stores/categories.ts` with:
   - `createCategory(workspaceId: string, name: string, description: string): Category`
   - `getCategoriesByWorkspace(workspaceId: string): Category[]` - sorted by `position` ascending
   - `updateCategory(id: string, updates: { name?: string; description?: string; position?: number }): Category | undefined`
   - `addChannelToCategory(categoryId: string, channelId: string): boolean`
   - `removeChannelFromCategory(categoryId: string, channelId: string): boolean`
   - `deleteCategory(id: string): boolean`
   - `clearCategories(): void`
3. Create `src/routes/categories.ts` with `categoriesRouter`:
   - `POST /workspaces/:workspaceId/categories` - accepts `{ name, description }`, returns 201
   - `GET /workspaces/:workspaceId/categories` - returns categories sorted by position
   - `PATCH /categories/:id` - updates name, description, or position
   - `POST /categories/:id/channels` - accepts `{ channelId }`, adds channel
   - `DELETE /categories/:id/channels/:channelId` - removes channel from category
   - `DELETE /categories/:id` - deletes category, returns 204
4. Create `test/categories.test.ts` with tests covering CRUD, channel assignment, and position ordering
5. Wire `categoriesRouter` into `src/app.ts` at `/categories`

### 3. Activity Module

Log and query user activity events for analytics.

1. Create `src/types/activity.ts` with an `ActivityEvent` interface: `id` (string), `workspaceId` (string), `userId` (string), `action` (string), `resourceType` (string), `resourceId` (string), `metadata` (Record<string, unknown>), `createdAt` (string)
2. Create `src/stores/activity.ts` with:
   - `logActivity(workspaceId: string, userId: string, action: string, resourceType: string, resourceId: string, metadata?: Record<string, unknown>): ActivityEvent`
   - `getActivityByWorkspace(workspaceId: string, options?: { limit?: number; before?: string }): ActivityEvent[]` - sorted by `createdAt` descending, supports cursor pagination
   - `getActivityByUser(userId: string, options?: { limit?: number }): ActivityEvent[]` - sorted by `createdAt` descending
   - `clearActivity(): void`
3. Create `src/routes/activity.ts` with `activityRouter`:
   - `POST /workspaces/:workspaceId/activity` - accepts `{ userId, action, resourceType, resourceId, metadata? }`, returns 201
   - `GET /workspaces/:workspaceId/activity` - returns events, supports `?limit=` and `?before=` query params
   - `GET /users/:userId/activity` - returns user's activity events, supports `?limit=`
4. Create `test/activity.test.ts` with tests covering logging, querying, pagination, and filtering
5. Wire `activityRouter` into `src/app.ts` at `/activity`

## Non-goals

- No authentication or authorization
- No cross-module interactions (bookmarks don't trigger activity events, etc.)
- No modifications to existing store, types, or route files beyond app.ts router wiring
- No database - all in-memory stores consistent with existing patterns
