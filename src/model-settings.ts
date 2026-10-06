import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CatalogEntry } from "./catalog.ts";
import { modelEnabled, type ModelPreferences } from "./model-preferences.ts";

function pricingLabel(entry: CatalogEntry): string {
  if (!entry.pricingReported) return "pricing unavailable";
  const c = entry.model.cost;
  return `$${c.input}/$${c.output} in/out; $${c.cacheRead}/$${c.cacheWrite} cache read/write per 1M`;
}

/** Native dialogs keep keyboard navigation, filtering and RPC support owned by Pi. */
export async function showModelSettings(
  ctx: ExtensionContext, catalog: Map<string, CatalogEntry>, preferences: ModelPreferences,
): Promise<ModelPreferences | undefined> {
  const draft = structuredClone(preferences);
  const providers = [...new Set([...catalog.values()].map(entry => entry.pair.providerID))].sort();
  for (;;) {
    const providerRows = providers.map(id => `Provider: ${id}`);
    const choice = await ctx.ui.select("OpenCode models — global settings (name contains 'free' = default on)",
      ["Save changes", "Cancel", "Reset to automatic defaults", ...providerRows]);
    if (choice === undefined || choice === "Cancel") return undefined;
    if (choice === "Save changes") return draft;
    if (choice === "Reset to automatic defaults") { draft.models = {}; continue; }
    const provider = providers[providerRows.indexOf(choice)];
    if (provider === undefined) continue;
    const entries = [...catalog.values()].filter(entry => entry.pair.providerID === provider)
      .sort((a, b) => a.modelName.localeCompare(b.modelName) || a.model.id.localeCompare(b.model.id));
    for (;;) {
      const rows = entries.map(entry => `[${modelEnabled(entry, draft) ? "x" : " "}] ${entry.modelName} (${entry.pair.modelID}) — ${pricingLabel(entry)}`);
      const selected = await ctx.ui.select(`${provider} — Enter toggles; changes apply only on Save`, ["Back", ...rows]);
      if (selected === undefined || selected === "Back") break;
      const entry = entries[rows.indexOf(selected)];
      if (!entry) continue;
      const enabled = !modelEnabled(entry, draft);
      if (enabled && (!entry.pricingReported || Object.values(entry.model.cost).some(cost => cost > 0))) {
        if (!await ctx.ui.confirm("Enable model with paid or unknown pricing?",
          `${entry.pair.providerID}/${entry.pair.modelID}: ${pricingLabel(entry)}. Enabling does not send a prompt, but using it may incur charges.`)) continue;
      }
      draft.models[entry.model.id] = enabled;
    }
  }
}
