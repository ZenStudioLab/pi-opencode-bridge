import type { ProviderListResponse } from "@opencode-ai/sdk/v2";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export interface CatalogEntry {
  pair: { providerID: string; modelID: string };
  model: Extract<ProviderModelConfig, { maxTokens: number }>;
  pricingReported: boolean;
  modelName: string;
}

/** Project only public model metadata; provider options/credentials never leave discovery. */
export function mapCatalog(catalog: ProviderListResponse): Map<string, CatalogEntry> {
  const entries = new Map<string, CatalogEntry>();
  for (const provider of catalog.all) {
    if (!catalog.connected.includes(provider.id)) continue;
    for (const model of Object.values(provider.models)) {
      if (!model.capabilities.toolcall || !model.capabilities.input.text || !model.capabilities.output.text) continue;
      const id = `${encodeURIComponent(provider.id)}/${encodeURIComponent(model.id)}`;
      entries.set(id, {
        pair: { providerID: provider.id, modelID: model.id },
        pricingReported: model.cost !== undefined,
        modelName: model.name,
        model: {
          id, name: `${provider.name}: ${model.name}${model.cost ? "" : " (pricing unavailable)"}`,
          input: model.capabilities.attachment && model.capabilities.input.image ? ["text", "image"] : ["text"],
          reasoning: model.capabilities.reasoning,
          contextWindow: model.limit.context, maxTokens: model.limit.output,
          // Pi requires numeric pricing. Unknown values are placeholders, explicitly
          // labelled above rather than presented as a verified free model.
          cost: { input: model.cost?.input ?? 0, output: model.cost?.output ?? 0,
            cacheRead: model.cost?.cache?.read ?? 0, cacheWrite: model.cost?.cache?.write ?? 0 },
        },
      });
    }
  }
  return entries;
}
