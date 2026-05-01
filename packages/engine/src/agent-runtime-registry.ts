/**
 * AgentRuntimeRegistry — maps agent roles to harness instances.
 *
 * With tier recipes, the registry's job is simple: for any role, look up
 * the role's tier and return the harness instance for that tier. Pi
 * harness instances are memoized by (harness, provider) so two tiers that
 * share `pi` + provider share one instance.
 */

import type { AgentRole } from './events.js';
import type { EforgeConfig, TierConfig, PiConfig, AgentTier } from './config.js';
import type { AgentHarness } from './harness.js';
import type { ClaudeSDKHarnessOptions } from './harnesses/claude-sdk.js';
import type { SdkPluginConfig, SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSDKHarness } from './harnesses/claude-sdk.js';
import { AGENT_ROLE_TIERS } from './pipeline/agent-config.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Minimal plan-entry shape consumed by the registry — only the tier override
 * field is needed here.
 */
export interface PlanEntryForRegistry {
  agents?: Record<string, { tier?: string; [key: string]: unknown }>;
}

/**
 * Registry that maps agent roles to harness instances.
 */
export interface AgentRuntimeRegistry {
  /**
   * Resolve the harness for an agent role.
   *
   * @param role - The agent role to resolve.
   * @param planEntry - Optional plan-file entry. When the plan overrides a
   *   role's tier, the harness instance for the plan-resolved tier is returned
   *   so the advertised harness matches the harness actually running the role.
   */
  forRole(role: AgentRole, planEntry?: PlanEntryForRegistry): AgentHarness;
}

// ---------------------------------------------------------------------------
// Options for global infrastructure (forwarded from EforgeEngine.create)
// ---------------------------------------------------------------------------

export interface RegistryGlobalOptions {
  mcpServers?: ClaudeSDKHarnessOptions['mcpServers'];
  plugins?: SdkPluginConfig[];
  settingSources?: SettingSource[];
}

// ---------------------------------------------------------------------------
// singletonRegistry — test adapter
// ---------------------------------------------------------------------------

/**
 * Create a registry where every role resolves to the same harness instance.
 * Used by test code to wrap a single StubHarness.
 */
export function singletonRegistry(harness: AgentHarness): AgentRuntimeRegistry {
  return {
    forRole(_role: AgentRole, _planEntry?: PlanEntryForRegistry): AgentHarness { return harness; },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a PiConfig from a tier's pi block, filling in defaults for any
 * unspecified fields.
 */
function buildPiConfig(piBlock: TierConfig['pi'] | undefined): PiConfig {
  return {
    apiKey: piBlock?.apiKey,
    provider: piBlock?.provider,
    thinkingLevel: piBlock?.thinkingLevel ?? 'medium',
    extensions: {
      autoDiscover: piBlock?.extensions?.autoDiscover ?? true,
      include: piBlock?.extensions?.include,
      exclude: piBlock?.extensions?.exclude,
      paths: piBlock?.extensions?.paths,
    },
    compaction: {
      enabled: piBlock?.compaction?.enabled ?? true,
      threshold: piBlock?.compaction?.threshold ?? 100_000,
    },
    retry: {
      maxRetries: piBlock?.retry?.maxRetries ?? 3,
      backoffMs: piBlock?.retry?.backoffMs ?? 1000,
    },
  };
}

// ---------------------------------------------------------------------------
// buildAgentRuntimeRegistry — async factory
// ---------------------------------------------------------------------------

/**
 * Build an `AgentRuntimeRegistry` from config.
 *
 * Lazily imports `./harnesses/pi.js` the first time a Pi tier is needed.
 * Pi instances are memoized by (harness, provider) so tiers sharing the same
 * pi.provider reuse a single harness instance. Claude SDK has a single shared
 * instance because its config is harness-global.
 */
export async function buildAgentRuntimeRegistry(
  config: EforgeConfig,
  globalOptions: RegistryGlobalOptions = {},
): Promise<AgentRuntimeRegistry> {
  const tiers = config.agents.tiers;
  if (!tiers || Object.keys(tiers).length === 0) {
    throw new Error(
      'buildAgentRuntimeRegistry: "agents.tiers" is not declared or is empty in config. ' +
      'Add agents.tiers entries (each with harness + model + effort) to eforge/config.yaml.',
    );
  }

  // Detect whether any tier uses Pi so we can lazily import the module.
  let PiHarnessCtor: (typeof import('./harnesses/pi.js'))['PiHarness'] | undefined;
  const hasPi = Object.values(tiers).some((t) => t?.harness === 'pi');
  if (hasPi) {
    try {
      const piModule = await import('./harnesses/pi.js');
      PiHarnessCtor = piModule.PiHarness;
    } catch (err) {
      throw new Error(
        'Failed to load Pi harness. Ensure Pi SDK dependencies are installed ' +
        '(@mariozechner/pi-ai and @mariozechner/pi-agent-core). ' +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Memoize instances keyed by (harness, provider). Provider is empty string
  // for claude-sdk (which is harness-global) and the pi.provider value for pi.
  const instances = new Map<string, AgentHarness>();

  function makeKey(harness: 'claude-sdk' | 'pi', provider?: string): string {
    return harness === 'pi' ? `pi:${provider ?? ''}` : 'claude-sdk';
  }

  function instanceForTier(tierRecipe: TierConfig): AgentHarness {
    const provider = tierRecipe.harness === 'pi' ? tierRecipe.pi?.provider : undefined;
    const key = makeKey(tierRecipe.harness, provider);
    const existing = instances.get(key);
    if (existing) return existing;

    let harness: AgentHarness;
    if (tierRecipe.harness === 'pi') {
      if (!PiHarnessCtor) throw new Error('Internal: Pi module not loaded despite pi tier');
      const piCfg = buildPiConfig(tierRecipe.pi);
      harness = new PiHarnessCtor({
        mcpServers: globalOptions.mcpServers,
        piConfig: piCfg,
        bare: config.agents.bare,
        extensions: {
          autoDiscover: piCfg.extensions.autoDiscover,
          include: piCfg.extensions.include,
          exclude: piCfg.extensions.exclude,
          paths: piCfg.extensions.paths,
        },
      });
    } else {
      harness = new ClaudeSDKHarness({
        mcpServers: globalOptions.mcpServers,
        plugins: globalOptions.plugins,
        settingSources: globalOptions.settingSources ?? config.agents.settingSources as SettingSource[] | undefined,
        bare: config.agents.bare,
        disableSubagents: tierRecipe.claudeSdk?.disableSubagents ?? false,
      });
    }

    instances.set(key, harness);
    return harness;
  }

  const registry: AgentRuntimeRegistry = {
    forRole(role: AgentRole, planEntry?: PlanEntryForRegistry): AgentHarness {
      // Resolve role's tier using the same precedence as resolveAgentConfig:
      // plan-file override > per-role config override > built-in AGENT_ROLE_TIERS.
      const planTier = planEntry?.agents?.[role]?.tier as AgentTier | undefined;
      const userRoleTier = (config.agents.roles?.[role] as { tier?: AgentTier } | undefined)?.tier;
      const tier = planTier ?? userRoleTier ?? AGENT_ROLE_TIERS[role];
      const tierRecipe = tiers[tier];
      if (!tierRecipe) {
        throw new Error(
          `Role "${role}" resolves to tier "${tier}" but no tier recipe is configured. ` +
          `Add agents.tiers.${tier} to eforge/config.yaml.`,
        );
      }
      return instanceForTier(tierRecipe);
    },
  };

  return registry;
}
