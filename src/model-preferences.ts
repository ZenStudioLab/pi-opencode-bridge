import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CatalogEntry } from "./catalog.ts";

/** Model choices override provider choices; otherwise new models receive automatic defaults. */
export interface ModelPreferences {
  models: Record<string, boolean>;
  providers?: Record<string, boolean>;
}

export function modelPreferencesPath(): string {
  return join(getAgentDir(), "opencode-bridge.json");
}

export function modelEnabled(entry: CatalogEntry, preferences: ModelPreferences): boolean {
  const saved = preferences.models[entry.model.id] ?? preferences.providers?.[entry.pair.providerID];
  return typeof saved === "boolean" ? saved : /free/i.test(entry.pair.modelID) || /free/i.test(entry.modelName);
}

/** A deliberate whole-provider action replaces its previous individual exceptions. */
export function setProviderPreference(preferences: ModelPreferences, providerID: string, enabled?: boolean): void {
  const prefix = `${encodeURIComponent(providerID)}/`;
  for (const id of Object.keys(preferences.models)) if (id.startsWith(prefix)) delete preferences.models[id];
  if (enabled === undefined) {
    if (preferences.providers) delete preferences.providers[providerID];
  } else {
    preferences.providers = { ...preferences.providers, [providerID]: enabled };
  }
  if (preferences.providers && !Object.keys(preferences.providers).length) delete preferences.providers;
}

export async function readModelPreferences(path = modelPreferencesPath()): Promise<ModelPreferences> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { models: {} };
    throw new Error("Cannot read global OpenCode bridge model preferences.");
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value) || !("models" in value)) throw new Error();
    const models = value.models;
    if (!models || typeof models !== "object" || Array.isArray(models) || Object.values(models).some(v => typeof v !== "boolean")) throw new Error();
    const providers = "providers" in value ? value.providers : undefined;
    if (providers !== undefined && (!providers || typeof providers !== "object" || Array.isArray(providers) || Object.values(providers).some(v => typeof v !== "boolean"))) throw new Error();
    return { models: { ...models } as Record<string, boolean>,
      ...(providers === undefined ? {} : { providers: { ...providers } as Record<string, boolean> }) };
  } catch {
    throw new Error("Invalid global OpenCode bridge model preferences; correct opencode-bridge.json before refreshing.");
  }
}

/** Replace the small extension-owned file without leaving a partially written JSON document. */
export async function writeModelPreferences(preferences: ModelPreferences, path = modelPreferencesPath()): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, JSON.stringify(preferences, null, 2) + "\n", { flag: "wx" });
    await rename(temporary, path);
  } catch {
    throw new Error("Cannot save global OpenCode bridge model preferences; previous settings were preserved.");
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}
