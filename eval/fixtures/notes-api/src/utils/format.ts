/**
 * Format a date string for display.
 */
export function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Truncate a string to the given max length, appending "..." if truncated.
 */
export function truncate(str: string, maxLength: number): string {
  if (maxLength < 4) return str.slice(0, maxLength);
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Format an array of records as CSV.
 * @deprecated Legacy CSV export - no longer used
 */
export function formatCsv(headers: string[], rows: string[][]): string {
  const headerLine = headers.join(',');
  const dataLines = rows.map((row) => row.join(','));
  return [headerLine, ...dataLines].join('\n');
}
