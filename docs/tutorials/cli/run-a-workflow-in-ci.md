# Run a Workflow in CI (CLI)

> Status: Living

This tutorial takes a workflow you already built — for example the Research Pipeline from
[Build your first workflow](../desktop/build-your-first-workflow.md) — commits it to git,
and runs it **headless in a CI pipeline** with the `relavium` CLI. The whole point of
git-native workflows is that the *same* `.relavium.yaml` runs identically on the desktop
canvas, in your terminal, and in CI (see [uvp.md](../../uvp.md)).

This walkthrough teaches the CLI by using it end-to-end. For the exact command surface,
flags, and exit codes, see the canonical
[CLI command reference](../../reference/cli/commands.md) — this tutorial links to it
rather than restating it.

## What you will accomplish

- Commit a workflow file to your repo so it is reviewable and versioned.
- Run it locally with `relavium run` to confirm it works.
- Run it in CI on every push, with machine-readable output and a CI-friendly exit code.

## Prerequisites

- The CLI installed: `npm install -g relavium`. It is published to npm as `relavium` and
  bundles the same `@relavium/core` engine as every other surface.
- At least one LLM provider key. Locally, the key lives in the OS keychain — see
  [add-a-provider-key.md](../../runbooks/add-a-provider-key.md). In CI, you will supply it
  as a secret (below).
- A `.relavium.yaml` workflow committed under `.relavium/` in your repo. Its schema's one
  home is [workflow-yaml-spec.md](../../reference/contracts/workflow-yaml-spec.md).

## Steps

1. **Commit the workflow.** Move (or export) your workflow into `.relavium/` and commit
   it. Because it is plain YAML, teammates review it in a PR like any other code change.

   ```bash
   git add .relavium/research-pipeline.relavium.yaml
   git commit -m "Add research pipeline workflow"
   ```

2. **Run it locally first.** Confirm it works against your keychain key before wiring CI:

   ```bash
   relavium run .relavium/research-pipeline.relavium.yaml --input topic="quantum computing"
   ```

   In a TTY you get the `ink` interactive view: per-node status, live token streaming for
   the active node, and a final cost/duration summary line.

3. **Switch to machine-readable output.** Pass `--json` to emit the stable machine contract:
   **stdout** becomes a pure NDJSON stream — one
   [RunEvent](../../reference/contracts/sse-event-schema.md) per line, in `sequenceNumber`
   order, with the terminal `run:completed` line carrying the run's `outputs` + totals — while
   **all diagnostics go to stderr**. Pipe stdout straight into a parser; nothing else lands there.

   ```bash
   relavium run .relavium/research-pipeline.relavium.yaml --input topic="quantum computing" --json \
     | jq -c 'select(.type == "run:completed") | .outputs'
   ```

   `--json` is the explicit opt-in: a non-TTY or `CI=true` shell alone only disables the
   interactive view, it does not switch stdout to NDJSON. See
   [the `--json` machine-output contract](../../reference/cli/commands.md#the---json-machine-output-contract).

4. **Provide the API key as a CI secret.** CI has no OS keychain, so the CLI reads the key from
   `RELAVIUM_<PROVIDER>_API_KEY` (e.g. `RELAVIUM_ANTHROPIC_API_KEY`) — the headless per-invocation
   key source. Store it as an encrypted CI secret and expose it as that environment variable on the
   run step; the key is never written to disk and never appears in run output. (A missing key for a
   referenced agent's provider fails the invocation up front with exit `2` and names the variable to
   set.)

5. **Add the CI step.** Install the CLI and run the committed workflow on every push:

   ```yaml
   # illustrative GitHub Actions step
   - run: npm install -g relavium
   - env:
       # provider key injected from CI secrets, never committed
       RELAVIUM_ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
     run: relavium run .relavium/research-pipeline.relavium.yaml --input topic="quantum computing" --json
   ```

6. **Gate the pipeline on the exit code.** The CLI uses deterministic exit codes so CI
   can branch on the outcome: `0` = success, `1` = workflow failed (a node errored and
   exhausted retries/fallbacks), `2` = invalid invocation, `3` = paused at a human gate
   (non-interactive). The full table is in the
   [CLI reference](../../reference/cli/commands.md#exit-codes). Under `--json`, a `2`
   invocation fault writes its structured `{ "type": "error", … }` detail to **stderr** and
   leaves stdout empty — so check the exit code first, then read stderr for the detail:

   ```bash
   # Read $? on the command itself (not after `! cmd`, where it would always be 0).
   if relavium run .relavium/research-pipeline.relavium.yaml --input topic="…" --json > run.ndjson 2> run.err; then
     jq -c 'select(.type == "run:completed") | .outputs' run.ndjson
   else
     code=$?; echo "run did not succeed (exit $code)" >&2; cat run.err >&2; exit "$code"
   fi
   ```

## What just happened

`relavium run` parsed and validated the committed YAML, then the **same** `@relavium/core`
engine that powers the desktop canvas built and executed the DAG, checkpointing each node.
Because the CLI is a renderer over the engine's event bus (not a fork), the run emitted the
identical [RunEvent](../../reference/contracts/sse-event-schema.md) stream it would on any
surface — `--json` just serialized each event verbatim to stdout as NDJSON instead of
painting a canvas, kept all diagnostics on stderr, and derived the exit code from the
terminal event. That is the whole git-native promise: one committed `.relavium.yaml`, one
engine, identical behavior across the desktop, your terminal, and CI
(see [shared-core-engine.md](../../architecture/shared-core-engine.md)).

## A note on human gates in CI

If the workflow contains a `human_gate` node, a non-interactive run cannot prompt for
approval. The CLI surfaces this as a distinct pause-pending state rather than a hard
failure, and the gate can be resolved out-of-band with `relavium gate` (see the
[CLI reference](../../reference/cli/commands.md)). For unattended pipelines, prefer
workflows whose gates have a `timeout_action`, or keep gated workflows on interactive
surfaces. (Cloud-delivered gate notifications are a **Phase 2** feature — see
[cloud-phase-2.md](../../architecture/cloud-phase-2.md).)

## Next steps

- Build the workflow visually first: [Build your first workflow (desktop)](../desktop/build-your-first-workflow.md).
- Trigger the same workflow from your editor: [Trigger from VS Code](../vscode/trigger-from-vscode.md).
- Full command surface and flags: [CLI command reference](../../reference/cli/commands.md).
