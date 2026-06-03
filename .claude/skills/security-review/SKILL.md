---
name: security-review
description: Run the binding Relavium security pass over a diff/branch — keys never leave the keychain or reach the frontend/logs, SSRF on custom provider base URLs, the run_javascript sandbox, prompt-injection posture, dependency provenance, and never hand-roll crypto. USE FOR: any change touching keys, the keychain bridge, IPC, network/base-URL handling, the JS sandbox, prompt/tool-call construction, the DB encryption path, or a new dependency. DO NOT USE FOR: a general correctness review (use code-review) or implementing the change (use implement-task).
---

## Purpose

Apply [security-review.md](../../../docs/standards/security-review.md) as an explicit gate.
Relavium is local-first and secure-by-default: secrets live in the OS keychain and never
touch disk, logs, or the frontend ([ADR-0006](../../../docs/decisions/0006-os-keychain-for-api-keys.md)).
This pass uses a STRIDE-lite lens plus a concrete checklist to confirm those guarantees hold
in the diff. It cites the canonical secret-handling flow in
[keychain-and-secrets.md](../../../docs/reference/desktop/keychain-and-secrets.md) — it does
not restate it.

## When to use

Mandatory for any change to: key handling or the keychain bridge, IPC commands, provider
base-URL handling, the `run_javascript` sandbox, prompt/tool-call construction, the DB
encryption (SQLCipher) path, or a new third-party dependency. When in doubt, run it.

## When not to use

- A change with no security surface — a general [../code-review/SKILL.md](../code-review/SKILL.md) covers it.
- You are still implementing — use [../implement-task/SKILL.md](../implement-task/SKILL.md) and run this before review.

## Inputs

- The diff/branch and which security surface(s) it touches.
- [security-review.md](../../../docs/standards/security-review.md), the keychain reference,
  and the relevant ADRs (0006 keychain, 0011 seam).

## Workflow

1. **Scope the surface.** From the diff, identify which of the surfaces below it touches.
   Read [security-review.md](../../../docs/standards/security-review.md) and the keychain
   reference before judging.

2. **STRIDE-lite framing.** Walk the change against the threats that actually apply to a
   local-first agent runner:
   - **Spoofing / Tampering** — can an agent-config value (a base URL, a tool arg) redirect
     a call or alter what executes?
   - **Information disclosure** — can a key, prompt, or raw provider payload escape to the
     frontend, a log, the DB, or an error/event?
   - **Elevation of privilege** — can model output or a tool result act as a trusted
     instruction, or can sandboxed code reach ambient authority?
   - **Denial of service** — can a hung provider or runaway sandbox pin a worker open?

3. **Keys and secrets.** Confirm keys live only in the OS keychain, resolved at call time
   and attached by the `@relavium/llm` adapter just before the HTTPS request:
   - No key in a Tauri IPC payload to the WebView, a Zustand store, a React prop,
     localStorage, or an IPC return value — the frontend learns only *that* a provider is
     configured.
   - No plaintext at rest: no key in a config file, a committed `.env`, a `.relavium.yaml`,
     a log, or an unencrypted DB column (the DB is SQLCipher; secrets still belong in the
     keychain).
   - No key interpolated into an error message or a `node:error`/`run:error` event.
   - Grep: `grep -rni "apikey\|api_key\|secret\|token" $changed_files` then trace each hit
     to confirm it never crosses to the frontend, a log, or a payload.

4. **SSRF on custom base URLs.** For any code reaching a user-supplied `baseURL` (DeepSeek /
   any OpenAI-compatible provider): HTTPS only; reject non-HTTP(S) schemes and
   credentials-in-URL; **block private/loopback/link-local/metadata ranges** (`127.0.0.0/8`,
   `::1`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` incl. `169.254.169.254`) unless the
   user explicitly opted into a local endpoint. An agent-config URL must never make the
   engine call an internal address with a real key attached. Confirm TLS verification is not
   disabled and every outbound call carries an `AbortSignal` + timeout.

5. **The `run_javascript` sandbox.** Confirm model-generated code runs with **no ambient
   authority** — no filesystem, network, process/env, or keychain — under a CPU/memory/time
   budget that terminates a runaway, and that it never receives a provider key or any secret.
   Its output is untrusted input. See [built-in-tools.md](../../../docs/reference/shared-core/built-in-tools.md).

6. **Prompt-injection posture.** Model output and tool results are untrusted *data*, never
   trusted instructions. Confirm: requested tool calls are validated against the declared
   tool schema and the user's tool allowlist before execution (a model cannot invoke an
   ungranted tool; args are schema-checked, not eval'd); high-impact effects (filesystem
   writes, shell, external calls) route through the human-gate/approval path; the `system`
   field is set by Relavium, never by tool output, and untrusted content is never
   concatenated where it can override the system prompt.

7. **Dependency provenance and crypto.** A new third-party dependency is a new attack
   surface — it requires an [ADR](../../../docs/decisions/README.md) and sign-off; check the
   `package.json` and lockfile diff and that no known-CVE dependency is knowingly added.
   Confirm **no hand-rolled crypto/TLS/keychain primitive** — vetted platform
   implementations only, wrapped behind a Relavium interface. A PR that rolls its own crypto
   is rejected.

8. **Logging.** No secrets, no full prompts/responses, no raw keys in logs — ever
   (redaction per [logging-and-observability.md](../../../docs/standards/logging-and-observability.md)).

9. **Report** findings as file:line — severity — issue — impact — fix, and state the
   verdict: any unresolved finding on the surfaces above blocks the merge.

## Checklist

- [ ] Keys only in the OS keychain; none in IPC payload, store, prop, localStorage, or IPC return.
- [ ] No plaintext key at rest (config, committed `.env`, `.relavium.yaml`, log, unencrypted DB column).
- [ ] No key in an error message, `node:error`/`run:error` event, or log line.
- [ ] Custom base URLs: HTTPS-only, no creds-in-URL, private/loopback/metadata ranges blocked, TLS not disabled, AbortSignal + timeout present.
- [ ] `run_javascript` sandbox has no ambient authority, a resource budget, and never gets a secret; its output treated as untrusted.
- [ ] Tool calls validated against schema + allowlist; high-impact effects gated; `system` set by Relavium, not tool output.
- [ ] No new dependency without an ADR; lockfile committed; no known-CVE dependency added.
- [ ] No hand-rolled crypto/TLS/keychain — vetted primitives, wrapped.
- [ ] No secret, full prompt/response, or raw key in logs.

## Outputs

- A severity-sorted findings report (file:line — severity — issue — impact — fix).
- The completed checklist with each item marked.
- A verdict: any unresolved finding on a mandatory surface blocks merge.

## Done criteria

- [ ] Scoped the security surface(s) the diff touches and framed them with STRIDE-lite.
- [ ] Verified keys-and-secrets handling (keychain-only, never frontend/log/at-rest/error).
- [ ] Checked SSRF defenses on any custom base-URL path.
- [ ] Confirmed the `run_javascript` sandbox has no ambient authority and no secret.
- [ ] Confirmed prompt-injection posture (untrusted output, allowlist, gated effects, Relavium-owned system prompt).
- [ ] Checked dependency provenance (ADR-gated) and that no crypto was hand-rolled.
- [ ] Confirmed logging redaction.
- [ ] Reported findings file:line — severity — issue — impact — fix, with a merge verdict.

## Common pitfalls

- **A key reaching the frontend "just for display"** — the frontend learns only that a
  provider is configured, never the secret.
- **Trusting a config base URL** — without the private-range block it is an SSRF straight at
  `169.254.169.254` with a real key attached.
- **Treating tool output as instructions** — it is untrusted data; never let it set the
  system prompt or invoke an ungranted tool.
- **A "tiny utility" dependency slipped in** — every new dependency is an attack surface and
  needs an ADR.
- **Re-implementing crypto** to avoid a dependency — the carve-out is explicit: never
  hand-roll crypto/TLS/keychain.
- **A key in an error message** that then lands in a log or a `run:error` event.

## Related

- [../code-review/SKILL.md](../code-review/SKILL.md) — the general review pass.
- [../implement-task/SKILL.md](../implement-task/SKILL.md) — run this before review.
- [../../agents/relavium-reviewer.md](../../agents/relavium-reviewer.md) — the reviewer subagent.
- [../../../docs/standards/security-review.md](../../../docs/standards/security-review.md)
- [../../../docs/standards/error-handling.md](../../../docs/standards/error-handling.md)
- [../../../docs/decisions/0006-os-keychain-for-api-keys.md](../../../docs/decisions/0006-os-keychain-for-api-keys.md)
- [../../../docs/reference/desktop/keychain-and-secrets.md](../../../docs/reference/desktop/keychain-and-secrets.md)
- [../../../docs/reference/shared-core/built-in-tools.md](../../../docs/reference/shared-core/built-in-tools.md)
