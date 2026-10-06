import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { fetchRuntime } from "./runtime-http.ts";
import { mapCatalog, type CatalogEntry } from "./catalog.ts";
import { createAssistantMessageEventStream, getCurrentTools, getCurrentSystemPrompt, type AssistantMessage } from "@earendil-works/pi-ai";
import { assertSelectiveConfiguration, createSelectiveConfiguration, observeEffectiveConfiguration } from "./configuration.ts";
import { loadProviderConfiguration } from "./provider-configuration.ts";
import { createProviderSeam } from "./provider-seam.ts";
import { startOwnedRuntime } from "./runtime.ts";

export default function registerPiOpenCodeBridge(pi: ExtensionAPI): void {
  let inherited: Awaited<ReturnType<typeof loadProviderConfiguration>> | undefined;
  let seam: Awaited<ReturnType<typeof createProviderSeam>> | undefined;
  let seamKey = "";
  let opening: Promise<void> | undefined;
  let disposed = false;
  let refreshing: Promise<void> | undefined;
  let catalog = new Map<string, CatalogEntry>();

  pi.registerProvider("opencode-bridge", { name: "OpenCode Bridge", models: [] });
  const discover = async (ctx: ExtensionContext): Promise<void> => {
    let stage = "provider configuration";
    try {
      const nextInherited = await loadProviderConfiguration(ctx.cwd);
      if (nextInherited.unavailableAuthProviders.length) ctx.ui.notify(`OpenCode bridge cannot retain unqualified OAuth/remote authentication for: ${nextInherited.unavailableAuthProviders.join(", ")}`, "warning");
      if (nextInherited.excludedPluginCount) ctx.ui.notify("OpenCode bridge excludes configured plugins; integrations requiring them are not qualified.", "warning");
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
      if (disposed) return;
      if (inherited && JSON.stringify(inherited) !== JSON.stringify(nextInherited)) await invalidate();
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
            } catch {
              const error: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
                timestamp: Date.now(), content: [], stopReason: options?.signal?.aborted ? "aborted" : "error",
                errorMessage: "OpenCode bridge could not start the selected model; configuration and selection were preserved",
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
              output.push({ type: "error", reason: error.stopReason === "aborted" ? "aborted" : "error", error });
            } finally { output.end(); }
          })();
          return output;
        },
      });
      catalog = nextCatalog;
      inherited = nextInherited;
      if (!catalog.size) ctx.ui.notify("OpenCode bridge found no connected text/tool models.", "warning");
    } catch (error) {
      const cause = error instanceof Error && error.message.includes("cannot launch executable (ENOENT)")
        ? "OpenCode executable is missing from PATH" : `OpenCode bridge ${stage} failed`;
      ctx.ui.notify(`${cause}; ${inherited ? "the last valid catalog and selection were preserved" : "no models were registered"}.`, "error");
    }
  };
  const refresh = (ctx: ExtensionContext): Promise<void> => {
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
    handler: async (_args, ctx) => { await refresh(ctx); },
  });
  pi.on("session_shutdown", async () => {
    disposed = true;
    await refreshing;
    await opening?.catch(() => undefined);
    await seam?.close();
    seam = undefined;
    inherited = undefined;
    catalog.clear();
  });
}
