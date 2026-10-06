import { createHash } from "node:crypto";
import { fetchRuntime } from "./runtime-http.ts";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
  type StreamFunction,
  type Tool,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { Config } from "@opencode-ai/sdk";
import { BRIDGE_AGENT } from "./configuration.ts";
import { startOwnedRuntime, type OwnedRuntimeOptions } from "./runtime.ts";
import { createToolRelay, type PendingCall } from "./tool-relay.ts";

interface Turn {
  queue: PendingCall[];
  emitted?: PendingCall;
  wake?: () => void;
  session?: string;
  done: boolean;
  error?: Error;
  text: string;
  userKey: string;
  controller: AbortController;
  abortBindings: Set<() => void>;
  retirement?: Promise<void>;
}

/** Minimal qualified seam; catalog and retained-context lifecycle are separate follow-up work. */
export async function createProviderSeam(options: OwnedRuntimeOptions & {
  tools: Tool[];
  providerID: string;
  modelID: string;
}) {
  let turn: Turn | undefined;
  let closed = false;
  let monitored = true;
  let segmentBusy = false;
  const waiting = new Set<() => void>();
  const notify = (): void => { for (const wake of waiting) wake(); };
  const wait = (signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    const cleanup = (): void => { waiting.delete(wake); signal?.removeEventListener("abort", abort); };
    const wake = (): void => { cleanup(); resolve(); };
    const abort = (): void => { cleanup(); reject(new Error("Pi request aborted")); };
    waiting.add(wake);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  let failedContext: string | undefined;
  const relay = await createToolRelay(options.tools, (call) => {
    if (!turn || turn.done || turn.controller.signal.aborted) { call.cancel(); return; }
    turn.queue.push(call);
    turn.wake?.();
  });
  const config: Config = structuredClone(options.config);
  config.mcp = { pi: { type: "remote", url: relay.url, oauth: false } };
  const agent = config.agent?.[BRIDGE_AGENT];
  if (!agent) { await relay.close(); throw new Error("Bridge agent configuration missing"); }
  agent.tools = { "*": false, ...Object.fromEntries(options.tools.map((tool) => [`pi_${tool.name}`, true])) };
  let runtime: Awaited<ReturnType<typeof startOwnedRuntime>>;
  try { runtime = await startOwnedRuntime({ ...options, config }); }
  catch (error) { await relay.close(); throw error; }

  const cancel = (active: Turn): void => {
    if (active.controller.signal.aborted) return;
    active.controller.abort();
    for (const remove of active.abortBindings) remove();
    active.abortBindings.clear();
    active.error = new Error("Pi request aborted");
    active.done = true;
    const pending = active.queue.splice(0);
    if (active.emitted) pending.push(active.emitted);
    active.emitted = undefined;
    active.wake?.();
    notify();
    // Keep this generation's ownership until remote retirement is acknowledged.
    // On failure, stop the owned process before results can advance obsolete work.
    active.retirement = (async () => {
      try {
        if (active.session) {
          const response = await runtime.client.session.abort({ path: { id: active.session },
            signal: AbortSignal.timeout(3_000), throwOnError: true });
          if (response.data !== true) throw new Error("OpenCode retirement was not acknowledged");
        }
      } catch {
        monitored = false;
        await runtime.close();
      } finally {
        for (const call of pending) call.cancel();
      }
    })();
    active.retirement.then(() => { active.retirement = undefined; notify(); }, () => {
      monitored = false;
      notify();
    });
  };

  const bindAbort = (active: Turn, signal?: AbortSignal): void => {
    if (!signal || active.controller.signal.aborted) return;
    const abort = (): void => cancel(active);
    signal.addEventListener("abort", abort, { once: true });
    active.abortBindings.add(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  };

  // The public retry transition precedes OpenCode's delay/retry. Retire the entire generation,
  // including queued handoffs, before allowing any further Pi execution.
  const eventsController = new AbortController();
  let ready!: () => void;
  const connected = new Promise<void>((resolve) => { ready = resolve; });
  let eventPump: Promise<void>;
  try {
    const response = await fetchRuntime(`${runtime.url}/event`, { signal: eventsController.signal }).catch((error: Error & { cause?: { code?: string; message?: string } }) => {
      throw new Error(`OpenCode event connection failed at ${runtime.url} (${error.cause?.code ?? error.cause?.message ?? "unknown transport failure"})`);
    });
    if (!response.ok || !response.body) throw new Error("Cannot subscribe to OpenCode runtime events");
    eventPump = (async () => {
      let buffer = "";
      for await (const chunk of response.body!.pipeThrough(new TextDecoderStream())) {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          if (!data) continue;
          const event = JSON.parse(data);
          if (event.type === "server.connected") ready();
          if (turn && event.properties?.sessionID === turn.session &&
              ((event.type === "session.status" && event.properties.status?.type === "retry") || event.type === "session.error")) {
            cancel(turn);
          }
        }
      }
    })().finally(() => {
      if (!closed) {
        monitored = false;
        if (turn) cancel(turn);
        notify();
      }
    });
    eventPump.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([connected, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("OpenCode event subscription unavailable")), 3_000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  } catch (error) {
    eventsController.abort();
    await runtime.close();
    await relay.close();
    throw error;
  }

  const begin = (model: Model<string>, context: TranscriptContext, streamOptions: SimpleStreamOptions): Turn => {
    const active: Turn = { queue: [], done: false, text: "", userKey: JSON.stringify([...context.messages].reverse().find((message) => message.role === "user")), controller: new AbortController(), abortBindings: new Set() };
    bindAbort(active, streamOptions.signal);
    void (async () => {
      try {
        const session = await runtime.client.session.create({ body: { title: "Pi bridge inference" }, throwOnError: true, signal: active.controller.signal });
        active.session = session.data.id;
        // Wave 1 starts a fresh session; authoritative retained-role replay is implemented in Wave 2.
        const user = [...context.messages].reverse().find((message) => message.role === "user");
        const text = user && (typeof user.content === "string" ? user.content : user.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
        const body = {
          model: { providerID: options.providerID, modelID: options.modelID },
          agent: BRIDGE_AGENT,
          system: getCurrentSystemPrompt(context.messages),
          parts: [{ type: "text" as const, text: text || "Continue." }],
        };
        const replacement = await streamOptions.onPayload?.(body, model);
        const response = await runtime.client.session.prompt({
          path: { id: session.data.id }, body: (replacement ?? body) as typeof body,
          throwOnError: true, signal: active.controller.signal,
        });
        if (response.data.info.error) throw new Error("OpenCode inference failed");
        active.text = response.data.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
      } catch (error) {
        cancel(active);
        active.error = error instanceof Error ? error : new Error("OpenCode inference failed");
      } finally {
        active.done = true;
        active.wake?.();
        for (const remove of active.abortBindings) remove();
        active.abortBindings.clear();
      }
    })();
    return active;
  };

  const streamSimple: StreamFunction<string, SimpleStreamOptions> = (model, context, streamOptions = {}) => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: [], stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    void (async () => {
      let owned: Turn | undefined;
      try {
        if (closed || !monitored) throw new Error("OpenCode bridge is unavailable");
        const fingerprint = createHash("sha256").update(JSON.stringify(context.messages)).digest("hex");
        if (failedContext === fingerprint) throw new Error("Failed generation cannot resume automatically");
        const userKey = JSON.stringify([...context.messages].reverse().find((message) => message.role === "user"));
        // A generation holds the lane across tool segments. Only its matching result
        // may bypass independent requests waiting for the whole generation to finish.
        for (;;) {
          if (closed || !monitored) throw new Error("OpenCode bridge is unavailable");
          const result = turn && !turn.done && !turn.error && turn.userKey === userKey && turn.emitted &&
            context.messages.find((item) => item.role === "toolResult" && item.toolCallId === turn!.emitted!.call.id);
          if (!segmentBusy && result && result.role === "toolResult") {
            owned = turn!;
            segmentBusy = true;
            bindAbort(owned, streamOptions.signal);
            if (owned.error) throw owned.error;
            const call = owned.emitted!;
            owned.emitted = undefined;
            call.settle(result);
            break;
          }
          if (streamOptions.signal?.aborted) throw new Error("Pi request aborted");
          if (turn?.retirement) {
            await wait(streamOptions.signal);
            continue;
          }
          if (!segmentBusy && (!turn || (turn.error && turn.userKey !== userKey))) {
            owned = turn = begin(model, context, streamOptions);
            segmentBusy = true;
            break;
          }
          if (!segmentBusy && turn?.error) throw turn.error;
          await wait(streamOptions.signal);
        }
        const active = owned;
        stream.push({ type: "start", partial: message });
        while (!active.queue.length && !active.done) {
          await new Promise<void>((resolve) => { active.wake = resolve; });
          active.wake = undefined;
        }
        if (active.error) throw active.error;
        const call = active.queue.shift();
        if (call) {
          active.emitted = call;
          message.content.push(call.call);
          message.stopReason = "toolUse";
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call.call, partial: message });
        } else {
          message.content.push({ type: "text", text: active.text });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: active.text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: active.text, partial: message });
        }
        stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
        if (!call && turn === active) turn = undefined;
      } catch {
        if (owned) {
          failedContext = createHash("sha256").update(JSON.stringify(context.messages)).digest("hex");
          cancel(owned);
        }
        message.stopReason = streamOptions.signal?.aborted ? "aborted" : "error";
        message.errorMessage = message.stopReason === "aborted" ? "Pi request aborted" : "OpenCode bridge request failed; no automatic replay was performed";
        stream.push({ type: "error", reason: message.stopReason, error: message });
      } finally {
        if (owned) segmentBusy = false;
        notify();
        stream.end();
      }
    })();
    return stream;
  };
  return {
    pid: runtime.pid,
    streamSimple,
    async close() {
      if (closed) return;
      closed = true;
      notify();
      if (turn) cancel(turn);
      eventsController.abort();
      await eventPump.catch(() => undefined);
      await runtime.close();
      await turn?.retirement;
      await relay.close();
    },
  };
}
