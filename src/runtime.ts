import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient, type Config, type OpencodeClient } from "@opencode-ai/sdk";

import { fetchRuntime } from "./runtime-http.ts";

const DEFAULT_EXECUTABLE = "opencode";
const STARTUP_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;

export interface OwnedRuntimeOptions {
  executable?: string;
  workspace?: string;
  config: Config;
  authentication?: Record<string, unknown>;
  environment?: NodeJS.ProcessEnv;
}

export interface OwnedRuntime {
  readonly client: OpencodeClient;
  readonly executable: string;
  readonly pid: number;
  readonly url: string;
  readonly workspace: string;
  readonly home: string;
  close(): Promise<void>;
}

export async function createRuntimeWorkspace(prefix = "pi-opencode-bridge-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeRuntimeWorkspace(workspace: string): Promise<void> {
  await rm(workspace, { recursive: true, force: true });
}

export async function startOwnedRuntime(options: OwnedRuntimeOptions): Promise<OwnedRuntime> {
  const executable = options.executable ?? DEFAULT_EXECUTABLE;
  const workspace = options.workspace ?? (await createRuntimeWorkspace());
  const home = join(workspace, "home");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.environment,
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
    OPENCODE_TEST_HOME: undefined,
    OPENCODE_CONFIG: undefined,
    OPENCODE_CONFIG_DIR: join(home, "config", "opencode"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config),
    OPENCODE_AUTH_CONTENT: JSON.stringify(options.authentication ?? {}),
    OPENCODE_PERMISSION: undefined,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_PRUNE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_PURE: "1",
  };
  const child = spawn(executable, ["serve", "--pure", "--hostname=127.0.0.1", "--port=0", "--log-level=ERROR"], {
    cwd: workspace,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Drain stderr, but do not retain/forward backend diagnostics that may contain credentials.
  child.stderr.resume();
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => closePromise ??= (async () => {
    await stopOwnedProcess(child);
    if (!options.workspace) await removeRuntimeWorkspace(workspace);
  })();
  try {
    const url = await waitForListening(child);
    return {
      client: createOpencodeClient({ baseUrl: url, fetch: fetchRuntime }),
      executable,
      pid: child.pid!,
      url,
      workspace,
      home,
      close,
    };
  } catch (error) {
    await close();
    throw new Error(`OpenCode bridge runtime failed to start: ${error instanceof Error ? error.message : "unknown startup failure"}`);
  }
}

function waitForListening(child: OwnedChild): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let line = "";
    const timeout = setTimeout(() => finish(new Error(`timed out after ${STARTUP_TIMEOUT_MS}ms`)), STARTUP_TIMEOUT_MS);
    const finish = (error?: Error, url?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(url!);
    };
    const onData = (chunk: Buffer): void => {
      line = (line + chunk.toString()).slice(-1024);
      const match = line.match(/opencode server listening on\s+(http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        child.stdout.resume();
        finish(undefined, match[1]);
      }
    };
    const onError = (error: NodeJS.ErrnoException): void => finish(new Error(`cannot launch executable (${error.code ?? "unknown"})`));
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      finish(new Error(`process exited before listening (code=${code}, signal=${signal})`));
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function stopOwnedProcess(child: OwnedChild): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => child.kill("SIGKILL"), SHUTDOWN_TIMEOUT_MS);
    child.once("exit", done);
    child.kill("SIGTERM");
  });
}

type OwnedChild = ChildProcessByStdio<null, Readable, Readable>;
export { DEFAULT_EXECUTABLE };
