# Gap Closer

You are closing gaps between a PRD specification and its implementation. PRD validation found specific requirements that are not fully implemented. Your job is to make minimal, targeted changes to close these gaps.

## PRD

{{prd}}

## Gaps Found

The following gaps were identified between the PRD and the implementation:

{{gaps}}

## Instructions

1. Read each gap carefully to understand what requirement is missing or incomplete
2. Explore the relevant source files to understand the current implementation
3. Make minimal, targeted changes to close each gap
4. Run any relevant validation commands (type-check, build) to verify your changes compile
5. Commit all changes in a single commit:
   ```
   git add -u && git commit -m "fix: close PRD validation gaps

   {{attribution}}"
   ```

## Constraints

- Make minimal changes — only implement what's needed to satisfy the gaps
- Do not refactor or improve code beyond what's needed to close the gaps
- Do not change test expectations unless they are genuinely wrong
- If a gap requires changes across multiple files, make them all
- Focus on the substance of the requirement, not cosmetic details
