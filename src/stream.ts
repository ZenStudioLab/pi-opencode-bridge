import type { AssistantMessage, AssistantMessageEvent, Usage } from "@earendil-works/pi-ai";
import { BridgeFailure } from "./failure.ts";

type ContentKind = "text" | "thinking";
interface Part { kind: ContentKind; text: string; emitted: number }
interface Accounting { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }

/** Generation-wide snapshots and accounting survive individual Pi tool-use segments. */
export class GenerationStream {
  private parts = new Map<string, Part>();
  private accounting = new Map<string, Accounting>();
  private charged: Accounting = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  private open = new Map<string, number>();
  private emittedParts: (string | null)[] = [];
  usageReported = false;

  snapshot(id: string, kind: ContentKind, text: string): void {
    const previous = this.parts.get(id);
    if (previous?.kind === kind && previous.text.startsWith(text)) return;
    if (previous && (previous.kind !== kind || !text.startsWith(previous.text))) {
      throw new Error("OpenCode replaced already retained stream content");
    }
    this.parts.set(id, { kind, text, emitted: previous?.emitted ?? 0 });
  }

  delta(id: string, text: string): void {
    const part = this.parts.get(id);
    if (!part) throw new Error("OpenCode delta has no declared content part");
    part.text += text;
  }

  handoff(): void {
    // The matching result precedes the next Pi segment. Both are a consumed
    // boundary even when no text was visible before this tool call.
    this.emittedParts.push(null);
  }

  reconcile(content: { id: string; kind: ContentKind | "tool"; text: string }[]): void {
    const ordered = new Map<string, Part>();
    for (const { id, kind, text } of content) if (kind !== "tool") {
      ordered.set(id, { kind, text, emitted: this.parts.get(id)?.emitted ?? 0 });
    }
    const nonempty = content.filter((part) => part.kind === "tool" || part.text.length > 0);
    // Earlier messages/segments cannot be rewritten after Pi has consumed them.
    // Only an authoritative extension of the actual emitted prefix is recoverable.
    for (const [index, id] of this.emittedParts.entries()) {
      const entry = nonempty[index];
      const prior = id === null ? undefined : this.parts.get(id)!;
      const compatible = id === null ? entry?.kind === "tool" :
        entry?.id === id && entry.kind === prior!.kind &&
        entry.text.startsWith(prior!.text.slice(0, prior!.emitted)) &&
        (index === this.emittedParts.length - 1 || prior!.emitted === entry.text.length);
      if (!compatible) {
        throw new BridgeFailure("stream", "OpenCode completed history conflicts with already emitted content order; no automatic replay was performed.");
      }
    }
    if (nonempty.filter((part) => part.kind === "tool").length !== this.emittedParts.filter((id) => id === null).length) {
      throw new BridgeFailure("stream", "OpenCode completed history has unconsumed tool calls; no automatic replay was performed.");
    }
    this.parts = ordered;
  }

  account(id: string, value: Accounting): void {
    if (Object.values(value).some((item) => !Number.isFinite(item) || item < 0)) throw new Error("Invalid OpenCode accounting");
    this.usageReported = true;
    const prior = this.accounting.get(id);
    this.accounting.set(id, prior ? {
      input: Math.max(prior.input, value.input), output: Math.max(prior.output, value.output),
      cacheRead: Math.max(prior.cacheRead, value.cacheRead), cacheWrite: Math.max(prior.cacheWrite, value.cacheWrite), cost: Math.max(prior.cost, value.cost),
    } : value);
  }

  flush(message: AssistantMessage, push: (event: AssistantMessageEvent) => void): void {
    for (const [id, part] of this.parts) {
      if (part.text.length === part.emitted) continue;
      let index = this.open.get(id);
      if (index === undefined) {
        index = message.content.length;
        this.open.set(id, index);
        if (this.emittedParts.at(-1) !== id) this.emittedParts.push(id);
        message.content.push(part.kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
        if (part.kind === "text") push({ type: "text_start", contentIndex: index, partial: message });
        else push({ type: "thinking_start", contentIndex: index, partial: message });
      }
      const delta = part.text.slice(part.emitted);
      part.emitted = part.text.length;
      const content = message.content[index];
      if (content.type === "text") {
        content.text += delta;
        push({ type: "text_delta", contentIndex: index, delta, partial: message });
      } else if (content.type === "thinking") {
        content.thinking += delta;
        push({ type: "thinking_delta", contentIndex: index, delta, partial: message });
      }
    }
  }

  finish(message: AssistantMessage, push: (event: AssistantMessageEvent) => void): void {
    this.flush(message, push);
    for (const index of this.open.values()) {
      const content = message.content[index];
      if (content.type === "text") push({ type: "text_end", contentIndex: index, content: content.text, partial: message });
      else if (content.type === "thinking") push({ type: "thinking_end", contentIndex: index, content: content.thinking, partial: message });
    }
    this.open.clear();
    const total = [...this.accounting.values()].reduce((sum, item) => ({
      input: sum.input + item.input, output: sum.output + item.output,
      cacheRead: sum.cacheRead + item.cacheRead, cacheWrite: sum.cacheWrite + item.cacheWrite, cost: sum.cost + item.cost,
    }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
    const usage: Usage = {
      input: Math.max(0, total.input - this.charged.input), output: Math.max(0, total.output - this.charged.output),
      cacheRead: Math.max(0, total.cacheRead - this.charged.cacheRead), cacheWrite: Math.max(0, total.cacheWrite - this.charged.cacheWrite),
      totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: Math.max(0, total.cost - this.charged.cost) },
    };
    usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    message.usage = usage;
    this.charged = total;
  }
}
