# User Management API

## Overview

Build a REST API for managing users, including CRUD operations and authentication.

## Acceptance Criteria

- [ ] Database schema with users table (id, email, name, created_at, deleted_at)
- [ ] Authentication middleware (JWT-based)
- [ ] GET /users endpoint with pagination
- [ ] POST /users endpoint with validation
- [ ] DELETE /users/:id endpoint with soft delete
- [ ] Integration tests for all endpoints
- [ ] OpenAPI documentation

## Technical Notes

- Use PostgreSQL for the database
- JWT tokens expire after 24 hours
- Soft delete sets deleted_at timestamp (records are not removed from DB)
