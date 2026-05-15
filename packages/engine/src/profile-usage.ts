/**
 * ProfileUsageProvider interface and ProfileUsageSummary mirror type.
 *
 * Defined here (separate from eforge.ts and profile-router-runtime.ts) to
 * avoid circular imports. Both the engine and the monitor package reference
 * this contract; eforge.ts re-exports it for external consumers.
 */

// ---------------------------------------------------------------------------
// ProfileUsageSummary — local mirror of @eforge-build/extension-sdk's type
// (engine must not import from the SDK to prevent rootDir violations)
// ---------------------------------------------------------------------------

export interface ProfileUsageSummary {
  /** ISO 8601 timestamp of the most recent build using this profile. */
  lastUsedAt?: string;
  /** Number of build runs using this profile in a recent window. */
  recentRunCount?: number;
  /** Approximate token usage in a recent window. */
  recentTokens?: {
    input?: number;
    output?: number;
    total?: number;
  };
  /** Approximate cost (USD) accumulated in a recent window. */
  recentCostUsd?: number;
  /** Number of quota errors encountered in a recent window. */
  recentQuotaErrors?: number;
  /** Whether a cooldown is currently active for this profile. */
  cooldownActive?: boolean;
  /** ISO 8601 timestamp when the cooldown expires, if active. */
  cooldownUntil?: string;
  /** Whether this profile is approaching its usage limit. */
  nearLimit?: boolean;
  /**
   * Indicates the source of the usage data.
   * - `'event-history'` — populated from recorded daemon event history.
   * - `'none'` — no provider is wired; all other fields will be absent.
   */
  dataSource: 'event-history' | 'none';
}

// ---------------------------------------------------------------------------
// ProfileUsageProvider — injected into engine options by the daemon
// ---------------------------------------------------------------------------

/**
 * Provider interface for best-effort profile usage statistics.
 *
 * The daemon implements this on top of MonitorDB. CLI/direct runs supply a
 * no-data provider so routers receive `{ dataSource: 'none' }` rather than
 * failing with missing data.
 */
export interface ProfileUsageProvider {
  /**
   * Return usage statistics for the named profile, or `null` when no data
   * exists for that profile in the configured window.
   *
   * @param profileName - The profile name to query.
   * @param options.windowMs - Rolling window in milliseconds (default: provider-specific).
   */
  getUsageSummary(profileName: string, options?: { windowMs?: number }): ProfileUsageSummary | null;
}

// ---------------------------------------------------------------------------
// No-data provider factory
// ---------------------------------------------------------------------------

/** Returns a provider that always yields `{ dataSource: 'none' }` for any profile. */
export function createNoDataUsageProvider(): ProfileUsageProvider {
  return {
    getUsageSummary(_profileName, _options) {
      return null;
    },
  };
}
