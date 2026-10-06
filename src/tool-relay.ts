import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

export interface PendingCall {
  call: ToolCall;
  settle(result: ToolResultMessage): void;
  cancel(): void;
}

/** MCP callbacks create handoffs only. Pi's executor remains the sole tool owner. */
export async function createToolRelay(tools: Tool[], accept: (pending: PendingCall) => void) {
  const snapshot = structuredClone(tools);
  const connections = new Set<Server>();
  const pending = new Set<PendingCall>();
  const http = createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    const server = new Server({ name: "pi-opencode-bridge", version: "0.0.0" }, { capabilities: { tools: {} } });
    connections.add(server);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: snapshot.map((tool) => ({
      name: tool.name, description: tool.description, inputSchema: tool.parameters as { type: "object" },
    })) }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = snapshot.find((tool) => tool.name === request.params.name);
      if (!tool) throw new Error("Undeclared Pi tool");
      return new Promise<CallToolResult>((resolve) => {
        let settled = false;
        const finish = (result: CallToolResult): void => {
          if (settled) return;
          settled = true;
          pending.delete(handoff);
          resolve(result);
        };
        const handoff: PendingCall = {
          call: { type: "toolCall", id: `pi-oc-${randomUUID()}`, name: tool.name, arguments: (request.params.arguments ?? {}) as ToolCall["arguments"] },
          settle(result) {
            if (result.toolCallId !== handoff.call.id || result.toolName !== tool.name) throw new Error("Pi tool result identity mismatch");
            finish({ isError: result.isError, content: result.content.map((part) => part.type === "text"
              ? { type: "text" as const, text: part.text }
              : { type: "image" as const, data: part.data, mimeType: part.mimeType }) });
          },
          cancel() { finish({ isError: true, content: [{ type: "text", text: "Pi handoff cancelled" }] }); },
        };
        pending.add(handoff);
        try { accept(handoff); } catch { handoff.cancel(); }
      });
    });
    response.once("close", () => { connections.delete(server); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) response.writeHead(500).end();
      else response.end();
      connections.delete(server);
      await server.close();
    }
  });
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Cannot bind Pi MCP relay");
  return {
    url: `http://127.0.0.1:${address.port}`,
    cancel() { for (const call of pending) call.cancel(); },
    async close() {
      for (const call of pending) call.cancel();
      await Promise.all([...connections].map((server) => server.close()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
