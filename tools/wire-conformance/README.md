# Canonical wire mutation controls

Run `pnpm check:wire-mutations` after installing dependencies. This optional offline
author/reviewer check exercises the permanent [canonical SDK HTTP matrix](../../packages/llm/src/conformance/canonical-wire.test.ts).
The ordinary package tests already run that matrix in required CI; the mutation
runner additionally proves that three distinct production lowering defects are caught.
It uses no keys, provider calls, new dependency or branch checkout.

The runner copies the current LLM source and test configuration to a uniquely owned
OS temporary directory, with links to the checkout's installed dependencies. It runs
the complete 24-case matrix before mutations. Independently, it then changes:

1. Anthropic's system-instruction lowering.
2. OpenAI's tool-result continuation identifier.
3. Gemini's tool-call continuation signature.

Each mutation changes the actual copied production adapter source. It must fail a
test with the strict oracle's `request_mismatch`; an unrelated runner or suite failure
is insufficient. The original source bytes are restored and the entire matrix must
pass again before the next mutation. The pinned case count and zero pending/todo
counts prevent an empty or silently reduced run from passing. Update the expected
case count deliberately if the canonical matrix grows.

A successful run prints JSON containing the baseline, each rejected case, restored
results and source SHA-256 digests. Redirect that report outside collected source
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
