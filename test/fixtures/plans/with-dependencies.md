---
id: dependent-plan
name: Dependent Plan
branch: feature/dependent
depends_on:
  - core
  - config
migrations:
  - timestamp: "20260101000000"
    description: Add users table
  - timestamp: "20260101000001"
    description: Add index on email
---

This plan depends on core and config.
