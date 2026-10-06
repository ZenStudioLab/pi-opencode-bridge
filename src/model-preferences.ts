import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CatalogEntry } from "./catalog.ts";

/** Explicit choices only: newly discovered models still receive automatic defaults. */
export interface ModelPreferences {
  models: Record<string, boolean>;
}

export function modelPreferencesPath(): string {
  return join(getAgentDir(), "opencode-bridge.json");
}

export function modelEnabled(entry: CatalogEntry, preferences: ModelPreferences): boolean {
  const saved = preferences.models[entry.model.id];
  return typeof saved === "boolean" ? saved : /free/i.test(entry.pair.modelID) || /free/i.test(entry.modelName);
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
    return { models: { ...models } as Record<string, boolean> };
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
