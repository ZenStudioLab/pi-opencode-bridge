import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { assertSelectiveConfiguration, createSelectiveConfiguration, observeEffectiveConfiguration } from "./configuration.js";
import { loadProviderConfiguration } from "./provider-configuration.js";
import { createProviderSeam } from "./provider-seam.js";
import { startOwnedRuntime } from "./runtime.js";

export default function registerPiOpenCodeBridge(pi: ExtensionAPI): void {
  let inherited: Awaited<ReturnType<typeof loadProviderConfiguration>> | undefined;
  let seam: Awaited<ReturnType<typeof createProviderSeam>> | undefined;
  let seamKey = "";
  let opening: Promise<void> | undefined;
  let disposed = false;
  const pairs = new Map<string, { providerID: string; modelID: string }>();

  pi.registerProvider("opencode-bridge", { name: "OpenCode Bridge", models: [] });
  pi.on("session_start", async (_event, ctx) => {
    if (inherited) return;
    disposed = false;
    try {
      inherited = await loadProviderConfiguration(ctx.cwd);
      if (inherited.unavailableAuthProviders.length) ctx.ui.notify(`OpenCode bridge cannot retain unqualified OAuth/remote authentication for: ${inherited.unavailableAuthProviders.join(", ")}`, "warning");
      if (inherited.excludedPluginCount) ctx.ui.notify("OpenCode bridge excludes configured plugins; integrations requiring them are not qualified.", "warning");
      // Discovery has no tools/inference. Its owned runtime closes before the inference runtime starts.
      const discovery = await startOwnedRuntime({ config: createSelectiveConfiguration(undefined, inherited.config), authentication: inherited.authentication });
      const models: ProviderModelConfig[] = [];
      try {
        const effective = await discovery.client.config.get({ throwOnError: true, signal: AbortSignal.timeout(10_000) });
        assertSelectiveConfiguration(observeEffectiveConfiguration(effective.data));
        const catalog = await discovery.client.provider.list({ throwOnError: true, signal: AbortSignal.timeout(10_000) });
        for (const provider of catalog.data.all) {
          if (!catalog.data.connected.includes(provider.id)) continue;
          for (const model of Object.values(provider.models)) {
            if (!model.tool_call || !model.modalities?.input.includes("text") || !model.modalities.output.includes("text")) continue;
            const id = `${encodeURIComponent(provider.id)}/${encodeURIComponent(model.id)}`;
            pairs.set(id, { providerID: provider.id, modelID: model.id });
            models.push({ id, name: `${provider.name}: ${model.name}`, input: ["text"], reasoning: false,
              contextWindow: model.limit.context, maxTokens: model.limit.output,
              cost: { input: model.cost?.input ?? 0, output: model.cost?.output ?? 0, cacheRead: model.cost?.cache_read ?? 0, cacheWrite: model.cost?.cache_write ?? 0 } });
          }
        }
      } finally { await discovery.close(); }
      pi.registerProvider("opencode-bridge", {
        name: "OpenCode Bridge", api: "opencode-bridge", baseUrl: "http://127.0.0.1", apiKey: "managed-by-opencode", models,
        streamSimple(model, context, options) {
          const output = createAssistantMessageEventStream();
          void (async () => {
            try {
              const pair = pairs.get(model.id);
              if (disposed || !pair || !inherited) throw new Error("OpenCode bridge model unavailable");
              const tools = getCurrentTools(context.messages);
              const key = JSON.stringify([pair, tools]);
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
      if (!models.length) ctx.ui.notify("OpenCode bridge found no connected text/tool models.", "warning");
    } catch {
      inherited = undefined;
      ctx.ui.notify("OpenCode bridge unavailable: provider configuration or runtime initialization failed.", "error");
    }
  });
  pi.on("session_shutdown", async () => {
    disposed = true;
    await opening?.catch(() => undefined);
    await seam?.close();
    seam = undefined;
    inherited = undefined;
    pairs.clear();
  });
}
