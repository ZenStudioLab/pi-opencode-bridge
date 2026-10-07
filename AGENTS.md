---
id: pi-opencode-bridge-development
summary: Preserve the standalone bridge's execution and configuration boundaries.
when: Working in this repository or its descendants.
tags: [pi, opencode, development]
---

# Agent instructions

These instructions own repository-local development constraints. Read [DEVELOPMENT.md](DEVELOPMENT.md) before changing implementation or tests, and consult [README.md](README.md) for user-visible behavior and qualification limits.

- Run package commands from this directory using Yarn and the existing lockfile. Do not modify the parent toolset's dependencies, activation or settings to make this package work.
- Pi owns tool execution, hooks, conversation and recovery. Keep OpenCode native tools disabled; MCP callbacks must hand execution back to Pi.
- Preserve explicit upstream configuration and authentication ownership. Do not write operator OpenCode files, copy credentials to disk, expose raw credential-bearing diagnostics or attach to unrelated servers.
- Preserve serial tool handoffs, cancellation retirement and no automatic replay of effectful work. Do not silently switch providers or models on failure.
- Model/provider visibility rules operate only on eligible discovered pairs. Keep explicit model choices above provider choices and automatic matching; names containing `free` are not billing guarantees.
- Keep the Responses adapter limited to its qualified route unless a requested change explicitly expands it with evidence.
- Use synthetic credentials and loopback fixtures for automated tests. External inference requires explicit approval of the payload/provider; never use operator credentials in ordinary tests.
- Run the smallest meaningful checks for each change. Use packed-loader coverage for packaging, registration, settings or lifecycle changes; distinguish supplied, rerun and unverified evidence.
- Keep README user-facing, DEVELOPMENT contributor-facing and architecture rationale in the existing ADR. Update only the documentation affected by a change.
- Treat standalone publication, parent submodule pinning and user installation as separate actions. Do not infer activation or installation permission from a request to publish source.
