export class BridgeFailure extends Error {
  readonly kind: "access" | "rate" | "context" | "backend" | "stream" | "unsupported";
  constructor(kind: BridgeFailure["kind"], message: string) { super(message); this.kind = kind; }
}

/** Classify evidenced backend metadata without forwarding arbitrary provider payloads. */
export function backendFailure(value: unknown): BridgeFailure {
  const error = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const data = error.data && typeof error.data === "object" ? error.data as Record<string, unknown> : error;
  const status = data.statusCode;
  if (error.name === "ProviderAuthError" || status === 401 || status === 403) {
    return new BridgeFailure("access", "OpenCode provider access denied; check its authentication and model entitlement.");
  }
  if (status === 429 || (data.type === "retry" && typeof data.message === "string" && /rate.?limit|too many requests/i.test(data.message))) return new BridgeFailure("rate", "OpenCode provider rate limit reached; no automatic replay was performed.");
  if (error.name === "ContextOverflowError" || (status === 400 && typeof data.message === "string" && /context.{0,30}(length|window|limit)|too many tokens/i.test(data.message))) {
    return new BridgeFailure("context", "Context length exceeded the model limit; Pi must compact or shorten the retained conversation.");
  }
  return new BridgeFailure("backend", "OpenCode inference failed; no automatic replay was performed.");
}
