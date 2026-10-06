import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { StringDecoder } from "node:string_decoder";
import { test } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Model, TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createSelectiveConfiguration } from "../src/configuration.ts";
import { createProviderSeam } from "../src/provider-seam.ts";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const mode of ["retry", "observer", "missing-events", "selective-loss", "ordered"] as const) {
  const retry = mode === "retry";
  test(`generation supervision and completeness: ${mode}`, { timeout: 30_000 }, async (t) => {
    let removed = 0;
    if (mode === "missing-events" || mode === "selective-loss") {
      const original = http.request;
      t.mock.method(http, "request", (...args: Parameters<typeof original>) => {
        const request = original(...args);
        if (args[0] instanceof URL && args[0].pathname === "/event") request.prependListener("response", (incoming) => {
          const push = incoming.push.bind(incoming);
          const decoder = new StringDecoder("utf8");
          let pending = "";
          let firstAssistant: string | undefined;
          incoming.push = (chunk: Buffer | null) => {
            if (chunk === null) return push(null);
            pending += decoder.write(chunk);
            let end: number;
            let kept = "";
            while ((end = pending.indexOf("\n\n")) !== -1) {
              const frame = pending.slice(0, end);
              pending = pending.slice(end + 2);
              const data = frame.split("\n").find((line) => line.startsWith("data:"));
              const event = data ? JSON.parse(data.slice(5)) : {};
              const info = event.properties?.info;
              const part = event.properties?.part;
              if (info?.role === "assistant") firstAssistant ??= info.id;
              const suppress = mode === "missing-events"
                ? ["message.updated", "message.part.updated", "message.part.delta"].includes(event.type)
                : firstAssistant && (part?.messageID ?? event.properties?.messageID) === firstAssistant &&
                  (part?.type === "text" || (event.type === "message.part.delta" && event.properties?.field === "text"));
              if (suppress) removed++;
              else kept += frame + "\n\n";
            }
            return kept ? push(Buffer.from(kept)) : true;
          };
        });
        return request;
      });
      syncBuiltinESMExports();
    }
    const releaseObserver = barrier();
    const finalResponse = barrier();
    const finalDisplayed = barrier();
    const preambleDisplayed = barrier();
    let freshRequest = "";
    let lastContext: TranscriptContext | undefined;
    let paused = false, requests = 0, executions = 0, completed = false;
    const server = createServer(async (request, response) => {
      let received = "";
      for await (const chunk of request) received += chunk.toString();
      requests++;
      if (requests === 3) freshRequest = received;
      if (retry && requests === 2) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Controlled effectful failure", type: "server_error" } }));
        return;
      }
      const tool = requests === 1 || (retry && requests === 3);
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      const deltas = tool ? [
        { role: "assistant", content: "PREAMBLE" },
        { tool_calls: [{ index: 0, id: `call-${requests}`, type: "function", function: { name: "pi_probe", arguments: "{}" } }] },
      ] : [{ role: "assistant", content: "FINAL" }];
      for (const delta of deltas) {
        response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        if (mode === "ordered" && "content" in delta && delta.content === "PREAMBLE") await preambleDisplayed.promise;
      }
      if (mode === "selective-loss" && requests === 2) await finalDisplayed.promise;
      response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const config = createSelectiveConfiguration({ id: "fixture", name: "Fixture", model: "probe", baseURL: `http://127.0.0.1:${address.port}/v1` });
    config.provider!.fixture.models!.probe.tool_call = true;
    const model: Model<string> = { id: "fixture/probe", name: "Fixture", api: "opencode-bridge", provider: "opencode-bridge", baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16000, maxTokens: 2000 };
    const tool = { name: "probe", description: "Controlled observer regression", parameters: Type.Object({}) };
    let seam: Awaited<ReturnType<typeof createProviderSeam>> | undefined;
    let agent: Agent | undefined;
    try {
      seam = await createProviderSeam({ config, authentication: { fixture: { type: "api", key: "synthetic" } }, tools: [tool], providerID: "fixture", modelID: "probe" });
      agent = new Agent({
        streamFn: (m, c, options) => {
          lastContext = c;
          return seam!.streamSimple(m, c, { ...options,
            onProviderStreamEvent: async () => { if ((retry || mode === "observer") && !paused) { paused = true; await releaseObserver.promise; } },
            onResponse: () => { finalResponse.resolve(); },
          });
        },
        initialState: { model, tools: [{ ...tool, label: "Probe", execute: async () => {
          executions++;
          return { content: [{ type: "text", text: "result" }], details: undefined };
        } }] },
      });
      t.signal.addEventListener("abort", () => { releaseObserver.resolve(); finalDisplayed.resolve(); preambleDisplayed.resolve(); agent?.abort(); }, { once: true });
      const events: string[] = [];
      agent.subscribe((event) => {
        if (event.type !== "message_update") return;
        events.push(event.assistantMessageEvent.type);
        if (event.assistantMessageEvent.type === "text_delta") {
          if (event.assistantMessageEvent.delta.includes("FINAL")) finalDisplayed.resolve();
          if (event.assistantMessageEvent.delta.includes("PREAMBLE")) preambleDisplayed.resolve();
        }
      });
      const prompt = agent.prompt("Run the observer regression.").then(() => { completed = true; });
      if (retry) {
        // Cancellation must complete while the observer is still held, not after it resumes.
        await prompt;
        assert.equal(executions, 1);
        assert.equal(requests, 2);
        const last = agent.state.messages.at(-1);
        assert.ok(last?.role === "assistant" && last.stopReason === "error");
      } else if (mode !== "ordered") {
        if (mode === "observer") {
          await finalResponse.promise;
          assert.equal(completed, false, "success must wait for accepted async observations");
          releaseObserver.resolve();
        }
        await prompt;
        if (mode !== "observer") assert.ok(removed > 0);
        assert.equal(requests, 2);
        assert.equal(executions, 1);
        const last = agent.state.messages.at(-1);
        assert.ok(last?.role === "assistant" && last.stopReason === "error");
        assert.match(last.errorMessage!, /no automatic replay/);
        if (mode === "selective-loss") assert.deepEqual(last.content, [{ type: "text", text: "FINAL" }]);
        const replay = await seam.streamSimple(model, lastContext!).result();
        assert.equal(replay.stopReason, "error");
        assert.equal(requests, 2, "failed context must not automatically replay");
        await agent.prompt("Start a new user-directed request.");
        const fresh = agent.state.messages.at(-1);
        assert.ok(fresh?.role === "assistant" && fresh.stopReason === "stop");
        assert.equal(requests, 3);
        assert.equal(executions, 1);
        const upstream = JSON.parse(freshRequest).messages as { role: string }[];
        assert.equal(upstream.some((message) => message.role === "assistant"), false, "failed native backend history must not be retained");
        assert.match(freshRequest, /Retained Pi conversation/, "new request must rebuild Pi-owned context");
      } else {
        await prompt;
        const transcript = agent.state.messages.map((message) => message.role === "toolResult" ? "<RESULT>" : message.role === "assistant"
          ? message.content.map((part) => part.type === "toolCall" ? "<TOOL>" : part.type === "text" ? part.text : "").join("") : "").join("");
        assert.equal(transcript, "PREAMBLE<TOOL><RESULT>FINAL");
        const messages = agent.state.messages.filter((message) => message.role === "assistant");
        assert.equal(messages.flatMap((message) => message.content.filter((part) => part.type === "text").map((part) => part.text)).join(""), "PREAMBLEFINAL");
        assert.equal(messages.reduce((sum, message) => sum + message.usage.input, 0), 20);
        assert.equal(messages.reduce((sum, message) => sum + message.usage.output, 0), 10);
        assert.equal(messages.at(-1)?.stopReason, "stop");
        assert.equal(executions, 1);
        assert.equal(requests, 2);
        assert.equal(events.filter((type) => type === "text_start").length, events.filter((type) => type === "text_end").length);
      }
      assert.equal(paused, retry || mode === "observer");
    } finally {
      releaseObserver.resolve();
      finalDisplayed.resolve();
      preambleDisplayed.resolve();
      agent?.abort();
      await seam?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
}
