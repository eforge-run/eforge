# Notes API

A simple REST API for managing notes.

## Features

- Create, read, update, and delete notes
- CSV import for bulk note creation
- Full-text search across note content

## Getting Started

```bash
pnpm install
pnpm dev
```

The API runs on port 3000 by default.

## API Endpoints

### Notes

- `GET /notes` — List all notes
- `POST /notes` — Create a note
- `GET /notes/:id` — Get a note by ID
- `PATCH /notes/:id` — Update a note
- `DELETE /notes/:id` — Delete a note

### Import

- `POST /import/csv` — Import notes from CSV file

Upload a CSV file with columns: `title`, `content`, `created_at` to bulk-import notes into the system.

## Development

```bash
pnpm test        # Run tests
pnpm type-check  # Type check
pnpm build       # Build
```
