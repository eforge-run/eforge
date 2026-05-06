export function formatTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function formatNumber(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return n.toString();
}

export function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatRelativeTime(iso: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'just now';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatRunDuration(startedAt: string, completedAt?: string): string {
  if (!startedAt) return '--';
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  return formatDuration(end - start);
}

/**
 * Convert a ThinkingConfig-shaped object to a human-readable string.
 * Accepts `unknown` to avoid importing engine types into monitor-ui.
 * Returns `undefined` for falsy input.
 */
export function formatThinking(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'type' in value) {
    const obj = value as { type: string; budgetTokens?: number };
    if (obj.type === 'disabled') return 'disabled';
    if (obj.type === 'adaptive') return 'adaptive';
    if (obj.type === 'enabled') {
      // Accept both camelCase (budgetTokens) and snake_case (budget_tokens) from wire protocol
      const v = value as Record<string, unknown>;
      const budget = typeof v['budgetTokens'] === 'number'
        ? v['budgetTokens'] as number
        : typeof v['budget_tokens'] === 'number'
        ? v['budget_tokens'] as number
        : undefined;
      if (budget !== undefined) {
        return `enabled (${formatNumber(budget)} tokens)`;
      }
      return 'enabled';
    }
  }
  return JSON.stringify(value);
}

export function shortenPath(path: string, maxChars: number = 50): string {
  if (!path) return '';
  if (path.length <= maxChars) return path;

  const segments = path.split('/');
  if (segments.length <= 1) return path;

  const filename = segments[segments.length - 1];
  // Build from right to left, always keeping filename
  let result = filename;

  for (let i = segments.length - 2; i >= 0; i--) {
    const candidate = segments.slice(i).join('/');
    if (('…/' + candidate).length > maxChars) break;
    result = candidate;
  }

  // If we kept all segments, return the original path
  if (result === path) return path;

  // If we couldn't add any parent dirs, still return …/filename
  return '…/' + result;
}
