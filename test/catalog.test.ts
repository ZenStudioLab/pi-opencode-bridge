import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model, ProviderListResponse } from "@opencode-ai/sdk/v2";
import { mapCatalog } from "../src/catalog.ts";

test("catalog preserves full identities and limits while excluding ineligible models and sensitive fields", () => {
  const modalities = { text: true, image: false, audio: false, video: false, pdf: false };
  const model: Model = {
    id: "shared/model", providerID: "a", api: { id: "shared/model", npm: "fixture", url: "http://127.0.0.1" }, name: "Shared", release_date: "2026-01-01", status: "active", headers: {},
    capabilities: { attachment: false, reasoning: false, temperature: true, toolcall: true, input: modalities, output: modalities, interleaved: false },
    limit: { context: 32000, output: 4000 }, options: { apiKey: "secret-sentinel" },
    cost: { input: 2, output: 8, cache: { read: 1, write: 3 } },
  };
  const provider = (id: string): ProviderListResponse["all"][number] => ({ id, name: id, env: ["SECRET_ENV"], source: "custom", options: {}, models: {
    shared: model, noTools: { ...model, id: "no-tools", capabilities: { ...model.capabilities, toolcall: false } },
    noText: { ...model, id: "no-text", capabilities: { ...model.capabilities, input: { ...modalities, text: false } } },
  } });
  const catalog = mapCatalog({ all: [provider("a/b"), provider("a"), provider("disconnected")], connected: ["a/b", "a"], default: {} });
  assert.equal(catalog.size, 2);
  const first = catalog.get("a%2Fb/shared%2Fmodel")!;
  assert.deepEqual(first.pair, { providerID: "a/b", modelID: "shared/model" });
  assert.deepEqual(catalog.get("a/shared%2Fmodel")!.pair, { providerID: "a", modelID: "shared/model" });
  assert.equal(first.model.contextWindow, 32000);
  assert.equal(first.model.maxTokens, 4000);
  assert.deepEqual(first.model.cost, { input: 2, output: 8, cacheRead: 1, cacheWrite: 3 });
  assert.doesNotMatch(JSON.stringify([...catalog]), /secret-sentinel|SECRET_ENV|apiKey/);
});
