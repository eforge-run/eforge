/**
 * AgentRuntimeRegistry — maps agent roles to harness instances.
 *
 * Supports multiple named harness configurations with lazy instance creation.
 * Pi module is imported lazily: only when the config declares at least one Pi
 * runtime entry. Instances are memoized by entry name.
 */

import type { AgentRole } from './events.js';
import type { EforgeConfig, AgentRuntimeEntry, PiConfig } from './config.js';
import type { AgentHarness, AgentRunOptions } from './harness.js';
import type { ClaudeSDKHarnessOptions } from './harnesses/claude-sdk.js';
import type { SdkPluginConfig, SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSDKHarness } from './harnesses/claude-sdk.js';
import { resolveAgentRuntimeForRole } from './pipeline/agent-config.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Registry that maps agent roles (and named entries) to harness instances.
 * All methods are synchronous — async work (Pi import) is done in the factory.
 */
export interface AgentRuntimeRegistry {
  /** Resolve the harness for an agent role. */
  forRole(role: AgentRole): AgentHarness;
  /** Look up a harness instance by agentRuntime entry name. */
  byName(name: string): AgentHarness;
  /** Get the agentRuntime entry name for a role. */
  nameForRole(role: AgentRole): string;
  /** List all configured entry names. */
  configured(): string[];
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
 * Create a registry where every role (and every name) resolves to the same
 * harness instance. Used by test code to wrap a single StubHarness so all
 * agent roles dispatch to it.
 */
export function singletonRegistry(harness: AgentHarness): AgentRuntimeRegistry {
  return {
    forRole(_role: AgentRole): AgentHarness { return harness; },
    byName(_name: string): AgentHarness { return harness; },
    nameForRole(_role: AgentRole): string { return 'singleton'; },
    configured(): string[] { return ['singleton']; },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a harness instance so every `run()` call automatically receives the
 * runtime name (from the `agentRuntimes` map key) in `options.agentRuntimeName`.
 * This lets harnesses emit `agentRuntime: name` in `agent:start` events without
 * requiring every agent function to be aware of the runtime name.
 */
function wrapWithRuntimeName(harness: AgentHarness, runtimeName: string): AgentHarness {
  return {
    effectiveCustomToolName(name: string) { return harness.effectiveCustomToolName(name); },
    async *run(options: AgentRunOptions, agent: AgentRole, planId?: string) {
      yield* harness.run({ ...options, agentRuntimeName: runtimeName }, agent, planId);
    },
  };
}

/**
 * Merge an optional per-entry Pi config with the global Pi defaults to produce
 * a fully resolved PiConfig.
 */
function mergepiConfig(global: PiConfig, override?: AgentRuntimeEntry['pi']): PiConfig {
  if (!override) return global;
  return {
    apiKey: override.apiKey ?? global.apiKey,
    thinkingLevel: override.thinkingLevel ?? global.thinkingLevel,
    extensions: {
      autoDiscover: override.extensions?.autoDiscover ?? global.extensions.autoDiscover,
      include: override.extensions?.include ?? global.extensions.include,
      exclude: override.extensions?.exclude ?? global.extensions.exclude,
      paths: override.extensions?.paths ?? global.extensions.paths,
    },
    compaction: {
      enabled: override.compaction?.enabled ?? global.compaction.enabled,
      threshold: override.compaction?.threshold ?? global.compaction.threshold,
    },
    retry: {
      maxRetries: override.retry?.maxRetries ?? global.retry.maxRetries,
      backoffMs: override.retry?.backoffMs ?? global.retry.backoffMs,
    },
  };
}

// ---------------------------------------------------------------------------
// buildAgentRuntimeRegistry — async factory
// ---------------------------------------------------------------------------

/**
 * Build an `AgentRuntimeRegistry` from config.
 *
 * Lazily imports `./backends/pi.js` the first time a `pi` entry is needed
 * (i.e. only when the config declares at least one Pi runtime). Instances are
 * memoized by entry name so two roles pointing at the same name share one instance.
 *
 * @param config - Fully resolved EforgeConfig.
 * @param globalOptions - Infrastructure options forwarded from EforgeEngine.create().
 */
export async function buildAgentRuntimeRegistry(
  config: EforgeConfig,
  globalOptions: RegistryGlobalOptions = {},
): Promise<AgentRuntimeRegistry> {
  if (!config.agentRuntimes || Object.keys(config.agentRuntimes).length === 0) {
    throw new Error(
      'buildAgentRuntimeRegistry: "agentRuntimes" is not declared or is empty in config. ' +
      'Add "agentRuntimes" and "defaultAgentRuntime" to eforge/config.yaml or the active profile.',
    );
  }
  const entries = config.agentRuntimes;

  // Lazily import Pi module only when at least one Pi entry is configured.
  let PiHarnessCtor: (typeof import('./harnesses/pi.js'))['PiHarness'] | undefined;
  const hasPi = Object.values(entries).some((e) => e.harness === 'pi');
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

  // Memoized instances keyed by entry name.
  const instances = new Map<string, AgentHarness>();

  function createInstance(name: string): AgentHarness {
    const entry = entries[name];
    if (!entry) {
      throw new Error(
        `Unknown agentRuntime name: "${name}". Configured: ${Object.keys(entries).join(', ')}.`,
      );
    }

    let harness: AgentHarness;

    if (entry.harness === 'pi') {
      if (!PiHarnessCtor) throw new Error('Internal: Pi module not loaded despite pi entry');
      const piCfg = mergepiConfig(config.pi, entry.pi);
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
      // claude-sdk entry
      harness = new ClaudeSDKHarness({
        mcpServers: globalOptions.mcpServers,
        plugins: globalOptions.plugins,
        settingSources: globalOptions.settingSources ?? config.agents.settingSources as SettingSource[] | undefined,
        bare: config.agents.bare,
        disableSubagents: entry.claudeSdk?.disableSubagents ?? config.claudeSdk.disableSubagents,
      });
    }

    // Wrap so every run() call receives agentRuntimeName for agent:start events.
    return wrapWithRuntimeName(harness, name);
  }

  const registry: AgentRuntimeRegistry = {
    forRole(role: AgentRole): AgentHarness {
      const { agentRuntimeName } = resolveAgentRuntimeForRole(role, config);
      return registry.byName(agentRuntimeName);
    },

    byName(name: string): AgentHarness {
      if (!instances.has(name)) {
        instances.set(name, createInstance(name));
      }
      return instances.get(name)!;
    },

    nameForRole(role: AgentRole): string {
      return resolveAgentRuntimeForRole(role, config).agentRuntimeName;
    },

    configured(): string[] {
      return Object.keys(entries);
    },
  };

  return registry;
}
