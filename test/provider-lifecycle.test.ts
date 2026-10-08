import assert from "node:assert/strict";
import http, { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { normalizeContext, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createSelectiveConfiguration } from "../src/configuration.ts";
import { createProviderSeam } from "../src/provider-seam.ts";

const model: Model<string> = {
  id: "fixture/probe", name: "Fixture", api: "opencode-bridge", provider: "opencode-bridge",
  baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16_000, maxTokens: 2_000,
};
const tool = { name: "probe", description: "Lifecycle probe", parameters: Type.Object({}) };
const context = (text: string): TranscriptContext => normalizeContext({ messages: [{ role: "user", content: text, timestamp: Date.now() }] });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
function reply(response: ServerResponse, count = 0): void {
  const delta = count ? { role: "assistant", tool_calls: Array.from({ length: count }, (_, index) => ({
    index, id: `backend-${index}`, type: "function", function: { name: "pi_probe", arguments: "{}" },
  })) } : { role: "assistant", content: "done" };
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  response.end([
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: count ? "tool_calls" : "stop" }] })}`,
    "data: [DONE]", "",
  ].join("\n\n"));
}
async function fixture(handle: (response: ServerResponse, request: number) => void) {
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the controlled request. */ }
    handle(response, ++requests);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config = createSelectiveConfiguration({ id: "fixture", name: "Fixture", model: "probe", baseURL: `http://127.0.0.1:${address.port}/v1` });
  config.provider!.fixture.models!.probe.tool_call = true;
  let seam: Awaited<ReturnType<typeof createProviderSeam>> | undefined;
  const close = async () => {
    await seam?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  try {
    seam = await createProviderSeam({ config, authentication: { fixture: { type: "api", key: "synthetic" } }, tools: [tool], providerID: "fixture", modelID: "probe" });
    return { seam, close, requests: () => requests };
  } catch (error) { await close(); throw error; }
}

test("independent requests wait without cancelling the owner, and a queued abort is isolated", { timeout: 30_000 }, async () => {
  const arrived = deferred();
  let firstResponse!: ServerResponse;
  const f = await fixture((response, request) => {
    if (request === 1) { firstResponse = response; arrived.resolve(); }
    else reply(response);
  });
  try {
    const first = f.seam.streamSimple(model, context("A")).result();
    await arrived.promise;
    const abort = new AbortController();
    const cancelled = f.seam.streamSimple(model, context("cancelled B"), { signal: abort.signal }).result();
    const second = f.seam.streamSimple(model, context("C")).result();
    abort.abort();
    assert.equal((await cancelled).stopReason, "aborted");
    assert.equal(f.requests(), 1);
    reply(firstResponse);
    assert.equal((await first).stopReason, "stop");
    assert.equal((await second).stopReason, "stop");
    assert.equal(f.requests(), 2);
  } finally { await f.close(); }
});

test("a matching tool continuation bypasses queued unrelated inference", { timeout: 30_000 }, async () => {
  const f = await fixture((response, request) => reply(response, request === 1 ? 1 : 0));
  try {
    let unrelated: ReturnType<ReturnType<typeof f.seam.streamSimple>["result"]> | undefined;
    const agent = new Agent({
      streamFn: f.seam.streamSimple,
      initialState: { model, tools: [{ ...tool, label: "Probe", execute: async () => {
        unrelated = f.seam.streamSimple(model, context("Independent request")).result();
        return { content: [{ type: "text", text: "result" }], details: undefined };
      } }] },
    });
    await agent.prompt("Call the tool.");
    assert.equal(agent.state.errorMessage, undefined);
    assert.ok(unrelated);
    assert.equal((await unrelated).stopReason, "stop");
    assert.equal(f.requests(), 3);
  } finally { await f.close(); }
});

for (const timing of ["already-aborted", "during-wait", "during-tool"] as const) {
  test(`continuation ${timing} retires pending handoffs in the real Pi loop`, { timeout: 30_000 }, async () => {
    const abort = new AbortController();
    const f = await fixture((response, request) => {
      if (request === 1) reply(response, timing === "during-tool" ? 3 : timing === "already-aborted" ? 2 : 1);
      else if (timing === "during-wait") abort.abort();
      else reply(response);
    });
    try {
      let invocations = 0;
      let executions = 0;
      const agent = new Agent({
        streamFn: (m, c, options) => {
          if (++invocations === 2) {
            if (timing === "already-aborted") abort.abort();
            return f.seam.streamSimple(m, c, { ...options, signal: abort.signal });
          }
          return f.seam.streamSimple(m, c, options);
        },
        initialState: { model, tools: [{ ...tool, label: "Probe", execute: async () => {
          executions++;
          if (timing === "during-tool" && executions === 2) abort.abort();
          return { content: [{ type: "text", text: "result" }], details: undefined };
        } }] },
      });
      await agent.prompt("Execute the controlled tools.");
      assert.equal(executions, timing === "during-tool" ? 2 : 1);
      const last = agent.state.messages.at(-1);
      assert.ok(last?.role === "assistant" && last.stopReason === (timing === "during-tool" ? "error" : "aborted"));
      assert.equal(f.requests(), timing === "during-wait" ? 2 : 1);
    } finally { await f.close(); }
  });
}

for (const failureMode of ["503", "timeout"] as const) {
test(`remote abort ${failureMode} retires the owned runtime without contaminating recovery`, { timeout: 30_000 }, async (t) => {
  let abortFailures = 0;
  const failure = createServer((_request, response) => {
    abortFailures++;
    if (failureMode === "timeout") return;
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Controlled abort failure" }));
  });
  await new Promise<void>((resolve) => failure.listen(0, "127.0.0.1", resolve));
  const address = failure.address();
  assert.ok(address && typeof address !== "string");
  const original = http.request;
  t.mock.method(http, "request", (...args: Parameters<typeof original>) => {
    if (args[0] instanceof URL && /\/session\/[^/]+\/abort$/.test(args[0].pathname)) {
      args[0] = new URL(`http://127.0.0.1:${address.port}/abort`);
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    // Any obsolete backend continuation would issue another tool.
    f = await fixture((response, request) => reply(response, request <= 2 ? 1 : 0));
    let executions = 0;
    const agent: Agent = new Agent({
      streamFn: f.seam.streamSimple,
      initialState: { model, tools: [{ ...tool, label: "Probe", execute: async () => {
        executions++;
        agent.abort();
        return { content: [{ type: "text", text: "cancelled" }], details: undefined };
      } }] },
    });
    await agent.prompt("Request A: cancel its tool.");
    await agent.prompt("Independent request B.");
    const last = agent.state.messages.at(-1);
    assert.ok(last?.role === "assistant" && last.stopReason === "error");
    await f.seam.close();
    assert.equal(abortFailures, 1);
    assert.equal(executions, 1, "obsolete tool must never execute in B");
    assert.equal(f.requests(), 1, "neither obsolete inference nor B may use the failed runtime");
    assert.throws(() => process.kill(f!.seam.pid, 0), { code: "ESRCH" });
  } finally {
    await f?.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    failure.closeAllConnections();
    await new Promise<void>((resolve) => failure.close(() => resolve()));
  }
});

}

test("failure while a Pi handoff is outstanding reports uncertain effects without replay", { timeout: 30_000 }, async (t) => {
  let events: IncomingMessage | undefined;
  let sessionID: string | undefined;
  const original = http.request;
  t.mock.method(http, "request", (...args: Parameters<typeof original>) => {
    const request = original(...args);
    if (args[0] instanceof URL) {
      if (args[0].pathname === "/event") request.once("response", response => { events = response; });
      sessionID ??= args[0].pathname.match(/^\/session\/([^/]+)\/message$/)?.[1];
    }
    return request;
  });
  syncBuiltinESMExports();
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture((response, request) => reply(response, request === 1 ? 1 : 0));
    const input = context("Hold the tool result.");
    const handoff = await f.seam.streamSimple(model, input).result();
    assert.equal(handoff.stopReason, "toolUse");
    assert.ok(events && sessionID);
    events.push(Buffer.from(`data: ${JSON.stringify({ type: "session.error", properties: { sessionID, error: { name: "APIError", data: { statusCode: 502, message: "Controlled handoff failure" } } } })}\n\n`));
    await new Promise<void>(resolve => setImmediate(resolve));
    const failed = await f.seam.streamSimple(model, normalizeContext({ messages: [...input.messages, handoff] })).result();
    assert.equal(failed.stopReason, "error");
    assert.match(failed.errorMessage!, /Tools: 1 handoff\(s\), 0 result\(s\) returned/);
    assert.match(failed.errorMessage!, /execution may have occurred/);
    assert.match(failed.errorMessage!, /Controlled handoff failure/);
    assert.equal(f.requests(), 1);
    assert.equal((await f.seam.streamSimple(model, context("New request after failure")).result()).stopReason, "stop");
    assert.equal(f.requests(), 2);
  } finally {
    await f?.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

for (const change of ["disconnect", "compaction"] as const) {
test(`backend ${change} between turns prevents stale inference`, { timeout: 30_000 }, async (t) => {
  let events: IncomingMessage | undefined;
  let sessionID: string | undefined;
  const original = http.request;
  t.mock.method(http, "request", (...args: Parameters<typeof original>) => {
    const request = original(...args);
    if (args[0] instanceof URL) {
      if (args[0].pathname === "/event") request.once("response", (response) => { events = response; });
      sessionID ??= args[0].pathname.match(/^\/session\/([^/]+)\/message$/)?.[1];
    }
    return request;
  });
  syncBuiltinESMExports();
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture((response) => reply(response));
    assert.equal((await f.seam.streamSimple(model, context("First turn")).result()).stopReason, "stop");
    assert.ok(events);
    if (change === "disconnect") events.destroy(new Error("Controlled monitor disconnect"));
    else {
      assert.ok(sessionID);
      events.push(Buffer.from(`data: ${JSON.stringify({ type: "session.compacted", properties: { sessionID } })}\n\n`));
    }
    // Let the transport rejection reach its event consumer; this is not a tool batching timer.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const result = await f.seam.streamSimple(model, context("Next turn")).result();
    assert.equal(result.stopReason, "error");
    assert.equal(f.requests(), 1, "unavailable monitoring or changed backend history prevents later inference");
    if (change === "compaction") assert.match(result.errorMessage!, /history changed/);
  } finally {
    await f?.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
}
