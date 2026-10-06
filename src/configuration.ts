import type { Config } from "@opencode-ai/sdk";

export const BRIDGE_AGENT = "pi-opencode-bridge";

export interface ControlledProviderOptions {
  id: string;
  name: string;
  model: string;
  baseURL: string;
  api?: string;
}

export interface EffectiveConfigurationObservation {
  agents: string[];
  commands: string[];
  compaction: { auto?: boolean; prune?: boolean };
  enabledProviders: string[];
  instructions: string[];
  mcpServers: string[];
  plugins: string[];
  providerIds: string[];
}

export function createSelectiveConfiguration(options?: ControlledProviderOptions, inherited: Config = {}): Config {
  const config: Config = {
    provider: inherited.provider,
    enabled_providers: inherited.enabled_providers,
    disabled_providers: inherited.disabled_providers,
    logLevel: "ERROR",
    autoupdate: false,
    plugin: [],
    command: {},
    instructions: [],
    mcp: {},
    agent: {
      [BRIDGE_AGENT]: {
        mode: "primary",
        prompt: "Use only the supplied Pi instructions and tools.",
        tools: { "*": false },
        permission: { edit: "deny", bash: "deny", webfetch: "deny", external_directory: "deny" },
      },
    },
  };

  if (options) {
    config.enabled_providers = [options.id];
    config.model = `${options.id}/${options.model}`;
    config.small_model = `${options.id}/${options.model}`;
    config.provider = {
      [options.id]: {
        api: options.api ?? "openai",
        name: options.name,
        options: {
          baseURL: options.baseURL,
        },
        models: {
          [options.model]: {
            id: options.model,
            name: options.name,
            attachment: false,
            reasoning: false,
            tool_call: false,
            cost: { input: 0, output: 0 },
            limit: { context: 16_000, output: 2_000 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    };
  }

  return config;
}

export function observeEffectiveConfiguration(config: unknown): EffectiveConfigurationObservation {
  const record = asRecord(config);
  const compaction = asRecord(record.compaction);
  return {
    agents: keys(record.agent),
    commands: keys(record.command),
    compaction: {
      auto: booleanOrUndefined(compaction.auto),
      prune: booleanOrUndefined(compaction.prune),
    },
    enabledProviders: stringArray(record.enabled_providers),
    instructions: stringArray(record.instructions),
    mcpServers: keys(record.mcp),
    plugins: stringArray(record.plugin),
    providerIds: keys(record.provider),
  };
}

export function assertSelectiveConfiguration(
  observation: EffectiveConfigurationObservation,
  providerId?: string,
): void {
  const unexpectedProviders = providerId
    ? observation.enabledProviders.filter((id) => id !== providerId)
    : [];
  if (unexpectedProviders.length > 0) {
    throw new Error(`bridge runtime enabled unrelated providers: ${unexpectedProviders.join(", ")}`);
  }
  if (observation.agents.some((agent) => agent !== BRIDGE_AGENT)) {
    throw new Error("bridge runtime loaded unrelated agent configuration");
  }
  if (observation.plugins.length > 0) {
    throw new Error(`bridge runtime loaded plugins: ${observation.plugins.join(", ")}`);
  }
  if (observation.commands.length > 0) {
    throw new Error(`bridge runtime loaded commands: ${observation.commands.join(", ")}`);
  }
  if (observation.mcpServers.length > 0) {
    throw new Error(`bridge runtime loaded MCP servers: ${observation.mcpServers.join(", ")}`);
  }
  if (observation.instructions.length > 0) {
    throw new Error(`bridge runtime loaded instructions: ${observation.instructions.join(", ")}`);
  }
  if (observation.compaction.auto !== false || observation.compaction.prune !== false) {
    throw new Error("bridge runtime did not disable automatic compaction and pruning");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function keys(value: unknown): string[] {
  return Object.keys(asRecord(value)).sort();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
