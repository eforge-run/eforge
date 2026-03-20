# Add Note Search

## Overview

Add a search endpoint that lets users find notes by matching a query string against note titles and content. This is a simple in-memory substring search - no full-text indexing needed.

## Requirements

### Endpoint

1. Add `GET /notes/search?q=<query>` to the notes router:
   - Returns all notes where `title` or `content` contains the query string (case-insensitive)
   - Returns 400 if the `q` query parameter is missing or empty
   - Returns an empty array if no notes match
   - Results are sorted by `createdAt` descending (newest first)

### Store

2. Add a `searchNotes(query: string): Note[]` function to `src/store.ts`:
   - Performs case-insensitive substring matching against `title` and `content`
   - Returns matches sorted by `createdAt` descending

### Tests

3. Add tests in a new `test/search.test.ts` covering:
   - Searching by title returns matching notes
   - Searching by content returns matching notes
   - Search is case-insensitive
   - Empty results return an empty array
   - Missing `q` parameter returns 400
   - Results are sorted newest-first
   - Partial matches work (searching "hello" matches "say hello world")

## Non-goals

- No pagination on search results
- No relevance scoring or ranking beyond date sort
- No fuzzy matching or typo tolerance
- No indexing or caching
