# ADR-0084: Consent before a local MCP spawn

- **Status**: Accepted
- **Date**: 2026-08-20 (Accepted 2026-08-20, after the mandatory design security review)
- **Related**:
  - [ADR-0006](0006-os-keychain-for-api-keys.md) — secrets live in the keychain; §3 states exactly what of a secret enters a digest.
  - [ADR-0034](0034-mcp-client-sdk-dependency.md) — the MCP SDK dependency and its child-env posture. **Amended here**: g5's "curated minimal base" describes what is *inherited*, not what may be *declared*.
  - [ADR-0047](0047-cli-framework-commander-ink-clack.md) — where a `@clack/prompts` call may live.
  - [ADR-0049](0049-cli-machine-output-contract.md) — the `--json` machine-output contract §6 must not break.
  - [ADR-0052](0052-inbound-mcp-client-package-lifecycle-registration.md) — the MCP client's lifecycle. §2's host-delegated connect gains a gate; §3's immutable registry is why lazy connect is *not* part of this ADR; §1 is why this gate cannot cover the desktop.
  - [ADR-0053](0053-mcp-network-transport-egress-security.md) — the network transports' SSRF floor. This is the missing floor for the *local* transport.
  - [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md) — per-tool approval at dispatch. §1 explains why the two cannot be the same mechanism.
  - [architectural-principles.md](../standards/architectural-principles.md) §"secure by default", [security-review.md](../standards/security-review.md) §Sandbox and tool policy and §CLI terminal-render safety.

> **Accepted (design reviewed, 2026-08-20).** The mandatory security review ran as two adversarial passes over
> this document, and it changed the decision rather than confirming it: the fingerprint originally excluded
> both the environment values and the `cwd`, and measurement showed each exclusion made the digest identify a
> *declaration* rather than a *program* — a prefixed `PATH` redirected a bare `npx` through the SDK's own
> spawn, `NODE_OPTIONS` executed a preload, and `node server.js` named two different files in two directories.
> A flat `secret:<name>` marker collided with the literal string of the same text; an append-only store was
> specified with a rewriting write; and the interactivity precondition consulted one stream of the four that
> matter. §3–§7 are what those passes produced.
>
> **A second, separate security review of the IMPLEMENTATION is a landing obligation** (§11), not a Status
> gate: this ADR records a decision, and §10's acceptance is what the implementation PR must satisfy before
> merge.

> **Amended 2026-08-20 — four corrections the first implementation step forced, each measured.**
>
> - **`digestOf` is NOT promoted, and §11's instruction to promote it was wrong.** Only `canonicalJson`
>   moved to `@relavium/shared`; the hash stays with each caller because `node:crypto` may not be imported
>   from a package the desktop WebView loads (CLAUDE.md rule 5). §3's pointer to
>   `packages/db/src/effect-journal-store.ts` for the canonical form is superseded by
>   `packages/shared/src/canonical.ts`.
> - **`canonicalJson` REFUSES a shape with no faithful JSON form**, rather than serializing it. Measured:
>   a `Date`, a `Map` and a class instance each produced `{}`; a non-finite number and an `undefined`
>   property each produced `null`. Every one collides with a different, real value — in a function whose only
>   job is to tell values apart. It is also depth-bounded, so a second implementation's own recursion limit
>   is not an undocumented part of the contract. A sparse array used to serialize to `[,1]`, which is not
>   JSON at all.
> - **§4's denylist is wider than the categories it inherited.** Three vectors were measured executing code
>   under names the original list permitted: `ZDOTDIR` (`BASH_ENV`'s vector for macOS's DEFAULT shell — a
>   `.zshenv` ran before the target command), `NPM_CONFIG_USERCONFIG` (redirected npm's resolved registry,
>   which lands on §3's own canonical example `npx -y @acme/server`, repointing an APPROVED fingerprint's
>   package), and `BASH_FUNC_*`. `PATHEXT` and `COMSPEC` are added for the reason `PATH` already was —
>   resolution reads them, so accepting them would mislead — along with `NODE_EXTRA_CA_CERTS`, `LESSOPEN`,
>   `SHELLOPTS`, `PS4`, `PERLLIB` and `XDG_CONFIG_DIRS`. The Consequences bullet naming an "inherited gap"
>   scoped it to other tools' config files; it was narrower than the truth, and the gap it still names — the
>   cloud CLIs' config paths — is now the whole of it.
> - **The §4 break is wider than "a workflow stops parsing".** It reaches PERSISTED state: a chat session's
>   frozen agent snapshot is re-parsed on every read, and `relavium gate` re-parses
>   `runs.workflow_definition_snapshot`, so a session and a PAUSED RUN authored under the old rules both
>   stop loading. Fail-closed is the right direction — the declaration can redirect the loader, and resuming
>   it would spawn under exactly that — but it is a consequence, not a footnote, and it was not recorded.

> **Amended 2026-08-20 (second) — four more the implementation forced, each measured.**
>
> - **§3's "a command that does not resolve is refused" was only true of a BARE name.** `path.resolve` is
>   string arithmetic — it never fails and never touches the filesystem — so a declared explicit path that
>   did not exist produced a fingerprint and could be consented to, and anything later materialising there
>   would spawn under a grant nobody evaluated against a real program. Both branches verify an existing,
>   executable regular FILE now; a directory sharing a command's name is skipped rather than "found", which
>   `access(X_OK)` alone permitted on POSIX and, `X_OK` being a documented no-op there, on Windows for
>   anything at all.
> - **The grant store refuses to be written through a SYMLINK.** The exclusive create refuses to follow one
>   at first creation, but every later append and `chmod` followed it — a review reproduced a grant record
>   landing in an arbitrary target file. §5's accepted risk is that write access to `~/.relavium` can edit
>   the grant file; using it as a write primitive against files elsewhere is a different thing and is not
>   accepted. The sibling terminal outbox has the identical shape and takes the identical guard.
> - **§5's "one bounded record" was a claim, not a property.** Neither `McpServerRefSchema` nor the grant
>   record caps an `args` count, an `env` count, or a string length, so a declaration could produce a line of
>   megabytes — past where a single write is reliably atomic, which is what the no-lock concurrent-append
>   design leans on. The stored COMPARISON METADATA is bounded now; the digest is fixed-size and untouched.
>   A schema-level cap remains worth having for the PROMPT rather than for atomicity, and is its own item.
> - **The §3 golden vectors did not cover what §3 says they cover.** The declaration→digest set had one
>   vector, exercising only the empty cases; non-ASCII, an embedded quote and a backslash are pinned now, as
>   is the `literal` / `secret-ref` tagging a second implementation has to reproduce. Each expected digest is
>   computed independently of the implementation, not read back out of it.

## Context

A workflow or agent may declare an MCP server with `transport: stdio`, a `command`, and `args`. Opening that
artifact runs the command.

Not "may eventually run it once a tool call is approved" — runs it, while the session or run is being
*constructed*, before the first turn exists. `connectAgentMcp` / `connectWorkflowMcp` resolve each declared
server into an `McpServerConfig` whose `open()` hands the spec to `openStdioConnection`, which constructs a
`StdioClientTransport` and spawns the child. The manager then calls `tools/list`, because the agent's tool
grant is *derived from what the server reports* — so the spawn is neither optional nor deferrable (§8).

Four properties, each measured against the tree rather than assumed:

- **The per-tool approval gate cannot see it.** [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md)'s
  `confirmDispatch` runs inside the tool registry, at dispatch. The spawn is strictly earlier. `ask` mode —
  the mode whose entire promise is "nothing happens without me" — does not cover it, and neither does `plan`.
- **`shell: false` is not a defence.** It stops a shell from interpreting a string. It does not stop the
  declaration from naming `sh`, `bash`, `node` or `npx` as the executable, and it does not stop a bare command
  from resolving through the child's `PATH` — measured: with `PATH` prefixed to a temp directory, the SDK's own
  `cross-spawn` ran a planted `npx`.
- **The declaration is the only gate today.** Registering — or inline-declaring — a stdio server *is* what
  authorizes the spawn. There is no second one. And an agent may declare a fully inline server with no
  `[[mcp_servers]]` registration at all, which is exactly the imported-artifact case.
- **The artifact is often not the user's.** `relavium import` exists to bring in a workflow someone else
  wrote. The threat is the ordinary act of trying out a shared artifact.

The network transports already have a floor: [ADR-0053](0053-mcp-network-transport-egress-security.md) puts
every `http`/`sse`/`websocket` URL through an SSRF check before it is reached. The *local* transport — the one
that executes code on the user's machine — has none.

### The child env is an unrestricted override channel, and a sibling host already knows it

[ADR-0034](0034-mcp-client-sdk-dependency.md) g5 describes the spawned child's environment as "the declared
env + a minimal base, never a blanket copy". True, and incomplete in the direction that matters: the SDK
spawns with `{ ...getDefaultEnvironment(), ...spec.env }`, so **the declared env wins every conflict**,
including over the base's own `PATH`. `buildChildEnv` inspects no key name; it resolves `{{secrets.*}}`
placeholders and passes everything else through verbatim.

Measured, on this tree's pinned SDK: `NODE_OPTIONS: '--require /tmp/preload.js'` executed the preload before
the target script; a prefixed `PATH` redirected a bare `npx`; `DYLD_INSERT_LIBRARIES` was honoured for a
non-SIP binary (and stripped for a SIP-protected one); `LD_PRELOAD` passes through intact and is the live arm
on Linux.

The project already draws this line one module away: `run_command`'s host maintains a denylist of declared
environment names covering interpreter and loader option injection, the whole `GIT_` namespace, and
config-home redirection. The MCP stdio path being exempt from the identical rule is a gap, not a decision —
§4 closes it.

### Three corrections this ADR is built on, verified against the tree

The plan review of [phase 2.6.5](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md) checked the
original `CR-16` item against the code and found three of its assumptions wrong.

1. **Lazy connect is structurally blocked**, so it is not part of this ADR (§8).
2. **`cwd` is host-supplied, not authored.** `McpServerRefSchema` is `.strict()` and has no `cwd` field; the
   value comes from `deps.global.cwd`. §3 records what that does and does not imply.
3. **`relavium import` spawns nothing.** It is synchronous YAML I/O. The execution happens at the next
   `chat --agent` / `agent run` / `run`, which is where the gate belongs (§9).

## Decision

**A stdio MCP server is not spawned until the user has consented to that exact declaration, resolved to an
exact executable, in that exact directory — and the consent is remembered by fingerprint.** In a
non-interactive process there is no prompt: a run with no recorded consent and no explicit authorization is
refused, with the digest printed so it can be authorized deliberately.

### 1. The gate is a HOST decision, at one chokepoint, before any spawn — and it covers the CLI

`@relavium/mcp` stays a transport fence: it knows how to spawn and connect, and nothing about who is allowed
to. The gate lives in the CLI host, in `apps/cli/src/engine/mcp-servers.ts`, between resolving each declared
server to its **inline** form and building the `McpServerConfig`s — the single point both `connectAgentMcp`
(chat, agent run) and `connectWorkflowMcp` (workflow run) already pass through. Gating on the *resolved inline
ref* rather than on a registration is what makes it cover an agent that declares a server with no
`[[mcp_servers]]` entry, which is the imported-artifact case. A refused server means `open()` is never
constructed, let alone called.

**Scope, stated rather than implied.** This gate covers the Node/CLI surface, which is the only surface that
can reach a stdio spawn today — `apps/desktop` and `apps/vscode-extension` contain a README and nothing else.
[ADR-0052](0052-inbound-mcp-client-package-lifecycle-registration.md) §1 assigns the desktop's stdio lifecycle
to its **Rust backend**, which never imports `@relavium/mcp`, so a gate in `apps/cli` is structurally
incapable of covering it. **A Phase-3 desktop or VS Code surface must implement its own gate before it ships a
stdio spawn**, and §3's digest plus §5's grant file are defined as a **language-agnostic contract** precisely
so a second implementation satisfies the same rule rather than inventing a parallel one.
[ipc-contract.md](../reference/contracts/ipc-contract.md) is the existing precedent for a contract the Rust
backend must satisfy, and §11 lands the invariant there.

Considered and rejected: **a consent hook inside `@relavium/mcp`** (policy and a prompt contract inside the
SDK-fenced package, which has no business owning either); **reusing
[ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md)'s `ConfirmActionHook`** (a *dispatch*-time hook over
a `ToolDef`, and there is no tool yet — the tools are what the spawn discovers); **gating inside each `open()`
thunk** (correct but later — "nothing was spawned" would become a property of every adapter rather than of one
decision).

**Proven by counting spawns, not by reading a flag.** §10's acceptance injects a counter at the process
boundary and asserts zero.

### 2. Consent is per server, not per artifact

Each declared server gets its own decision, showing its own executable. A batched "this artifact will run 2
programs — approve all?" is rejected: the most dangerous line disappears into a list, and "approve all" is the
habit that empties consent of meaning. The *count* is stated once before the first prompt ("this artifact will
start 2 local programs"), so a user knows how many decisions they are entering rather than discovering the
second one after granting the first.

A refused server fails the whole start, which is
[ADR-0052](0052-inbound-mcp-client-package-lifecycle-registration.md) §2's existing fail-loud rule — a run
that silently lost a tool grant would be worse than one that stopped.

### 3. The fingerprint: what makes it "the same server I approved"

```text
v1:<64 lowercase hex>  =  "v1:" + sha256( canonicalJson({
  transport : "stdio",
  command   : <the RESOLVED absolute executable path>,
  args      : [<each authored arg, verbatim, in order>],
  env       : { <name> : { kind: "literal",    value: <authored text> }
                       | { kind: "secret-ref", name:  <referenced secret> }, … },
  cwd       : <the canonical realpath of the spawn directory>,
}) )
```

**The command is RESOLVED before the gate, and the resolved path is what is spawned.** A digest over the word
`npx` names a word, not a program: the ambient `PATH` decides which file runs, and a directory prepended to it
substitutes another binary under an unchanged declaration. So the host resolves `command` against the ambient
`PATH` (and `PATHEXT` on Windows) *before* computing the fingerprint, digests the absolute path it found, and
passes **that same absolute path** to the spawn. A command that does not resolve is refused before any prompt
— an unresolvable executable is not a decision a user can meaningfully make. (An earlier draft claimed the
child's `PATH` was "now in the digest" and closed this. It did not, and could not: §4 forbids an authored
`PATH` outright, and the *inherited* `PATH` was never in the payload.)

**Env values are IN, type-tagged, and an earlier draft's reason for excluding them was measured false.** That
draft said hashing the authored placeholder "would make the fingerprint change when a secret is rotated". It
would not: `{{secrets.foo}}` is literal authored text, and rotating the keychain entry changes what the
resolver returns at spawn time, never the text. Excluding values bought nothing and cost the whole guarantee —
`NODE_OPTIONS` is an env *name*, so a grant taken for one value matched any later value byte for byte.

Each value enters under an explicit `kind`, and the tag is load-bearing rather than decorative: a flat
`secret:<name>` marker collided with the *literal string* `secret:<name>`, so an approved literal could later
become a real credential reference with no re-prompt. The split follows the project's other durable digest,
where a secret-tainted value is **removed** before hashing rather than hashed, because a digest over an
unencrypted-at-rest store is a permanent offline oracle:

- A value that is exactly one `{{secrets.<name>}}` reference contributes `{ kind: "secret-ref", name }`. The
  credential never enters the digest, and swapping `{{secrets.a}}` for `{{secrets.b}}` — handing the same
  approved program a *different* credential under an unchanged set of env names — re-prompts.
- Any other authored value contributes `{ kind: "literal", value }` with the text as written. If an author
  hardcoded a literal credential there, its digest is derived — named rather than hidden: the same literal is
  already sitting in plaintext in the artifact and, for a registration, in `config.toml`, so the digest adds
  no exposure the machine did not have. The
  [phase 2.5.5](../roadmap/phases/phase-2.5.5-hardening-and-remediation.md) secret-shaped-literal lint is the
  item that addresses hardcoded credentials; this ADR does not.

**`cwd` is IN, as a canonical realpath.** An earlier draft left it out for consent-fatigue reasons, on the
premise that a fingerprint identifies "that specific executable". It does not, without `cwd`:
`McpServerRefSchema` does not require an absolute path, and an argument like `server.js` resolves against the
spawn directory — measured, one identical declaration is two different programs in two directories. A grant is
therefore **project-scoped**. The path is `realpath`'d so two symlinked routes to one directory are one grant
rather than two, and so a symlink swapped between grant and spawn cannot present as the approved directory.
The fatigue cost is real and accepted, mitigated by telling the user what the prompt is a repeat of ("you
approved this same program in `~/a`") rather than by weakening the identity.

**What the digest still does not pin, said plainly.** It names a *file at a path*, not that file's contents:
between the grant and a later spawn the bytes at that path can change, and `npx -y @acme/server` resolves a
*package* at run time to whatever the registry serves. No digest available here closes either, and the
alternatives are worse — **hashing the artifact file** is defeated by `relavium import` re-serializing through
`serializeAuthored`, so the on-disk bytes differ from the reviewed bytes; **hashing the executable's contents**
would re-prompt on every routine upgrade of a trusted tool while still not covering an interpreter reading a
changed script.

**Canonicalization is byte-exact, because a digest is a stored equality oracle a second implementation must
reproduce.** It follows the repo's existing `canonicalJson` / `digestOf`
(`packages/db/src/effect-journal-store.ts`) rather than inventing a second canonicalizer: object keys sorted
by **UTF-16 code-unit ordinal** comparison (never `localeCompare` — the nearby `mcp-servers.ts` sort uses it
today and is a latent reproducibility defect this ADR does not inherit), no whitespace, UTF-8, SHA-256,
**lowercase hex**. Five things that helper does not settle are pinned here:

- an **absent** `args` or `env` serializes as `[]` / `{}` — absent and empty are the same declaration;
- string escaping is **ECMAScript `JSON.stringify` semantics** (`\"`, `\\`, `\b\f\n\r\t`, `\uXXXX` for other
  C0, everything else literal UTF-8), because that is what the existing helper produces and what a second
  implementation must match rather than guess;
- a **lone surrogate** in any field makes the declaration unfingerprintable and is refused at parse — it has
  no well-defined UTF-8 encoding, so two implementations would legitimately disagree;
- the digest carries a **`v1:` algorithm prefix**, so changing any of the above later makes every stored grant
  unrecognisable and fails closed into a re-prompt rather than silently matching;
- a set of **golden test vectors** (declaration → digest) ships with the contract, covering non-ASCII, an
  embedded quote and backslash, an empty `args`, and an absent `env`, so a Rust implementation is verified
  against the same fixtures rather than against a second reading of this paragraph.

`node:crypto` computes it, host-side — the CLI is a Node surface, `packages/core`'s purity is untouched, and
[CLAUDE.md](../../CLAUDE.md) rule 3 forbids hand-rolling it.

### 4. One environment denylist, shared by both process hosts

A declared MCP stdio `env` is subject to **the same forbidden-name rule `run_command` already enforces** —
interpreter and loader option injection, module paths, the `GIT_` namespace, config-home redirection, and
`PATH` — matched **case-insensitively**. Rejected at parse, as an authored error.

**The list is not restated here.** An earlier draft named four entries and called them "the exact list";
they were a subset, and a subset is worse than a citation because it reads as complete. The rule becomes one
exported predicate in `@relavium/shared` — the package both the agent schema and the config schema already
parse through — consumed by `run_command`'s host and by the MCP path, with a test asserting the two cannot
drift apart. **That predicate is the list's one canonical home**; today the names live only inside
`process.ts`, and [security-review.md](../standards/security-review.md) §Sandbox and tool policy states the
rule without enumerating them, which is why §11 extends that section to cover the MCP path rather than
copying a list into a second place.

Consent answers "do I trust this program"; a loader variable answers "this is actually a different program",
and the two are not the same question. The fingerprint alone would catch a *change*, but an approved server
could still be handed `NODE_OPTIONS` on the very first run. One rule, one list, both hosts.

This is a **compatibility break**: a workflow that declares `env: { PATH: … }` parses today and stops parsing.
It is taken deliberately — the alternative is a documented inconsistency where the same variable is dangerous
in one host and inert in the other — and §11 lands it in both the agent and the config spec.

### 5. The grant store: an append-only log, machine-local

`~/.relavium/mcp-consent.ndjson`, mode `0600`, inside the existing `0700` directory.

**A file rather than a `history.db` table**, because a trust decision is not run history: putting it there
needs a migration and widens that database from "what the runs did" to "what this machine believes". **Not a
config layer**, because the project and workspace layers are git-committable by design — a grant recorded
there would travel to every other machine — and the global layer is deliberately write-restricted to a few
typed preference keys.

**Append-only with tombstones.** The repo's terminal outbox began as a rewrite-in-place file and was changed
to append-only *because* a read-modify-write lost data across concurrent `relavium` processes, which are a
supported scenario. A consent store has the identical shape, so it takes the identical protocol: one JSON
object per line, a later `revoked` line tombstoning an earlier grant, and the effective set computed by
folding the file.

**The write protocol is append, not replace — and an earlier draft contradicted itself here.** It specified
both "append-only" and a temp-file + atomic `rename`, which are incompatible: a rename replaces the whole
file, discarding whatever a concurrent process appended in between, which is precisely the guarantee
append-only exists to provide. So:

- **Creation** is `openSync(path, 'wx', 0o600)` — create-if-absent, owner-only from the first byte, never a
  `chmod` after create, which the project has already been bitten by on `history.db`. Losing that race is
  fine: the winner's empty file is the file, and the loser proceeds to append.
- **Every write** is a single `appendFileSync` of one bounded record, framed with a leading newline and
  serialized through the safe line serializer — byte-for-byte the outbox's own protocol, so a torn write
  cannot merge with the next record and a partial line is recognisable as partial.
- The permission is **self-healed on every touch**, as the outbox does, so a file restored from a backup with
  a wider mode is repaired rather than trusted.

**Any unparseable line makes the whole store "no grants" for that invocation, and is reported.** Skipping the
bad line and keeping the rest is the tempting answer and the wrong one: a truncated line may be a *tombstone*,
and dropping it silently resurrects a grant the user revoked. Failing the whole fold closed costs one prompt
and cannot re-authorize anything.

No lock is taken; concurrent appends of the same grant are idempotent by digest.

### 6. Non-interactive: a recorded grant is enough; otherwise, the digest on the command line

- A **recorded grant** for the fingerprint satisfies the gate. Consent means "I trust this program on this
  machine, in this project"; requiring it to be re-proven every run would empty it of meaning and would make
  the interactive and `--json` invocations of the same command behave differently for no security gain.
- Otherwise the run is **refused, exit 2**, and the message names the executable and prints the `v1:` digest so
  a CI author can authorize it with `--allow-mcp-stdio <digest>` (repeatable). An ephemeral runner has an empty
  store by construction, which is the case the flag exists for. **The digest is not a secret** — it is a hash
  of an approved declaration, safe in a CI definition, a script, or a log.

`--allow-mcp-stdio` authorizes for **that invocation only** and writes nothing: a flag is how a CI definition
states its own trust, and a runner that silently accumulated grants would be a shared machine slowly agreeing
to everything anyone ran on it.

**A prompt requires all four of: stdin a TTY, stdout a TTY, no `--json`, not CI.** Stdin alone is not enough —
a piped stdout or `--json` would put a question into a machine-readable stream, breaking
[ADR-0049](0049-cli-machine-output-contract.md)'s contract, and `CI=true` with an attached TTY would hang
an automated job on a question nobody answers. Any of the four failing means refuse-with-digest, not ask. The
prompt itself lives in one wrapper module behind an injectable seam, per
[ADR-0047](0047-cli-framework-commander-ink-clack.md), and defaults to **No**.

### 7. A changed fingerprint re-prompts, and the prompt shows what is being decided

A grant is for one exact `(resolved command, args, env, cwd)`. A difference in any of them is a different
declaration and is prompted again — with the *difference* named from the stored comparison metadata, because
"the args changed" is the fact the user needs and "here are two hashes" is not.

**The prompt shows the whole decision, not a summary of it.** A user cannot consent to "the exact
declaration" while half of it is invisible, and the env is exactly the half that changes what an executable
does. Displayed, each as its **own field** — never a joined shell string, because argument boundaries are
precisely what an escape sequence or a bidi override would blur:

- the server **id**, and its provenance: an inline declaration or the `[[mcp_servers]]` registration name;
- the **artifact** the declaration came from (the workflow/agent path), so the imported-artifact case names
  its own file;
- the **resolved executable path**, and the authored `command` beside it when the two differ (`npx` →
  `/opt/homebrew/bin/npx`);
- each **argument**, one per line;
- each **env name with its authored value** — `<secret:NAME>` for a reference, and the sanitized, bounded
  authored text for a literal. A resolved secret is never displayed, and a `kind` is never inferred from how
  the text looks;
- the **realpath'd cwd**.

Every one of those fields is artifact- or path-derived, and a consent prompt showing a different command than
the one that will run is precisely the attack [security-review.md](../standards/security-review.md) names.
Each renders through the CLI's existing terminal-control sanitizer — which already neutralises CSI, OSC, DCS,
C0/C1 and the full Trojan-Source bidi family — extended to strip **zero-width** characters for these fields,
because an executable name in a trust decision is a structured field exactly like the URL the provider surface
already rejects them from. Any consent output under `--json` goes through the safe line serializer.

### 8. What is NOT decided here: lazy connect

The original item asked for the spawn to be deferred to "the first actual MCP tool need". That is structurally
blocked, and is split out with its blocker named rather than quietly dropped.

An MCP `ToolDef` exists only because `listTools()` ran at connect. `createToolRegistry` returns
`{ has, list, dispatch }` with its tool map captured at construction and no mutation API — a deliberate
[ADR-0052](0052-inbound-mcp-client-package-lifecycle-registration.md) §3 invariant. Deferring the spawn
therefore *deletes* the agent's MCP tool grant, and there is no "first actual tool need" to trigger a connect,
because the model was never told the tools exist. The unblocker is a persisted tool-list cache, itself
deferred.

Adding a registry mutation API would **reverse** ADR-0052 §3 and needs a supersession — it must not happen
inside an implementation PR. **Consent-before-spawn alone satisfies the whole of the original item's
acceptance**, and it is the security-relevant half: lazy connect would reduce how *often* an approved program
runs; consent decides *whether* it runs.

### 9. `relavium import` is untouched

It spawns nothing. Gating it would be theatre — the user would approve at import and the program would run
later anyway, at the `chat` / `agent run` / `run` that actually opens the artifact, which is where the gate is.

### 10. Acceptance

1. Opening an artifact with an unapproved stdio server **spawns nothing** — proven with a spawn counter
   injected at the process boundary and asserted at zero, not by inspecting a state flag.
2. Approving it spawns exactly once and the run proceeds; declining refuses the run (exit 2) and still spawns
   nothing.
3. A second invocation **in the same directory** with a recorded grant does not prompt, and spawns.
4. Each of a changed `command`, a changed `args`, a changed env **name**, a changed env **value**, a
   `{{secrets.a}}` → `{{secrets.b}}` swap, and a changed `cwd` re-prompts. A **rotated keychain secret behind
   an unchanged reference does not.**
5. **A literal env value `secret:prod` and a `{{secrets.prod}}` reference produce DIFFERENT digests** — the
   type-tag collision, asserted directly.
6. The digest is computed over the **resolved** executable: two different binaries reachable as the same bare
   `command` under two different ambient `PATH`s produce different digests, and the spawn receives the
   resolved absolute path — asserted by planting a binary and observing which one ran.
7. Two symlinked routes to one directory are **one** grant; a symlink repointed between grant and spawn does
   **not** match.
8. A declared `env` naming any denylisted key fails at PARSE (exit 2) — asserted for an inline `mcp_servers`
   entry and a `[[mcp_servers]]` registration, case-insensitively, plus a **drift test** proving both process
   hosts consume one predicate.
9. Non-interactive with no grant: exit 2, nothing spawned, and the printed digest is exactly the one
   `--allow-mcp-stdio` accepts — asserted by feeding the printed value back in.
10. **No prompt** when any of stdin-TTY, stdout-TTY, `--json`, CI fails — including the case where **both**
    streams are TTYs and `--json` is set.
11. `--allow-mcp-stdio` authorizes that invocation and writes **no** grant — asserted by reading the store.
12. The store is created `0600` **at open** (asserted on a pre-existing wider-mode file, which is repaired),
    inside a `0700` directory, and contains **no env value and no resolved secret** — asserted by scanning the
    written bytes for a seeded credential.
13. **Two real concurrent child processes**, each granting a different server, both survive — asserted by
    folding the file afterwards. Run as actual processes, not as two calls in one process, because that is the
    race the protocol exists for.
14. **A grant followed by a TRUNCATED tombstone spawns nothing** — the whole store folds to no-grants and the
    invocation re-prompts or refuses. A corrupt line is reported.
15. The digest is **stable across runs and processes**, matches the shipped **golden vectors**, and a
    `v1:`-prefixed grant is unrecognised by a `v2:` reader (fails closed). A declaration containing a lone
    surrogate is refused at parse.
16. Every displayed field survives a hostile declaration — CSI, OSC 8, U+202E, zero-width — with the rendered
    text carrying none of them, asserted on the prompt composition and not on an error boundary; and the
    arguments render as separate fields, asserted by an argument containing a space.
17. The prompt displays the **env values** (authored form) and the **artifact source**; a resolved secret
    appears nowhere in the rendered output.
18. Two agents declaring the same server in one artifact prompt **once**, and the count line states 1.
19. The network transports are unaffected: an `http`/`sse`/`websocket` server needs no consent and still passes
    the ADR-0053 floor.

### 11. Landing obligations

- [mcp-integration.md](../reference/shared-core/mcp-integration.md): the gate, the fingerprint's exact inputs
  and canonicalization, the golden vectors, and the grant-file format — stated as the **cross-surface
  contract**, and qualified against that file's own line naming the desktop's Rust spawner.
- [ipc-contract.md](../reference/contracts/ipc-contract.md): the language-neutral invariant — the Rust backend
  must not spawn a declared stdio MCP server without a matching grant.
- [commands.md](../reference/cli/commands.md): `--allow-mcp-stdio`, the exit-2 refusal, and the four-way
  interactivity precondition, on every command that can open an MCP-bearing artifact.
- [agent-yaml-spec.md](../reference/contracts/agent-yaml-spec.md) **and**
  [config-spec.md](../reference/contracts/config-spec.md), separately: §4's env denylist as an authored-error
  rule on the inline `mcp_servers` entry and on the `[[mcp_servers]]` registration.
- [security-review.md](../standards/security-review.md): the local-spawn floor added to the checklist, and
  §Sandbox and tool policy extended so its declared-environment rule names the MCP stdio path alongside
  `run_command` — one rule, stated once, now true of both hosts.
- Promote `canonicalJson` / `digestOf` out of `packages/db`'s module scope to a shared home **and update its
  existing caller** in the same change — it is a package-boundary move, not a copy.
- [ADR-0034](0034-mcp-client-sdk-dependency.md): a dated amendment — g5's "curated minimal base" governs what
  is inherited, not what may be declared.
- [ADR-0052](0052-inbound-mcp-client-package-lifecycle-registration.md): a dated amendment naming the gate on
  §2's host-delegated connect, recording that §3's immutable registry is what blocks lazy connect, and that §1
  places the desktop outside this gate.
- [deferred-tasks.md](../roadmap/deferred-tasks.md): **split** the MCP stdio trust item — the consent half
  closed here and re-scoped from "untrusted-provenance imports" to every stdio server; the `npx` pinning half
  left open with its own scheduling — and add a new item for **lazy connect** with ADR-0052 §3 as its blocker
  and the tool-list cache as its unblocker.
- The `CR-16` heading and register row in
  [phase 2.6.5](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md), whose Decision cell still says
  "consent before spawn, lazy connect".
- The four cross-phase pointers that still route this gate to "2.6.B" —
  [phase 2.6](../roadmap/phases/phase-2.6-conversational-authoring.md) (two),
  [phase 7](../roadmap/phases/phase-7-hub-marketplace.md) (two) — plus the two "tracked in deferred-tasks"
  pointers in [current.md](../roadmap/current.md) and [phase 2](../roadmap/phases/phase-2-cli.md).
- The implementation PR states, per §10 item, which test or fixture satisfies it.

## Consequences

### Positive

- The one path that executes arbitrary local code without a tool call has a decision in front of it, at one
  chokepoint, covering inline declarations as well as registrations.
- The fingerprint names a **file**, not a word: resolving the command before the gate and spawning the
  resolved path removes the child's `PATH` from executable selection entirely.
- A credential never enters the digest, a rotated secret behind an unchanged reference does not re-prompt, a
  *swapped* reference does, and a literal can no longer masquerade as a reference.
- The prompt shows the whole decision — executable, arguments, environment, directory, and which artifact
  asked — as separate sanitized fields, rather than an opaque hash a user would learn to click past.
- CI is deliberate rather than incidental, and the digest is defined byte-exactly with golden vectors, so a
  second implementation is verified rather than trusted.
- No new runtime dependency, no engine change, and `@relavium/mcp` keeps its single responsibility.

### Negative

- **Project-scoped consent means more prompts.** The same server in a second checkout is asked again. Accepted
  deliberately in §3, because the alternative is a grant that does not identify a program; mitigated by naming
  the earlier approval in the prompt, not by weakening the identity.
- **§4 breaks a workflow that declares a denylisted `env` key.** Taken deliberately, and it is a parse-time
  error with a clear message rather than a silent behaviour change.
- **The fingerprint identifies a file at a path, not that file's contents.** The bytes there can change between
  grant and spawn, and `npx -y @acme/server` resolves a package at run time; a compromised upstream publishes
  new code under an approved fingerprint. §3 records why every alternative is worse.
- **Resolving the command before the gate can itself change behaviour** for a declaration that relied on the
  child resolving it — a server invoked through a wrapper that expects to be found relative to a modified
  child `PATH` would now be pinned to the ambient one. §4 forbids that modification anyway, so the case is
  narrow, but it is a behaviour change and not only a hardening.
- **The desktop and VS Code surfaces are outside this gate.** They do not exist yet, so the exposure today is
  zero, but §1's obligation is a promise about future work rather than a mechanism — a Phase-3 author who
  implements a Rust stdio lifecycle without reading it inherits nothing.
- **A corrupt store costs a prompt, every time, until it is repaired.** Failing the whole fold closed is the
  right direction and it is not free: one unparseable line makes every grant on the machine invisible until
  the user fixes or deletes the file.
- **No lock on the grant file.** Append-only makes concurrent grants safe; a *revocation* racing a grant is
  still last-writer-wins in the fold, and the repo's only sound lock mechanism (an exclusive SQLite
  transaction) would drag the database back into a decision §5 removed it from.
- **The shared denylist inherits a known gap.** It covers interpreter and loader hijacks, the `GIT_`
  namespace and config-home redirection, but not the config-file variables of other tools a declaration might
  invoke — a kubeconfig or an AWS config path can point a trusted binary at an attacker-authored file whose
  credential plugin executes a command. Adopting one list for both hosts spreads that gap to the MCP path as
  well as closing four vectors on it; widening the list is its own item, and doing it in one place is now
  possible because there is one place.
- **The store is a file the user can edit.** Anything with write access to `~/.relavium` can add a grant — but
  anything with that access can also write the artifact, so this adds no exposure the machine did not have.
- **Lazy connect stays undone**, so a granted server is spawned at every session/run start whether or not a
  tool is ever called. §8 names the blocker; the cost is startup time and a running child, not a trust gap.
