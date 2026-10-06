import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CatalogEntry } from "../src/catalog.ts";
import { showModelSettings } from "../src/model-settings.ts";

const catalog = new Map<string, CatalogEntry>(["a", "b"].map(provider => {
  const id = `${provider}/shared`;
  return [id, { pair: { providerID: provider, modelID: "shared" }, modelName: provider === "a" ? "Free model" : "Paid model",
    pricingReported: true, model: { id, name: id, input: ["text"], reasoning: false, contextWindow: 16000, maxTokens: 2000,
      cost: { input: provider === "b" ? 1 : 0, output: 2, cacheRead: 0, cacheWrite: 0 } } }];
}));

test("settings toggle models across providers, show prices and confirm paid enable before explicit Save", async () => {
  const steps = ["Provider: a", "[x] Free model", "Back", "Provider: b", "[ ] Paid model", "[ ] Paid model", "Back", "Save changes"];
  const confirmations = [false, true];
  const initial = { models: { "missing/free": false } };
  const ctx = { ui: {
    async select(_title: string, rows: string[]) {
      const step = steps.shift();
      assert.ok(step);
      const row = rows.find(value => value.startsWith(step));
      assert.ok(row, `${step} not found`);
      if (step.includes("Paid model")) assert.match(row, /\$1\/\$2 in\/out/);
      return row;
    },
    async confirm(_title: string, message: string) {
      assert.match(message, /may incur charges/);
      assert.match(message, /b\/shared/);
      return confirmations.shift()!;
    },
  } } as unknown as ExtensionContext;
  const result = await showModelSettings(ctx, catalog, initial);
  assert.deepEqual(result, { models: { "missing/free": false, "a/shared": false, "b/shared": true } });
  assert.deepEqual(initial, { models: { "missing/free": false } });
  assert.equal(steps.length, 0);
  assert.equal(confirmations.length, 0);
});

test("whole-provider enabling requires confirmation and individual exceptions can follow", async () => {
  const steps = ["Provider: a", "Enable whole provider", "Enable whole provider", "[x] Free model", "Back", "Save changes"];
  const confirmations = [false, true];
  const initial = { models: { "a/shared": false, "b/shared": true } };
  const ctx = { ui: {
    async select(_title: string, rows: string[]) {
      const step = steps.shift();
      assert.ok(step);
      const row = rows.find(value => value.startsWith(step));
      assert.ok(row);
      if (step === "Enable whole provider") assert.ok(rows.some(value => value.startsWith("[ ] Free model")));
      return row;
    },
    async confirm(_title: string, message: string) {
      assert.match(message, /current and future eligible models/);
      assert.match(message, /resets its individual choices/);
      assert.match(message, /paid or unknown-price/);
      return confirmations.shift()!;
    },
  } } as unknown as ExtensionContext;
  assert.deepEqual(await showModelSettings(ctx, catalog, initial),
    { models: { "a/shared": false, "b/shared": true }, providers: { a: true } });
  assert.equal(steps.length, 0);
  assert.equal(confirmations.length, 0);
  assert.deepEqual(initial, { models: { "a/shared": false, "b/shared": true } });
});

test("provider disable and reset replace only that provider's choices", async () => {
  for (const action of ["Disable whole provider", "Reset provider to automatic"]) {
    const steps = ["Provider: a", action, "Back", "Save changes"];
    const initial = { models: { "a/shared": true, "a/missing": false, "b/shared": true }, providers: { a: true } };
    const ctx = { ui: { select: async () => steps.shift() } } as unknown as ExtensionContext;
    assert.deepEqual(await showModelSettings(ctx, catalog, initial), {
      models: { "b/shared": true }, ...(action.startsWith("Disable") ? { providers: { a: false } } : {}),
    });
    assert.equal(initial.models["a/missing"], false);
  }
});

test("settings cancel discards drafts and reset restores automatic rules only on Save", async () => {
  for (const finish of ["Cancel", undefined, "Save changes"]) {
    const steps = ["Reset to automatic defaults", finish];
    const initial = { models: { "a/shared": false, "b/shared": true }, providers: { a: false } };
    const ctx = { ui: { select: async () => steps.shift() } } as unknown as ExtensionContext;
    assert.deepEqual(await showModelSettings(ctx, catalog, initial), finish === "Save changes" ? { models: {} } : undefined);
    assert.deepEqual(initial, { models: { "a/shared": false, "b/shared": true }, providers: { a: false } });
  }
});
