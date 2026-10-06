# pi-opencode-bridge

A standalone, opt-in Pi provider backed by an owned OpenCode runtime. Development is in progress. The initial text/provider entry and single-request MCP handoff are implemented; full stream/context fidelity, catalog refresh and released-loader qualification remain incomplete. Do not treat this candidate as a qualified release.

## Development prerequisites

Use Node >=22.19.0, Yarn Classic and an existing `opencode` executable on PATH. The proposed qualification pair is released, unpatched Pi 1.0.4 and OpenCode 1.18.29; other versions are not qualified. Dependencies are pinned in `yarn.lock`. No CLI, plugin or provider SDK is automatically installed by the bridge.

From this package directory, run `yarn typecheck` and `yarn test`. Tests use synthetic authentication and a deterministic loopback model fixture, never the operator's credentials or a paid/external model.

## Configuration and authentication boundary

The source reader retains only `provider`, `enabled_providers` and `disabled_providers` from OpenCode JSON/JSONC configuration. It reads global sources, the explicit config file, worktree-local provider definitions, `.opencode` config files, the explicit config directory and process-provided configuration. Later sources override earlier provider fields. Environment/file references are resolved only inside the retained provider subset; excluded instructions are not read or executed.

API authentication from OpenCode's existing `auth.json` or `OPENCODE_AUTH_CONTENT` is read into memory and passed only to the owned child environment. Existing environment credentials remain available to OpenCode. The child uses temporary HOME/XDG paths, process-only configuration/authentication and a minimal agent with all native tools disabled. Source files are not rewritten, authentication is not copied to disk or Pi's credential store, and raw backend diagnostics are not forwarded. Owned resources are closed on failure/shutdown; unrelated OpenCode servers are not attached to or stopped.

Configured plugins are excluded and reported as an integration limitation. OAuth/remote-auth providers are explicitly disabled and reported as unavailable until their necessary integrations and refresh behavior are qualified without user-file writes. Do not infer OAuth support from API-authentication tests. Organization/remote-managed configuration and custom dynamically installed provider SDKs are not qualified.

Automatic backend compaction/pruning is disabled. Tests observe the effective configuration, absence of native tools in the actual model request, unchanged synthetic source files, no persisted credential bytes and one inference request from an explicitly titled session. These checks do not yet qualify long-history behavior, the full Pi loader or broad provider compatibility.

## Tool handoff and current limits

Each accepted MCP call is emitted as one Pi assistant tool-call segment. Pi executes it through its normal loop/hooks; its matching result resumes the same backend request. Backend-parallel calls execute serially with distinct IDs and separate Pi segments. Tools that require concurrent sibling execution are unsupported; no debounce or backend step-finish signal determines the boundary.

Real Pi 1.0.4 agent-core/OpenCode tests cover text, one call, two identical calls, failed results, cancellation during a tool, owned-server termination, and a transient provider failure after a Pi tool result. Retry events retire the backend generation; the identical failed Pi context is rejected instead of automatically replayed. A new user request can start a fresh backend session. Qualification through Pi's full released loader remains pending.

The Wave 1 seam currently returns completed text, uses fresh sessions for new user requests, and does not yet implement retained-role replay, incremental reasoning/text normalization, complete accounting or image input. Model metadata discovery is not entitlement. Missing usage/pricing is unqualified—not proof of free inference. Those limitations are owned by the pending Wave 2 tasks.

## Storage and activation

The intended source repository is `ZenStudioLab/pi-opencode-bridge`, stored in the toolset as a reviewed submodule. Storage does not enable the extension or change Pi settings. Remote creation/submodule registration and installable-package qualification remain pending. No npm release is published.
