import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Config } from "@opencode-ai/sdk";
import type { Tool } from "@earendil-works/pi-ai";
import { responsesToolNames } from "./responses-tool-names.ts";
import { requestFailure, type BridgeFailure } from "./failure.ts";

const MUSE = "muse-spark-1.3-contributor-free";
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

/** The qualified Responses route only; every other model retains its existing transport. */
export async function startInferenceRelay(config: Config, tools: readonly Tool[], providerID: string, modelID: string,
  environment: NodeJS.ProcessEnv = process.env,
  captureFailure?: () => ((failure: BridgeFailure) => void) | undefined) {
  if (providerID !== "opencode" || modelID !== MUSE) return undefined;
  const provider = config.provider?.opencode;
  // Pinned runtime supports model.provider.api; the SDK's v1 Config omits it.
  const modelProvider = provider?.models?.[modelID]?.provider as { npm?: string; api?: string } | undefined;
  const npm = modelProvider?.npm ?? provider?.npm;
  if (npm && npm !== "@ai-sdk/openai") return undefined;
  // Match OpenCode 1.18.29's endpoint precedence before installing our local URL.
  const configuredBase = provider?.options?.baseURL;
  const endpoint = typeof configuredBase === "string" && configuredBase !== "" ? configuredBase
    : modelProvider?.api ?? provider?.api ?? "https://opencode.ai/zen/v1";
  const expanded = endpoint.replace(/\$\{([^}]+)\}/g, (placeholder, name: string) => environment[name] ?? placeholder);
  let upstream: URL;
  try {
    if (/\$\{[^}]+\}/.test(expanded)) throw new Error();
    upstream = new URL(`${expanded.replace(/\/$/, "")}/responses`);
    if (!["http:", "https:"].includes(upstream.protocol)) throw new Error();
  } catch {
    throw new Error("OpenCode bridge configured inference endpoint is invalid or unresolved; no request was sent.");
  }
  const names = responsesToolNames(tools);
  const active = new Set<AbortController>();
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    const reportFailure = captureFailure?.(); // Capture ownership before asynchronous forwarding.
    let operation = "relay request processing";
    let reported = false;
    const report = (error: unknown): void => {
      if (reported || controller.signal.aborted) return;
      reported = true;
      reportFailure?.(requestFailure(error, operation));
    };
    active.add(controller);
    request.once("aborted", () => controller.abort());
    response.once("close", () => { if (!response.writableFinished) controller.abort(); });
    try {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404); response.end(); return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      names.request(body);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value === undefined || HOP_HEADERS.has(key) || ["host", "content-length", "accept-encoding"].includes(key)) continue;
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      operation = "upstream forwarding";
      const result = await fetch(upstream, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
      for (const [key, value] of result.headers) {
        if (!HOP_HEADERS.has(key) && !["content-length", "content-encoding"].includes(key)) response.setHeader(key, value);
      }
      response.statusCode = result.status;
      const contentType = result.headers.get("content-type") ?? "";
      if (result.ok && contentType.includes("application/json")) {
        operation = "upstream response processing";
        const value: unknown = await result.json();
        names.response(value);
        response.end(JSON.stringify(value));
      } else if (result.body) {
        operation = "upstream response streaming";
        const body = result.ok && contentType.includes("text/event-stream")
          ? result.body.pipeThrough(new TextDecoderStream()).pipeThrough(names.stream()).pipeThrough(new TextEncoderStream())
          : result.body;
        const source = Readable.from(body);
        // Capture the upstream cause before pipeline destroys the downstream response.
        source.once("error", report);
        await pipeline(source, response, { signal: controller.signal });
      } else response.end();
    } catch (error) {
      report(error);
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "OpenCode bridge inference transport failed" } }));
      } else response.destroy();
    } finally {
      controller.abort();
      active.delete(controller);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("Inference relay did not bind loopback"); }
  config.provider = { ...config.provider, opencode: { ...provider,
    options: { ...provider?.options, baseURL: `http://127.0.0.1:${address.port}/v1` } } };
  let closing: Promise<void> | undefined;
  return {
    baseURL: config.provider.opencode.options!.baseURL!,
    close(): Promise<void> {
      return closing ??= (async () => {
        for (const controller of active) controller.abort();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      })();
    },
  };
}
