# Add a Provider (CLI)

> Last updated: 2026-07-06

This runbook is the end-to-end CLI procedure for making an LLM provider usable by
`relavium` — registering it, storing its key, verifying the key works, discovering its
models, and (for a model the shipped registry does not price) hand-entering a price so
the cost cap enforces it. It covers both a **built-in** provider (`anthropic`, `openai`,
`gemini`, `deepseek`) and a **custom OpenAI-compatible endpoint** reached through one of
those ids.

It operationalizes the canonical command reference
[commands.md](../reference/cli/commands.md) and the two design ADRs —
[ADR-0064](../decisions/0064-live-model-catalog.md) (the live model catalog) and
[ADR-0065](../decisions/0065-provider-economics-and-extensibility.md) (provider economics
& extensibility) — and does not restate them. For the **desktop** key flow (and where
keys live per OS), see the sibling [add-a-provider-key.md](add-a-provider-key.md).

Local-first Phase 1: **your machine calls the provider directly** — no Relavium account,
no cloud relay. Keys live in the **OS keychain**, never in plaintext, never in argv, never
in a log or a `--json` payload ([keychain-and-secrets.md](../reference/desktop/keychain-and-secrets.md)).

## The lifecycle at a glance

```bash
relavium provider add openai                              # 1. register (built-in defaults)
echo "$OPENAI_API_KEY" | relavium provider set-key openai # 2. store the key (STDIN, never argv)
relavium provider list --verify                           # 3. confirm the key works (live probe)
relavium models refresh                                   # 4. discover the models the key can reach
relavium models                                           # 5. list the cached catalog
```

Re-running `add` never resets a base/pricing URL you set earlier, and `set-key` re-registers
without disturbing that config; `set-key` does overwrite the key itself — that is how you
rotate (see "Rotate or remove" below).

## 1. Register the provider

```bash
relavium provider add <provider>
```

`<provider>` is one of the closed set `anthropic | openai | gemini | deepseek` (the id set
is deliberately closed — see [ADR-0065](../decisions/0065-provider-economics-and-extensibility.md) §6).
This seeds the provider row with its default base URL + pricing page. `set-key` (step 2)
also auto-registers, so this explicit step is only needed when you want a **custom base
URL** or **pricing URL**:

```bash
# A custom OpenAI-compatible endpoint (a proxy, a self-hosted gateway, a compatible vendor):
relavium provider add openai --base-url https://my-gateway.example.com/v1
# Override where you look up prices to hand-enter them:
relavium provider add openai --pricing-url https://my-gateway.example.com/pricing
```

- `--base-url` is **OpenAI-compatible only** (`openai` / `deepseek`); on `anthropic` /
  `gemini` it is refused (exit 2). All egress to a custom base URL — streaming turns **and**
  the model-list refresh — goes through an **SSRF-validated** hop
  ([ADR-0065](../decisions/0065-provider-economics-and-extensibility.md) §3–4): HTTPS-only,
  no embedded credentials, no private/loopback/link-local host, and no terminal-control /
  bidirectional characters. A custom endpoint **reuses** the `openai` / `deepseek` id, so it
  cannot coexist with the real vendor under that id (a genuinely-separate custom id awaits a
  future enum-opening ADR).
- `--pricing-url` is a **display-only pointer** (never fetched), so it may point at any HTTPS
  host with no embedded credentials (no SSRF host block); it is where you go to find a model's
  price for step 6.

## 2. Store the key

```bash
echo "$PROVIDER_API_KEY" | relavium provider set-key <provider>
```

The key is read from **stdin**, never a CLI flag (argv leaks into `ps`, shell history, and
CI logs). It is written to the OS keychain; the `llm_providers` row stores only a keychain
**ref**, and the command echoes only a hint (last 4 chars), never the key.

**Headless / CI:** instead of the keychain, export `RELAVIUM_<PROVIDER>_API_KEY` (e.g.
`RELAVIUM_OPENAI_API_KEY`) from a masked secret. Resolution is **keychain → env var →
error**. Never commit a key or print it in CI logs.

## 3. Verify the key works

```bash
relavium provider list --verify        # a live, key-redacted probe per registered provider
relavium provider test <provider>      # verify one provider (optionally --model <id>)
```

`list --verify` reports `verified` / `failed — <redacted reason>` / `no key` per provider
(the probes run concurrently, each timeout-bounded). A provider with no resolvable key is
reported `no key` and never probed. For a machine-readable result use `relavium provider list
--verify --json` — one key-free NDJSON record per provider (the record shape is documented in
[commands.md](../reference/cli/commands.md#relavium-provider)). No key is ever echoed on any of these.

## 4–5. Discover and list the models

```bash
relavium models refresh    # force a live re-fetch of each connected provider's model list
relavium models            # list the cached catalog (auto-refreshes once on an empty cache)
```

`models refresh` is **per-provider isolated** — one provider's failure never fails the whole
command (it is reported `failed` / `skipped`, the others still refresh). The catalog is a
local cache of *which model ids each key can reach*; the shipped `MODEL_PRICING` registry is
the pricing authority for a known model. (The interactive Home's `/models` picker
additionally **dims** a model not available on your key and **flags** a deprecated one; the
plain `relavium models` list is `<modelId> <provider> ctx=<n> [<source>]` —
[ADR-0064](../decisions/0064-live-model-catalog.md) §7/§10.)

## 6. Price a model the registry does not know

A **custom-endpoint model**, or a brand-new vendor model not yet in the shipped registry,
has **no price** — so the cost cap (`budget.max_cost_microcents` for a workflow,
`[chat].max_cost_microcents` for chat) would **degrade to "allow"** for it. Hand-enter its
price so the cap is enforced ([ADR-0065](../decisions/0065-provider-economics-and-extensibility.md) §1–2):

```bash
relavium models pricing <model> --provider <provider> --input <usd/Mtok> --output <usd/Mtok> [--cached <usd/Mtok>]
# e.g. a self-hosted model behind an openai-compatible gateway, $3 in / $9 out per million tokens:
relavium models pricing my-gateway-llama --provider openai --input 3 --output 9
```

Prices are **USD per million tokens** (stored as integer micro-cents). The price is written
as a user row and a live `models refresh` **never** clobbers it; once set, the model is
enforced by the cost cap on `run`, a `run` resumed via `relavium gate`, `chat` /
`chat-resume`, the interactive Home, and one-shot `agent run`. Guards (each exit 2, nothing
written): a **built-in-priced** model is refused (the shipped price always wins); an
**unregistered provider** is refused (do step 1 first); the **same model id already priced
under a different provider** is refused (the cost cap keys by model id, so it could not tell
them apart); and a **negative / non-finite / implausibly-large** price is refused. Look up the
real price at the provider's pricing page — the one `--pricing-url` recorded in step 1 (the
`provider add` confirmation echoes it).

## Rotate or remove a key

```bash
echo "$NEW_KEY" | relavium provider set-key <provider>   # rotate (overwrites the keychain entry in place)
relavium provider remove-key <provider>                  # delete the key from the keychain
```

`remove-key` clears the keychain entry + the row's ref; it leaves the provider row (base URL,
pricing URL) intact — and your user pricing, which lives in a separate `model_catalog` row it
never touches — so re-adding a key restores the provider as configured.

## Safety checklist

- [ ] Key supplied only via **stdin** (`set-key`) or a masked env var — never a CLI flag, a
      workflow/agent YAML file, or `~/.relavium/` config.
- [ ] No key value appears in `relavium provider list [--json]`, `--verify` output, `models`
      output, or any error message (all are key-free by construction — a hint at most).
- [ ] A custom `--base-url` is HTTPS, public-host, credential-free (the CLI enforces this; a
      private/loopback/tampered value is refused at `add`).
- [ ] In CI, the key comes from a masked secret, and `--json` is used for machine parsing.
- [ ] A user-entered price is verified against the provider's real pricing page before you
      rely on the cost cap.
