import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import register from "../src/index.ts";

test("global settings apply across projects, retain overrides on new discovery and preserve the catalog on errors", { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-settings-entry-"));
  const agentDir = join(home, "agent");
  const path = join(agentDir, "opencode-bridge.json");
  const environment = { ...process.env };
  const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  const commands = new Map<string, { handler: (...args: unknown[]) => Promise<void> }>();
  const notices: string[] = [];
  const choices: string[] = [];
  let failSave = false;
  let idleChecks = 0;
  let registered: Parameters<ExtensionAPI["registerProvider"]>[1] | undefined;
  const pi = {
    registerProvider(_name: string, provider: typeof registered) { registered = provider; },
    on(name: string, handler: (...args: unknown[]) => Promise<void>) { handlers.set(name, handler); return () => handlers.delete(name); },
    registerCommand(name: string, command: { handler: (...args: unknown[]) => Promise<void> }) { commands.set(name, command); },
  } as unknown as ExtensionAPI;
  const ctx = { cwd: join(home, "first-project"), hasUI: true, waitForIdle: async () => { idleChecks++; }, ui: {
    notify: (message: string) => notices.push(message),
    confirm: async () => true,
    select: async (_title: string, rows: string[]) => {
      const choice = choices.shift();
      assert.ok(choice);
      if (failSave && choice === "Save changes") await chmod(agentDir, 0o500);
      const row = rows.find(value => value === choice || value.includes(`(${choice})`));
      assert.ok(row, choice);
      return row;
    },
  } } as unknown as ExtensionContext;
  const model = (name: string) => ({ name, tool_call: true, cost: { input: 1, output: 2 },
    modalities: { input: ["text"], output: ["text"] }, limit: { context: 16000, output: 2000 } });
  const provider = (name: string, display: string) => ({ npm: "@ai-sdk/openai-compatible", name,
    options: { baseURL: "http://127.0.0.1:9/v1" }, models: { shared: model(display) } });
  const config = { enabled_providers: ["a", "b"], provider: { a: provider("First", "Free first"), b: provider("Free provider name", "Paid second") } };
  const ids = () => registered!.models!.map(m => m.id).sort();
  try {
    await mkdir(ctx.cwd);
    await mkdir(join(home, "second-project"));
    for (const key of Object.keys(process.env)) if (key.startsWith("OPENCODE_") || key.startsWith("XDG_")) delete process.env[key];
    Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: agentDir,
      XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
      OPENCODE_AUTH_CONTENT: JSON.stringify({ a: { type: "api", key: "synthetic" }, b: { type: "api", key: "synthetic" } }),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config) });
    register(pi);
    await handlers.get("session_start")!({}, ctx);
    assert.deepEqual(ids(), ["a/shared"], notices.join("\n"));
    choices.push("Provider: a", "shared", "Back", "Provider: b", "shared", "Back", "Save changes");
    await commands.get("opencode-settings")!.handler("", ctx);
    assert.deepEqual(ids(), ["b/shared"]);
    const saved = await readFile(path, "utf8");
    assert.deepEqual(JSON.parse(saved), { models: { "a/shared": false, "b/shared": true } });
    assert.ok(idleChecks >= 2);
    await handlers.get("session_shutdown")!({}, ctx);
    ctx.cwd = join(home, "second-project");
    register(pi);
    await handlers.get("session_start")!({}, ctx);
    assert.deepEqual(ids(), ["b/shared"]);
    const expanded = structuredClone(config);
    Object.assign(expanded.provider.a.models, { new: model("New FREE model") });
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(expanded);
    await commands.get("opencode-refresh")!.handler("", ctx);
    assert.deepEqual(ids(), ["a/new", "b/shared"]);
    await writeFile(path, '{"secret":"not-for-diagnostics" broken}');
    const previous = registered;
    await commands.get("opencode-refresh")!.handler("", ctx);
    assert.equal(registered, previous);
    assert.match(notices.at(-1)!, /global model preferences failed.*preserved/);
    assert.doesNotMatch(notices.at(-1)!, /not-for-diagnostics/);
    await writeFile(path, saved);
    choices.push("Provider: b", "shared", "Back", "Cancel");
    await commands.get("opencode-settings")!.handler("", ctx);
    assert.deepEqual(ids(), ["a/new", "b/shared"]);
    assert.equal(await readFile(path, "utf8"), saved);
    failSave = true;
    choices.push("Provider: b", "shared", "Back", "Save changes");
    await commands.get("opencode-settings")!.handler("", ctx);
    assert.match(notices.at(-1)!, /Cannot save global/);
    assert.deepEqual(ids(), ["a/new", "b/shared"]);
    assert.equal(await readFile(path, "utf8"), saved);
    assert.equal(choices.length, 0);
  } finally {
    await chmod(agentDir, 0o700).catch(() => undefined);
    await handlers.get("session_shutdown")?.({}, ctx);
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    await rm(home, { recursive: true, force: true });
  }
});
