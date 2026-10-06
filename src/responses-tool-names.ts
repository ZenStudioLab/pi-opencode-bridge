import type { Tool } from "@earendil-works/pi-ai";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);

/** Only the current Pi declarations can acquire an upstream name or map back to MCP. */
export function responsesToolNames(tools: readonly Tool[]) {
  const outgoing = new Map(tools.map(({ name }) => [`pi_${name}`, name]));
  const incoming = new Map(tools.map(({ name }) => [name, `pi_${name}`]));
  const rename = (item: unknown, names: Map<string, string>): void => {
    if (object(item) && typeof item.name === "string" && names.has(item.name)) item.name = names.get(item.name);
  };
  const response = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(response); return; }
    if (!object(value)) return;
    if (value.type === "function_call") { rename(value, incoming); return; }
    // Visit protocol containers only, never argument strings, metadata or text.
    if (Array.isArray(value.output)) value.output.forEach(response);
    if (object(value.response)) response(value.response);
    if (typeof value.type === "string" && value.type.startsWith("response.output_item.") && object(value.item)) response(value.item);
  };
  return {
    request(value: unknown): void {
      if (!object(value)) throw new Error("Invalid Responses request");
      if (Array.isArray(value.tools)) {
        for (const tool of value.tools) if (object(tool) && tool.type === "function") rename(tool, outgoing);
      }
      if (object(value.tool_choice) && value.tool_choice.type === "function") rename(value.tool_choice, outgoing);
      if (Array.isArray(value.input)) {
        for (const item of value.input) if (object(item) && item.type === "function_call") rename(item, outgoing);
      }
    },
    response,
    stream(): TransformStream<string, string> {
      let pending = "";
      const rewrite = (event: string): string => {
        const lines = event.split(/\r?\n/);
        const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data || data.trim() === "[DONE]") return event;
        const value: unknown = JSON.parse(data);
        response(value);
        let inserted = false;
        return lines.flatMap(line => {
          if (!line.startsWith("data:")) return [line];
          if (inserted) return [];
          inserted = true;
          return [`data: ${JSON.stringify(value)}`];
        }).join("\n");
      };
      return new TransformStream({
        transform(chunk, controller) {
          pending += chunk;
          let delimiter: RegExpExecArray | null;
          while ((delimiter = /\r?\n\r?\n/.exec(pending))) {
            controller.enqueue(rewrite(pending.slice(0, delimiter.index)) + "\n\n");
            pending = pending.slice(delimiter.index + delimiter[0].length);
          }
        },
        flush(controller) {
          if (pending) controller.enqueue(rewrite(pending));
        },
      });
    },
  };
}
