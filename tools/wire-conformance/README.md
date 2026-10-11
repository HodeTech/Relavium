# Canonical wire mutation controls

Run `pnpm check:wire-mutations` after installing dependencies and building workspaces. This offline
required-CI and author/reviewer check exercises the permanent [canonical SDK HTTP matrix](../../packages/llm/src/conformance/canonical-wire.test.ts).
The ordinary package tests already run that matrix in required CI; the mutation
runner additionally proves that three distinct production lowering defects and a counter-preserving evidence demotion are caught.
It uses no keys, provider calls, new dependency or branch checkout.

The runner copies the current LLM source and test configuration to a uniquely owned
OS temporary directory, with links to the checkout's installed dependencies. It runs
the complete 24-case matrix before mutations. Independently, it then changes:

1. Anthropic's system-instruction lowering.
2. OpenAI's tool-result continuation identifier.
3. Gemini's tool-call continuation signature.
4. Complete evidence demoted to partial while preserving every observed quantity.

Each mutation changes the actual copied production adapter source. It must fail a
test with the strict oracle's `request_mismatch`; the evidence demotion must fail all
24 cases with the declared literal complete/partial evidence diagnostic. An unrelated runner or
suite failure is insufficient. The original source bytes are restored and the entire matrix must
pass again before the next mutation. The pinned case count and zero pending/todo
counts prevent an empty or silently reduced run from passing. Update the expected
case count deliberately if the canonical matrix grows.

A successful run prints JSON containing the baseline, each rejected case, restored
results and source SHA-256 digests. Provenance records the actually installed Anthropic, OpenAI
and Gemini SDK package versions and complete package-byte digests, the Node/platform identity,
lockfile digest, captured source/fixture/configuration identity and actually resolved built shared
seam support bytes. CI builds workspaces first; a developer must do the same. It compares those identities
before and after execution. These are observed installed bytes, not independent package attestation
or a claim that a package entry was executed on a particular SDK branch. Redirect that report outside collected source
trees when retaining evidence. The runner checks that the original developer adapter
files remain unchanged and removes its owned temporary directory in `finally`.
It never writes a mutation into the developer checkout. A process killed before
cleanup can leave only its OS temporary copy; no developer source restoration is needed.

These controls prove the stated mappings against the installed SDK version and the
independent static expectations. They do not establish every possible provider option,
replace the broader response/grammar suites, authorize live recording, or close W8's
unknown-usage accounting. The [conformance harness](../../packages/llm/src/conformance/README.md)
owns projection and recording rules; the [testing standard](../../docs/standards/testing.md#per-provider-conformance-tests)
owns policy and distinguishes synthetic seeds from genuine captured overflow records.

The complete command runs in the offline `wire-mutations` CI job; the existing required `ci` job
waits for successful wire and usage controls and refuses skipped, cancelled, missing or failed
results. Local `pnpm run ci` invokes both complete commands. Orchestration guards are exercised
by `pnpm test:acceptance-tools`. With `RELAVIUM_ACCEPTANCE_EVIDENCE` set outside authored source,
only bounded JSON reports are exported before scratch cleanup, including failure diagnostics;
CI retains those metadata artifacts for seven days. A failed export preserves any primary control
failure. A hard-killed process produces no acceptance claim.
