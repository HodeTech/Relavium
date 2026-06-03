# Add a Provider Key

> Last updated: 2026-06-03

This runbook covers adding, verifying, and rotating an LLM provider API key (Anthropic,
OpenAI, Gemini, DeepSeek) so Relavium can run agents on your machine. In the local-first
Phase 1, **your machine calls the provider directly** — there is no Relavium account and
no cloud relay (see [product-constraints.md](../product-constraints.md)).

Keys are stored in the **OS keychain**, never in plaintext, never committed to a repo,
and never sent to the frontend. The exact storage mechanism and the IPC boundary it
crosses are specified in
[keychain-and-secrets.md](../reference/desktop/keychain-and-secrets.md) — this runbook
operationalizes that spec and does not restate it.

## Where keys live

| Platform | Backing store |
|----------|---------------|
| macOS | Keychain |
| Windows | Credential Manager |
| Linux | libsecret (GNOME Keyring / KWallet) |

The Rust backend reads and writes the keychain; the React frontend only ever sees a
non-secret status (present / verified / model list), never the key material. See
[keychain-and-secrets.md](../reference/desktop/keychain-and-secrets.md) for the IPC
contract.

## Add a key (desktop app)

1. Open the desktop app. On first launch the canvas is dimmed and the single CTA is
   **Connect your first API key** — no account prompt.
2. Click **Connect API Key** and select the provider (e.g. Anthropic).
3. Paste the key (e.g. `sk-ant-...`).
4. Click **Verify & Save**.
5. The key is verified inline (green checkmark) and the model list populates in real
   time — each model with its context window and per-token pricing. The key is written
   to the OS keychain; it is not written to disk in plaintext.

You can now bind agents to that provider's models and run workflows offline-of-account
(direct to the provider).

## Verify a key later

Re-open the provider settings screen. A present key shows its verified status and the
fetched model list. If a key has been revoked upstream, verification fails and you are
prompted to rotate it. (For the desktop screens involved, see
[routes-and-screens.md](../reference/desktop/routes-and-screens.md).)

## Rotate or remove a key

1. Open provider settings for the provider whose key you want to change.
2. Choose **Rotate** to replace the key (paste the new value → **Verify & Save**), or
   **Remove** to delete it from the keychain entirely.
3. Rotation overwrites the keychain entry in place; removal deletes it. Either way, no
   plaintext copy is left behind.

## CLI and CI

For headless and CI use, the CLI reads the same provider configuration model. CI runs
typically supply the key via an environment variable that maps to the provider rather
than the desktop keychain — see [commands.md](../reference/cli/commands.md) and the
[run-a-workflow-in-ci.md](../tutorials/cli/run-a-workflow-in-ci.md) tutorial. Never
commit a key to the repo or print it in CI logs.

## Safety checklist

- [ ] Key entered only through the app's verify flow, never pasted into a workflow or
      agent YAML file.
- [ ] No key value appears in `~/.relavium/` config, the project `.relavium/` directory,
      or git history.
- [ ] In CI, the key comes from a masked secret, not a plaintext variable.
- [ ] Rotated promptly if a key is ever exposed.
