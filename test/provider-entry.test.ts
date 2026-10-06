import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import register from "../src/index.ts";

test("provider entry preserves catalog on failed refresh and rejects removed selection", { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-bridge-entry-"));
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume controlled inference. */ }
    const call = ++requests === 1;
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: "entry-call", type: "function", function: { name: "pi_probe", arguments: "{}" } }] } : { role: "assistant", content: "entry done" };
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    response.end(`data: ${JSON.stringify({ id: "entry", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "entry", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const environment = { ...process.env };
  const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  const commands = new Map<string, { handler: (...args: unknown[]) => Promise<void> }>();
  const notices: string[] = [];
  let registered: Parameters<ExtensionAPI["registerProvider"]>[1] | undefined;
  const pi = {
    registerProvider(_name: string, provider: typeof registered) { registered = provider; },
    on(name: string, handler: (...args: unknown[]) => Promise<void>) { handlers.set(name, handler); return () => handlers.delete(name); },
    registerCommand(name: string, command: { handler: (...args: unknown[]) => Promise<void> }) { commands.set(name, command); },
  } as unknown as ExtensionAPI;
  const ctx = { cwd: home, ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionContext;
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith("OPENCODE_") || key.startsWith("XDG_")) delete process.env[key];
    Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
      OPENCODE_AUTH_CONTENT: JSON.stringify({ fixture: { type: "api", key: "synthetic" } }),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: ["fixture"], provider: { fixture: {
        npm: "@ai-sdk/openai-compatible", name: "Fixture", options: { baseURL: `http://127.0.0.1:${address.port}/v1` },
        models: { probe: { name: "Probe", tool_call: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 16000, output: 2000 } } },
      } } }),
    });
    register(pi);
    await handlers.get("session_start")!({}, ctx);
    assert.ok(registered?.models?.some((model) => model.id === "fixture/probe"), notices.join("\n"));
    assert.equal(requests, 0, "catalog discovery must not infer");
    const selected: Model<string> = { id: "fixture/probe", name: "Probe", provider: "opencode-bridge", api: "opencode-bridge", baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    let executions = 0, before = 0, after = 0, payloads = 0, responses = 0;
    const agent = new Agent({
      streamFn: (model, context, options) => registered!.streamSimple!(model, context, { ...options,
        onPayload: () => { payloads++; }, onResponse: () => { responses++; },
      }),
      initialState: { model: selected, tools: [{ name: "probe", label: "Probe", description: "Controlled entry tool", parameters: Type.Object({}), execute: async () => {
        executions++;
        return { content: [{ type: "text", text: "entry result" }], details: undefined };
      } }] },
      beforeToolCall: async () => { before++; return undefined; }, afterToolCall: async () => { after++; return undefined; },
    });
    await agent.prompt("Run the entry tool.");
    assert.equal(agent.state.errorMessage, undefined);
    assert.deepEqual([requests, executions, before, after, payloads, responses], [2, 1, 1, 1, 1, 1]);
    const cancelled = await registered!.streamSimple!(selected, normalizeContext({ messages: [{ role: "user", content: "cancelled entry", timestamp: 2 }] }), { signal: AbortSignal.abort() }).result();
    assert.equal(cancelled.stopReason, "aborted");
    assert.equal(requests, 2);
    for (const event of ["session_tree", "session_compact", "model_select"]) await handlers.get(event)!({}, ctx);
    await agent.prompt("Fresh entry after Pi context transition.");
    assert.equal(agent.state.errorMessage, undefined);
    assert.equal(requests, 3);
    const previous = registered;
    process.env.OPENCODE_CONFIG_CONTENT = "{ invalid JSON";
    await commands.get("opencode-refresh")!.handler("", ctx);
    assert.equal(registered, previous, "failed refresh must not replace valid registration");
    assert.match(notices.at(-1)!, /configuration failed.*preserved/);
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ enabled_providers: ["fixture"], disabled_providers: ["fixture"] });
    await commands.get("opencode-refresh")!.handler("", ctx);
    assert.equal(registered!.models!.length, 0);
    const result = await registered!.streamSimple!(selected, normalizeContext({ messages: [{ role: "user", content: "unchanged prompt", timestamp: 1 }] }), {}).result();
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage!, /selection were preserved/);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    await rm(home, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
