# Remove Dead Code

## Overview

The codebase has several deprecated artifacts that are no longer used by any live code path:

- `src/legacy/` directory containing `importer.ts` and `migrator.ts` - a deprecated CSV import pipeline that nothing imports
- `formatCsv()` in `src/utils/format.ts` - marked `@deprecated`, not called anywhere
- `validateCsvRow()` in `src/utils/validate.ts` - marked `@deprecated`, not called anywhere

Remove all of it. The test file `test/format.test.ts` may have tests covering `formatCsv` - remove those tests as well.

## Requirements

1. Delete the entire `src/legacy/` directory (`importer.ts` and `migrator.ts`)
2. Remove the `formatCsv()` function from `src/utils/format.ts` (keep `formatDate` and `truncate`)
3. Remove the `validateCsvRow()` function from `src/utils/validate.ts` (keep `validateTitle`)
4. Remove any tests in `test/format.test.ts` that cover `formatCsv` or `validateCsvRow`
5. All remaining tests must pass without modification

## Non-goals

- No new features or code additions
- No refactoring of live code
- No changes to routes, store, or types
