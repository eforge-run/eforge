/**
 * Profile router example: Claude → Codex → local fallback.
 *
 * This extension demonstrates a three-tier profile selection strategy:
 *
 * 1. **Primary** (default: `claude-sdk-4-7`) — preferred for most builds.
 *    Skipped when its usage summary shows a cooldown or it is near its limit.
 *
 * 2. **Secondary** (default: `pi-codex-5-5`) — used when the primary is
 *    unavailable due to quota pressure. Also skipped on cooldown or near-limit.
 *
 * 3. **Local** (default: `pi-deepseek-qwen`) — always available as a last
 *    resort. Returns `{ profile }` without a quota check.
 *
 * Profile names are read from environment variables so users can experiment
 * without editing code:
 *
 *   EFORGE_PROFILE_PRIMARY   — overrides the primary profile name
 *   EFORGE_PROFILE_SECONDARY — overrides the secondary profile name
 *   EFORGE_PROFILE_LOCAL     — overrides the local fallback profile name
 *
 * If none of the three profiles exist in the configured scopes, this router
 * defers (returns `null`) so other routers or the default profile take over.
 *
 * Fail-open semantics apply: if this router throws, the engine emits a
 * `queue:profile:router-failed` diagnostic and continues with the default
 * profile. No `setActiveProfile` calls are made — routing is dispatch-time only.
 */

import { defineEforgeExtension } from '@eforge-build/extension-sdk';
import type { ProfileRouterContext, ProfileRouterResult } from '@eforge-build/extension-sdk';

// ---------------------------------------------------------------------------
// Profile name defaults (overridable via env vars)
// ---------------------------------------------------------------------------

const PRIMARY_PROFILE = process.env.EFORGE_PROFILE_PRIMARY ?? 'claude-sdk-4-7';
const SECONDARY_PROFILE = process.env.EFORGE_PROFILE_SECONDARY ?? 'pi-codex-5-5';
const LOCAL_PROFILE = process.env.EFORGE_PROFILE_LOCAL ?? 'pi-deepseek-qwen';

// ---------------------------------------------------------------------------
// Router logic
// ---------------------------------------------------------------------------

/**
 * Check whether a profile is available and not in cooldown/near-limit state.
 *
 * Returns `true` when:
 * - The profile appears in `ctx.availableProfiles` (exists in scope).
 * - Its usage summary does not have `cooldownActive: true`.
 * - Its usage summary does not have `nearLimit: true`.
 */
function isProfileAvailable(ctx: ProfileRouterContext, profileName: string): boolean {
  const available = ctx.availableProfiles.find((p) => p.name === profileName);
  if (!available) return false;

  const usage = ctx.usage.profile(profileName);
  if (usage.cooldownActive) return false;
  if (usage.nearLimit) return false;

  return true;
}

/**
 * Build a human-readable reason string for the selection decision.
 */
function buildReason(chosen: string, primarySkipped: boolean, secondarySkipped: boolean): string {
  if (chosen === PRIMARY_PROFILE) {
    return `Primary profile '${PRIMARY_PROFILE}' is available and within quota limits`;
  }
  if (chosen === SECONDARY_PROFILE) {
    const why = primarySkipped
      ? `primary '${PRIMARY_PROFILE}' is in cooldown or near quota limit`
      : `primary '${PRIMARY_PROFILE}' is not configured`;
    return `Secondary profile '${SECONDARY_PROFILE}' selected: ${why}`;
  }
  // Local fallback
  const reasons: string[] = [];
  if (primarySkipped) reasons.push(`primary '${PRIMARY_PROFILE}' unavailable`);
  if (secondarySkipped) reasons.push(`secondary '${SECONDARY_PROFILE}' unavailable`);
  const why = reasons.length > 0 ? reasons.join(', ') : 'all other profiles unavailable';
  return `Local fallback profile '${LOCAL_PROFILE}' selected: ${why}`;
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default defineEforgeExtension((eforge) => {
  eforge.registerProfileRouter({
    name: 'claude-codex-local-fallback',

    async selectBuildProfile(ctx: ProfileRouterContext): Promise<ProfileRouterResult | null> {
      let primarySkipped = false;
      let secondarySkipped = false;

      // --- Tier 1: Primary profile ---
      if (isProfileAvailable(ctx, PRIMARY_PROFILE)) {
        return {
          profile: PRIMARY_PROFILE,
          reason: buildReason(PRIMARY_PROFILE, false, false),
          confidence: 'high',
        };
      }
      primarySkipped = true;

      // --- Tier 2: Secondary profile ---
      if (isProfileAvailable(ctx, SECONDARY_PROFILE)) {
        return {
          profile: SECONDARY_PROFILE,
          reason: buildReason(SECONDARY_PROFILE, primarySkipped, false),
          confidence: 'medium',
        };
      }
      secondarySkipped = true;

      // --- Tier 3: Local fallback ---
      const localAvailable = ctx.availableProfiles.find((p) => p.name === LOCAL_PROFILE);
      if (localAvailable) {
        // No quota check for the local profile — always use it as last resort.
        return {
          profile: LOCAL_PROFILE,
          reason: buildReason(LOCAL_PROFILE, primarySkipped, secondarySkipped),
          confidence: 'low',
        };
      }

      // None of the three profiles exist in this project's scope — defer to
      // other routers or the default profile.
      return null;
    },
  });
});
