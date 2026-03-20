import { migrate } from './migrator.js';
import type { MigrationResult } from './migrator.js';

export interface CsvImportResult {
  parsed: number;
  imported: MigrationResult;
}

/**
 * Parse CSV content into raw lines for migration.
 * @deprecated Legacy CSV import pipeline - no longer used.
 */
export function parseCSV(csvContent: string): string[] {
  const lines = csvContent.split('\n');
  // Skip header row
  return lines.slice(1).filter((line) => line.trim().length > 0);
}

/**
 * Import notes from a CSV file by parsing then migrating.
 * @deprecated Legacy CSV import pipeline - no longer used.
 */
export function importNotes(csvContent: string): CsvImportResult {
  const parsed = parseCSV(csvContent);
  const rawData = parsed.join('\n');
  const imported = migrate(rawData);
  return { parsed: parsed.length, imported };
}
