# Development guide

This is a standalone TypeScript Pi extension, also stored as a submodule in the toolset. Run package commands here, not at the parent repository root. User setup, authentication and qualification limits are documented in [README.md](README.md); agent-specific instructions live in [AGENTS.md](AGENTS.md).

## Local setup

The qualified pair is Pi 1.0.4 and OpenCode 1.18.29. Use Node >=22.19.0, Yarn Classic and an existing `opencode` executable on PATH. Development dependencies pin the released Pi packages used by tests.

```sh
cd /absolute/path/to/pi-opencode-bridge
yarn install --frozen-lockfile --ignore-scripts
yarn typecheck
yarn test
```

Installation needs access to the locked dependencies or an existing cache. It does not install OpenCode, configure credentials or activate the extension. For local interactive testing, use the explicit loading instructions in the README.

## Source map

The bridge separates Pi-facing selection and execution from its owned OpenCode runtime:

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Extension registration, catalog publication, refresh and settings commands. |
| `src/catalog.ts` | Connected, text/tool-capable model discovery and metadata. |
| `src/provider-configuration.ts` | Selective OpenCode provider configuration projection. |
| `src/model-preferences.ts` | Global model/provider visibility rules and persistence. |
| `src/model-settings.ts` | Native settings dialogs and draft Save/Cancel behavior. |
| `src/runtime.ts` | Owned OpenCode process lifecycle. |
| `src/provider-seam.ts` | Generation orchestration and handoff lifecycle. |
| `src/tool-relay.ts` | MCP handoffs to Pi-owned tool execution. |
| `src/inference-relay.ts` | Narrow Muse Responses transport adapter. |
| `src/responses-tool-names.ts` | Protocol-scoped tool-name translation. |
| `src/context.ts`, `src/stream.ts` | Retained context and incremental output reconciliation. |
| `src/failure.ts` | Sanitized failure classification. |

The architecture rationale is in [ADR 0001](docs/adr/0001-pi-owned-opencode-provider.md).

## Checks

Ordinary tests use synthetic authentication and loopback fixtures. They must not require operator credentials or external inference. Run a focused test while iterating, then the relevant integration coverage:

```sh
node --experimental-strip-types --test test/model-preferences.test.ts
node --experimental-strip-types --test --test-concurrency=1 test/*.test.ts
```

Serial execution reduces competition between tests that launch actual runtimes. Do not raise timeouts merely to hide a failure.

`test/released-loader.test.ts` packs and extracts the package outside the toolset, installs locked production dependencies offline with scripts disabled, and exercises released Pi's real loader/session. It needs the existing dependency cache. This catches packaging, registration, settings and lifecycle failures that direct imports cannot. Test changes to settings through both the pure dialog/preference tests and the packed command flow.

Successful discovery is not proof of external model entitlement or inference compatibility. A live check needs explicit approval for its payload and provider, current pricing/terms checks and a bounded synthetic request. Never substitute a paid model or replay effectful work to make a check pass.

## Changes and release preparation

Keep user-visible behavior in the README and architecture decisions in the ADR. Preserve configured upstream endpoints, authentication ownership, Pi tool execution and cancellation/retry guarantees. Visibility controls affect discovery, not billing enforcement or upstream eligibility.

Before publishing, inspect the standalone diff, run proportionate checks and verify the packed file list when changing package contents. `package.json` explicitly controls the runtime archive; contributor guides are repository documentation and are not currently included in that archive.

Commit and publish the standalone repository before updating a parent submodule pin. A pin update stores a revision; it must not activate the extension or modify user settings. Keep unrelated parent changes out of the commit. Report exact checks and any remaining qualification limits rather than treating compilation or discovery alone as completion.
