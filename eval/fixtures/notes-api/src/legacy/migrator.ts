export interface MigrationResult {
  migrated: number;
  skipped: number;
  errors: string[];
}

/**
 * Migrate notes from the old flat-file format to the in-memory store.
 * @deprecated This migration path is no longer active.
 */
export function migrate(rawData: string): MigrationResult {
  const lines = rawData.split('\n').filter((line) => line.trim().length > 0);
  const result: MigrationResult = { migrated: 0, skipped: 0, errors: [] };

  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 2) {
      result.errors.push(`Invalid line format: ${line}`);
      result.skipped++;
      continue;
    }
    result.migrated++;
  }

  return result;
}
