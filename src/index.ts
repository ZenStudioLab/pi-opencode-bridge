import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { fetchRuntime } from "./runtime-http.ts";
import { mapCatalog, type CatalogEntry } from "./catalog.ts";
import { createAssistantMessageEventStream, getCurrentTools, getCurrentSystemPrompt, type AssistantMessage } from "@earendil-works/pi-ai";
import { assertSelectiveConfiguration, createSelectiveConfiguration, observeEffectiveConfiguration } from "./configuration.ts";
import { loadProviderConfiguration } from "./provider-configuration.ts";
import { createProviderSeam } from "./provider-seam.ts";
import { startOwnedRuntime } from "./runtime.ts";
import { modelEnabled, readModelPreferences, writeModelPreferences, type ModelPreferences } from "./model-preferences.ts";
import { showModelSettings } from "./model-settings.ts";
import { renderFailure } from "./failure.ts";

export default function registerPiOpenCodeBridge(pi: ExtensionAPI): void {
  let inherited: Awaited<ReturnType<typeof loadProviderConfiguration>> | undefined;
  let seam: Awaited<ReturnType<typeof createProviderSeam>> | undefined;
  let seamKey = "";
  let opening: Promise<void> | undefined;
  let disposed = false;
  let refreshing: Promise<boolean> | undefined;
  let catalog = new Map<string, CatalogEntry>();
  let availableCatalog = new Map<string, CatalogEntry>();
  let preferences: ModelPreferences = { models: {} };
  let settingsOpen = false;

  pi.registerProvider("opencode-bridge", { name: "OpenCode Bridge", models: [] });
  const publish = (available: Map<string, CatalogEntry>, nextPreferences: ModelPreferences): void => {
      const nextCatalog = new Map([...available].filter(([, entry]) => modelEnabled(entry, nextPreferences)));
      pi.registerProvider("opencode-bridge", {
        name: "OpenCode Bridge", api: "opencode-bridge", baseUrl: "http://127.0.0.1", apiKey: "managed-by-opencode",
        models: [...nextCatalog.values()].map((entry) => entry.model),
        streamSimple(model, context, options) {
          const output = createAssistantMessageEventStream();
          void (async () => {
            try {
              const pair = catalog.get(model.id)?.pair;
              if (disposed || !pair || !inherited) throw new Error("OpenCode bridge model unavailable");
              const tools = getCurrentTools(context.messages);
              const key = JSON.stringify([pair, tools, getCurrentSystemPrompt(context.messages)]);
              if (opening) await opening;
              if (!seam || seamKey !== key) {
                opening = (async () => {
                  await seam?.close();
                  seam = undefined;
                  const candidate = await createProviderSeam({
                    config: createSelectiveConfiguration(undefined, inherited!.config), authentication: inherited!.authentication,
                    tools, ...pair,
                  });
                  if (disposed) { await candidate.close(); throw new Error("OpenCode bridge unloaded"); }
                  seam = candidate;
                  seamKey = key;
                })();
                try { await opening; } finally { opening = undefined; }
              }
              for await (const event of seam!.streamSimple(model, context, options)) output.push(event);
            } catch (cause) {
              const error: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
                timestamp: Date.now(), content: [], stopReason: options?.signal?.aborted ? "aborted" : "error",
                errorMessage: options?.signal?.aborted ? "Pi request aborted" : renderFailure(cause, { operation: "request startup", model: model.id }),
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
              output.push({ type: "error", reason: error.stopReason === "aborted" ? "aborted" : "error", error });
            } finally { output.end(); }
          })();
          return output;
        },
      });
      catalog = nextCatalog;
      availableCatalog = available;
      preferences = nextPreferences;
  };
  const discover = async (ctx: ExtensionContext): Promise<boolean> => {
    let stage = "global model preferences";
    try {
      const nextPreferences = await readModelPreferences();
      stage = "provider configuration";
      const nextInherited = await loadProviderConfiguration(ctx.cwd);
      if (nextInherited.unavailableAuthProviders.length) ctx.ui.notify(`OpenCode bridge cannot retain unqualified OAuth/remote authentication for: ${nextInherited.unavailableAuthProviders.join(", ")}`, "warning");
      // Discovery has no tools/inference. Its owned runtime closes before the inference runtime starts.
      stage = "owned runtime startup";
      const discovery = await startOwnedRuntime({ config: createSelectiveConfiguration(undefined, nextInherited.config), authentication: nextInherited.authentication });
      stage = "catalog discovery";
      let nextCatalog: Map<string, CatalogEntry>;
      try {
        const effective = await discovery.client.config.get({ throwOnError: true, signal: AbortSignal.timeout(10_000) });
        assertSelectiveConfiguration(observeEffectiveConfiguration(effective.data));
        const client = createOpencodeClient({ baseUrl: discovery.url, fetch: fetchRuntime });
        const response = await client.provider.list({}, { throwOnError: true, signal: AbortSignal.timeout(10_000) });
        nextCatalog = mapCatalog(response.data);
      } finally { await discovery.close(); }
      if (disposed) return false;
      if (inherited && (JSON.stringify(inherited) !== JSON.stringify(nextInherited) || JSON.stringify(preferences) !== JSON.stringify(nextPreferences))) await invalidate();
      publish(nextCatalog, nextPreferences);
      inherited = nextInherited;
      if (!catalog.size) ctx.ui.notify("OpenCode bridge has no enabled models; use opencode-settings to choose from connected text/tool models.", "warning");
      return true;
    } catch (error) {
      const cause = error instanceof Error && error.message.includes("cannot launch executable (ENOENT)")
        ? "OpenCode executable is missing from PATH" : `OpenCode bridge ${stage} failed`;
      ctx.ui.notify(`${cause}; ${inherited ? "the last valid catalog and selection were preserved" : "no models were registered"}.`, "error");
      return false;
    }
  };
  const refresh = (ctx: ExtensionContext): Promise<boolean> => {
    if (!refreshing) refreshing = discover(ctx).finally(() => { refreshing = undefined; });
    return refreshing;
  };
  const invalidate = async (): Promise<void> => {
    await opening?.catch(() => undefined);
    const previous = seam;
    seam = undefined;
    seamKey = "";
    await previous?.close();
  };
  pi.on("session_tree", invalidate);
  pi.on("session_compact", invalidate);
  pi.on("model_select", invalidate);
  pi.on("session_start", async (_event, ctx) => {
    await invalidate();
    disposed = false;
    if (!inherited) await refresh(ctx);
  });
  pi.registerCommand("opencode-refresh", {
    description: "Refresh the OpenCode bridge model catalog without changing selection",
    handler: async (_args, ctx) => { await ctx.waitForIdle(); await refresh(ctx); },
  });
  pi.registerCommand("opencode-settings", {
    description: "Choose OpenCode models globally; names containing free are enabled by default",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) { ctx.ui.notify("OpenCode model settings require an interactive UI.", "warning"); return; }
      if (settingsOpen) return;
      settingsOpen = true;
      try {
        await ctx.waitForIdle();
        if (!await refresh(ctx)) return;
        const nextPreferences = await showModelSettings(ctx, availableCatalog, preferences);
        if (!nextPreferences || disposed) return;
        await ctx.waitForIdle();
        await invalidate();
        await writeModelPreferences(nextPreferences);
        if (disposed) return;
        publish(availableCatalog, nextPreferences);
        ctx.ui.notify(`OpenCode model preferences saved globally (${catalog.size} enabled). Other sessions pick them up on refresh.`, "info");
        if (ctx.model?.provider === "opencode-bridge" && !catalog.has(ctx.model.id)) {
          ctx.ui.notify("The selected model is now hidden; choose an enabled model before sending another prompt.", "warning");
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error && error.message.startsWith("Cannot save global OpenCode")
          ? error.message : "OpenCode model settings failed; the last valid catalog was preserved.", "error");
      } finally { settingsOpen = false; }
    },
  });
  pi.on("session_shutdown", async () => {
    disposed = true;
    await refreshing;
    await opening?.catch(() => undefined);
    await seam?.close();
    seam = undefined;
    inherited = undefined;
    catalog.clear();
    availableCatalog.clear();
  });
}
