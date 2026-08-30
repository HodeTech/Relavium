# ADR-0088: The MCP boundary is hostile — a remote server is pinned and bounded, an unbounded one must be local and opted into

- **Status**: Accepted
- **Date**: 2026-08-30
- **Decides**: `CR-40`, `CR-41` and `CR-42` of [Phase 2.6.5](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md)
  (`W4`), together with the 2.5.5 MCP queue those three absorb (see
  [current.md](../roadmap/current.md) Wave 2 step 2, which binds that queue to this wave).
- **Amends (does not reverse)**:
  - [ADR-0053](0053-mcp-network-transport-egress-security.md) §2 — its connect-by-validated-IP **target** is
    what §2 below finally implements on the transports that can carry it. Two mechanism clauses change: a
    redirect hop is **refused** rather than re-validated (§3), and the `websocket` transport is **narrowed to
    a local, opted-in endpoint** (§2.3) rather than carrying an open hardening obligation, because the SDK
    transport §2 was waiting on does not exist and cannot be made to.
  - [ADR-0053](0053-mcp-network-transport-egress-security.md) §3 — its `allow_local_endpoint` opt-in becomes
    **one bound policy** rather than two independent relaxations (§4); the rule it states — a remote endpoint
    is always `https`/`wss` — is unchanged and §4 exists to keep it true inside the dialer.
  - [ADR-0034](0034-mcp-client-sdk-dependency.md) g2 — the "one shared SSRF primitive" is honoured by
    **extending** that primitive (§4), never by a second parser beside it.
- **Related**: [ADR-0029](0029-tool-policy-hardening.md) (d) (the one range-block primitive) ·
  [ADR-0043](0043-media-egress-failover-rematerialization-ssrf.md) (the connect-by-validated-IP mechanism this
  reuses) · [ADR-0052](0052-inbound-mcp-client-package-lifecycle-registration.md) (the MCP client's structure
  and its §4 "the server-reported schema is untrusted content") ·
  [ADR-0080](0080-durable-effect-journal-and-the-tiered-effect-contract.md) §4 (a server annotation may never
  raise trust) · [ADR-0082](0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md)
  §5 (the attempt-deadline discipline and its caller-cancel-wins rule, which §1 extends to MCP) ·
  [ADR-0084](0084-consent-before-a-local-mcp-spawn.md) (consent before a local spawn — §6 rests on it) ·
  [ADR-0086](0086-absolute-admission-ceilings-on-authored-values.md) (the authored-ceiling shape §1.4 reuses) ·
  [ADR-0087](0087-consumed-streams-size-bounds-and-run-retention.md) §2 (rejection, never truncation — §5
  applies the same rule) · [security-review.md](../standards/security-review.md) ·
  [error-handling.md](../standards/error-handling.md) ·
  [mcp-integration.md](../reference/shared-core/mcp-integration.md) ·
  [config-spec.md](../reference/contracts/config-spec.md) ·
  [agent-yaml-spec.md](../reference/contracts/agent-yaml-spec.md)

## Context

`packages/mcp` is the one place a third-party process the user configured — possibly one they did not audit,
possibly one a cloned repository chose for them — hands data straight into the model's context and into the
tool-dispatch loop. [ADR-0052](0052-inbound-mcp-client-package-lifecycle-registration.md) §4 already names the
server-reported `inputSchema` as untrusted content, and the schema→Zod compiler is genuinely hardened against
it. The rest of the boundary is not, and three measurements taken before this ADR was written say so
concretely rather than by inspection:

1. **A connect has no upper bound.** Given a transport whose `start()` never resolves, `connectSdkTransport`
   hangs indefinitely. The SDK's `DEFAULT_REQUEST_TIMEOUT_MSEC` (60 s) bounds only the `initialize`
   *request*; `Client.connect` awaits `transport.start()` **first and with no options at all**, and
   `WebSocketClientTransport.start()` settles only on the socket's `open` or `error`. A hung network server
   blocks CLI startup with no deadline.
2. **Cancellation is dropped.** `McpCapability.call(input, signal)` receives the engine's signal and discards
   it; `McpConnection.callTool(name, args)` has nowhere to put one. Measured: an aborted call was still
   pending 500 ms later. The user's Esc tears the whole connection down instead of the one call — and the
   remote or child effect keeps running.
3. **Discovery ingress is unbounded.** A server returning 100 pages of 500 tools, each with a 1 MiB
   description, was admitted whole: **50 000 tools, 52 GB of description text, zero skipped** — and that text
   is re-sent to the provider on every subsequent turn of the session.

Alongside those, this wave absorbs the 2.5.5 MCP queue — connect-phase deadlines (`#35`, `G32`, `#205`),
ingress bounds (`G33`, `#201`, `#209`, `#288`), the structured error discriminants (`#203`, `#204`), the two
fail-loud violations (`#206`, `#207`), per-file adapter coverage (`#297`), the client version (`#208`) — plus
tool-definition poisoning (`#202`) and the project-layer registration hijack (`G19`), which belong to the same
threat class and the same security sitting.

**The invariant every section below serves, stated once:** a transport that reaches a **remote** server is
pinned to a validated address and bounded in bytes; a transport that cannot be pinned or bounded is admitted
**only** for a local endpoint the user explicitly opted into. There is no third case, and no remote server the
host merely hopes is well behaved.

## Decision

### 1. Every MCP interaction carries a deadline, and the deadline is ours

**No MCP call may be unbounded, and no bound may be the SDK's implicit one.** Four deadlines, each named,
each applied by us rather than inherited:

| Phase | Bound | Why this number |
|---|---|---|
| `stdio` connect (spawn → `initialize` complete) | **120 000 ms** | The canonical authored example is `command: npx`, and a cold `npx` resolution routinely outruns the SDK's fixed 60 s before the child speaks MCP at all (`#205`). |
| network connect (dial → `initialize` complete) | **30 000 ms** | Nothing is being downloaded; 60 s is a hang, not a slow start. |
| `tools/list` discovery | **60 000 ms** | Bounds the whole paged walk, not one page — a server that answers each page slowly must not outlive the bound by paginating. |
| `tools/call` | **60 000 ms** | Matches the SDK default, now stated rather than inherited. |

**1.1 The connect deadline is one absolute window, opened before the first I/O.** Passing the SDK a
`RequestOptions` is **not** sufficient and measurement 1 is why: `Client.connect` awaits `transport.start()`
before it issues the `initialize` request, and the options reach only the request. So the window opens before
the DNS preflight (§2), covers `start()` and `initialize` together, and is enforced as a **hard race** against
the whole `client.connect()` call. The winner on the timeout or cancel path **closes the transport**, which is
what reaps a `stdio` child or a half-open socket; a race that merely rejects would leave the process behind.
The **remaining** time is passed into the SDK's own `timeout` so its internal 60 s default can neither cut an
authored 120 s window short nor extend one past its end. On a same-tick tie the caller's cancel wins, per
[ADR-0082](0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md) §5.

**1.2 Cancellation is threaded, not simulated.** `McpConnection.callTool` and `listTools` take an optional
`AbortSignalLike`; each adapter converts it to a real `AbortSignal` at the SDK boundary and passes it as
`RequestOptions.signal`. The manager forwards the signal it already receives. *(Considered: widening
`AbortSignalLike` in `@relavium/shared` to be a DOM `AbortSignal` — rejected: `@relavium/shared` compiles with
`types: []` and must not acquire a DOM/Node lib to describe a signal it only observes. Considered: leaving the
per-server teardown as the only cancellation — rejected: it invalidates every other in-flight and future call
to that server for the rest of the session, which is why the existing code comment already calls it a fallback
rather than an answer.)*

**1.3 A cancelled or timed-out `stdio` server leaves no child behind.** The bound is on the *connect*, but the
obligation is on the *process*: every abandonment path must reach the transport's teardown, which is what
reaps the child. This binds the CLI drivers too — a surface that exits on Ctrl-C without tearing the MCP client
down orphans every program it spawned (`#21`).

**1.4 An author may raise the connect deadline, under an absolute ceiling.** `McpServerRef` and
`McpServerRegistration` gain an optional `connect_timeout_ms`, admitted up to **600 000 ms** and refused
above it — the admission shape [ADR-0086](0086-absolute-admission-ceilings-on-authored-values.md) established:
a rejection, never a clamp. Without it, a user whose npx server needs four minutes has no way out and `#205`
does not close.

Three consequences of that field are settled here rather than left to an implementer:

- **It is an inline connection field**, so it joins `INLINE_CONNECTION_FIELDS` and is **rejected alongside a
  by-name `ref`** — the registration provides it, exactly as it provides `command`, `url` and
  `allow_local_endpoint`. No precedence rule is needed because no precedence is possible.
- **It enters the duplicate-declaration fingerprint** (`serverFingerprint`), for the reason that fingerprint
  already gives for `allow_local_endpoint`: two declarations sharing an `id` but differing in a connection
  property must fail loud rather than collapse first-wins.
- **It does NOT enter the ADR-0084 consent fingerprint.** That digest answers "is this the same *program* I
  approved"; a timeout changes nothing about what executes, and folding it in would re-prompt for a change
  that carries no decision — which trains a user to approve without reading, the failure
  [ADR-0084](0084-consent-before-a-local-mcp-spawn.md) §7 is built against.

*(Considered: a host-only constant — rejected, `#205` does not close. Considered: a `config.toml`-only
setting — rejected: it leaves an author writing inline `mcp_servers` with no recourse, though the registration
form does also accept the field.)*

### 2. A remote transport connects through the ONE validated dialer

[ADR-0053](0053-mcp-network-transport-egress-security.md) §2 chose connect-by-validated-IP as the target and
shipped a pre-connect host check as the floor, "until the SDK transport permits". Measured against
`@modelcontextprotocol/sdk` 1.29.0, that condition resolves in two directions, not one:

**2.1 `http` and `sse` — full pinning, today.** `StreamableHTTPClientTransportOptions` and
`SSEClientTransportOptions` both expose an injectable `fetch`. Every request on those transports goes through
a validated `fetch` built on the same `connectValidated` hop that backs media egress, the `http_request` tool
and the custom-provider adapter: resolve DNS → range-block **every** resolved IP → connect **pinned** to the
validated IP with the hostname as SNI. The host builds it and injects it; `packages/mcp` accepts it as a
`fetch`-shaped function declared in Relavium terms, so no SDK type crosses the seam.

**2.2 The pin enforces the authored `host:port`, not just the host.** This is
[ADR-0053](0053-mcp-network-transport-egress-security.md) §3's `SEC-EGRESS-3` obligation binding the dialer:
an `allow_local_endpoint` server is permitted exactly its declared `host:port`, so a resolved target on a
different port of the same permitted-private host (`:6379`, `:5432`, `:22`, the Docker socket) stays blocked.

**2.3 `websocket` is narrowed to a local, opted-in endpoint.** `WebSocketClientTransport`'s constructor accepts
a `URL` and nothing else — no `fetch`, no dialer, no socket factory — and its `onmessage` runs
`JSON.parse(event.data)` before any Relavium code sees a byte. So on that transport we can enforce **neither**
the pin of §2.1 **nor** the byte bound of §5. A **remote** `websocket` server is therefore **refused at
admission**, with a typed error naming `http` (Streamable HTTP) as the transport that carries the same server
safely. A `websocket` server with `allow_local_endpoint` is still permitted, and still runs the pre-connect
resolve-and-range-block so it cannot reach anything but its declared private `host:port`.

This is a narrowing of what Relavium accepts, chosen over three alternatives. *(Considered: keep remote
websocket on a pre-connect check and record the rebind window as a residual — rejected once the memory hole
was measured: that is two unclosed holes against a server the user never consented to run, and unlike `stdio`
there is no gate anywhere on the path. Considered: own a `Transport` over the `ws` package, which offers
`maxPayload` and a custom `lookup`/`agent` and would close both — rejected for this wave: it is a new runtime
dependency in the tool path, and the narrowing above costs a niche transport rather than a guarantee.
Considered: own a `Transport` over Node's global `WebSocket` — rejected: measured, it accepts an options bag
without throwing but its honouring of a `dispatcher` is not verifiable from outside undici, and a security
mechanism that cannot be verified is not one.)* **The trigger to revisit is either an SDK release with a
dialer hook, or a user who actually needs remote websocket** — at which point the `ws`-backed transport
becomes the proposal, with its own dependency ADR.

### 3. A redirect is refused, not followed

A `3xx` on an MCP network transport is a typed connect failure naming the redirect, and the fix is for the
author to declare the final url.

[ADR-0053](0053-mcp-network-transport-egress-security.md) §2 assumed the HTTP layer would follow redirects and
re-validate each hop. **The guarantee it wanted — a redirect to a private address is blocked — is kept
strictly more tightly by not following at all**, and two things make refusal the better mechanism rather than
merely the cheaper one. First, an MCP server is identified by the exact url the user declared and, for a local
endpoint, by an exact `host:port`; a redirect changes which server the session is talking to, and no
range-block expresses "and it is still the server the user chose". Second, refusal is provable from the
outside — there is no hop count, no re-validation ordering, and no partial state to get wrong. The CLI's
`http_request` egress arm already refuses to follow redirects for the analogous reason (its allowlist was
checked on the original url only).

*(Considered: follow up to N hops with the final `host:port` pinned to the authored one — rejected: it admits
only path redirects, which is a narrow gain for a real increase in moving parts. Considered: follow with full
per-hop re-validation as ADR-0053 §2 wrote it — rejected: a redirect to any *public* host passes the
range-block and silently relocates the server the user authored.)*

### 4. The local-endpoint opt-in is ONE bound policy, not two independent relaxations

`connectValidated` is HTTPS-only, and the canonical local-dev MCP endpoint documented in
[mcp-integration.md](../reference/shared-core/mcp-integration.md) is `http://localhost:4000/mcp`. The shared
mechanism therefore gains **a single optional local-endpoint policy** — the authored `host:port` a server
declared — and **not** a pair of independent `allowPrivate` / `allowPlaintext` booleans.

Two independent flags would invert ADR-0053 §3's own rule. Set both for any server carrying
`allow_local_endpoint`, and `http://public.example` with that flag becomes a plaintext connection to a
**remote** host — a relaxation the flag was never meant to grant, and one today's pre-connect floor correctly
refuses. So the policy is bound at both ends:

> The private-range block and the plaintext permission are lifted **together, and only** for a target whose
> resolved address is genuinely private/local **and** whose `host:port` matches the authored one exactly.
> A target that resolves outside the private ranges is `https`/`wss`-only and range-checked as normal,
> whatever the flag says.

Which means a server declared as a local endpoint but resolving to a public address is refused, not silently
downgraded — the flag narrows what is allowed, it never widens it.

This touches a security-critical file that media egress and provider egress also depend on, which is the
reason to state it here rather than let it happen inside an implementation. The alternative — a narrow second
path for local endpoints — is where [ADR-0029](0029-tool-policy-hardening.md) (d)'s one-primitive rule starts
to erode, and a second URL parser beside the first is exactly the shape this project has refused twice before.
The default is unchanged: absent the policy, every existing call site keeps the behaviour it has.

### 5. Discovery and result ingress are bounded, by named values

Seven bounds, chosen so that every real MCP server in circulation clears them with several times' headroom
while measurement 3's server is refused:

| What | Bound | Level |
|---|---|---|
| Tools admitted per server (across all `tools/list` pages) | **256** | application |
| One tool's `description` | **8 KiB** | application |
| One server's total discovery payload (names + descriptions + schemas) | **1 MiB** | application |
| One string literal or `enum` member inside a schema | **4 KiB** | application |
| One schema property name | **256 B** | application |
| One `tools/call` result's text | **1 MiB** | application |
| One message on an `http`/`sse` transport | **4 MiB** | transport |

**5.1 Two levels, two different guarantees — stated apart because they are not the same promise.**

- A **transport-level** bound is enforced on raw bytes **before** anything parses them, so it bounds **peak
  memory**. It is available exactly where we own the byte path: the injected `fetch` of `http`/`sse`.
- An **application-level** bound is enforced on an already-parsed value, so it bounds **what is admitted** —
  what reaches the prompt, the state and the registry — and **not** what was allocated to get there.

Claiming the second prevents an OOM would be false, and this ADR says so rather than implying it. Where only
the application bound exists — `stdio` and a local `websocket` — the memory story is §6's, not §5's.

**5.2 Measurement is normative, because "8 KiB" alone is three different numbers.** Every bound counts **UTF-8
bytes** through the one shared helper (`utf8ByteLength`, which moves to `@relavium/shared` so the compiler and
the mapper share it rather than each choosing), never a UTF-16 `.length`. A schema is measured as its
**canonical JSON serialization**, the form that actually travels. The aggregate discovery bound is applied in
**declaration order** as tools are admitted, and the first tool that would cross it is **dropped along with
every tool after it, and paging stops** — fail-closed rather than admitting a prefix that depends on which
page arrived first. A test covers multi-byte characters specifically, because that is where a `.length`
regression hides.

**5.3 An over-bound tool is dropped, not admitted** — through the existing `SkippedTool` mechanism, the same
way an unsupported `inputSchema` is already dropped, so the server stays usable and the host reports what it
refused. **An over-bound result or message fails the call**, because half a tool result silently reaching the
model is a wrong answer that looks like a right one — the same rule
[ADR-0087](0087-consumed-streams-size-bounds-and-run-retention.md) §2 gives for rejecting rather than
truncating.

**5.4 The `http`/`sse` message bound is per message, not per body.** A Streamable HTTP session's GET stream is
long-lived and carries many messages, so a whole-body cap would kill a normal session at the wrong moment. It
is enforced on a counting pass-through that resets at each SSE event boundary, which yields the property that
is actually wanted — bounded peak memory — and not the one that cannot be had, a bounded total for a session
with no defined length.

The `tools/call` result bound sits above `DEFAULT_TOOL_RESULT_LIMITS` (50 KiB, with spill) deliberately: the
model-facing bound still does its work, and this one exists to stop the host admitting something it can never
show. The aggregate discovery bound exists because 256 tools at 8 KiB each is already 2 MiB before a single
schema is counted; per-item bounds alone do not bound the total.

### 6. An unbounded transport must be local and opted into — and both are

The SDK's `StdioClientTransport` accumulates the child's stdout in an internal buffer we cannot reach, and its
`WebSocketClientTransport` parses a frame before we see it. Neither can carry §5's transport-level bound
without owning the socket. Rather than leave that as a hole, §2.3 removes the only case where it would apply
to a server the user did not deliberately admit:

- **`stdio`** runs a program the user consented to run on this machine
  ([ADR-0084](0084-consent-before-a-local-mcp-spawn.md)). A program you have agreed to execute can exhaust
  your memory by any means it likes; MCP is not the interesting one.
- **`websocket`** is now permitted only with `allow_local_endpoint` — an explicit, per-server opt-in to a
  private address the author wrote down.
- **`http`/`sse`**, the transports a remote server actually uses, are bounded at the byte level by §5.

So the residual is stated exactly, and it is small: a **local** MCP server the user opted into can exhaust
host memory with one enormous message, and the control for that is the consent decision and the author's own
choice of endpoint — not a byte counter we cannot install. §5's application-level bounds still apply to both.

### 7. A server's tool DEFINITIONS are untrusted content

`packages/core`'s `Untrusted<T>` brand covers tool *results*. A server's `description` and `inputSchema` are
equally attacker-controlled and reach the model in the tool spec itself, without ever passing that boundary —
the "MCP tool poisoning" channel (`#202`).

**7.1 Presentation text is sanitized; a semantic field is not rewritten.** The distinction is load-bearing: a
tool's `description` and `title` are text shown to a model or a human, and stripping terminal-control bytes
from them changes nothing else. A property **name**, a `const` or `enum` value, and a `required` entry are
**semantic** — they are simultaneously the model-visible schema, the compiled validator's expectation, and the
wire contract with the server. Rewriting one desynchronises all three and produces a tool that is broken
rather than safe. So:

- **Presentation text is sanitized** at the discovery boundary, so poisoned bytes never propagate to a render,
  an approval prompt, or a log — not only at the last surface that happens to display them.
- **A semantic field carrying a terminal-control byte drops the tool**, fail-closed, through the existing
  `SkippedTool` path. A legitimate server has no reason to put a control character in a property name.

The existing `stripTerminalControls` (today in `apps/cli/src/render/sanitize.ts`) moves to `@relavium/shared`
so `packages/mcp` reuses the one primitive rather than growing a second — the same extraction
[ADR-0029](0029-tool-policy-hardening.md) (d)'s one-primitive rule asks for everywhere else.

**7.2 The provenance is stated to the model**, not hidden: a discovered tool's description is presented as
text the server supplied. This is **advisory, not structural** — the model is the thing being steered, so no
wrapper can make it safe — and this ADR says so rather than implying a guarantee. Concretely, tool
definitions are **not** routed through the `Untrusted<T>` brand: that brand's guarantee is that a value cannot
reach prompt assembly without an explicit unwrap, and a tool definition's whole purpose is to reach the model.
Sanitization at discovery plus a stated provenance is the honest mechanism; a brand here would imply a
structural property that does not exist.

**7.3 The gap is documented** in [mcp-integration.md](../reference/shared-core/mcp-integration.md)'s Security
section, which today discusses only SSRF and credentials.

A server's own annotations (`readOnlyHint` and friends) still may never raise trust — that is already settled
in [ADR-0080](0080-durable-effect-journal-and-the-tiered-effect-contract.md) **§4** and is unchanged. (The
citation in `tool-mapping.ts` says §5; that is a stale reference this wave corrects.)

### 8. A project-layer config may not redefine a global MCP registration

`mergeMcpServers` is last-writer-wins by name, so a project-scoped `[[mcp_servers]]` entry silently replaces a
global one — including a global one whose `env` carries `{{secrets.*}}` (`G19`). A registration is not a
preference: it names **a program to execute** and **a secret to inject**, and a project config arrives with a
cloned repository. A name collision across trust layers is therefore a **loud refusal** naming both layers,
not a merge.

Last-writer-wins stays correct for every other setting; this is one list, singled out for what its entries
authorise. *(Considered: let the project layer win but strip secret injection — rejected: it turns a
configuration mistake into a silently degraded server. Considered: rely on ADR-0084's consent re-prompt —
rejected as sufficient: it covers `stdio` only, and a re-prompt for a name the user already approved invites
approval by habit.)*

### 9. Errors carry structured fields, a reason, and a real client version

Every `@relavium/mcp` error gains the identifying context as **fields** (`serverId`, `toolId`) rather than
interpolated sentences, and `McpConnectError` gains a `reason` discriminant derived from the caught error's
shape — spawn failure, timeout, protocol mismatch, malformed url, blocked host, redirect, unknown. The
message stays secret-free and `cause` stays opaque and host-stripped; the discriminant is what lets a host say
"wait, npx is still installing" instead of one sentence for every failure (`#203`, `#204`).

Two silent paths become loud in the same pass: a non-object `arguments` payload is a typed error rather than
a silent swap to `undefined` (`#206`), and `closeAll` surfaces teardown failures to a caller that can report
them rather than discarding them unconditionally (`#207`).

**The client version reported in the MCP handshake is derived, not hand-maintained** (`#208`).
`CLIENT_INFO.version` is a `0.1.0` literal while the CLI is already past `0.1.1`; it is sourced from the same
build-time token `tsup.config.ts` already injects for `--version`, injected by the host rather than compiled
into `packages/mcp` (which has no release version of its own), with a regression test that fails if the two
diverge.

### 10. What is NOT decided here

**Lazy connect** ([ADR-0052](0052-inbound-mcp-client-package-lifecycle-registration.md) §3) is untouched — it
is blocked on the durable tool-list cache, and nothing here changes that. **`npx` dependency pinning** is
untouched: consent answers "may this program run", not "is it the same code as yesterday". **Header-based auth
for network servers** stays scheduled where it is recorded, in
[deferred-tasks.md](../roadmap/deferred-tasks.md) ("MCP network transport — header-based auth"). **Outbound
MCP** remains ownerless. Each keeps its entry there.

### 11. Acceptance

A hostile-server harness with adversarial cases, not a smoke test:

- A server that never answers is refused **within its deadline** on each permitted transport, with the bound
  covering `transport.start()` — proven against a transport whose `start()` never settles, which is
  measurement 1's own reproduction. A `stdio` one leaves **no orphan process**, asserted against the actual
  child-process state, never against the promise.
- An authored `connect_timeout_ms` above the SDK's internal default is honoured rather than cut to 60 s; one
  above the ceiling is refused at admission; one alongside a `ref` is refused at parse.
- An in-flight `tools/call` that is aborted rejects promptly, and the abort reaches the SDK request.
- A DNS record resolving to loopback, to an RFC1918 range, and to the cloud metadata address is refused on
  `http` and `sse`.
- A redirect is refused with the typed reason, whatever it points at.
- An `allow_local_endpoint` server resolving to a **different port** of the permitted host is refused, and one
  resolving to a **public** address is refused rather than silently downgraded to plaintext (§4).
- A **remote** `websocket` server is refused at admission; a local opted-in one still connects.
- Discovery over each §5 bound is dropped and reported, with a **multi-byte** case proving UTF-8 accounting;
  an over-bound result and an over-bound `http`/`sse` message each fail with a typed error **before** reaching
  the prompt.
- A tool whose `description` carries terminal-control bytes is admitted **sanitized**; one whose property name
  carries them is **dropped**.
- A project-layer registration colliding with a global one refuses loudly.
- Each test is **break-verified**: reverted production change ⇒ red, and the mutation confirmed to have
  landed.

**The canonical specs land with the code that implements them, not with this ADR.** `mcp-integration.md`'s
Security section, `agent-yaml-spec.md` and `config-spec.md` (the `connect_timeout_ms` field, the websocket
narrowing, the registration-collision rule) are updated in the step that makes each true. Writing them at
acceptance time would leave the specs describing behaviour the code does not yet have, which is the exact
failure mode [Phase 2.6.5](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md)'s exit criterion 7
exists to catch.

## Consequences

### Positive

- The three measurements that opened this ADR each become an assertion: a bounded connect, a cancelled call,
  a refused catalogue.
- The boundary gets one statable invariant — remote means pinned and bounded, unbounded means local and
  opted-in — instead of a per-transport patchwork with an open obligation in the middle of it.
- ADR-0053's connect-by-validated-IP target stops being an aspiration on the transports that can carry it, and
  the one that cannot is removed from the remote surface rather than left with a residual.
- The SSRF surface stays on **one** primitive, extended in place — the outcome ADR-0029 (d) asks for and the
  one a second local-endpoint path would have quietly ended.
- A user whose npx server is slow has a way to say so, and a user whose server fails gets a reason rather than
  one sentence.

### Negative

- **Remote `websocket` stops working.** Accepted, and it is a real removal, not a technicality: an author
  using it must move the server to `http`. Mitigated by the typed error naming that transport, and by the fact
  that the alternative is two unclosed holes against an unconsented remote server. The trigger to restore it
  is named in §2.3.
- **Other previously-working configurations can now be refused**: a server behind a redirect, a project config
  that redefines a global registration, a server with an unusually large catalogue. Accepted, with the
  mitigation that each refusal names what to change; the alternative is an engine with no defined behaviour at
  the extremes, which is the reason [ADR-0086](0086-absolute-admission-ceilings-on-authored-values.md) gives
  for its own ceilings.
- **A security-critical shared file gains a local-endpoint policy** that media and provider egress also
  compile against. Accepted: the default is unchanged and fails closed, and the alternative is a second parser.
- **A local MCP server can still exhaust memory.** Accepted and stated in §6: the control is the consent gate
  and the explicit local opt-in, not a byte counter.
- **Seven more numbers that will eventually be wrong.** Accepted rather than pretended otherwise; they are
  named constants and raising one is not a breaking change.

### Neutral

- The authored surface grows by one optional field (`connect_timeout_ms`, on both server schemas) — additive,
  strict-validated, secure by default, and rejected alongside a by-name `ref` like every other connection
  field.
- Two pure primitives (`utf8ByteLength`, `stripTerminalControls`) move to `@relavium/shared` so the MCP layer
  reuses them; `packages/mcp` gains `@relavium/shared` as a workspace dependency. No third-party runtime
  dependency is added by this ADR.
- This ADR owns the hostile-MCP *boundary*; the client's structure stays with
  [ADR-0052](0052-inbound-mcp-client-package-lifecycle-registration.md) and the local-spawn decision with
  [ADR-0084](0084-consent-before-a-local-mcp-spawn.md).
