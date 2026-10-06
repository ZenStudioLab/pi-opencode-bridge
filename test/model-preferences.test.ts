import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CatalogEntry } from "../src/catalog.ts";
import { modelEnabled, readModelPreferences, setProviderPreference, writeModelPreferences, type ModelPreferences } from "../src/model-preferences.ts";

function entry(provider: string, id: string, name = id): CatalogEntry {
  return { pair: { providerID: provider, modelID: id }, modelName: name, pricingReported: true,
    model: { id: `${encodeURIComponent(provider)}/${encodeURIComponent(id)}`, name: `${provider}: ${name}`,
      input: ["text"], reasoning: false, contextWindow: 16000, maxTokens: 2000,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } };
}

test("automatic matching uses raw model ID/name, with explicit full-pair choices taking precedence", () => {
  const preferences = { models: { "a/model-FREE": false, "b/paid": true, "a/unavailable": false } };
  for (const [model, enabled] of [
    [entry("a", "model-FREE"), false], [entry("b", "model-FREE"), true],
    [entry("a", "new", "New FrEe Model"), true], [entry("free-provider", "paid"), false],
    [entry("b", "paid"), true], [entry("a", "big-pickle"), false],
    [entry("a", "free/model"), true],
  ] as const) assert.equal(modelEnabled(model, preferences), enabled);
  assert.equal(preferences.models["a/unavailable"], false);
});

test("provider rules cover future models while individual exceptions win and bulk changes reset only that provider", () => {
  const preferences: ModelPreferences = { models: { "a%2Fb/old": false, "a%2Fb/unavailable": true, "a/old": true } };
  setProviderPreference(preferences, "a/b", true);
  assert.deepEqual(structuredClone(preferences), { models: { "a/old": true }, providers: { "a/b": true } });
  assert.equal(modelEnabled(entry("a/b", "future-paid"), preferences), true);
  preferences.models["a%2Fb/future-paid"] = false;
  assert.equal(modelEnabled(entry("a/b", "future-paid"), preferences), false);
  setProviderPreference(preferences, "a/b", false);
  assert.equal(modelEnabled(entry("a/b", "future-free"), preferences), false);
  preferences.models["a%2Fb/future-free"] = true;
  assert.equal(modelEnabled(entry("a/b", "future-free"), preferences), true);
  setProviderPreference(preferences, "a/b");
  assert.deepEqual(preferences, { models: { "a/old": true } });
  assert.equal(modelEnabled(entry("a/b", "future-free"), preferences), true);
  assert.equal(modelEnabled(entry("a/b", "future-paid"), preferences), false);
});

test("global preferences persist only explicit choices and failed writes/invalid reads do not erase them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-preferences-"));
  const path = join(root, "agent", "opencode-bridge.json");
  try {
    assert.deepEqual(await readModelPreferences(path), { models: {} });
    assert.deepEqual(await readdir(root), [], "discovery must not create preference files");
    // Existing models-only files remain valid; provider choices add an optional field.
    await writeModelPreferences({ models: { "legacy/free": false } }, path);
    assert.deepEqual(await readModelPreferences(path), { models: { "legacy/free": false } });
    const preferences = { models: { "a/auto-free": false, "b/paid": true, "c/unavailable": false }, providers: { a: true, b: false } };
    await writeModelPreferences(preferences, path);
    const restored = await readModelPreferences(path);
    assert.deepEqual(restored, preferences);
    assert.equal(modelEnabled(entry("a", "new-paid"), restored), true);
    assert.equal(modelEnabled(entry("b", "new-free"), restored), false);
    const before = await readFile(path, "utf8");
    await assert.rejects(writeModelPreferences({ models: {} }, join(path, "child.json")));
    assert.equal(await readFile(path, "utf8"), before);
    assert.deepEqual(await readdir(join(root, "agent")), ["opencode-bridge.json"]);
    for (const bad of ['{"secret":"do-not-log" broken}', '{"models":{"a/free":"false"}}', '{"models":[]}', '{"models":{},"providers":{"a":"false"}}']) {
      await writeFile(path, bad);
      await assert.rejects(readModelPreferences(path), (error: Error) => /Invalid global/.test(error.message) && !error.message.includes("do-not-log"));
      assert.equal(await readFile(path, "utf8"), bad);
    }
    await writeModelPreferences({ models: {} }, path);
    assert.equal(modelEnabled(entry("a", "auto-free"), await readModelPreferences(path)), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
