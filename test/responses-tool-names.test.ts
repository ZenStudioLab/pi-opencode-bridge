import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { responsesToolNames } from "../src/responses-tool-names.ts";
import { backendFailure } from "../src/failure.ts";

const tools = [{ name: "read", description: "Read a fixture", parameters: Type.Object({ path: Type.String() }) }];

test("Responses aliases only declared tool names, preserving arguments, IDs and results", () => {
  const names = responsesToolNames(tools);
  const request = {
    tools: [{ type: "function", name: "pi_read", parameters: { description: "pi_read" } }, { type: "function", name: "pi_other" }],
    tool_choice: { type: "function", name: "pi_read" },
    input: [{ type: "function_call", name: "pi_read", call_id: "call1", arguments: '{"path":"pi_read"}' },
      { type: "function_call_output", call_id: "call1", output: "pi_read" }],
  };
  names.request(request);
  assert.deepEqual(request, {
    tools: [{ type: "function", name: "read", parameters: { description: "pi_read" } }, { type: "function", name: "pi_other" }],
    tool_choice: { type: "function", name: "read" },
    input: [{ type: "function_call", name: "read", call_id: "call1", arguments: '{"path":"pi_read"}' },
      { type: "function_call_output", call_id: "call1", output: "pi_read" }],
  });
  const response = { output: [{ type: "function_call", name: "read", call_id: "call1", arguments: '{"path":"read"}' },
    { type: "function_call", name: "other" }] };
  names.response(response);
  assert.deepEqual(response.output, [{ type: "function_call", name: "pi_read", call_id: "call1", arguments: '{"path":"read"}' },
    { type: "function_call", name: "other" }]);
});

test("fragmented Responses SSE maps calls and completion without altering text or argument deltas", async () => {
  const events = [
    { type: "response.output_item.added", item: { type: "function_call", name: "read", call_id: "call1", arguments: "" } },
    { type: "response.function_call_arguments.delta", delta: '{"path":"read"}' },
    { type: "response.output_text.delta", delta: "read" },
    { type: "response.completed", response: { output: [{ type: "function_call", name: "read" }], usage: { input_tokens: 12 } } },
  ];
  const input = events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
  const source = new ReadableStream<string>({ start(controller) {
    for (let i = 0; i < input.length; i += 3) controller.enqueue(input.slice(i, i + 3));
    controller.close();
  } });
  let output = "";
  for await (const chunk of source.pipeThrough(responsesToolNames(tools).stream())) output += chunk;
  const parsed = output.trim().split("\n\n").slice(0, -1).map(frame => JSON.parse(frame.slice(6)));
  assert.deepEqual(parsed, [
    { ...events[0], item: { type: "function_call", name: "pi_read", call_id: "call1", arguments: "" } },
    events[1], events[2],
    { type: "response.completed", response: { output: [{ type: "function_call", name: "pi_read" }], usage: { input_tokens: 12 } } },
  ]);
  assert.ok(output.endsWith("data: [DONE]\n\n"));
});

test("free-tier denial is not misreported as missing authentication", () => {
  const failure = backendFailure({ name: "APIError", data: { statusCode: 403,
    responseBody: JSON.stringify({ error: { type: "FreeTierError", message: "private provider payload" } }) } });
  assert.equal(failure.kind, "access");
  assert.match(failure.message, /free-tier client restriction/);
  assert.doesNotMatch(failure.message, /authentication|private provider payload/);
  assert.match(backendFailure({ data: { statusCode: 403, responseBody: "not JSON" } }).message, /authentication/);
});
