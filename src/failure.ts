export interface FailureDetails {
  name?: string;
  message?: string;
  status?: number;
  code?: string;
  causes: string[];
}

const LIMIT = 320;
const WITHHELD = "[detail withheld]";

// Read only named metadata, never serialize the thrown object or its payloads.
function field(value: unknown, key: string): unknown {
  try { return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined; }
  catch { return undefined; }
}

function safeText(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  // Opaque dumps and quoted content can contain arbitrary echoed prompts or secrets.
  if (/[{}\[\]"`]|\b(?:requestBody|responseBody|prompt|messages|tool.?arguments|tool.?results|payload)\s*[:=]/i.test(value)) return WITHHELD;
  const text = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/https?:\/\/[^\s]+/gi, "[URL redacted]")
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie|api[-_ ]?key|token|password|secret)\s*[:=].*/gi, "[credential redacted]")
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[credential redacted]")
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, "[credential redacted]")
    .replace(/'[^']*'/g, "[quoted detail withheld]");
  return text.length > LIMIT ? text.slice(0, LIMIT) + " [truncated]" : text;
}

/** Bounded and nonthrowing, including SDK objects, non-Error throws and cyclic causes. */
export function failureDetails(value: unknown): FailureDetails {
  const data = field(value, "data") ?? value;
  const status = field(data, "statusCode") ?? field(data, "status");
  const details: FailureDetails = {
    name: safeText(field(value, "name") ?? field(data, "type")),
    message: safeText(field(data, "message") ?? field(value, "message") ?? (typeof value === "string" ? value : undefined)),
    status: typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined,
    code: safeText(field(data, "code") ?? field(value, "code")), causes: [],
  };
  const seen = new Set<unknown>([value]);
  let cause = field(value, "cause") ?? field(data, "cause");
  for (let depth = 0; cause != null; depth++) {
    if (depth === 3 || seen.has(cause)) { details.causes.push("[cause detail truncated]"); break; }
    seen.add(cause);
    const name = safeText(field(cause, "name"));
    const code = safeText(field(cause, "code"));
    const message = safeText(field(cause, "message") ?? (typeof cause === "string" ? cause : undefined));
    details.code ??= code;
    details.causes.push([name, code, message].filter(Boolean).join(": ") || "detail unavailable");
    cause = field(cause, "cause");
  }
  return details;
}

export class BridgeFailure extends Error {
  readonly kind: "access" | "rate" | "context" | "backend" | "stream" | "unsupported";
  readonly details: FailureDetails;
  operation?: string;
  constructor(kind: BridgeFailure["kind"], message: string, details: FailureDetails = { causes: [] }) {
    super(message); this.kind = kind; this.details = details;
  }
}

/** Attach operation context once, before cleanup can obscure the originating error. */
export function requestFailure(value: unknown, operation: string): BridgeFailure {
  const failure = value instanceof BridgeFailure ? value : backendFailure(value);
  failure.operation ??= operation;
  return failure;
}

export function renderFailure(value: unknown, context: {
  operation: string; model: string; handoffs?: number; results?: number; blocked?: boolean;
}): string {
  const failure = requestFailure(value, context.operation);
  const detail = failure.details;
  const handoffs = context.handoffs ?? 0, results = context.results ?? 0;
  return [
    `OpenCode request failed: ${context.blocked ? "blocked replay" : failure.operation}`,
    `Model: ${safeText(context.model) ?? "unavailable"}`,
    ...(context.blocked ? [`Original operation: ${failure.operation}`] : []),
    failure.message,
    `Cause: ${[detail.name, detail.message].filter(Boolean).join(": ") || "detail unavailable"}`,
    ...(detail.status ? [`HTTP: ${detail.status}`] : []),
    ...(detail.code ? [`Code: ${detail.code}`] : []),
    ...detail.causes.map(cause => `Underlying cause: ${cause}`),
    handoffs === 0 ? "Tools: no handoff issued" : `Tools: ${handoffs} handoff(s), ${results} result(s) returned; ${handoffs > results ? "execution may have occurred without a returned result" : "returned results do not imply success"}`,
    "No automatic replay was performed.",
  ].join("\n");
}

/** Classify evidenced backend metadata without forwarding arbitrary provider payloads. */
export function backendFailure(value: unknown): BridgeFailure {
  const details = failureDetails(value);
  const data = field(value, "data") ?? value;
  const message = field(data, "message");
  const status = details.status;
  if (status === 403 && typeof field(data, "responseBody") === "string") {
    try {
      const body = JSON.parse(field(data, "responseBody") as string);
      if (body?.error?.type === "FreeTierError") {
        return new BridgeFailure("access", "OpenCode rejected this request under its free-tier client restriction.", details);
      }
    } catch { /* Unstructured responses retain the conservative status classification. */ }
  }
  if (field(value, "name") === "ProviderAuthError" || status === 401 || status === 403) {
    return new BridgeFailure("access", "OpenCode provider access denied; check its authentication and model entitlement.", details);
  }
  if (status === 429 || (field(data, "type") === "retry" && typeof message === "string" && /rate.?limit|too many requests/i.test(message))) {
    return new BridgeFailure("rate", "OpenCode provider rate limit reached.", details);
  }
  if (field(value, "name") === "ContextOverflowError" || (status === 400 && typeof message === "string" && /context.{0,30}(length|window|limit)|too many tokens/i.test(message))) {
    return new BridgeFailure("context", "Context length exceeded the model limit; Pi must compact or shorten the retained conversation.", details);
  }
  return new BridgeFailure("backend", "OpenCode inference failed.", details);
}
