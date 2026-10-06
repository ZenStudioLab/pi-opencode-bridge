import assert from "node:assert/strict";
import childProcess, { execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

for (const responses of [false, true]) {
const providerID = responses ? "opencode" : "fixture";
const modelID = responses ? "muse-spark-1.3-contributor-free" : "probe";
test(`packed package qualifies through released Pi loader (${responses ? "Responses aliases" : "chat"}): selection, tools, abort, reload and unload`, { timeout: 90_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-bridge-packed-"));
  const environment = { ...process.env };
  const children: ChildProcess[] = [];
  const originalSpawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: Parameters<typeof originalSpawn>) => {
    const child = originalSpawn(...args);
    if (args[0] === "opencode" && Array.isArray(args[1]) && args[1].includes("serve")) children.push(child);
    return child;
  });
  syncBuiltinESMExports();
  let requests = 0, executions = 0, before = 0, after = 0;
  const requestTools: string[][] = [];
  let cancelTool = false;
  let toolStarted!: () => void;
  const cancellingTool = new Promise<void>((resolve) => { toolStarted = resolve; });
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    const payload = JSON.parse(body);
    requestTools.push((payload.tools ?? []).map((tool: { name?: string; function?: { name?: string } }) => tool.name ?? tool.function?.name ?? "unknown"));
    const tool = [1, 3, 5].includes(++requests);
    if (responses) {
      assert.equal(request.url, "/v1/responses");
      assert.deepEqual(requestTools.at(-1), ["probe"]);
      if ([2, 4].includes(requests)) {
        assert.ok(payload.input.some((item: { type: string; name: string }) => item.type === "function_call" && item.name === "probe"));
        assert.ok(payload.input.some((item: { type: string; output: string }) => item.type === "function_call_output" && item.output.includes("packed result")));
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
      const info = { id: `resp_${requests}`, object: "response", status: "in_progress", model: modelID, output: [] };
      send({ type: "response.created", response: info });
      let item;
      if (tool) {
        item = { type: "function_call", id: `fc_${requests}`, call_id: `packed-${requests}`, name: "probe", arguments: "" };
        send({ type: "response.output_item.added", output_index: 0, item });
        send({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: "{}" });
        item = { ...item, arguments: "{}", status: "completed" };
      } else {
        item = { type: "message", id: `msg_${requests}`, role: "assistant", status: "in_progress", content: [] };
        send({ type: "response.output_item.added", output_index: 0, item });
        send({ type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        send({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "packed done" });
        item = { ...item, status: "completed", content: [{ type: "output_text", text: "packed done", annotations: [] }] };
      }
      send({ type: "response.output_item.done", output_index: 0, item });
      send({ type: "response.completed", response: { ...info, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
      response.end();
      return;
    }
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `packed-${requests}`, type: "function", function: { name: "pi_probe", arguments: "{}" } }] }
      : { role: "assistant", content: "packed done" };
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    response.end(`data: ${JSON.stringify({ id: "packed", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "packed", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let settings: SettingsManager | undefined;
  try {
    const archive = join(root, "bridge.tgz");
    execFileSync("yarn", ["pack", "--filename", archive], { cwd: packageRoot, stdio: "pipe", timeout: 15_000 });
    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split("\n");
    assert.ok(entries.includes("package/src/index.ts"));
    assert.ok(!entries.some((entry) => /\/(test|node_modules|\.git)\//.test(entry)));
    execFileSync("tar", ["-xzf", archive, "-C", root]);
    const packed = join(root, "package");
    await copyFile(join(packageRoot, "yarn.lock"), join(packed, "yarn.lock"));
    // Reuse only the already-reviewed immutable dependency set; no downloads,
    // lifecycle scripts, global installs or dependency symlinks are permitted.
    execFileSync("yarn", ["install", "--production", "--offline", "--ignore-scripts", "--frozen-lockfile", "--non-interactive"], { cwd: packed, stdio: "pipe", timeout: 30_000 });
    assert.equal(await readFile(join(packed, "yarn.lock"), "utf8"), await readFile(join(packageRoot, "yarn.lock"), "utf8"));
    const hostPackage = JSON.parse(await readFile(join(packageRoot, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
    assert.equal(hostPackage.version, "1.0.4");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    await mkdir(cwd);
    await mkdir(agentDir);
    for (const key of Object.keys(process.env)) if (key.startsWith("OPENCODE_") || key.startsWith("XDG_")) delete process.env[key];
    Object.assign(process.env, { HOME: root, PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
      OPENCODE_AUTH_CONTENT: JSON.stringify({ [providerID]: { type: "api", key: "synthetic" } }),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: [providerID], provider: { [providerID]: {
        npm: responses ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible", name: "Fixture", options: { baseURL: `http://127.0.0.1:${address.port}/v1` },
        models: { [modelID]: { name: "Free packed probe", tool_call: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 16000, output: 2000 } },
          ...(responses ? { "paid-probe": { name: "Paid probe", tool_call: true, cost: { input: 1, output: 2 },
            modalities: { input: ["text"], output: ["text"] }, limit: { context: 16000, output: 2000 } } } : {}),
        },
      } } }),
    });
    settings = SettingsManager.inMemory({ packages: [packed], compaction: { enabled: false }, retry: { enabled: false } });
    const errors: string[] = [];
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => {
        pi.registerTool({ name: "probe", label: "Probe", description: "Controlled packed-loader tool", parameters: Type.Object({}),
          execute: async (_id, _args, signal) => {
            executions++;
            if (cancelTool) {
              toolStarted();
              await new Promise<void>((resolve) => {
                signal?.addEventListener("abort", () => resolve(), { once: true });
                if (signal?.aborted) resolve();
              });
            }
            return { content: [{ type: "text", text: "packed result" }], details: undefined };
          },
        });
        pi.on("tool_call", () => { before++; });
        pi.on("tool_result", () => { after++; });
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.ok(loader.getExtensions().extensions.some((extension) => extension.path === join(packed, "src/index.ts")));
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    ({ session } = await createAgentSession({ cwd, agentDir, settingsManager: settings, resourceLoader: loader,
      modelRuntime, sessionManager: SessionManager.inMemory(cwd), tools: ["probe"], thinkingLevel: "off" }));
    t.signal.addEventListener("abort", () => { void session?.abort(); }, { once: true });
    const choices: string[] = [];
    await session.bindExtensions({ onError: (error) => { errors.push(error.error); }, mode: "tui", uiContext: {
      select: async (_title: string, rows: string[]) => {
        const choice = choices.shift();
        assert.ok(choice, "unexpected settings dialog");
        const row = rows.find(value => value === choice || value.includes(`(${choice})`));
        assert.ok(row, `missing settings choice ${choice}`);
        return row;
      },
      confirm: async () => true,
      notify: () => {},
    } as unknown as ExtensionUIContext });
    const model = modelRuntime.getModel("opencode-bridge", `${providerID}/${modelID}`);
    assert.ok(model, errors.join("\n"));
    if (responses) {
      for (const id of ["mimo-v2.5-free", "nemotron-3.5-lightning-free", "ling-3.0-flash-fin-free"]) {
        assert.ok(modelRuntime.getModel("opencode-bridge", `opencode/${id}`), `${id} must be discoverable without inference`);
      }
      assert.equal(modelRuntime.getModel("opencode-bridge", "opencode/paid-probe"), undefined,
        "nonmatching paid models must be hidden by default");
      assert.equal(modelRuntime.getModel("opencode-bridge", "opencode/big-pickle"), undefined);
      choices.push("Provider: opencode", "mimo-v2.5-free", "paid-probe", "Back", "Save changes");
      await session.prompt("/opencode-settings");
      assert.equal(choices.length, 0);
      assert.equal(modelRuntime.getModel("opencode-bridge", "opencode/mimo-v2.5-free"), undefined);
      assert.ok(modelRuntime.getModel("opencode-bridge", "opencode/paid-probe"));
      assert.deepEqual(JSON.parse(await readFile(join(agentDir, "opencode-bridge.json"), "utf8")),
        { models: { "opencode/mimo-v2.5-free": false, "opencode/paid-probe": true } });
    }
    assert.equal(requests, 0);
    await session.setModel(model);
    session.setActiveToolsByName(["probe"]);
    await session.prompt("First controlled tool turn.");
    assert.equal(session.getLastAssistantText(), "packed done", JSON.stringify({ requests, executions, errors, requestTools, activeTools: session.getActiveToolNames(),
      assistants: session.messages.filter((message) => message.role === "assistant").map((message) => ({ reason: message.stopReason, error: message.errorMessage })) }));
    await session.prompt("Second controlled tool turn.");
    assert.equal(session.getLastAssistantText(), "packed done");
    assert.deepEqual([requests, executions, before, after], [4, 2, 2, 2]);
    cancelTool = true;
    const interrupted = session.prompt("Cancel during a controlled tool.");
    await cancellingTool;
    await session.abort();
    await interrupted;
    assert.equal(requests, 5);
    cancelTool = false;
    await session.prompt("Fresh request after cancellation.");
    assert.equal(session.getLastAssistantText(), "packed done");
    const previous = [...children];
    await session.reload();
    assert.ok(previous.every((child) => child.exitCode !== null || child.signalCode !== null), "reload must retire all old owned runtimes");
    const reloaded = modelRuntime.getModel("opencode-bridge", `${providerID}/${modelID}`);
    assert.ok(reloaded);
    if (responses) {
      assert.equal(modelRuntime.getModel("opencode-bridge", "opencode/mimo-v2.5-free"), undefined);
      assert.ok(modelRuntime.getModel("opencode-bridge", "opencode/paid-probe"));
    }
    await session.setModel(reloaded);
    await session.prompt("Request after released-loader reload.");
    assert.equal(session.getLastAssistantText(), "packed done");
    assert.equal(requests, 7);
    settings.setPackages([]);
    await session.reload();
    assert.ok(children.length >= 3, "observe actual owned OpenCode children");
    assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null), "unload must close owned children");
    assert.deepEqual(errors, []);
  } finally {
    if (session) {
      await session.abort();
      settings!.setPackages([]);
      await session.reload();
      session.dispose();
    }
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});
}
