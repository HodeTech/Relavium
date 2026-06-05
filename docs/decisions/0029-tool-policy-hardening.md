# ADR-0029: Tool-policy hardening — command match, tool narrowing, secret interpolation, SSRF

- **Status**: Accepted
- **Date**: 2026-06-05
- **Related**: [0006-os-keychain-for-api-keys.md](0006-os-keychain-for-api-keys.md), [0011-internal-llm-abstraction.md](0011-internal-llm-abstraction.md), [0023-strict-authored-yaml-validation.md](0023-strict-authored-yaml-validation.md), [../standards/security-review.md](../standards/security-review.md), [../reference/contracts/workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md), [../reference/shared-core/built-in-tools.md](../reference/shared-core/built-in-tools.md), [../reference/shared-core/mcp-integration.md](../reference/shared-core/mcp-integration.md)

## Context

Four tool-policy ambiguities in the current specs are individually small and collectively a real
attack surface. Because no production workflow exists yet, tightening them now is nearly free; doing
it after the engine ships would be a breaking change to a public contract. Each is a **deliberate
behavior change**, not an additive field, and is labeled as such:

1. **`run_command` match semantics are undefined** — the spec says only "matched against the resolved
   command string" ([workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md)), which a
   naive implementation reads as a substring/prefix match → `allowlist: ['git']` would permit
   `git push --force`. An escalation footgun.
2. **Node `tools:` vs agent `tools:` has no relationship rule** — a node lists `tools:`
   ([workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md) `agent` node) and so does
   the agent ([agent-yaml-spec.md](../reference/contracts/agent-yaml-spec.md)); a plain reading lets a
   node *add* a tool (e.g. `run_command`) the agent was never granted — privilege escalation.
3. **`secret`-typed inputs can be interpolated into prompts** — secret masking exists only in *event*
   payloads ([sse-event-schema.md](../reference/contracts/sse-event-schema.md)); a `secret` input
   interpolated into a `prompt_template` is sent to the model and persisted in the message store. A
   keychain-leak-class hole ([ADR-0006](0006-os-keychain-for-api-keys.md)).
4. **SSRF protection is scoped to provider base URLs only** — [security-review.md](../standards/security-review.md)
   blocks private/loopback/link-local/metadata ranges for a provider `baseURL`, but the `http_request`
   tool's `allowedDomains` and the **MCP server URLs** are a *second and third* egress path with no
   range-block — and MCP URLs additionally carry injected secrets, so leaving them open is worse than
   leaving `http_request` open.

## Decision

**Adopt four tool-policy tightenings, each validator- or engine-enforced and each carrying a "public
workflow-API tightening" migration note:**

- **(a) Exact command match by default.** `allowedCommands` entries match the resolved command
  **exactly**; pattern matching is opt-in via a separate `allowedCommandGlobs`. The binding rule lives
  in [security-review.md](../standards/security-review.md); the authored fields in
  [workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md).
- **(b) Node tools narrow-only.** A node's `tools:` may only **intersect** (narrow) the agent's
  granted tools; it can never add a tool the agent lacks. Enforced by the parser
  ([ADR-0023](0023-strict-authored-yaml-validation.md)).
- **(c) No secret interpolation into agent text.** `secret`-typed inputs are **rejected at parse**
  from `prompt_template` and any tool text field; they may feed only credential/header fields. (User
  *conversational* content is the user's own data, encrypted in `history.db`, and is out of scope of
  this rule.)
- **(d) One SSRF policy, three egress paths.** The existing provider-`baseURL` range-block is the
  **single vetted primitive**, reused (never re-implemented) for the `http_request` tool **and** MCP
  server URLs: HTTPS-only, block private/loopback/link-local/metadata ranges, exact-FQDN
  `allowedDomains` match, and **empty/absent `allowedDomains` ⇒ deny-all** (symmetry with
  `allowedCommands`). `http_request` and MCP URLs are added to the mandatory-review trigger list in
  [security-review.md](../standards/security-review.md); [built-in-tools.md](../reference/shared-core/built-in-tools.md)
  and [mcp-integration.md](../reference/shared-core/mcp-integration.md) stay one-line pointers, not
  second homes.

Considered for each: documenting the loose status quo (rejected — exploitable), or a `schema_version`
bump (rejected — these are pre-implementation tightenings of a not-yet-shipped contract, so no
authored workflow can break). Chosen: tighten now, label as behavior changes, keep one canonical home
per rule.

## Consequences

### Positive

- Closes a privilege-escalation path (b), a command-allowlist bypass (a), and a keychain-leak-class
  hole (c) before any engine code is written.
- One SSRF primitive guards every egress path (provider base URL, `http_request`, MCP), so a future
  egress cannot quietly skip the check.
- Secure-by-default posture: deny-all empty allowlists, exact matching, narrow-only tools.

### Negative

- A workflow author must now opt into globbing (`allowedCommandGlobs`) and cannot widen tools at the
  node — slightly more typing for explicit safety; documented as a tightening.
- Rejecting `secret` interpolation removes a (dangerous) convenience; the supported path is
  credential/header fields, which is documented.
