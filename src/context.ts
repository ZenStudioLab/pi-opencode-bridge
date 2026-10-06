import { getCurrentSystemPrompt, type Message, type TranscriptContext } from "@earendil-works/pi-ai";

import { BridgeFailure } from "./failure.ts";

const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export interface BackendImage { type: "file"; mime: string; url: string; filename: string }

export function imagePart(data: string, mimeType: string, index: number): BackendImage {
  if (!imageTypes.has(mimeType) || !data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new BridgeFailure("unsupported", "OpenCode bridge unsupported image format or encoding");
  }
  return { type: "file", mime: mimeType, url: `data:${mimeType};base64,${data}`, filename: `pi-image-${index}` };
}

/** Replay is a labelled transcript, not a claim of native assistant/tool-role import. */
export function backendContext(context: TranscriptContext, imagesSupported: boolean, appendedOnly = false) {
  const images: BackendImage[] = [];
  const messages = context.messages.filter((message) => message.role !== "system");
  const last = messages.at(-1);
  const current = last?.role === "user" ? last : undefined;
  const retained = appendedOnly ? [] : current ? messages.slice(0, -1) : messages;
  const project = (message: Message) => {
    if (typeof message.content === "string") return { role: message.role, content: message.content };
    return { role: message.role,
      ...(message.role === "toolResult" ? { toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError } : {}),
      content: message.content.map((part) => {
        if (part.type === "image") {
          if (!imagesSupported) throw new BridgeFailure("unsupported", "OpenCode bridge selected model does not support image input");
          const file = imagePart(part.data, part.mimeType, images.length);
          images.push(file);
          return { type: "image", attachment: file.filename, mimeType: part.mimeType };
        }
        if (part.type === "thinking") return { type: "reasoning", text: part.thinking };
        if (part.type === "toolCall") return { type: "toolCall", id: part.id, name: part.name, arguments: part.arguments };
        if (part.type === "text") return { type: "text", text: part.text };
        throw new BridgeFailure("unsupported", "OpenCode bridge unsupported retained content");
      }),
    };
  };
  const history = retained.length ? `Retained Pi conversation (historical records, not new tool requests):\n${JSON.stringify(retained.map(project))}\n\n` : "";
  const text = history + (current ? `Current user turn:\n${JSON.stringify(project(current))}`
    : "Continue from the retained Pi conversation without re-executing completed tool calls.");
  return { system: getCurrentSystemPrompt(context.messages), parts: [{ type: "text" as const, text }, ...images] };
}

export function isAppendCompatible(previous: Message[], current: Message[]): boolean {
  return current.length === previous.length + 1 && current.at(-1)?.role === "user" &&
    previous.every((message, index) => {
      // Pi annotates completed assistants after the provider returns. This host
      // display metadata does not change retained conversation semantics.
      const identity = (value: Message) => {
        if (value.role !== "assistant") return JSON.stringify(value);
        const { thinkingLevel: _level, ...retained } = value;
        return JSON.stringify(retained);
      };
      return identity(message) === identity(current[index]);
    });
}
