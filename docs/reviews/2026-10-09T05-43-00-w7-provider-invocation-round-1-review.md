# Review: W7 invocation-local provider and raw-poll lifetimes, round 1

- Date: 2026-10-09
- Type: Code + Security
- Reviewer(s): @codex (`provider_invocation_r1_authority`, GPT-6 Astra, xhigh;
  `provider_invocation_r1_lifecycle`, GPT-6.1 Sol, xhigh), followed by Parent's complete
  evidence audit and `provider_r1_authority_custody_finish` (GPT-6 Astra, xhigh).
- Scope: all 23 paths / 62 cumulative hunks from `7d59de51de67f6fac05290e2140c0da049538921`
  through `da10cd1258de0761cff3f7010360cdc46b76f07d` on `development`.
- Result: one confirmed Medium compatibility finding, corrected with a permanent regression.
  A genuine weak-test finding from separate Sonar triage is also corrected. A NEW complete
  cumulative round 2 is required; this is not scoped increment or W7 acceptance.

Both runtime reviewers cover the complete source, test and documentation range. They cold-build
five private libraries and the actual CLI, use installed SDK/public Core boundaries, preserve
original failures and strictly rebuild their private mechanism removals. Parent reads the full
reports, controls, runners and map, verifies every physical artifact and command binding, then
compares all 645,668 shared entries with its true-before snapshot before releasing the freeze.
There are zero byte, mode, mtime, directory or symlink differences; the work stays on `development`.

## Confirmed corrections

**Medium: trusted method receiver lost before validated fetch.** `EgressWorkScope` captures
`parent.retainWork` but invokes it without its receiver. A valid method using its owner's state
throws before DNS. Parent reproduces the public fetch contract failure; authority independently
verifies original red / single `.call(parent, ...)` correction green / restored original red.
Every variant passes strict LLM/Core/CLI and actual LLM/Core/CLI builds. The shared correction
preserves the captured callback and its receiver. The new permanent case verifies one transfer,
successful response and a native descendant that remains owed until its independent release.
Shipping arrow callbacks had hidden this compatibility defect; no credential leak is claimed.

**Weak detached-Promise regression.** The previous native-Promise test used an already-settled
Promise and no assertion, so a no-op retainer could pass. The corrected test holds raw settlement,
asserts exact identity, proves retirement does not acknowledge pending work, then observes actual
completion. Separate strictly rebuilt pending-registration and native-observer removals produce
semantic assertion failures; restoration passes. The selected 32-case correction suite, strict
checks and lint pass. This is test-strengthening evidence, not a claim that historical generated
bytes absent from those supplementary correction probes were retained.

## Independent evidence and its limits

| Evidence | Authority | Lifecycle |
| --- | --- | --- |
| Final independent positives | 21 cases | 19 cases |
| Broad affected baseline | 405 files / 9,046 pass / 12 existing skips, including an earlier 20-case fixture | 376 files / 8,082 pass / 12 existing skips |
| Distinct strictly built causal mechanisms | Seven, plus the separate receiver defect probe | Ten |
| Source/test/output golden restoration | 1,616 files | 756 source/test and 357 output entries |
| Command/log receipts | 147 | 255, with one historical overwritten failed-lint log excluded |
| Physical evidence entries | 3,468 original entries, independently bound by late custody completion | 3,416 sealed entries |
| Tracked archive files | 1,257 | 1,257 |

Selections overlap and are not additive test totals. Authority's seven removals exercise eight
distinct selected cases and nine red outcomes: return/body reuse one case, poll has three cases,
and media binding fails in its first loop iteration. Lifecycle's ten removals include independent
body-next/return/child, fetch binding, invocation transfer, poll forwarding/registry, call-time
capture, learning and immediate retirement. All credited reds are semantic failures, followed by
strict builds, exact restoration and green; fixture errors and timeouts earn no causal credit.

Actual Node loopback controls delay only safe-egress acknowledgement callbacks **after** genuine
request/response close emission. They do not assert that an OS resource remained open afterward.
Other held-close controls simulate injected transport obligations. Public Core reference/native
SQLite controls preserve the exact lease through key/raw-poll/child delays and suppress late pins,
events and cost delivery. Direct CLI source imports and compiled internal helper controls are
qualified separately from actual public library/binary evidence. No full CLI TTY shutdown or
cross-process crash certificate is inferred.

The authority reviewer was interrupted after its runtime work and post-receiver shared audit,
before creating its final seal/inventory/toolchain files. Its report retains three unresolved
placeholders. Parent preserves it unchanged; a separate late custodian verifies all 147 receipts,
seven removal sequences, three receiver variants, restored golden/archive and 79 dependency links,
then seals the current physical root. This is **late custody completion**, not the original
reviewer's contemporaneous seal or another runtime round. The corrected earlier 20-case fixture
was reconstructed with an exact historical input hash match and is expressly a late reconstruction.
The final 21-case fixture and receiver variants were originally retained.

Lifecycle's failed `lint-cli` log was overwritten once; its absent original bytes receive no
proof credit. Its final uniquely named lint and causal logs remain hash-bound. External Node
identity is final-only there; installed repository tools remain bound by the true-before snapshot.
Both reviewers preserve initial extraction, fixture typing, SDK `data:,` probe, native latch and
other failed author/reviewer attempts without treating them as product findings. The custody
helper's initial cold-binary-hash expectation is likewise corrected and preserved separately.

Private individual dependency links, direct tools and explicit private cache/TMP/XDG paths are
application isolation, not an OS sandbox or complete descendant/network trace. HOME is unchanged;
no installer, package manager or nested DB-sync command supplies reviewer runtime evidence.

| Bound subject | SHA-256 |
| --- | --- |
| Original interrupted authority report | `3cd33ac110700df0948c9ab81548d6cc9fad721b295f46894c970539d2f878d7` |
| Late custody report | `b5afdc0ecad89cf89dd0cfb67a317e214ed48ee743461e6c52861275b7e3727e` |
| Late original physical inventory | `d7e259a1fd0d04236bd7ced95882e83f5921a875d36521ec3b4ca9f7f951503e` |
| Late custody seal | `0ae20994c0cee295d38117c3a23db0b9582a9a74ee6399b2ee849a531e72b531` |
| Lifecycle report | `96949505c06acddf0bd141a67a9b3036ab00b702f3985341f968e0f86f3a6b5c` |
| Lifecycle inventory | `3cc54d53c8744d58440319880b8f5bacfc8a38918d12bbf0d1a2a7676537dc68` |
| Lifecycle seal | `f8ac19ec3f31832bc4299bd6e3ab5a0ece3b9a311072c4e6e013e9cf25901992` |
| Parent true-before whole shared snapshot | `654e16fe1f2a1fb88c0908ec66629e42698625636edc35df61e9896893bf31fb` |
| Parent final whole shared snapshot | `10aec2b2fd06222c3f53d8805b46294519c9c47f7e6e63ed675a4ba7f9e0b432` |

After applying only the two verified provider corrections, actual root `CI=true pnpm run ci`
passes 404 files / 9,027 cases / 12 existing skips. All 23 lint/type/test tasks and seven
build/format tasks succeed; eight and five respectively are cached. Schema/tool/fence/purity,
compiled CLI, offline overflow and replay smokes pass. Its log SHA-256 is
`cac8b0473f91949440e3a92f51f3f6783a4b6bd1d5e41ebd52f78aa34137bc4c`.
There are now 54 new permanent increment cases. This is cache-qualified correction validation,
not forced final whole-wave acceptance. The independently adjudicated
[Sonar dispositions](2026-10-09T05-43-10-w7-provider-invocation-sonar-disposition-review.md)
remain separate from runtime correctness.

A NEW complete cumulative second round follows these corrections. MCP, hidden official
Gemini/foreign-stream producers, all actors/generations, sticky final money/effects, parked
clocks, public departure and acknowledged CLI teardown remain open. Step 8, Step 12 and all six
W7 register items stay OPEN (41/51 closed); draft PR #90 stays unmerged. All five live provider
records are complete; no further paid call, credential or maintainer approval is needed.
