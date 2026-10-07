# pi-opencode-bridge

A standalone, opt-in Pi provider backed by an owned OpenCode runtime. The minimal provider seam and Wave 2 catalog, streaming, images and retained-context support passed whole-wave review with controlled-runtime tests. Packed-package tests also pass through released Pi's loader and session lifecycle, and final Wave 3 review is accepted. This is controlled qualification, not an npm release or exhaustive external-provider qualification.

## Documentation

- Start with [Installation and lifecycle](#installation-and-lifecycle) to load the extension explicitly; checking out this repository does not install or activate it.
- Use [Configuration and authentication boundary](#configuration-and-authentication-boundary) for model/provider settings and existing OpenCode authentication.
- See [DEVELOPMENT.md](DEVELOPMENT.md) for source structure, local checks and contributor workflow.
- Coding agents working in this repository must follow [AGENTS.md](AGENTS.md).

## Development prerequisites

Use Node >=22.19.0, Yarn Classic and an existing `opencode` executable on PATH. The controlled qualification pair is released, unpatched Pi 1.0.4 and OpenCode 1.18.29; other versions are not qualified. Dependencies are pinned in `yarn.lock`. No CLI, plugin or provider SDK is automatically installed by the bridge.

From this package directory, run `yarn typecheck` and `yarn test`. Tests use synthetic authentication and a deterministic loopback model fixture, never the operator's credentials or a paid/external model.

## Configuration and authentication boundary

Models whose ID or display name contains **`free`** (case-insensitive) are shown automatically, across connected OpenCode providers. This replaces the old fixed Zen whitelist. Matching uses the model's name, not the provider's name; for example, Big Pickle now requires explicit enabling because its name does not contain `free`. A name is not a billing guarantee: reported prices remain visible, and external pricing/availability can change.

Run **`/opencode-settings`** to choose a provider and toggle model rows marked `[x]` or `[ ]` with Enter. You can uncheck automatic models or enable additional models, including paid ones; a paid/unknown-price enable requires confirmation. The provider screen also offers **Enable whole provider**, **Disable whole provider**, and **Reset provider to automatic**. A whole-provider choice covers current and future eligible models and clears that provider's previous individual choices; you can then toggle individual exceptions. Enabling a provider always asks for confirmation because it can include paid or unknown-price models. Visibility precedence is individual model choice, then provider choice, then automatic `free` matching. Return with Back, then choose Save changes or Cancel. Reset to automatic defaults clears all provider and model choices only when you save. The command never sends a prompt or changes your selected model; if you hide the current model, choose another before using it.

Preferences are global across projects in `~/.pi/agent/opencode-bridge.json` (or the agent directory selected by `PI_CODING_AGENT_DIR`). Only explicit provider/model visibility booleans are saved—never credentials or prompts. Existing files containing only model choices remain supported. Newly discovered matching models appear automatically, while saved exclusions and additions survive refresh/restart, including temporary model unavailability. Other running sessions pick up changes through `/opencode-refresh` or restart. Concurrent saves use last-save-wins. Malformed settings are reported instead of silently overwritten; correct the file before refreshing.

No environment-variable prefix is needed. Existing OpenCode enabled/disabled-provider and whitelist/blacklist settings remain authoritative discovery limits; remove the earlier single-model environment prefix if you still use it. To add a provider or model not offered in settings, configure/authenticate it in OpenCode, then refresh and enable it here. Only connected text/tool-capable models are eligible; this UI does not create endpoints or qualify OAuth/plugins. Pi-native provider visibility is unchanged, and OpenCode files are not edited.

Only Muse has passed the approved live bridge smoke; other selectable models have discovery coverage, not live inference qualification, and may still encounter provider restrictions. Free-tier terms may permit data collection/model improvement; do not assume zero retention or send confidential data without checking current terms.

`/<name>` may refer to either a registered command or a loaded skill, depending on the active toolset. The two commands above are registered by this extension.

The source reader retains only `provider`, `enabled_providers` and `disabled_providers` from OpenCode JSON/JSONC configuration. It reads global sources, the explicit config file, worktree-local provider definitions, `.opencode` config files, the explicit config directory and process-provided configuration. Later sources override earlier provider fields. Environment/file references are resolved only inside the retained provider subset; excluded instructions are not read or executed.

API authentication from OpenCode's existing `auth.json` or `OPENCODE_AUTH_CONTENT` is read into memory and passed only to the owned child environment. Existing environment credentials remain available to OpenCode. The child uses temporary HOME/XDG paths, process-only configuration/authentication and a minimal agent with all native tools disabled. Source files are not rewritten, authentication is not copied to disk or Pi's credential store, and raw backend diagnostics are not forwarded. Owned resources are closed on failure/shutdown; unrelated OpenCode servers are not attached to or stopped.

Configured plugins are excluded and reported as an integration limitation. OAuth/remote-auth providers are explicitly disabled and reported as unavailable until their necessary integrations and refresh behavior are qualified without user-file writes. Do not infer OAuth support from API-authentication tests. Organization/remote-managed configuration and custom dynamically installed provider SDKs are not qualified.

Automatic backend compaction/pruning is disabled. Tests observe the effective configuration, absence of native tools in the actual model request, unchanged synthetic source files, no persisted credential bytes and one inference request from an explicitly titled session. Long-history tests also retain role-labelled tool results beyond the fixture model's reported context limit without auxiliary compaction requests. Evidenced provider overflow is surfaced to Pi. These isolation checks do not by themselves qualify the loader or broad provider compatibility; the packed-loader check is described below.

## Tool handoff and current limits

Each accepted MCP call is emitted as one Pi assistant tool-call segment. Pi executes it through its normal loop/hooks; its matching result resumes the same backend request. Backend-parallel calls execute serially with distinct IDs and separate Pi segments. Tools that require concurrent sibling execution are unsupported; no debounce or backend step-finish signal determines the boundary.

Real Pi 1.0.4 agent-core/OpenCode tests cover text, one call, two identical calls, failed results, cancellation during a tool, owned-server termination, and a transient provider failure after a Pi tool result. Retry events retire the backend generation; the identical failed Pi context is rejected instead of automatically replayed. A new user request can start a fresh backend session. The packed-loader check also covers model selection, repeated tool turns, cancellation, fresh-user recovery, reload and unloading.

## Catalog, streaming and context

The `opencode-refresh` command refreshes connected text/tool models without changing selection. Failed refresh preserves the last valid catalog; a successfully removed pair cannot silently route elsewhere. Complete provider/model identities remain distinct. Catalog discovery uses the pinned SDK's `v2` API types because those match OpenCode 1.18.29's actual capability shape; this is not qualification of the separate OpenCode v2 product.

Text and reported reasoning use incremental Pi content events. Cumulative snapshots and usage are attributed once across handoff segments. OpenCode reports aggregate cost; per-category cost fields are placeholders where no breakdown exists. Missing usage/pricing is unavailable—not proof of free inference. Pi requires numeric pricing fields, so an absent price uses numeric placeholders with an explicit "pricing unavailable" model label. Even reported zero pricing is catalog metadata, not verified billing or entitlement.

PNG, JPEG, WebP and GIF base64 images are supported for image-capable models, including image tool results; other formats and images on text-only models are rejected explicitly. The actual loopback-model test exercises PNG user input and a PNG tool result, not every external provider or image format.

Append-compatible turns reuse a backend session. A new session receives Pi's current system prompt and a clearly role-labelled retained transcript, preserving tool-call/result IDs and failure status. This is textual replay, not native-role import, and can change interpretation or caching. Opaque reasoning signatures are not replayed. Branch/tree navigation, Pi compaction, session restoration, model/system/tool changes or incompatible retained history replace the old context. Pi remains the recovery owner.

Request payload/response hooks describe the bridge's owned OpenCode HTTP request, not an inaccessible upstream provider request; stream observation covers mapped backend events. Async observers run in order before normalization without blocking retry/cancellation supervision. Successful completion drains accepted observations and reconciles every request-owned assistant's persisted content/accounting, rather than trusting only the final HTTP assistant or SSE delivery timing. Recovered content must extend the authoritative order of output already emitted to Pi; otherwise the generation fails without retaining backend continuation or automatically replaying tools. This order includes consumed tool calls/results: pre-tool content lost or delayed past a handoff cannot be recovered after its result as a successful transcript. Text/tool execution and hooks are tested through the actual extension entry and real Pi agent loop, and through released Pi's package loader and `AgentSession` lifecycle in the packed-package test.

## Recovery

Authentication/entitlement rejection, free-tier client restrictions, rate limiting and context overflow use evidenced, sanitized diagnostics without changing the prompt or model. An evidenced `FreeTierError` is reported as a client restriction, not a request to repair credentials. Cancellation blocks new ownership until OpenCode acknowledges retirement. Failed/timed-out retirement stops the owned runtime; lost event monitoring also makes the seam unavailable. Reload the bridge before a fresh user request in those cases. Successful ordinary cancellation permits a fresh user-directed request without replaying the cancelled tool. No automatic provider fallback or effectful replay is performed.

## Installation and lifecycle

After reviewing and checking out the selected source revision, install its locked runtime dependencies and explicitly load it with Pi 1.0.4:

```sh
yarn install --production --frozen-lockfile --ignore-scripts
pi -e /absolute/path/to/pi-opencode-bridge
```

Run the install command inside this standalone repository, not the parent toolset. An existing OpenCode 1.18.29 executable must be on PATH. The example does not upgrade Pi/OpenCode or persist an extension-loading declaration. Select the `opencode-bridge` provider and its complete provider/model pair using Pi's model selector. A Git-based Pi package installation must likewise pin the reviewed revision; no npm release is published.

`test/released-loader.test.ts` packs the package, extracts it into an owned temporary directory outside the toolset, installs only locked production dependencies from the existing offline cache with scripts disabled, and loads its declared entry through Pi 1.0.4's real `DefaultResourceLoader`. Real `AgentSession` checks cover catalog selection without inference, multi-turn tool execution/hooks, cancellation during a tool, fresh-user recovery, reload and package removal. The test observes that owned OpenCode processes exit. It uses synthetic authentication and a loopback model, not an external provider or a patched host. This is SDK-loader/lifecycle qualification, not a separately automated TUI test.

The initial approved Muse smoke was rejected before tool execution. Subsequent diagnosis identified HTTP 403 `FreeTierError`, not missing authentication. User-authorized experiments isolated MCP-prefixed tool names as decisive in the tested comparison.

For `opencode/muse-spark-1.3-contributor-free` on the OpenAI Responses SDK route, an owned loopback adapter now exposes only the current Pi tools under their original names upstream and restores MCP names in model responses. It also translates retained function-call history and selected-tool references. IDs, arguments, results, prompt, credentials and configured upstream endpoint remain unchanged. Native OpenCode tools remain disabled; no placeholder tool, plugin, fallback or automatic replay is introduced. Other model/SDK routes are untouched.

The integrated implementation passed an explicitly approved synthetic live round trip: two HTTP 200 responses, one Pi-owned fixture read, final `pong`. Only constrained `bash` and `read` tools were offered; `bash` was not executed. Read-only tool declarations had still been rejected in earlier experiments, so this does not guarantee acceptance for every tool set or continued availability under the vendor's free-tier policy. The packed-loader test covers this adapter with a controlled Responses fixture as well as the original chat fixture. Wave 4's final independent review and caller acceptance passed after correcting configured-endpoint precedence.

The Contributor tier permits prompt/completion use for training. External checks require explicit prompt-egress approval and current pricing/terms checks; the ordinary test suite never calls it.

For one-invocation loading, exit Pi to unload; do not reuse a stale session after unloading. For a persistent Pi package declaration, remove that declaration through Pi's package management and reload. SDK hosts must run Pi's extension shutdown lifecycle (for example package removal followed by `session.reload()`) before disposing; `session.dispose()` alone does not await extension shutdown handlers in Pi 1.0.4.

## Storage and activation

The source repository is `ZenStudioLab/pi-opencode-bridge`; the toolset stores a reviewed revision as a submodule. Storage does not enable the extension or change Pi settings. Private SSH publication, storage-only submodule integration and final Wave 3 acceptance are complete and recorded by the parent change. No npm release is published.
