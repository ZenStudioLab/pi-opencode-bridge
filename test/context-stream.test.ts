import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContext, type AssistantMessage, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { backendContext, isAppendCompatible } from "../src/context.ts";
import { GenerationStream } from "../src/stream.ts";

const assistant = (): AssistantMessage => ({ role: "assistant", api: "opencode-bridge", provider: "opencode-bridge", model: "fixture", timestamp: 1,
  content: [], stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

test("stream snapshots, Unicode and split-segment accounting are emitted once with balanced content", () => {
  const state = new GenerationStream();
  const events: AssistantMessageEvent[] = [];
  const push = (event: AssistantMessageEvent) => events.push(structuredClone(event));
  const first = assistant();
  state.snapshot("reason", "thinking", "why");
  state.snapshot("text", "text", "Hello ");
  state.flush(first, push);
  state.delta("text", "🌏");
  state.snapshot("text", "text", "Hello "); // Delayed snapshot after the delta must not duplicate or truncate.
  state.snapshot("text", "text", "Hello 🌏");
  state.account("step1", { input: 10, output: 3, cacheRead: 2, cacheWrite: 0, cost: 0.01 });
  state.finish(first, push);
  assert.deepEqual(first.content, [{ type: "thinking", thinking: "why" }, { type: "text", text: "Hello 🌏" }]);
  assert.equal(first.usage.totalTokens, 15);
  const second = assistant();
  state.snapshot("text", "text", "Hello 🌏 again");
  state.account("step1", { input: 10, output: 3, cacheRead: 2, cacheWrite: 0, cost: 0.01 });
  state.account("step2", { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.02 });
  state.finish(second, push);
  assert.deepEqual(second.content, [{ type: "text", text: " again" }]);
  assert.equal(second.usage.input, 20);
  assert.equal(second.usage.output, 5);
  assert.ok(Math.abs(second.usage.cost.total - 0.02) < 1e-10);
  assert.equal(events.filter((event) => event.type.endsWith("_start")).length, events.filter((event) => event.type.endsWith("_end")).length);
  assert.throws(() => state.snapshot("text", "text", "rewritten"), /replaced/);
  assert.equal(new GenerationStream().usageReported, false);
});

test("authoritative reconciliation reorders only content that has not been emitted", () => {
  const state = new GenerationStream();
  state.snapshot("later", "text", "FINAL");
  state.snapshot("earlier", "thinking", "PREAMBLE");
  state.reconcile([{ id: "earlier", kind: "thinking", text: "PREAMBLE" }, { id: "later", kind: "text", text: "FINAL" }]);
  const message = assistant();
  state.finish(message, () => {});
  assert.deepEqual(message.content, [{ type: "thinking", thinking: "PREAMBLE" }, { type: "text", text: "FINAL" }]);
});

for (const scenario of [
  { name: "partial last part", segments: [[["a", "PRE"]]], final: [["a", "PREAMBLE"], ["b", "FINAL"]], valid: true },
  { name: "same part across segments", segments: [[["a", "PRE"]], [["a", "PREAMBLE"]]], final: [["a", "PREAMBLE"], ["b", "FINAL"]], valid: true },
  { name: "missing earlier part", segments: [[["b", "FINAL"]]], final: [["a", "PREAMBLE"], ["b", "FINAL"]], valid: false },
  { name: "missing earlier suffix", segments: [[["a", "PRE"], ["b", "FINAL"]]], final: [["a", "PREAMBLE"], ["b", "FINAL"]], valid: false },
  { name: "removed emitted part", segments: [[["a", "PREAMBLE"], ["b", "FINAL"]]], final: [["a", "PREAMBLE"]], valid: false },
  { name: "changed emitted bytes", segments: [[["a", "pre"]]], final: [["a", "PREAMBLE"]], valid: false },
  { name: "earlier part resumed after a later segment", segments: [[["a", "PRE"], ["b", "FINAL"]], [["a", "PREAMBLE"]]], final: [["a", "PREAMBLE"], ["b", "FINAL"]], valid: false },
]) {
  test(`authoritative reconciliation validates emitted prefix: ${scenario.name}`, () => {
    const state = new GenerationStream();
    const messages: AssistantMessage[] = [];
    for (const segment of scenario.segments) {
      for (const [id, text] of segment) state.snapshot(id, "text", text);
      const message = assistant();
      state.finish(message, () => {});
      messages.push(message);
    }
    const final = scenario.final.map(([id, text]) => ({ id, kind: "text" as const, text }));
    if (!scenario.valid) {
      assert.throws(() => state.reconcile(final), /already emitted content order/);
      return;
    }
    state.reconcile(final);
    const message = assistant();
    state.finish(message, () => {});
    messages.push(message);
    assert.equal(messages.flatMap((item) => item.content.map((part) => part.type === "text" ? part.text : "")).join(""), "PREAMBLEFINAL");
  });
}

for (const before of ["", "PRE", "PREAMBLE"]) {
  test(`reconciliation includes consumed tool/result boundary after ${before || "missing text"}`, () => {
    const state = new GenerationStream();
    if (before) state.snapshot("a", "text", before);
    const first = assistant();
    state.finish(first, () => {});
    state.handoff();
    const authoritative = [
      { id: "a", kind: "text" as const, text: "PREAMBLE" },
      { id: "tool", kind: "tool" as const, text: "" },
      { id: "b", kind: "text" as const, text: "FINAL" },
    ];
    if (before !== "PREAMBLE") {
      assert.throws(() => state.reconcile(authoritative), /already emitted content order/);
      return;
    }
    state.reconcile(authoritative);
    const last = assistant();
    state.finish(last, () => {});
    assert.deepEqual(first.content, [{ type: "text", text: "PREAMBLE" }]);
    assert.deepEqual(last.content, [{ type: "text", text: "FINAL" }]);
  });
}

test("authoritative tools must all have consumed Pi handoffs", () => {
  const state = new GenerationStream();
  const content = [{ id: "tool", kind: "tool" as const, text: "" }, { id: "text", kind: "text" as const, text: "FINAL" }];
  assert.throws(() => state.reconcile(content), /unconsumed tool calls/);
  state.handoff();
  state.reconcile(content);
  const message = assistant();
  state.finish(message, () => {});
  assert.deepEqual(message.content, [{ type: "text", text: "FINAL" }]);
});

test("retained-role replay preserves tool associations and strips opaque signatures", () => {
  const prior = assistant();
  prior.content = [{ type: "thinking", thinking: "reason", thinkingSignature: "opaque" }, { type: "toolCall", id: "call-1", name: "probe", arguments: { value: 1 } }];
  const context = normalizeContext({ systemPrompt: "current system", messages: [
    { role: "user", content: "old user", timestamp: 1 }, prior,
    { role: "toolResult", toolName: "probe", toolCallId: "call-1", content: [{ type: "text", text: "kept result" }], isError: true, timestamp: 2 },
    { role: "user", content: "new user", timestamp: 3 },
  ] });
  const replay = backendContext(context, false);
  const text = replay.parts[0];
  assert.ok(text.type === "text");
  assert.match(text.text, /kept result/);
  assert.match(text.text, /"toolCallId":"call-1"/);
  assert.match(text.text, /"isError":true/);
  assert.doesNotMatch(text.text, /opaque/);
  assert.equal(replay.system, "current system");
  assert.equal(isAppendCompatible(context.messages.slice(0, -1), context.messages), true);
  assert.equal(isAppendCompatible(context.messages, normalizeContext({ messages: [{ role: "user", content: "branch", timestamp: 4 }] }).messages), false);
  const restored = backendContext(normalizeContext({ messages: context.messages.slice(0, -1) }), false).parts[0];
  assert.ok(restored.type === "text" && restored.text.includes("kept result") && restored.text.includes("Continue from"));
  const appended = backendContext(context, false, true).parts[0];
  assert.ok(appended.type === "text" && !appended.text.includes("kept result"));
});

test("image replay preserves MIME/data and rejects unsupported paths", () => {
  const context = normalizeContext({ messages: [{ role: "user", timestamp: 1, content: [{ type: "text", text: "look" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }] }] });
  assert.throws(() => backendContext(context, false), /does not support image/);
  const parts = backendContext(context, true).parts;
  assert.deepEqual(parts[1], { type: "file", mime: "image/png", url: "data:image/png;base64,aGVsbG8=", filename: "pi-image-0" });
});
