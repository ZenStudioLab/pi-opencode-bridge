import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { test } from "node:test";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import { createSelectiveConfiguration } from "../src/configuration.ts";
import { createProviderSeam } from "../src/provider-seam.ts";

for (const scenario of [
  { status: 401, message: "Controlled credentials rejected", expected: /access denied/ },
  { status: 403, message: "Controlled entitlement denied", expected: /access denied/ },
  { status: 429, message: "Controlled rate limit reached", expected: /rate limit/ },
  { status: 400, message: "Context length exceeded", expected: /Context length exceeded/ },
  { status: 200, message: "partial disconnect", expected: /failed/ },
]) {
  test(`evidenced provider ${scenario.status} failure preserves prompt and does not retry`, { timeout: 30_000 }, async () => {
    let requests = 0;
    let partialResponse: ServerResponse | undefined;
    let observedPartial = false;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* Consume fixture request. */ }
      requests++;
      if (scenario.status === 200) {
        partialResponse = response;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ id: "partial", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "partial text" }, finish_reason: null }] })}\n\n`);
        return;
      }
      response.writeHead(scenario.status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: scenario.message, type: "controlled_error", code: scenario.status === 400 ? "context_length_exceeded" : "controlled" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const config = createSelectiveConfiguration({ id: "fixture", name: "Fixture", model: "probe", baseURL: `http://127.0.0.1:${address.port}/v1` });
    const model: Model<string> = { id: "fixture/probe", name: "Fixture", api: "opencode-bridge", provider: "opencode-bridge", baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16000, maxTokens: 2000 };
    const context = normalizeContext({ messages: [{ role: "user", content: "preserved prompt", timestamp: 1 }] });
    const original = structuredClone(context);
    let seam: Awaited<ReturnType<typeof createProviderSeam>> | undefined;
    try {
      seam = await createProviderSeam({ config, authentication: { fixture: { type: "api", key: "synthetic-secret" } }, tools: [], providerID: "fixture", modelID: "probe" });
      const stream = seam.streamSimple(model, context, { onProviderStreamEvent(event) {
        const value = event as { properties?: { delta?: string; field?: string; part?: { type?: string; text?: string } } };
        if (scenario.status === 200 && ((value.properties?.part?.type === "text" && value.properties.part.text === "partial text") ||
            (value.properties?.field === "text" && value.properties.delta === "partial text"))) {
          observedPartial = true;
          partialResponse!.destroy();
        }
      } });
      const events: string[] = [];
      for await (const event of stream) events.push(event.type);
      const result = await stream.result();
      if (scenario.status === 200) {
        assert.equal(observedPartial, true);
        assert.deepEqual(result.content, [{ type: "text", text: "partial text" }]);
        assert.equal(events.filter((event) => event === "text_start").length, events.filter((event) => event === "text_end").length);
      }
      assert.equal(events.filter((event) => event === "done" || event === "error").length, 1);
      assert.equal(result.stopReason, "error");
      assert.match(result.errorMessage!, scenario.expected);
      assert.match(result.errorMessage!, /Model: fixture\/probe/);
      assert.match(result.errorMessage!, /Tools: no handoff issued/);
      if (scenario.status === 401 || scenario.status === 403) assert.ok(result.errorMessage!.includes(`HTTP: ${scenario.status}`));
      // OpenCode's retry and ContextOverflowError events omit the original HTTP status.
      if (scenario.status === 429 || scenario.status === 400) assert.doesNotMatch(result.errorMessage!, /HTTP:/);
      assert.doesNotMatch(result.errorMessage!, /synthetic-secret|preserved prompt/);
      assert.deepEqual(context, original);
      assert.equal(requests, 1);
    } finally {
      await seam?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
