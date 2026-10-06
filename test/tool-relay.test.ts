import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "typebox";
import { createToolRelay } from "../src/tool-relay.ts";
import type { PendingCall } from "../src/tool-relay.ts";

test("relay rejects undeclared tools and settles cancelled handoffs without executing tools", { timeout: 5_000 }, async () => {
  const accepted: PendingCall[] = [];
  let arrived!: () => void;
  const arrival = new Promise<void>((resolve) => { arrived = resolve; });
  const relay = await createToolRelay([{ name: "probe", description: "Controlled", parameters: Type.Object({}) }], (call) => {
    accepted.push(call);
    arrived();
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(relay.url)));
    await assert.rejects(client.callTool({ name: "native_bash", arguments: {} }), /Undeclared Pi tool/);
    assert.equal(accepted.length, 0);
    const result = client.callTool({ name: "probe", arguments: {} });
    await arrival;
    assert.equal(accepted.length, 1);
    relay.cancel();
    assert.equal((await result).isError, true);
    // A late Pi result cannot revive a settled callback.
    accepted[0].settle({ role: "toolResult", toolCallId: accepted[0].call.id, toolName: "probe", content: [{ type: "text", text: "late" }], isError: false, timestamp: Date.now() });
  } finally {
    await client.close();
    await relay.close();
  }
});
