# ADR-0034: MCP client implementation — the official TypeScript SDK, scheduled in build phase 2

- **Status**: Accepted
- **Date**: 2026-06-10
- **Related**: [ADR-0006](0006-os-keychain-for-api-keys.md), [ADR-0011](0011-internal-llm-abstraction.md), [ADR-0019](0019-cli-node-keychain-library.md), [ADR-0029](0029-tool-policy-hardening.md), [mcp-integration.md](../reference/shared-core/mcp-integration.md), [architectural-principles.md](../standards/architectural-principles.md)

## Context

Relavium's MCP integration has been **contract-complete but implementation-unscheduled** since
Phase 0: the canonical spec ([mcp-integration.md](../reference/shared-core/mcp-integration.md))
defines both directions (agents consuming MCP tools; workflows published as MCP servers), the
`McpServerRef` shape lives in the agent/workflow schemas, `[[mcp_servers]]` registration lives in
[config-spec.md](../reference/contracts/config-spec.md), and the desktop IPC contract reserves
`list_mcp_servers` — yet **no roadmap workstream builds the client**, and the implementation
requires a runtime dependency that rule #2 ("no new runtime dependency without an ADR",
[architectural-principles.md](../standards/architectural-principles.md)) says must be decided in
an ADR **before** any implementation work starts. Leaving the gap open risks the contract and the
implementation drifting apart, or the dependency being adopted ad hoc inside a feature PR.

Two questions are settled here: **which client implementation** (hand-rolled protocol code vs the
official SDK) and **when** (which build phase owns the workstream). The engine-first critical path
(M2: parser → runner → checkpoint → harness) must not grow; the CLI build phase already resolves
the `[[mcp_servers]]` config and is the first surface that can exercise a live MCP round-trip
end-to-end.

## Decision

**We will implement the MCP client (and later the workflow-as-MCP-server adapter) on the official
TypeScript MCP SDK — `@modelcontextprotocol/sdk` — and bind the client implementation to a
dedicated workstream at the start of build phase 2 (the CLI phase), off the M3 critical path.**
The exact version is pinned in the pnpm `catalog:` and recorded in
[tech-stack.md](../tech-stack.md) when the package lands with that workstream, not here.

Considered alternatives:

- **Hand-roll the MCP protocol client** (rejected) — Relavium's build-in-house rule targets the
  *core* (engine, LLM seam, schedulers), not interop-protocol plumbing. MCP is an external,
  still-evolving protocol with an official, actively maintained TS SDK that doubles as the
  conformance reference; hand-rolling it buys no differentiation, adds a permanent
  protocol-tracking burden, and repeats the class of mistake [ADR-0019](0019-cli-node-keychain-library.md)
  avoided by choosing a maintained library over bespoke plumbing.
- **Implement in Phase 1, alongside the engine** (rejected) — the M2 critical path stays lean; the
  engine consumes tools through the `ToolRegistry` abstraction either way, so MCP-backed tools are
  additive. The CLI phase is the first place a real `mcp_servers` config, keychain-backed secrets,
  and a live stdio server can be proven together.
- **Defer the decision itself until someone needs MCP** (rejected) — the contract has been ahead of
  the implementation for two phases already; deciding the dependency and the slot now is what keeps
  the contract honest and gives the workstream (2.R) an unambiguous starting point.

Binding guardrails for the implementation (each is an existing decision applied to MCP, cited not
restated):

1. **Secrets**: MCP server credentials resolve from the OS keychain / secret store into the server
   `env` at spawn time and never appear in YAML, logs, or event payloads ([ADR-0006](0006-os-keychain-for-api-keys.md),
   [keychain-and-secrets.md](../reference/desktop/keychain-and-secrets.md)).
2. **Egress**: MCP `url` endpoints pass the one shared SSRF primitive — the same range-block used
   for provider base URLs and `http_request` ([ADR-0029](0029-tool-policy-hardening.md),
   [security-review.md](../standards/security-review.md)).
3. **Type discipline**: SDK types are confined to the MCP integration layer, exactly as provider
   SDK types are confined to `@relavium/llm` adapters ([ADR-0011](0011-internal-llm-abstraction.md));
   discovered tools surface to the `ToolRegistry` and the LLM seam only as Relavium/Zod tool
   definitions, schema-validated before dispatch.
4. **Tool policy**: MCP-discovered tools enter an agent's tool surface only under the same
   narrow-only tool policy as built-in tools ([ADR-0029](0029-tool-policy-hardening.md)); a
   per-server `tools_allowlist` is the recommended authoring posture
   ([mcp-integration.md](../reference/shared-core/mcp-integration.md#tool-discovery)).
5. **Process hygiene**: stdio servers are spawned with an explicitly constructed environment (the
   declared `env` plus a minimal base), never a blanket copy of the host process environment.

## Consequences

### Positive

- The two-phase-old contract↔implementation gap gets an owner (workstream 2.R) and a decided
  dependency before any code is written — no ad-hoc adoption inside a feature PR.
- The official SDK tracks protocol revisions for us; conformance against real MCP hosts (Claude
  Desktop, Cursor) is testable from day one.
- The engine critical path (M2) is untouched; MCP arrives where it can first be proven end-to-end
  (CLI), behind the existing `ToolRegistry` abstraction.

### Negative

- A new runtime dependency in the tool path — mitigated by confining SDK types to the integration
  layer (guardrail 3), pinning the version in the catalog, and the dependency being absent from
  `@relavium/core`'s import graph (the engine sees only `ToolRegistry` shapes).
- MCP support ships later than the engine (build phase 2, not 1) — mitigated by the fact that no
  Phase-1 milestone needs a live MCP server, and the schemas/config keep authored files valid in
  the meantime.
- The workflow-as-MCP-server direction (outbound) waits further still — it depends on a running
  engine plus a surface to host the adapter; 2.R scopes the **client** (inbound) and leaves
  outbound to a later workstream rather than inflating the slot.
