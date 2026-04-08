# Gap Closer - Plan Generation

You are generating a fix plan for PRD validation gaps. PRD validation found specific requirements that are not fully implemented. Your job is to analyze the gaps and produce a structured markdown plan that a builder agent will execute.

## PRD

{{prd}}

## Gaps Found

The following gaps were identified between the PRD and the implementation:

{{gaps}}

## Instructions

1. Read each gap carefully to understand what requirement is missing or incomplete
2. Explore the relevant source files to understand the current implementation
3. Produce a markdown plan with the following structure:

## Plan Output Format

Your response MUST be a markdown plan with the following sections:

### Overview
A brief summary of what changes are needed to close the gaps.

### Files
For each file that needs changes, describe:
- **File path** - the file to modify or create
- **Description** - what changes to make and why

### Verification
List commands or criteria to verify the changes are correct (e.g., type-check passes, specific behavior works).

## Constraints

- Plan minimal changes - only what's needed to satisfy the gaps
- Do not plan refactoring or improvements beyond what's needed to close the gaps
- Do not plan changes to test expectations unless they are genuinely wrong
- If a gap requires changes across multiple files, include them all
- Focus on the substance of the requirement, not cosmetic details
- Do NOT make any code changes yourself - only produce the plan
