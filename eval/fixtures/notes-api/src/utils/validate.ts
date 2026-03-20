/**
 * Validate a note title. Returns an error message or null if valid.
 */
export function validateTitle(title: unknown): string | null {
  if (!title || typeof title !== 'string') {
    return 'Title is required and must be a string';
  }
  if (title.trim().length === 0) {
    return 'Title cannot be empty';
  }
  if (title.length > 200) {
    return 'Title must be 200 characters or less';
  }
  return null;
}

/**
 * Validate a CSV row has the expected number of columns.
 * @deprecated Legacy CSV import - no longer used
 */
export function validateCsvRow(row: string, expectedColumns: number): boolean {
  const columns = row.split(',');
  return columns.length === expectedColumns;
}
