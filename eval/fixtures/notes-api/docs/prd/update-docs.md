# Update Documentation

## Overview

The README and API reference are out of date. The README advertises a CSV import feature and a `POST /import/csv` endpoint that no longer exists - the legacy import pipeline was deprecated and is slated for removal. The API reference uses incorrect field names (`body` instead of `content`, `created` instead of `createdAt`) and has incomplete Tags documentation (missing Get Tag and Delete Tag, using `label` instead of `name`).

Fix both documents so they accurately reflect the current API.

## Requirements

1. Update `docs/README.md`:
   - Remove the "CSV import for bulk note creation" bullet from the Features section
   - Remove the entire Import section (`### Import` and the `POST /import/csv` description)
   - Add a Tags section under API Endpoints listing `GET /tags`, `POST /tags`, `GET /tags/:id`, `DELETE /tags/:id` (the README has no Tags section currently)

2. Update `docs/api-reference.md`:
   - Fix Note field names: `body` → `content`, `created` → `createdAt`
   - Add an `updatedAt` field to all Note response examples
   - Fix and complete Tags documentation: rename `label` to `name` in existing entries, add Get Tag and Delete Tag endpoints with request/response examples

## Non-goals

- No changes to source code or tests
- No new endpoints or features
- No restructuring of the docs directory
