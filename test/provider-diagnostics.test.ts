import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { normalizeContext, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createSelectiveConfiguration } from "../src/configuration.ts";
import { createProviderSeam } from "../src/provider-seam.ts";

const model: Model<string> = { id: "fixture/probe", name: "Fixture", api: "opencode-bridge", provider: "opencode-bridge", baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16000, maxTokens: 2000 };

test("request boundary diagnostics retain observer and malformed-response causes without replay", { timeout: 30_000 }, async (t) => {
  let malformed = false;
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain synthetic request. */ }
    requests++;
    if (request.url === "/invalid") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"info":null}');
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const original = http.request;
  t.mock.method(http, "request", (...args: Parameters<typeof original>) => {
    if (malformed && args[0] instanceof URL && /\/session\/[^/]+\/message$/.test(args[0].pathname) && (args[1] as http.RequestOptions)?.method === "POST") {
      args[0] = new URL(`http://127.0.0.1:${address.port}/invalid`);
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  let seam: Awaited<ReturnType<typeof createProviderSeam>> | undefined;
  try {
    seam = await createProviderSeam({ config: createSelectiveConfiguration({ id: "fixture", name: "Fixture", model: "probe", baseURL: `http://127.0.0.1:${address.port}/v1` }), tools: [], authentication: { fixture: { type: "api", key: "synthetic" } }, providerID: "fixture", modelID: "probe" });
    for (const [hook, stage] of [["onPayload", "payload observation"], ["onResponse", "response observation"], ["onProviderStreamEvent", "stream observation"], ["malformed", "response processing"]] as const) {
      malformed = hook === "malformed";
      const context = normalizeContext({ messages: [{ role: "user", content: `Private request for ${hook}`, timestamp: Date.now() }] });
      const options: SimpleStreamOptions = {};
      if (!malformed) Object.assign(options, { [hook]: () => { throw Object.assign(new Error("controlled hook failure"), { code: "HOOK_FAILURE" }); } });
      const stream = seam.streamSimple(model, context, options);
      const events: string[] = [];
      for await (const event of stream) events.push(event.type);
      const result = await stream.result();
      assert.equal(result.stopReason, "error");
      assert.match(result.errorMessage!, new RegExp(`failed: ${stage}`));
      assert.match(result.errorMessage!, malformed ? /TypeError/ : /controlled hook failure/);
      assert.doesNotMatch(result.errorMessage!, /Private request|synthetic/);
      assert.equal(events.filter(e => e === "done" || e === "error").length, 1);
      const before = requests;
      const replay = await seam.streamSimple(model, context).result();
      assert.match(replay.errorMessage!, /blocked replay/);
      assert.equal(requests, before);
    }
    malformed = false;
    const fresh = await seam.streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "fresh request", timestamp: Date.now() }] })).result();
    assert.equal(fresh.stopReason, "stop");
    assert.equal(fresh.errorMessage, undefined);
  } finally {
    await seam?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
