import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Model, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createSelectiveConfiguration } from "../src/configuration.ts";
import { createProviderSeam } from "../src/provider-seam.ts";

for (const scenario of [{ count: 0 }, { count: 1 }, { count: 2 }, { count: 1, transientFailure: true }, { count: 1, cancelWhileTool: true }, { count: 1, terminateServer: true }]) {
  const { count } = scenario;
  test(`real Pi loop handles ${count} backend calls${scenario.transientFailure ? " with effectful retry retirement" : scenario.cancelWhileTool ? " with cancellation" : scenario.terminateServer ? " with server termination" : ""} in single-request segments`, { timeout: 30_000 }, async () => {
    let requests = 0;
    let observedResults: Array<{ tool_call_id: string; content: string }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests++;
      observedResults = body.messages.filter((message: { role: string }) => message.role === "tool");
      if (scenario.transientFailure && requests === 2) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Controlled temporary failure", type: "server_error" } }));
        return;
      }
      const call = count > 0 && requests === 1;
      const delta = call ? { role: "assistant", tool_calls: Array.from({ length: count }, (_, index) => ({
        index, id: `backend-${index}`, type: "function", function: { name: "pi_probe", arguments: '{"value":"identical"}' },
      })) } : { role: "assistant", content: "done" };
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end([
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] })}`,
        "data: [DONE]", "",
      ].join("\n\n"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const tool = { name: "probe", description: "Synthetic exactly-once probe", parameters: Type.Object({ value: Type.String() }) };
    const model: Model<string> = {
      id: "fixture/probe", name: "Fixture", api: "opencode-bridge", provider: "opencode-bridge",
      baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16_000, maxTokens: 2_000,
    };
    const config = createSelectiveConfiguration({ id: "fixture", name: "Fixture", model: "probe", baseURL: `http://127.0.0.1:${address.port}/v1` });
    config.provider!.fixture.models!.probe.tool_call = true;
    let seam: Awaited<ReturnType<typeof createProviderSeam>> | undefined;
    try {
      seam = await createProviderSeam({ config, authentication: { fixture: { type: "api", key: "synthetic-key" } }, tools: [tool], providerID: "fixture", modelID: "probe" });
      const executed: string[] = [];
      const before: string[] = [];
      const after: string[] = [];
      const agent: Agent = new Agent({
        streamFn: seam.streamSimple,
        initialState: { model, systemPrompt: "Use the controlled tool when requested.", tools: [{
          ...tool, label: "Probe",
          execute: async (id, args, signal) => {
            assert.deepEqual(args, { value: "identical" });
            executed.push(id);
            if (scenario.cancelWhileTool) {
              await new Promise<void>((resolve) => {
                signal?.addEventListener("abort", () => resolve(), { once: true });
                setImmediate(() => agent.abort());
              });
            }
            if (scenario.terminateServer) process.kill(seam!.pid, "SIGTERM");
            if (executed.length === 2) throw new Error("controlled-tool-failure");
            return { content: [{ type: "text", text: `result-${executed.length}` }], details: undefined };
          },
        }] },
        beforeToolCall: async (context) => { before.push(context.toolCall.id); return undefined; },
        afterToolCall: async (context) => { after.push(context.toolCall.id); return undefined; },
      });
      const timer = setTimeout(() => agent.abort(), 10_000);
      try { await agent.prompt("Run the controlled scenario."); }
      finally { clearTimeout(timer); }
      if (!scenario.transientFailure && !scenario.cancelWhileTool && !scenario.terminateServer) assert.equal(agent.state.errorMessage, undefined);
      assert.equal(executed.length, count);
      assert.equal(new Set(executed).size, count);
      assert.deepEqual(before, executed);
      assert.deepEqual(after, executed);
      const messages = agent.state.messages.filter((message) => message.role === "assistant");
      assert.equal(messages.length, count + 1);
      const emitted = messages.flatMap((message) => message.content.filter((part): part is ToolCall => part.type === "toolCall"));
      assert.deepEqual(emitted.map((call) => call.id), executed);
      assert.ok(messages.every((message) => message.content.filter((part) => part.type === "toolCall").length <= 1));
      if (scenario.cancelWhileTool) {
        assert.equal(requests, 1);
        assert.equal(messages.at(-1)?.stopReason, "aborted");
      }
      else if (scenario.transientFailure || scenario.terminateServer) assert.equal(messages.at(-1)?.stopReason, "error");
      else assert.equal(messages.at(-1)?.content.filter((part) => part.type === "text").map((part) => part.text).join(""), "done");
      assert.equal(requests, scenario.cancelWhileTool || scenario.terminateServer ? 1 : count ? 2 : 1, "continuations must resume the same OpenCode request, not issue a prompt per tool");
      assert.equal(observedResults.length, scenario.cancelWhileTool || scenario.terminateServer ? 0 : count);
      if (count && !scenario.cancelWhileTool && !scenario.terminateServer) {
        assert.equal(observedResults[0].tool_call_id, "backend-0");
        assert.match(observedResults[0].content, /result-1/);
      }
      if (scenario.cancelWhileTool) {
        // Historical tool results must not claim the retired generation on a new user turn.
        for (const prompt of ["First fresh request after cancellation.", "Second fresh request after cancellation."]) {
          await agent.prompt(prompt);
          const last = agent.state.messages.at(-1);
          assert.ok(last?.role === "assistant" && last.stopReason === "stop");
        }
        assert.equal(requests, 3);
        assert.equal(executed.length, 1, "recovery must not replay the cancelled tool");
      }
      if (scenario.transientFailure) {
        // Reusing the same failed context must not restart inference (host retry simulation).
        const context = { messages: agent.state.messages.slice(0, -1) };
        const replay = await seam.streamSimple(model, context as Parameters<typeof seam.streamSimple>[1]).result();
        assert.equal(replay.stopReason, "error");
        assert.equal(requests, 2);
        const recoveryTimer = setTimeout(() => agent.abort(), 10_000);
        try { await agent.prompt("Fresh user-directed recovery request."); }
        finally { clearTimeout(recoveryTimer); }
        assert.equal(requests, 3);
        assert.equal(executed.length, 1);
        assert.equal(agent.state.messages.at(-1)?.role, "assistant");
        const last = agent.state.messages.at(-1);
        assert.ok(last?.role === "assistant" && last.stopReason === "stop");
      }
      if (count === 2) {
        assert.equal(observedResults[1].tool_call_id, "backend-1");
        assert.match(observedResults[1].content, /controlled-tool-failure/);
        const result = agent.state.messages.find((message) => message.role === "toolResult" && message.toolCallId === executed[1]);
        assert.ok(result?.role === "toolResult" && result.isError);
      }
    } finally {
      await seam?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
