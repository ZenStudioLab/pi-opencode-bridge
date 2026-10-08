import assert from "node:assert/strict";
import { test } from "node:test";
import { backendFailure, failureDetails, renderFailure, requestFailure } from "../src/failure.ts";

const context = { operation: "upstream forwarding", model: "opencode/muse-spark-1.3-contributor-free" };

test("diagnostics retain source wording, nested transport cause and operation", () => {
  const error = new TypeError("fetch failed", { cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET" }) });
  const failure = requestFailure(error, "upstream forwarding");
  const text = renderFailure(failure, { ...context, operation: "cleanup" });
  assert.match(text, /^OpenCode request failed: upstream forwarding/);
  assert.match(text, /Model: opencode\/muse-spark-1.3-contributor-free/);
  assert.match(text, /Cause: TypeError: fetch failed/);
  assert.match(text, /Code: ECONNRESET/);
  assert.match(text, /Underlying cause: Error: ECONNRESET: connection reset/);
  assert.match(text, /Tools: no handoff issued/);
  assert.doesNotMatch(text, /HTTP:|access denied/);
});

test("structured non-Error failures retain status and known domain classification", () => {
  for (const [status, name, message, expected] of [
    [401, "APIError", "Credentials rejected", "access"],
    [403, "APIError", "Denied", "access"],
    [429, "APIError", "Too many requests", "rate"],
    [400, "ContextOverflowError", "Context length exceeded", "context"],
    [502, "APIError", "Bad gateway", "backend"],
  ] as const) {
    const failure = backendFailure({ name, data: { statusCode: status, message } });
    assert.equal(failure.kind, expected);
    const text = renderFailure(failure, context);
    assert.ok(text.includes(`HTTP: ${status}`));
    assert.ok(text.includes(`Cause: ${name}: ${message}`));
  }
  const free = backendFailure({ data: { statusCode: 403, responseBody: '{"error":{"type":"FreeTierError"}}' } });
  assert.match(free.message, /free-tier client restriction/);
  assert.doesNotMatch(free.message, /authentication/);
});

test("diagnostics exclude credential, URL and payload sentinels without losing safe codes", () => {
  for (const message of [
    "fetch failed https://user:URL_SECRET@host/path?api_key=QUERY_SECRET",
    "connection failed Authorization: Bearer HEADER_SECRET",
    "failed cookie=COOKIE_SECRET",
    "failed api_key=API_SECRET",
    "failed Bearer BARE_SECRET",
    'bad input {"prompt":"PAYLOAD_SECRET"}',
    "prompt: PROMPT_SECRET",
    "tool results=TOOL_SECRET",
    "Unexpected token 'PARSE_SECRET'",
  ]) {
    const text = renderFailure(Object.assign(new Error(message), { code: "ECONNRESET" }), context);
    assert.doesNotMatch(text, /(?:URL|QUERY|HEADER|COOKIE|API|BARE|PAYLOAD|PROMPT|TOOL|PARSE)_SECRET/);
    assert.match(text, /redacted|withheld/);
    assert.match(text, /Code: ECONNRESET/);
  }
  const text = renderFailure({ name: "APIError", data: { message: "Bad gateway", statusCode: 502,
    responseBody: "BODY_SECRET", headers: { authorization: "HEADER_SECRET" }, request: "REQUEST_SECRET" } }, context);
  assert.match(text, /Bad gateway/);
  assert.doesNotMatch(text, /SECRET/);
});

test("oversized, cyclic, missing and throwing metadata stays bounded and nonthrowing", () => {
  const cyclic = Object.assign(new Error("x".repeat(2000)), { cause: undefined as unknown });
  cyclic.cause = cyclic;
  const text = renderFailure(cyclic, context);
  assert.ok(text.length < 1500);
  assert.match(text, /truncated/);
  assert.match(text, /cause detail truncated/);
  for (const value of [null, 42, {}, { get data() { throw new Error("GETTER_SECRET"); } }]) {
    assert.match(renderFailure(value, context), /detail unavailable/);
  }
  assert.equal(failureDetails("connection closed").message, "connection closed");
});

test("replay and handoff diagnostics distinguish unknown effects from returned results", () => {
  const failure = requestFailure(new Error("connection reset"), "prompt submission");
  const waiting = renderFailure(failure, { ...context, handoffs: 1, results: 0 });
  assert.match(waiting, /execution may have occurred without a returned result/);
  const blocked = renderFailure(failure, { ...context, handoffs: 1, results: 1, blocked: true });
  assert.match(blocked, /failed: blocked replay/);
  assert.match(blocked, /Original operation: prompt submission/);
  assert.match(blocked, /returned results do not imply success/);
  assert.match(blocked, /No automatic replay/);
});
