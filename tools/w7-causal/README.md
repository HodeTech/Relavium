# W7 scoped causal diagnosis

Run `node tools/w7-causal/check.mjs` after installing the repository's pinned development toolchain.
This optional offline diagnostic reproduces the six mechanism-removal experiments from the W7
closing register against **current** sources. It projects twelve named implementation/test files
into an exclusive temporary directory, redirects their relative imports to projected peers or
current sources, and aliases shared/LLM source and the installed YAML/Vitest entry points.

Each separate intervention removes one grant, window, estimator, debit, pending-replay or session
result-noninspection mechanism. The named permanent suite must fail a real assertion; import/setup
failures cannot count as causal evidence. Restoration must pass all six scoped suites. The tool
retains source/projected/mutated hashes, command receipts and logs at the printed external path and
checks that the twelve repository source bytes remain unchanged. It never runs a provider/key or
network operation and never modifies the repository or a historical checkout.

These are projected current-source tests using current installed dependencies, **not** an independently
built historical commit or a new required CI gate. Historical `b68188fe` receipts reported 59 restored
cases; current counts come from this invocation's real log and can evolve. The original external
experiment's failed YAML-alias fixture remains excluded from its historical acceptance.

Intervention anchors intentionally fail closed when source changes. Review an evolved mechanism
before changing its anchor; do not accept arbitrary nonzero exits or invent a limit to force a failure.
The external evidence contains only the synthetic fixtures already in these suites. Its directory
is retained for manual inspection; the tool does not delete unrelated or earlier evidence.
