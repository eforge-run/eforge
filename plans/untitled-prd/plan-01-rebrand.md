---
id: plan-01-rebrand
name: Rebrand eforge.run to eforge.build
dependsOn: []
branch: untitled-prd/rebrand
---

# Rebrand eforge.run to eforge.build

## Architecture Context

eforge is rebranding from `eforge.run` / `eforge-run` to `eforge.build` / `eforge-build`. This is a straightforward text replacement across source files, prompts, docs, and package metadata. The roadmap section tracking this work is removed since the rebrand completes it.

## Implementation

### Overview

Two global replacements (`eforge.run` → `eforge.build`, `eforge-run` → `eforge-build`) across all in-scope files, plus removing the "Rebrand to eforge.build" section from `docs/roadmap.md`.

### Key Decisions

1. The PRD file itself (`docs/prd-queue/untitled-prd.md`) is not modified — it references the old names in its description text and that's expected.
2. The "Marketing Site (eforge.build)" section in the roadmap is left untouched — it already uses the new domain.

## Scope

### In Scope
- Replace `eforge.run` → `eforge.build` in all matching files
- Replace `eforge-run` → `eforge-build` in all matching files
- Remove the "Rebrand to eforge.build" roadmap section (lines 42–49 including surrounding `---` delimiters)

### Out of Scope
- `node_modules/`, `.git/`, `dist/` directories
- The PRD queue file (`docs/prd-queue/untitled-prd.md`)
- The "Marketing Site" section in `docs/roadmap.md`

## Files

### Modify
- `src/engine/git.ts` — Update ATTRIBUTION URL from `eforge.run` to `eforge.build`
- `package.json` — Update `homepage` URL and `repository.url` GitHub org
- `CLAUDE.md` — Update attribution string reference from `eforge.run` to `eforge.build`
- `README.md` — Update plugin marketplace install command from `eforge-run` to `eforge-build`
- `src/engine/prompts/builder.md` — Update attribution URL in prompt text
- `src/engine/prompts/tester.md` — Update attribution URL in prompt text
- `src/engine/prompts/test-writer.md` — Update attribution URL in prompt text
- `src/engine/prompts/evaluator.md` — Update attribution URL in prompt text
- `src/engine/prompts/plan-evaluator.md` — Update attribution URL in prompt text
- `src/engine/prompts/validation-fixer.md` — Update attribution URL in prompt text
- `docs/roadmap.md` — Remove the "Rebrand to eforge.build" section (lines 42–49 and the trailing `---` delimiter)

## Verification

- [ ] `grep -r "eforge\.run" --include="*.ts" --include="*.md" --include="*.json" --include="*.yaml" . | grep -v node_modules | grep -v .git | grep -v dist | grep -v docs/prd-queue` returns zero matches
- [ ] `grep -r "eforge-run" --include="*.ts" --include="*.md" --include="*.json" --include="*.yaml" . | grep -v node_modules | grep -v .git | grep -v dist | grep -v docs/prd-queue` returns zero matches
- [ ] `docs/roadmap.md` contains no "Rebrand to eforge.build" heading
- [ ] `docs/roadmap.md` still contains the "Marketing Site (eforge.build)" section
- [ ] `pnpm type-check` passes
- [ ] `pnpm build` succeeds
