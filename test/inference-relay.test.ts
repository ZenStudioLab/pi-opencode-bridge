import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { test } from "node:test";
import type { Config } from "@opencode-ai/sdk";
import { Type } from "typebox";
import { startInferenceRelay } from "../src/inference-relay.ts";
import { renderFailure, type BridgeFailure } from "../src/failure.ts";

const model = "muse-spark-1.3-contributor-free";
const tools = [{ name: "read", description: "Read fixture", parameters: Type.Object({}) }];

test("owned inference relay translates Responses tools and preserves authentication and errors", async () => {
  let denied = false;
  let requests = 0;
  const upstream = createServer(async (request, response) => {
    requests++;
    assert.equal(request.url, "/v1/responses");
    assert.equal(request.headers.authorization, "Bearer synthetic");
    let input = "";
    for await (const chunk of request) input += chunk;
    assert.deepEqual(JSON.parse(input).tools, [{ type: "function", name: "read" }]);
    if (denied) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end('{"error":{"type":"FreeTierError"}}');
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = { type: "response.output_item.added", item: { type: "function_call", name: "read", call_id: "c1", arguments: "{}" } };
    response.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const config: Config = { provider: { opencode: { options: { baseURL: `http://127.0.0.1:${address.port}/v1` } } } };
  const relay = await startInferenceRelay(config, tools, "opencode", model);
  assert.ok(relay);
  try {
    assert.equal(config.provider!.opencode.options!.baseURL, relay.baseURL);
    const send = () => fetch(`${relay.baseURL}/responses`, { method: "POST", headers: { authorization: "Bearer synthetic" },
      body: JSON.stringify({ tools: [{ type: "function", name: "pi_read" }] }) });
    const response = await send();
    assert.equal(response.status, 200);
    const frames = (await response.text()).split("\n\n");
    assert.deepEqual(JSON.parse(frames[0].slice(6)).item, { type: "function_call", name: "pi_read", call_id: "c1", arguments: "{}" });
    denied = true;
    const failure = await send();
    assert.equal(failure.status, 403);
    assert.deepEqual(await failure.json(), { error: { type: "FreeTierError" } });
    assert.equal((await fetch(`${relay.baseURL}/other`)).status, 404);
    assert.equal(requests, 2);
  } finally {
    await relay.close();
    await relay.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
  await assert.rejects(fetch(`${relay.baseURL}/responses`));
});

test("configured endpoint precedence and environment expansion never fall through to public Zen", async (t) => {
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.hostname, "127.0.0.1", "regression must not issue external requests");
    return nativeFetch(input, init);
  });
  const paths: string[] = [];
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the synthetic body. */ }
    paths.push(request.url!);
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"output":[]}');
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (const scenario of [
      { api: `${origin}/provider`, expected: "/provider/responses" },
      { api: `${origin}/provider`, baseURL: "", expected: "/provider/responses" },
      { api: `${origin}/provider`, modelApi: `${origin}/model`, expected: "/model/responses" },
      { api: `${origin}/provider`, modelApi: `${origin}/model`, baseURL: `${origin}/base/`, expected: "/base/responses" },
      { api: "${BRIDGE_TEST_ORIGIN}/expanded", expected: "/expanded/responses" },
    ]) {
      const modelProvider = { npm: "@ai-sdk/openai", api: scenario.modelApi };
      const config: Config = { provider: { opencode: { npm: "@ai-sdk/openai", api: scenario.api,
        options: { baseURL: scenario.baseURL },
        models: scenario.modelApi ? { [model]: { provider: modelProvider } } : undefined } } };
      const relay = await startInferenceRelay(config, tools, "opencode", model, { BRIDGE_TEST_ORIGIN: origin });
      assert.ok(relay);
      try {
        const response = await fetch(`${relay.baseURL}/responses`, { method: "POST", body: "{}" });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { output: [] });
        assert.equal(paths.at(-1), scenario.expected);
      } finally { await relay.close(); }
    }
    assert.equal(paths.length, 5);
    for (const api of ["${MISSING_ENDPOINT}/v1", "not-a-url", "file:///tmp/provider"]) {
      const config: Config = { provider: { opencode: { api } } };
      await assert.rejects(startInferenceRelay(config, tools, "opencode", model, {}), /invalid or unresolved/);
      assert.equal(config.provider!.opencode.api, api);
      assert.equal(config.provider!.opencode.options, undefined);
    }
    assert.equal(paths.length, 5);
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test("closing the relay aborts an outstanding upstream stream", { timeout: 5_000 }, async () => {
  let connected!: () => void;
  const ready = new Promise<void>(resolve => { connected = resolve; });
  let disconnected!: () => void;
  const ended = new Promise<void>(resolve => { disconnected = resolve; });
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain request before observing stream cancellation. */ }
    response.on("close", disconnected);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": waiting\n\n");
    connected();
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const config: Config = { provider: { opencode: { options: { baseURL: `http://127.0.0.1:${address.port}/v1` } } } };
  const failures: BridgeFailure[] = [];
  const relay = await startInferenceRelay(config, tools, "opencode", model, {}, () => failure => failures.push(failure));
  assert.ok(relay);
  try {
    const request = fetch(`${relay.baseURL}/responses`, { method: "POST", body: '{"tools":[]}' }).then(response => response.text());
    const rejected = assert.rejects(request);
    await ready;
    await relay.close();
    await rejected;
    await ended;
    assert.deepEqual(failures, [], "owned close must not report an intentional abort as a backend failure");
  } finally {
    await relay.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test("relay captures originating causes before headers and after stream delivery without leaking payloads", { timeout: 10_000 }, async () => {
  let mode: "transport" | "malformed" | "stream" | "success" = "transport";
  let upstreamResponse: ServerResponse | undefined;
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume fixture input. */ }
    if (mode === "transport") { request.socket.destroy(); return; }
    if (mode === "stream") {
      upstreamResponse = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": first frame\n\n");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(mode === "malformed" ? 'SECRET_PAYLOAD_NOT_JSON' : '{"output":[]}');
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const config: Config = { provider: { opencode: { options: { baseURL: `http://127.0.0.1:${address.port}/v1` } } } };
  const failures: { owner: number; failure: BridgeFailure }[] = [];
  let owner = 0;
  const relay = await startInferenceRelay(config, tools, "opencode", model, {}, () => {
    const captured = ++owner;
    return failure => { failures.push({ owner: captured, failure }); };
  });
  assert.ok(relay);
  const send = () => fetch(`${relay.baseURL}/responses`, { method: "POST", body: "{}" });
  try {
    const failed = await send();
    assert.equal(failed.status, 502);
    assert.equal(failures[0].failure.operation, "upstream forwarding");
    assert.equal(failures[0].failure.details.code, "UND_ERR_SOCKET");
    assert.equal(failures[0].failure.details.status, undefined, "local gateway status is not an upstream HTTP failure");
    assert.doesNotMatch(await failed.text(), /UND_ERR_SOCKET/, "details stay in the owning Pi process");
    mode = "malformed";
    assert.equal((await send()).status, 502);
    assert.equal(failures[1].failure.operation, "upstream response processing");
    assert.equal(failures[1].failure.details.name, "SyntaxError");
    assert.doesNotMatch(renderFailure(failures[1].failure, { operation: "unused", model }), /SECRET_PAYLOAD/);
    mode = "stream";
    const response = await send();
    const reader = response.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), ": first frame\n\n");
    const rejected = assert.rejects(reader.read());
    upstreamResponse!.destroy();
    await rejected;
    assert.equal(failures[2].failure.operation, "upstream response streaming");
    assert.equal(failures[2].failure.details.code, "UND_ERR_SOCKET");
    mode = "success";
    assert.equal((await send()).status, 200);
    assert.deepEqual(failures.map(entry => entry.owner), [1, 2, 3], "later success must not reuse a stale failure");
  } finally {
    await relay.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test("unqualified models and SDK routes retain their existing configuration", async () => {
  for (const [provider, id, config] of [
    ["other", model, {}], ["opencode", "other", {}],
    ["opencode", model, { provider: { opencode: { npm: "@ai-sdk/openai-compatible" } } }],
  ] as const) {
    const before = structuredClone(config);
    assert.equal(await startInferenceRelay(config, tools, provider, id), undefined);
    assert.deepEqual(config, before);
  }
});
