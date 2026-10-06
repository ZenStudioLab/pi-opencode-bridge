import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertSelectiveConfiguration,
  createSelectiveConfiguration,
  observeEffectiveConfiguration,
} from "../src/configuration.ts";
import {
  createRuntimeWorkspace,
  removeRuntimeWorkspace,
  startOwnedRuntime,
} from "../src/runtime.ts";

import { loadProviderConfiguration } from "../src/provider-configuration.ts";

const EXECUTABLE = process.env.PI_OPENCODE_TEST_EXECUTABLE ?? "opencode";

interface Fixture {
  readonly baseURL: string;
  readonly chatRequests: () => number;
  readonly authenticatedRequests: () => number;
  readonly requestPaths: () => string[];
  readonly declaredToolNames: () => string[];
  close(): Promise<void>;
}

test("production isolation retains provider-only auth without native tools or auxiliary inference", { timeout: 30_000 }, async () => {
  const phases: string[] = [];
  const fixture = await startFixture();
  const workspace = await createRuntimeWorkspace("pi-opencode-bridge-test-");
  const testHome = await mkdtemp(join(tmpdir(), "pi-opencode-bridge-home-"));
  const projectConfig = join(workspace, "opencode.json");
  let runtime: Awaited<ReturnType<typeof startOwnedRuntime>> | undefined;

  try {
    await writeFile(
      projectConfig,
      JSON.stringify({
        command: { unrelated: { template: "unrelated prompt" } },
        agent: { unrelated: { mode: "primary", prompt: "unrelated agent" } },
        mcp: { unrelated: { type: "remote", url: "http://127.0.0.1:9/unrelated" } },
        plugin: ["unrelated-plugin"],
      }),
    );

    const sourceDirectory = join(testHome, "config", "opencode");
    const authDirectory = join(testHome, "data", "opencode");
    await mkdir(sourceDirectory, { recursive: true });
    await mkdir(authDirectory, { recursive: true });
    const providerConfig = createSelectiveConfiguration({
      id: "fixture", name: "Deterministic local fixture", model: "sentinel", baseURL: fixture.baseURL,
    });
    const sourceText = JSON.stringify({ ...providerConfig, command: { globalUnrelated: { template: "excluded" } } });
    const authText = JSON.stringify({ fixture: { type: "api", key: "synthetic-fixture-key" } });
    await writeFile(join(sourceDirectory, "opencode.json"), sourceText);
    await writeFile(join(authDirectory, "auth.json"), authText);
    const inherited = await loadProviderConfiguration(workspace, {
      HOME: testHome,
      XDG_CONFIG_HOME: join(testHome, "config"),
      XDG_DATA_HOME: join(testHome, "data"),
    });
    assert.equal(inherited.excludedPluginCount, 1);
    assert.deepEqual(inherited.unavailableAuthProviders, []);

    runtime = await withPhaseTimeout(
      phases,
      "runtime.start",
      () => startOwnedRuntime({
        executable: EXECUTABLE,
        workspace,
        config: createSelectiveConfiguration(undefined, inherited.config),
        authentication: inherited.authentication,
        environment: { OPENCODE_CONFIG: projectConfig, OPENCODE_CONFIG_DIR: sourceDirectory }, 
      }),
      15_000,
    );

    const configResponse = await withPhaseTimeout(
      phases,
      "config.get",
      (signal) => runtime!.client.config.get({
        query: { directory: workspace },
        throwOnError: true,
        signal,
      }),
    );
    const observation = observeEffectiveConfiguration(configResponse.data);
    assert.equal(observation.enabledProviders.includes("fixture"), true);
    assert.equal(observation.providerIds.includes("fixture"), true);
    assert.equal(observation.plugins.includes("unrelated-plugin"), false);
    assert.equal(observation.mcpServers.includes("unrelated"), false);
    assert.equal(observation.compaction.auto, false);
    assert.equal(observation.compaction.prune, false);

    assert.doesNotThrow(
      () => assertSelectiveConfiguration(observation, "fixture"),
      "synthetic process authentication must not reintroduce unrelated execution configuration",
    );

    const commands = await withPhaseTimeout(
      phases,
      "command.list",
      (signal) => runtime!.client.command.list({
        query: { directory: workspace },
        throwOnError: true,
        signal,
      }),
    );
    assert.equal(commands.data.some((command) => command.name === "unrelated"), false);

    const agents = await withPhaseTimeout(
      phases,
      "app.agents",
      (signal) => runtime!.client.app.agents({
        query: { directory: workspace },
        throwOnError: true,
        signal,
      }),
    );
    assert.equal(agents.data.some((agent) => agent.name === "unrelated"), false);

    const mcp = await withPhaseTimeout(
      phases,
      "mcp.status",
      (signal) => runtime!.client.mcp.status({
        query: { directory: workspace },
        throwOnError: true,
        signal,
      }),
    );
    assert.equal(Object.prototype.hasOwnProperty.call(mcp.data, "unrelated"), false);
    assert.equal(fixture.chatRequests(), 0, "startup and discovery must not issue inference");

    const session = await withPhaseTimeout(phases, "session.create", (signal) =>
      runtime!.client.session.create({
        body: { title: "Pi bridge controlled authentication probe" },
        query: { directory: workspace },
        throwOnError: true,
        signal,
      }),
    );
    const reply = await withPhaseTimeout(phases, "session.prompt", (signal) =>
      runtime!.client.session.prompt({
        path: { id: session.data.id },
        query: { directory: workspace },
        body: {
          model: { providerID: "fixture", modelID: "sentinel" },
          agent: "pi-opencode-bridge",
          parts: [{ type: "text", text: "Reply with sentinel-ok." }],
        },
        throwOnError: true,
        signal,
      }),
      15_000,
    ).catch(async (error) => {
      const messages = await runtime!.client.session.messages({
        path: { id: session.data.id },
        query: { directory: workspace },
        signal: AbortSignal.timeout(2_000),
      });
      const errors = messages.data?.filter((message) => message.info.role === "assistant").map((message) =>
        message.info.role === "assistant" ? message.info.error?.name : undefined,
      );
      throw new Error(`${error.message}; fixtureRequests=${fixture.chatRequests()}; fixturePaths=${[...new Set(fixture.requestPaths())].join(",")}; backendErrorNames=${errors?.join(",")}`);
    });
    assert.equal(reply.data.info.error, undefined);
    assert.equal(reply.data.parts.filter((part) => part.type === "text").map((part) => part.text).join(""), "sentinel-ok");
    assert.equal(fixture.chatRequests(), 1, "explicit title must suppress auxiliary inference");
    assert.equal(fixture.authenticatedRequests(), 1, "OpenCode must use the synthetic auth entry");

    assert.deepEqual(fixture.declaredToolNames(), [], "the model must not receive any native OpenCode tools");
    const authCopy = await readFile(join(runtime.home, "data", "opencode", "auth.json"), "utf8").catch(() => undefined);
    assert.equal(authCopy, undefined, "runtime must not persist auth data");
    assert.equal(await readFile(join(sourceDirectory, "opencode.json"), "utf8"), sourceText);
    assert.equal(await readFile(join(authDirectory, "auth.json"), "utf8"), authText);
    for (const file of await readdir(runtime.home, { recursive: true, withFileTypes: true })) {
      if (file.isFile()) {
        const bytes = await readFile(join(file.parentPath, file.name));
        assert.equal(bytes.includes(Buffer.from("synthetic-fixture-key")), false, "owned runtime files must not contain credentials");
      }
    }
    assert.deepEqual(phases, [
      "runtime.start:start",
      "runtime.start:done",
      "config.get:start",
      "config.get:done",
      "command.list:start",
      "command.list:done",
      "app.agents:start",
      "app.agents:done",
      "mcp.status:start",
      "mcp.status:done",
      "session.create:start",
      "session.create:done",
      "session.prompt:start",
      "session.prompt:done",
    ]);
  } finally {
    phases.push("cleanup.start");
    await runtime?.close().catch(() => undefined);
    await removeRuntimeWorkspace(workspace).catch(() => undefined);
    await rm(testHome, { recursive: true, force: true });
    await fixture.close();
  }
});

test("missing executable fails without hanging or changing caller-owned workspace files", { timeout: 2_000 }, async () => {
  const workspace = await createRuntimeWorkspace("pi-opencode-bridge-missing-");
  const sentinel = join(workspace, "sentinel");
  try {
    await writeFile(sentinel, "unchanged");
    await assert.rejects(startOwnedRuntime({
      executable: join(workspace, "does-not-exist"),
      workspace,
      config: createSelectiveConfiguration(),
    }), /cannot launch executable \(ENOENT\)/);
    assert.equal(await readFile(sentinel, "utf8"), "unchanged");
  } finally {
    await removeRuntimeWorkspace(workspace);
  }
});

async function withPhaseTimeout<T>(
  phases: string[],
  phase: string,
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 10_000,
): Promise<T> {
  phases.push(`${phase}:start`);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const operationPromise = operation(controller.signal);
  operationPromise.catch(() => undefined);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${phase} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([operationPromise, timeoutPromise]);
    phases.push(`${phase}:done`);
    return result;
  } catch (error) {
    phases.push(`${phase}:failed`);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${phase}: ${message}; phases=${phases.join(",")}`, { cause: error });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function startFixture(): Promise<Fixture> {
  let chatRequests = 0;
  let authenticatedRequests = 0;
  const requestPaths: string[] = [];
  const declaredToolNames: string[] = [];
  const server = createServer(async (request, response) => {
    requestPaths.push(request.url ?? "");
    if (request.method === "POST" && request.url?.includes("chat/completions")) {
      chatRequests += 1;
      if (request.headers.authorization === "Bearer synthetic-fixture-key") authenticatedRequests += 1;
      const body = JSON.parse(await consume(request)) as { tools?: Array<{ function?: { name?: string } }> };
      declaredToolNames.push(...(body.tools ?? []).flatMap((tool) => tool.function?.name ? [tool.function.name] : []));
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "close",
        "cache-control": "no-cache",
      });
      response.end(
        [
          'data: {"id":"sentinel","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"sentinel-ok"},"finish_reason":null}]}',
          'data: {"id":"sentinel","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
      );
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && typeof address !== "string");
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    chatRequests: () => chatRequests,
    authenticatedRequests: () => authenticatedRequests,
    requestPaths: () => requestPaths,
    declaredToolNames: () => declaredToolNames,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function consume(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}
