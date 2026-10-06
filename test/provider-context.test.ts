import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { normalizeContext, type Model, type Message, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createSelectiveConfiguration } from "../src/configuration.ts";
import { createProviderSeam } from "../src/provider-seam.ts";

const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const model: Model<string> = { id: "fixture/probe", name: "Fixture", api: "opencode-bridge", provider: "opencode-bridge", baseUrl: "http://127.0.0.1", reasoning: true, input: ["text", "image"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16000, maxTokens: 2000 };

for (const mode of ["context", "image-tool"] as const) {
  test(`real backend preserves ${mode} with streaming instrumentation and usage`, { timeout: 30_000 }, async () => {
    const requests: unknown[] = [];
    const tool = { name: "picture", description: "Return a controlled image", parameters: Type.Object({}) };
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const call = mode === "image-tool" && requests.length === 1;
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      const deltas = call ? [{ role: "assistant", tool_calls: [{ index: 0, id: "backend-picture", type: "function", function: { name: "pi_picture", arguments: "{}" } }] }]
        : [{ role: "assistant", reasoning_content: "reason" }, { content: "Hello " }, { content: "🌏" }];
      for (const delta of deltas) response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: mode === "context" ? 10000 : 10, completion_tokens: 5, total_tokens: mode === "context" ? 10005 : 15 } })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const config = createSelectiveConfiguration({ id: "fixture", name: "Fixture", model: "probe", baseURL: `http://127.0.0.1:${address.port}/v1` });
    Object.assign(config.provider!.fixture.models!.probe, { tool_call: true, reasoning: true, attachment: true, modalities: { input: ["text", "image"], output: ["text"] } });
    if (mode === "context") config.provider!.fixture.models!.probe.limit = { context: 1024, output: 128 };
    let seam: Awaited<ReturnType<typeof createProviderSeam>> | undefined;
    try {
      seam = await createProviderSeam({ config, authentication: { fixture: { type: "api", key: "synthetic" } }, providerID: "fixture", modelID: "probe", tools: mode === "image-tool" ? [tool] : [] });
      const sessions = new Set<string>();
      let payloads = 0, responses = 0;
      const events: AssistantMessageEvent[] = [];
      const history: Message[] = mode === "context" ? [
        { role: "user", content: "Retained historical tool work", timestamp: 1 },
        { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 2, stopReason: "toolUse",
          content: Array.from({ length: 12 }, (_, i) => ({ type: "toolCall" as const, id: `retained-${i}`, name: "historical", arguments: { i } })),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
        ...Array.from({ length: 12 }, (_, i) => ({ role: "toolResult" as const, toolCallId: `retained-${i}`, toolName: "historical", isError: false, timestamp: i + 3,
          content: [{ type: "text" as const, text: `RETAINED_RESULT_${i}:` + "retained data ".repeat(300) }] })),
      ] : [];
      const agent = new Agent({
        streamFn: (m, c, options) => {
          const stream = seam!.streamSimple(m, c, { ...options,
            onPayload: () => { payloads++; }, onResponse: () => { responses++; },
            onProviderStreamEvent: (event) => { const e = event as { properties?: { info?: { sessionID?: string } } }; if (e.properties?.info?.sessionID) sessions.add(e.properties.info.sessionID); },
          });
          // Agent itself consumes the stream; subscribe through its public events below.
          return stream;
        },
        initialState: { model, messages: history, systemPrompt: "CURRENT_SYSTEM", tools: mode === "image-tool" ? [{ ...tool, label: "Picture", execute: async () => ({ content: [{ type: "image" as const, data: pixel, mimeType: "image/png" }], details: undefined }) }] : [] },
      });
      agent.subscribe((event) => { if (event.type === "message_update") events.push(structuredClone(event.assistantMessageEvent)); });
      if (mode === "image-tool") {
        await agent.prompt("Inspect the image, then call picture.", [{ type: "image", data: pixel, mimeType: "image/png" }]);
        assert.equal(requests.length, 2);
        assert.ok(JSON.stringify(requests[0]).includes(pixel), "user image reaches actual model request");
        assert.ok(JSON.stringify(requests[1]).includes(pixel), "image tool result reaches actual model request");
        assert.equal(agent.state.messages.filter((message) => message.role === "toolResult").length, 1);
      } else {
        await agent.prompt("OLD_RETAINED_SENTINEL");
        await agent.prompt("NEW_APPEND_SENTINEL");
        assert.equal(requests.length, 2);
        assert.equal(sessions.size, 1, "compatible append reuses its backend session");
        assert.ok((requests[1] as { messages: Array<{ role: string }> }).messages.some((message) => message.role === "assistant"), "native prior assistant is retained rather than text-replayed");
        assert.match(JSON.stringify(requests[0]), /RETAINED_RESULT_11/);
        assert.match(JSON.stringify(requests[1]), /RETAINED_RESULT_11/);
        assert.match(JSON.stringify(requests[1]), /OLD_RETAINED_SENTINEL/);
        const branch = normalizeContext({ systemPrompt: "CHANGED_SYSTEM", messages: [{ role: "user", content: "BRANCH_ONLY_SENTINEL", timestamp: Date.now() }] });
        const result = await seam.streamSimple(model, branch).result();
        assert.equal(result.stopReason, "stop");
        assert.doesNotMatch(JSON.stringify(requests[2]), /OLD_RETAINED_SENTINEL|NEW_APPEND_SENTINEL|RETAINED_RESULT/);
        assert.match(JSON.stringify(requests[2]), /CHANGED_SYSTEM|BRANCH_ONLY_SENTINEL/);
      }
      assert.equal(agent.state.errorMessage, undefined);
      const assistants = agent.state.messages.filter((message) => message.role === "assistant");
      const final = assistants.at(-1)!;
      assert.equal(final.content.filter((part) => part.type === "text").map((part) => part.text).join(""), "Hello 🌏");
      assert.ok(final.content.some((part) => part.type === "thinking" && part.thinking === "reason"));
      assert.equal(assistants.reduce((sum, message) => sum + message.usage.input, 0), mode === "context" ? 20000 : 20);
      assert.equal(assistants.reduce((sum, message) => sum + message.usage.output, 0), 10);
      assert.equal(payloads, mode === "image-tool" ? 1 : 2);
      assert.equal(responses, payloads);
      assert.ok(events.some((event) => event.type === "text_delta"));
    } finally {
      await seam?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
