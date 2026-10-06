import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadProviderConfiguration } from "../src/provider-configuration.ts";

// These test synthetic operator-owned inputs, never this machine's credential/config files.
test("provider projection preserves JSONC, references and precedence without reading excluded instructions", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-opencode-source-"));
  try {
    const project = join(home, "project");
    const config = join(home, ".config", "opencode");
    const auth = join(home, ".local", "share", "opencode");
    await Promise.all([mkdir(project), mkdir(config, { recursive: true }), mkdir(auth, { recursive: true })]);
    await writeFile(join(config, "provider-key"), "synthetic-file-key\n");
    const source = `{
      // Global execution surfaces must not be inherited.
      "provider": { "fixture": { "options": {
        "apiKey": "{file:provider-key}", "baseURL": "{env:FIXTURE_URL}",
        "quoted": "https://example.test/*not-a-comment*/,}",
      }, "blacklist": ["excluded-model",], }, },
      "instructions": ["{file:must-not-be-read}"],
      "plugin": ["must-not-execute"],
    }`;
    await writeFile(join(config, "opencode.jsonc"), source);
    await writeFile(join(project, "opencode.json"), JSON.stringify({
      provider: { fixture: { options: { baseURL: "project-value" } } },
      mcp: { unrelated: { type: "remote", url: "http://127.0.0.1:9" } },
    }));
    const authText = JSON.stringify({ fixture: { type: "api", key: "synthetic-api-key" }, oauth: { type: "oauth", refresh: "synthetic-refresh" } });
    await writeFile(join(auth, "auth.json"), authText);
    const result = await loadProviderConfiguration(project, {
      HOME: home,
      FIXTURE_URL: "global-value",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { fixture: { options: { baseURL: "inline-value" } } } }),
    });
    assert.equal(result.config.provider?.fixture.options?.baseURL, "inline-value");
    assert.equal(result.config.provider?.fixture.options?.apiKey, "synthetic-file-key");
    assert.equal(result.config.provider?.fixture.options?.quoted, "https://example.test/*not-a-comment*/,}");
    assert.deepEqual(result.config.provider?.fixture.blacklist, ["excluded-model"]);
    assert.equal(result.config.instructions, undefined);
    assert.equal(result.config.mcp, undefined);
    assert.equal(result.config.plugin, undefined);
    assert.equal(result.excludedPluginCount, 1);
    assert.deepEqual(result.unavailableAuthProviders, ["oauth"]);
    assert.deepEqual(result.config.disabled_providers, ["oauth"]);
    assert.deepEqual(result.authentication, { fixture: { type: "api", key: "synthetic-api-key" } });
    assert.equal(await readFile(join(config, "opencode.jsonc"), "utf8"), source);
    assert.equal(await readFile(join(auth, "auth.json"), "utf8"), authText);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("bridge defaults expose only free Muse while explicit provider settings retain precedence", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-opencode-defaults-"));
  try {
    const environment = { HOME: home, OPENCODE_AUTH_CONTENT: "{}" };
    const defaults = await loadProviderConfiguration(home, environment);
    assert.deepEqual(defaults.config.enabled_providers, ["opencode"]);
    assert.deepEqual(defaults.config.provider?.opencode.whitelist, ["muse-spark-1.3-contributor-free"]);
    const configured = await loadProviderConfiguration(home, { ...environment,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { opencode: { options: { baseURL: "http://127.0.0.1:9/v1" } } } }),
    });
    assert.deepEqual(configured.config.provider?.opencode.whitelist, ["muse-spark-1.3-contributor-free"]);
    assert.equal(configured.config.provider?.opencode.options?.baseURL, "http://127.0.0.1:9/v1");
    const explicit = await loadProviderConfiguration(home, { ...environment,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: ["fixture"],
        provider: { opencode: { whitelist: ["operator-selected"] } } }),
    });
    assert.deepEqual(explicit.config.enabled_providers, ["fixture"]);
    assert.deepEqual(explicit.config.provider?.opencode.whitelist, ["operator-selected"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("invalid provider/auth inputs report a source without exposing parser excerpts", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-opencode-source-"));
  try {
    for (const key of ["OPENCODE_CONFIG_CONTENT", "OPENCODE_AUTH_CONTENT"]) {
      await assert.rejects(loadProviderConfiguration(home, { HOME: home, [key]: '{"secret":"synthetic-secret" broken}' }),
        (error: Error) => error.message.startsWith("Invalid OpenCode configuration") && !error.message.includes("synthetic-secret"));
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
