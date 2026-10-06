import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BRIDGE_AGENT, createSelectiveConfiguration } from "../src/configuration.ts";
import { startOwnedRuntime } from "../src/runtime.ts";

// Qualification gate: observe the real public boundary, not a guessed debounce or fixture call count.
test("OpenCode delays whole-step completion until MCP results, requiring request-level handoffs", { timeout: 20_000 }, async (t) => {
  const pending: Array<(result: CallToolResult) => void> = [];
  let reachTwo!: () => void;
  const twoCalls = new Promise<void>((resolve) => { reachTwo = resolve; });
  const transports: StreamableHTTPServerTransport[] = [];
  const servers: Server[] = [];
  const relay = createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    const server = new Server({ name: "pi-boundary-probe", version: "0.0.0" }, { capabilities: { tools: {} } });
    servers.push(server);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
      name: "probe", description: "Controlled pending request; no actual tool execution.",
      inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    }] }));
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      assert.equal(call.params.name, "probe");
      assert.deepEqual(call.params.arguments, { value: "identical" });
      return new Promise<CallToolResult>((resolve) => {
        pending.push(resolve);
        if (pending.length === 2) reachTwo();
      });
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    transports.push(transport);
    await server.connect(transport);
    await transport.handleRequest(request, response);
  });
  let requests = 0;
  const model = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Never log model payloads. */ }
    requests++;
    const choices = requests === 1
      ? [{ index: 0, delta: { role: "assistant", tool_calls: [0, 1].map((index) => ({
          index, id: `controlled-${index}`, type: "function", function: { name: "pi_probe", arguments: '{"value":"identical"}' },
        })) }, finish_reason: null }]
      : [{ index: 0, delta: { role: "assistant", content: "completed" }, finish_reason: null }];
    const finish = requests === 1 ? "tool_calls" : "stop";
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    response.end([
      `data: ${JSON.stringify({ id: "controlled", object: "chat.completion.chunk", choices })}`,
      `data: ${JSON.stringify({ id: "controlled", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}`,
      "data: [DONE]", "",
    ].join("\n\n"));
  });
  const listen = (server: ReturnType<typeof createServer>): Promise<string> => new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  let runtime: Awaited<ReturnType<typeof startOwnedRuntime>> | undefined;
  let prompt: Promise<unknown> | undefined;
  const controller = new AbortController();
  const eventController = new AbortController();
  let eventPump: Promise<void> | undefined;
  let released = false;
  const events: Array<{ phase: string; type: string; part?: string; state?: string; finish?: string }> = [];
  try {
    const [relayURL, modelURL] = await Promise.all([listen(relay), listen(model)]);
    const config = createSelectiveConfiguration({ id: "fixture", name: "Controlled fixture", model: "probe", baseURL: `${modelURL}/v1` });
    config.provider!.fixture.models!.probe.tool_call = true;
    config.mcp = { pi: { type: "remote", url: relayURL, oauth: false } };
    config.agent![BRIDGE_AGENT]!.tools = { "*": false, pi_probe: true };
    runtime = await startOwnedRuntime({
      executable: process.env.PI_OPENCODE_TEST_EXECUTABLE ?? "opencode",
      config, authentication: { fixture: { type: "api", key: "synthetic-key" } },
    });
    const response = await fetch(`${runtime.url}/event`, { signal: eventController.signal });
    assert.equal(response.status, 200);
    let connected!: () => void;
    const ready = new Promise<void>((resolve) => { connected = resolve; });
    eventPump = (async () => {
      let buffer = "";
      for await (const chunk of response.body!.pipeThrough(new TextDecoderStream())) {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          if (!data) continue;
          const event = JSON.parse(data);
          events.push({ phase: released ? "after-results" : "pending-results", type: event.type,
            part: event.properties?.part?.type, state: event.properties?.part?.state?.status,
            finish: event.properties?.info?.finish });
          if (event.type === "server.connected") connected();
        }
      }
    })();
    eventPump.catch(() => undefined);
    await Promise.race([ready, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("event subscription handshake missing")), 3_000);
      ready.finally(() => clearTimeout(timer));
    })]);
    const session = await runtime.client.session.create({ body: { title: "Pi finite-batch boundary probe" }, throwOnError: true, signal: AbortSignal.timeout(3_000) });
    prompt = runtime.client.session.prompt({
      path: { id: session.data.id },
      body: { model: { providerID: "fixture", modelID: "probe" }, agent: BRIDGE_AGENT, parts: [{ type: "text", text: "Controlled two-tool probe." }] },
      throwOnError: true, signal: controller.signal,
    });
    prompt.catch(() => undefined);
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([twoCalls, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`MCP requests did not arrive: calls=${pending.length}, modelRequests=${requests}`)), 10_000);
      })]);
    } finally { if (timeout) clearTimeout(timeout); }
    // Diagnostic observation window only: NEVER use elapsed silence as a production batch boundary.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const before = await runtime.client.session.messages({ path: { id: session.data.id }, throwOnError: true, signal: AbortSignal.timeout(3_000) });
    const beforeParts = before.data.flatMap((message) => message.parts);
    const beforeFinish = beforeParts.filter((part) => part.type === "step-finish");
    const beforeRunning = beforeParts.filter((part) => part.type === "tool" && part.state.status === "running");
    assert.equal(requests, 1);
    assert.equal(beforeRunning.length, 2);
    const pendingEvents = new Map<string, number>();
    for (const event of events) {
      const key = [event.type, event.part, event.state, event.finish].filter(Boolean).join(":");
      pendingEvents.set(key, (pendingEvents.get(key) ?? 0) + 1);
    }
    t.diagnostic(`Public events while results pending (counts only): ${JSON.stringify(Object.fromEntries(pendingEvents))}`);
    released = true;
    for (const [index, resolve] of pending.entries()) resolve({ content: [{ type: "text", text: `controlled-result-${index}` }] });
    await prompt;
    const after = await runtime.client.session.messages({ path: { id: session.data.id }, throwOnError: true, signal: AbortSignal.timeout(3_000) });
    const afterFinish = after.data.flatMap((message) => message.parts).filter((part) => part.type === "step-finish");
    t.diagnostic(`Public completion events after release: ${JSON.stringify(events.filter((event) => event.phase === "after-results" && (event.part === "step-finish" || event.finish || event.type === "session.idle")))}`);
    assert.ok(afterFinish.length > 0, "the runtime must publish step completion after results");
    assert.equal(beforeFinish.length, 0,
      "Pinned OpenCode holds step completion behind MCP results; handoffs must not wait for it");
  } finally {
    controller.abort();
    eventController.abort();
    await eventPump?.catch(() => undefined);
    for (const resolve of pending) resolve({ isError: true, content: [{ type: "text", text: "Probe closed" }] });
    await runtime?.close();
    await prompt?.catch(() => undefined);
    await Promise.all(servers.map((server) => server.close()));
    await Promise.all(transports.map((transport) => transport.close()));
    for (const server of [relay, model]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
