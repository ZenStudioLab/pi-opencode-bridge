import { createHash, randomUUID } from "node:crypto";
import { fetchRuntime } from "./runtime-http.ts";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type Message,
  type SimpleStreamOptions,
  type StreamFunction,
  type Tool,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { Config } from "@opencode-ai/sdk";
import { backendFailure, BridgeFailure, requestFailure, renderFailure } from "./failure.ts";
import { GenerationStream } from "./stream.ts";
import { backendContext, imagePart, isAppendCompatible } from "./context.ts";
import { BRIDGE_AGENT } from "./configuration.ts";
import { startOwnedRuntime, type OwnedRuntimeOptions } from "./runtime.ts";
import { createToolRelay, type PendingCall } from "./tool-relay.ts";
import { startInferenceRelay } from "./inference-relay.ts";

interface Turn {
  queue: PendingCall[];
  emitted?: PendingCall;
  wake?: () => void;
  session?: string;
  done: boolean;
  error?: Error;
  diagnostic?: BridgeFailure;
  handoffs: number;
  results: number;
  output: GenerationStream;
  finish: "stop" | "length";
  requestID: string;
  assistantIDs: Set<string>;
  observe?: (event: unknown) => Promise<void>;
  observations: Promise<void>;
  observationsClosed: boolean;
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
  let unavailableReason = "OpenCode runtime monitoring or retirement failed; reload the bridge before a new request.";
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
  let failedContext: { fingerprint: string; failure: BridgeFailure; handoffs: number; results: number } | undefined;
  let retained: { session: string; messages: Message[] } | undefined;
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
  let inferenceRelay: Awaited<ReturnType<typeof startInferenceRelay>>;
  let startupOperation = "inference relay startup";
  try {
    inferenceRelay = await startInferenceRelay(config, options.tools, options.providerID, options.modelID,
      { ...process.env, ...options.environment }, () => {
        const active = turn;
        return (failure) => {
          if (active && turn === active && !active.done && !active.controller.signal.aborted) active.diagnostic ??= failure;
        };
      });
    startupOperation = "runtime startup";
    runtime = await startOwnedRuntime({ ...options, config });
  } catch (error) {
    await inferenceRelay?.close();
    await relay.close();
    throw requestFailure(error, startupOperation);
  }

  const cancel = (active: Turn): void => {
    if (active.controller.signal.aborted) return;
    retained = undefined;
    active.controller.abort();
    for (const remove of active.abortBindings) remove();
    active.abortBindings.clear();
    active.error ??= new Error("Pi request aborted");
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

  const observe = (active: Turn, event: unknown, apply: () => void): void => {
    if (active.observationsClosed) return;
    // Instrumentation is ordered and precedes normalization, but never blocks
    // the independent reader responsible for retry/cancellation supervision.
    active.observations = active.observations.then(async () => {
      if (active.controller.signal.aborted) return;
      try { await active.observe?.(event); }
      catch (error) { throw requestFailure(error, "stream observation"); }
      if (active.controller.signal.aborted) return;
      try { apply(); }
      catch (error) { throw requestFailure(error, "stream normalization"); }
      active.wake?.();
    }).catch((error) => {
      if (active.controller.signal.aborted) return;
      active.diagnostic ??= requestFailure(error, "stream observation");
      active.error = active.diagnostic;
      cancel(active);
    });
  };

  // The public retry transition precedes OpenCode's delay/retry. Retire the entire generation,
  // including queued handoffs, before allowing any further Pi execution.
  const eventsController = new AbortController();
  let ready!: () => void;
  const connected = new Promise<void>((resolve) => { ready = resolve; });
  let eventPump: Promise<void>;
  try {
    const response = await fetchRuntime(`${runtime.url}/event`, { signal: eventsController.signal });
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
          const changedSession = event.properties?.sessionID ?? event.properties?.part?.sessionID;
          const transformed = ["session.compacted", "message.removed", "message.part.removed"].includes(event.type) ||
            event.properties?.part?.type === "compaction" || event.properties?.part?.state?.time?.compacted;
          if (transformed && changedSession && (changedSession === turn?.session || changedSession === retained?.session)) {
            retained = undefined;
            monitored = false;
            unavailableReason = "OpenCode backend history changed unexpectedly; reload the bridge to rebuild Pi-owned context.";
            if (turn) {
              turn.diagnostic ??= requestFailure(new Error(unavailableReason), "backend history monitoring");
              turn.error = turn.diagnostic;
              cancel(turn);
            }
            notify();
          }
          const active = turn;
          if (active?.session && !active.done) {
            const info = event.properties?.info;
            const part = event.properties?.part;
            if (info?.sessionID === active.session && info.role === "assistant" && info.parentID === active.requestID) {
              active.assistantIDs.add(info.id);
              observe(active, event, () => {
                if (info.tokens && info.time?.completed) active.output.account(info.id, { input: info.tokens.input, output: info.tokens.output,
                  cacheRead: info.tokens.cache?.read ?? 0, cacheWrite: info.tokens.cache?.write ?? 0, cost: info.cost ?? 0 });
              });
            }
            if (event.type === "message.part.delta" && event.properties.sessionID === active.session &&
                active.assistantIDs.has(event.properties.messageID) && event.properties.field === "text") {
              observe(active, event, () => active.output.delta(event.properties.partID, event.properties.delta));
            }
            if (part?.sessionID === active.session && active.assistantIDs.has(part.messageID)) {
              if (part.type === "text" || part.type === "reasoning") {
                observe(active, event, () => active.output.snapshot(part.id, part.type === "text" ? "text" : "thinking", part.text));
              }
            }
          }
          if (turn && event.properties?.sessionID === turn.session &&
              ((event.type === "session.status" && event.properties.status?.type === "retry") || event.type === "session.error")) {
            if (!turn.controller.signal.aborted) {
              turn.diagnostic ??= requestFailure(backendFailure(event.properties.error ?? event.properties.status), "backend inference");
              turn.error = turn.diagnostic;
              cancel(turn);
            }
          }
        }
      }
    })().catch((error) => {
      if (turn && !closed && !turn.controller.signal.aborted) {
        turn.diagnostic ??= requestFailure(error, "event monitoring");
        turn.error = turn.diagnostic;
      }
      throw error;
    }).finally(() => {
      if (!closed) {
        monitored = false;
        if (turn && !turn.controller.signal.aborted) {
          turn.diagnostic ??= requestFailure(new Error(unavailableReason), "event monitoring");
          turn.error = turn.diagnostic;
          cancel(turn);
        }
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
    await inferenceRelay?.close();
    await relay.close();
    throw requestFailure(error, "event connection");
  }

  const begin = (model: Model<string>, context: TranscriptContext, streamOptions: SimpleStreamOptions): Turn => {
    const active: Turn = { queue: [], done: false, handoffs: 0, results: 0, observations: Promise.resolve(), observationsClosed: false, output: new GenerationStream(), finish: "stop", requestID: `msg_${randomUUID().replaceAll("-", "")}`, assistantIDs: new Set(),
      observe: streamOptions.onProviderStreamEvent ? async (event) => { await streamOptions.onProviderStreamEvent!(event, model); } : undefined,
      userKey: JSON.stringify([...context.messages].reverse().find((message) => message.role === "user")), controller: new AbortController(), abortBindings: new Set() };
    bindAbort(active, streamOptions.signal);
    void (async () => {
      let operation = "context preparation";
      try {
        const compatible = retained && isAppendCompatible(retained.messages, context.messages);
        const prompt = backendContext(context, model.input.includes("image"), !!compatible);
        operation = "session creation";
        active.session = compatible ? retained!.session : (await runtime.client.session.create({
          body: { title: "Pi bridge inference" }, throwOnError: true, signal: active.controller.signal,
        })).data.id;
        const body = {
          model: { providerID: options.providerID, modelID: options.modelID },
          agent: BRIDGE_AGENT, messageID: active.requestID, ...prompt,
        };
        operation = "payload observation";
        const replacement = await streamOptions.onPayload?.(body, model);
        operation = "prompt submission";
        const response = await runtime.client.session.prompt({
          path: { id: active.session }, body: (replacement ?? body) as typeof body,
          throwOnError: true, signal: active.controller.signal,
          fetch: async (request) => {
            const response = await fetchRuntime(request);
            try { await streamOptions.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model); }
            catch (error) { throw requestFailure(error, "response observation"); }
            return response;
          },
        });
        operation = "response processing";
        if (response.data.info.error) throw backendFailure(response.data.info.error);
        active.finish = response.data.info.finish === "length" ? "length" : "stop";
        active.observationsClosed = true;
        // Only final success waits for observers; cancellation remains responsive.
        await new Promise<void>((resolve, reject) => {
          const abort = (): void => { cleanup(); reject(active.error ?? new Error("Pi request aborted")); };
          const cleanup = (): void => active.controller.signal.removeEventListener("abort", abort);
          active.controller.signal.addEventListener("abort", abort, { once: true });
          active.observations.then(() => { cleanup(); resolve(); }, (error) => { cleanup(); reject(error); });
          if (active.controller.signal.aborted) abort();
        });
        // Prompt returns only the final assistant. Persisted request-owned history
        // is the completion boundary for all earlier steps, independent of SSE lag.
        operation = "completed-history retrieval";
        const history = await runtime.client.session.messages({ path: { id: active.session },
          throwOnError: true, signal: active.controller.signal });
        operation = "completed-history reconciliation";
        const ownedMessages = history.data.filter((entry) => entry.info.role === "assistant" && entry.info.parentID === active.requestID)
          .sort((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id));
        if (!ownedMessages.some((entry) => entry.info.id === response.data.info.id)) throw new BridgeFailure("stream", "OpenCode completed history is unavailable; no automatic replay was performed.");
        const content: { id: string; kind: "text" | "thinking" | "tool"; text: string }[] = [];
        for (const entry of ownedMessages) {
          const info = entry.info;
          if (info.role !== "assistant") continue;
          if (info.error) throw backendFailure(info.error);
          active.output.account(info.id, { input: info.tokens.input, output: info.tokens.output,
            cacheRead: info.tokens.cache.read, cacheWrite: info.tokens.cache.write, cost: info.cost });
          for (const part of entry.parts) if (part.type === "text" || part.type === "reasoning" || part.type === "tool") {
            content.push({ id: part.id, kind: part.type === "reasoning" ? "thinking" : part.type, text: part.type === "tool" ? "" : part.text });
          }
        }
        active.output.reconcile(content);
      } catch (error) {
        active.diagnostic ??= requestFailure(error, operation);
        active.error = active.diagnostic;
        cancel(active);
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
      let started = false;
      let blocked = false;
      let rejected: Turn | undefined;
      let operation = "request availability";
      try {
        const fingerprint = createHash("sha256").update(JSON.stringify(context.messages)).digest("hex");
        if (failedContext?.fingerprint === fingerprint) { blocked = true; throw failedContext.failure; }
        if (closed || !monitored) throw new Error(unavailableReason);
        const userKey = JSON.stringify([...context.messages].reverse().find((message) => message.role === "user"));
        // A generation holds the lane across tool segments. Only its matching result
        // may bypass independent requests waiting for the whole generation to finish.
        for (;;) {
          if (closed || !monitored) throw new Error(unavailableReason);
          const result = turn && !turn.done && !turn.error && turn.userKey === userKey && turn.emitted &&
            context.messages.find((item) => item.role === "toolResult" && item.toolCallId === turn!.emitted!.call.id);
          if (!segmentBusy && result && result.role === "toolResult") {
            owned = turn!;
            segmentBusy = true;
            bindAbort(owned, streamOptions.signal);
            operation = "tool-result continuation";
            owned.results++;
            if (owned.error) throw owned.error;
            for (const part of result.content) if (part.type === "image") {
              if (!model.input.includes("image")) throw new BridgeFailure("unsupported", "OpenCode bridge selected model does not support image results");
              imagePart(part.data, part.mimeType, 0);
            }
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
          if (!segmentBusy && turn?.error) { rejected = turn; blocked = true; throw turn.error; }
          await wait(streamOptions.signal);
        }
        const active = owned;
        operation = "stream normalization";
        stream.push({ type: "start", partial: message });
        started = true;
        while (!active.queue.length && !active.done) {
          active.output.flush(message, (event) => stream.push(event));
          await new Promise<void>((resolve) => { active.wake = resolve; });
          active.wake = undefined;
        }
        if (active.error) throw active.error;
        active.output.finish(message, (event) => stream.push(event));
        const call = active.queue.shift();
        if (call) {
          active.output.handoff();
          active.emitted = call;
          active.handoffs++;
          const contentIndex = message.content.length;
          message.content.push(call.call);
          message.stopReason = "toolUse";
          stream.push({ type: "toolcall_start", contentIndex, partial: message });
          stream.push({ type: "toolcall_end", contentIndex, toolCall: call.call, partial: message });
        }
        if (!call) message.stopReason = active.finish;
        stream.push({ type: "done", reason: call ? "toolUse" : active.finish, message });
        if (!call && turn === active) {
          if (active.session) retained = { session: active.session, messages: structuredClone([...context.messages, message]) };
          turn = undefined;
        }
      } catch (error) {
        const source = owned ?? rejected;
        const failure = source?.diagnostic ?? requestFailure(error, operation);
        if (owned) {
          if (started) owned.output.finish(message, (event) => stream.push(event));
          failedContext = { fingerprint: createHash("sha256").update(JSON.stringify(context.messages)).digest("hex"),
            failure, handoffs: owned.handoffs, results: owned.results };
          cancel(owned);
        }
        message.stopReason = streamOptions.signal?.aborted ? "aborted" : "error";
        message.errorMessage = message.stopReason === "aborted" ? "Pi request aborted" : renderFailure(failure, {
          operation, model: `${options.providerID}/${options.modelID}`, blocked,
          handoffs: source?.handoffs ?? (blocked ? failedContext?.handoffs : 0),
          results: source?.results ?? (blocked ? failedContext?.results : 0),
        });
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
      await inferenceRelay?.close();
      await relay.close();
    },
  };
}
