import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Config } from "@opencode-ai/sdk";

export interface ProviderConfiguration {
  config: Config;
  authentication: Record<string, unknown>;
  unavailableAuthProviders: string[];
  excludedPluginCount: number;
}

/** Read data, not OpenCode's config loader: that loader can execute unrelated plugins. */
export async function loadProviderConfiguration(
  directory: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProviderConfiguration> {
  const home = environment.HOME ?? homedir();
  const configHome = join(environment.XDG_CONFIG_HOME ?? join(home, ".config"), "opencode");
  const dataHome = join(environment.XDG_DATA_HOME ?? join(home, ".local", "share"), "opencode");
  // Discover eligible models within the operator's configuration. Bridge visibility
  // is a separate global preference, never an upstream provider/endpoint override.
  let config: Record<string, unknown> = {};
  let excludedPluginCount = 0;

  const mergeSource = async (text: string, source: string, base: string): Promise<void> => {
    const parsed = parseObject(text, source);
    if (Array.isArray(parsed.plugin)) excludedPluginCount += parsed.plugin.length;
    const retained: Record<string, unknown> = {};
    for (const key of ["provider", "enabled_providers", "disabled_providers"]) {
      if (parsed[key] !== undefined) retained[key] = await expandReferences(parsed[key], base, home, environment);
    }
    config = mergeObjects(config, retained);
  };
  const mergeFile = async (file: string): Promise<void> => {
    const text = await optionalRead(file);
    if (text !== undefined) await mergeSource(text, file, dirname(file));
  };
  for (const file of ["config.json", "opencode.json", "opencode.jsonc"]) await mergeFile(join(configHome, file));
  if (environment.OPENCODE_CONFIG) await mergeFile(resolve(directory, environment.OPENCODE_CONFIG));

  // Worktree-local provider definitions are data; agent/command/plugin directories never load.
  const directories = [resolve(directory)];
  let cursor = resolve(directory);
  while (cursor !== dirname(cursor)) {
    if (await stat(join(cursor, ".git")).then(() => true, () => false)) break;
    cursor = dirname(cursor);
    directories.push(cursor);
  }
  const hasWorktree = await stat(join(cursor, ".git")).then(() => true, () => false);
  const projectDirectories = hasWorktree ? directories.reverse() : [resolve(directory)];
  if (environment.OPENCODE_DISABLE_PROJECT_CONFIG !== "1" && environment.OPENCODE_DISABLE_PROJECT_CONFIG !== "true") {
    for (const dir of projectDirectories) {
      for (const name of ["opencode.json", "opencode.jsonc"]) await mergeFile(join(dir, name));
    }
  }
  const configDirectories = [join(home, ".opencode"), ...projectDirectories.map((dir) => join(dir, ".opencode"))];
  if (environment.OPENCODE_CONFIG_DIR) configDirectories.push(resolve(directory, environment.OPENCODE_CONFIG_DIR));
  for (const dir of new Set(configDirectories)) {
    for (const name of ["opencode.json", "opencode.jsonc"]) await mergeFile(join(dir, name));
  }
  if (environment.OPENCODE_CONFIG_CONTENT) {
    await mergeSource(environment.OPENCODE_CONFIG_CONTENT, "OPENCODE_CONFIG_CONTENT", directory);
  }

  const authentication = environment.OPENCODE_AUTH_CONTENT
    ? parseObject(environment.OPENCODE_AUTH_CONTENT, "OpenCode authentication input")
    : parseObject((await optionalRead(join(dataHome, "auth.json"))) ?? "{}", "OpenCode authentication source");
  const unavailableAuthProviders = Object.entries(authentication)
    .filter(([, entry]) => !isObject(entry) || entry.type !== "api")
    .map(([id]) => id);
  for (const id of unavailableAuthProviders) delete authentication[id];
  if (unavailableAuthProviders.length) {
    config.disabled_providers = [...new Set([
      ...(Array.isArray(config.disabled_providers) ? config.disabled_providers : []),
      ...unavailableAuthProviders,
    ])];
  }
  return { config: config as Config, authentication, unavailableAuthProviders, excludedPluginCount };
}

async function optionalRead(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // File content and parser excerpts may contain credentials; never forward them.
    throw new Error(`Cannot read OpenCode configuration source (${(error as NodeJS.ErrnoException).code ?? "unknown"})`);
  }
}

async function expandReferences(value: unknown, base: string, home: string, environment: NodeJS.ProcessEnv): Promise<unknown> {
  if (typeof value === "string") {
    let result = value.replace(/\{env:([^}]+)\}/g, (_match, name: string) => environment[name] ?? "");
    for (const match of result.matchAll(/\{file:([^}]+)\}/g)) {
      const path = match[1].startsWith("~/") ? join(home, match[1].slice(2)) : resolve(base, match[1]);
      const content = await optionalRead(path);
      if (content === undefined) throw new Error("A retained OpenCode provider file reference is unavailable");
      result = result.replace(match[0], content.trim());
    }
    return result;
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => expandReferences(item, base, home, environment)));
  if (isObject(value)) {
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) =>
      [key, await expandReferences(item, base, home, environment)],
    )));
  }
  return value;
}

function mergeObjects(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([...new Set([...Object.keys(left), ...Object.keys(right)])].map((key) => {
    const a = left[key], b = right[key];
    return [key, b === undefined ? a : isObject(a) && isObject(b) ? mergeObjects(a, b) : b];
  }));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** OpenCode's local configuration is JSONC: preserve quoted text while removing comments/commas. */
function parseObject(text: string, source: string): Record<string, unknown> {
  try {
    let clean = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i], next = text[i + 1];
      if (quoted) {
        clean += c;
        if (c === "\\") clean += text[++i] ?? "";
        else if (c === '"') quoted = false;
      } else if (c === '"') {
        quoted = true;
        clean += c;
      } else if (c === "/" && next === "/") {
        while (i < text.length && text[i] !== "\n") i++;
        clean += "\n";
      } else if (c === "/" && next === "*") {
        const end = text.indexOf("*/", i + 2);
        if (end === -1) throw new Error();
        i = end + 1;
        clean += " ";
      } else clean += c;
    }
    let normalized = "";
    quoted = false;
    for (let i = 0; i < clean.length; i++) {
      const c = clean[i];
      if (quoted) {
        normalized += c;
        if (c === "\\") normalized += clean[++i] ?? "";
        else if (c === '"') quoted = false;
      } else {
        if (c === '"') quoted = true;
        if (c !== "," || !/^\s*[}\]]/.test(clean.slice(i + 1))) normalized += c;
      }
    }
    const parsed: unknown = JSON.parse(normalized.replace(/^\uFEFF/, ""));
    if (!isObject(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error(`Invalid OpenCode configuration in ${source}`);
  }
}
