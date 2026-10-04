# W7 post-PR rendering correction, round 1

- **Type**: Code
- **Date**: 2026-10-04
- **Reviewer(s)**: `/root/w7_rendering_round1_runtime`, `/root/w7_rendering_round1_contracts_clean`; parent `/root`
- **Subject**: `development`, `95137c34..578c14a5`, all 16 rendering/diagnostic/capture paths
- **Outcome**: Changes requested; fresh corrective round 2 required

## Findings

**High:** a real production Home chat first displays its reply at 100×30, then resizes to 100×1 during
model reseat. Ink flushes a footer without the effect disclosure, and the committed evidence is swept.
The parent independently reproduces this in a fresh owned tree. The matching 80×24 control displays the
notice before deletion. Writable output and a generic flush are necessary but insufficient.

**Medium:** with `CI=true` and a TTY, the real chat selector still mounts Ink despite the shared plain-output
policy. A selector-only correction also leaves transcript ownership wrong: the notice enters an undrawn
store before cleanup. The parent reproduces both routing and delivery boundaries; selection and ownership
must share the existing predicate, with acknowledged stderr on the plain path.

The contract reviewer finds no additional material issue in its complete scoped pass. That does not
overrule the independently reproduced runtime findings or accept the whole wave.

## Parent corrections and checks

Correction commit `11e2575b` tracks the exact published notice object. Inline acknowledgement comes from its actual
Static child; full-screen acknowledgement requires all its wrapped rows in the committed, measured,
terminal-clipped viewport. A second bounded flush handles the initial blank measurement frame. An invisible
notice retains evidence without parking input. An older identical notice, stale frame or replacement store
cannot acknowledge it. See the [canonical contract](../reference/shared-core/effect-journal.md#8-needs_attention).

Permanent actual-Ink controls resize after a visible reply, retain both rows at 100×1, then show the notice
and sweep only the committed row on the next usable activation. The supported-size control and existing
close/error, inline reseat and raw Ctrl-Z controls remain. Eight raw Ctrl-Z cases now exercise supported
interactive contexts, including `CI=false`/`0`; the former forced-Ink `CI=true` cases are replaced by two
actual-production plain-driver tests asserting stderr acknowledgement while the evidence still exists.
This follows the corrected production route rather than requiring job control on a plain surface.

The first candidate exposes a blank measurement-frame refusal and the two obsolete forced-Ink CI
expectations: seven failures are retained in private logs. A subsequent full check rejects an unsafe matcher
assignment; the assertion is expressed as a typed transcript predicate. All failures remain in private logs.
The final candidate passes strict CLI types and **224 selected tests separately in three environments**:
`CI=true`, empty CI and `CONTINUOUS_INTEGRATION=true`. `pnpm run ci` and sequential `pnpm coverage` each
exit 0: **328 files, 7,552 passing tests, 12 skipped** (eleven existing conformance skips and the existing
CI-only wrap-shape skip); global line/branch/function coverage is 95.88% / 92.63% / 96.73%.

Parent causal controls disable only published visibility (one resize failure), the CI predicate (two
unexpected-Ink failures), or CI delivery ownership while keeping plain routing (two missing-stderr failures).
Exact restoration passes all twenty matching controls and strict types. The final candidate passes the
standards screen, append-only ADR prefix check and 497 changed-document relative path targets.

## Evidence integrity and limits

Both reviewers use fresh physical owned sources, clean child environments, main/worker network and native
keyring denial, and explicit fake-keyring resolution. Each fresh-builds its own package dependencies.
The parent fully reads both reports, then verifies every sealed file/directory/literal-link entry, all
1,085 source pins and all 79 named links, including 11 internal links confined to the respective Own.
Neither sealed tree is executed or mutated after release.

| Reviewer | Entries | Report bytes / SHA256 | Inventory bytes / SHA256 |
| --- | ---: | --- | --- |
| Runtime | 2,193 | 28,076 / `ee2b2a870c5463b6491f7ea85a396fb52f1c134b5f4a03d874bcb6516f7d8305` | 378,565 / `43a46866fbfc36fc9c745d5dce2a30da2654a4f2685f037167a5bb287345ccc5` |
| Clean contracts | 2,306 | 24,278 / `1eec7b05c54d6dc189ae225208025d10ddd7e91ead8cf72a007bb16afb19c46a` | 530,576 / `0cd2731529598741be41faee735578d7d103c8fda15319480d34c526cce09a60` |

The runtime review passes 104 permanent controls in three separate environments and 393 further lifecycle
controls; the contract review passes 107 controls in its two restored environments. Their negative controls
break the earlier interactivity/cursor fixes. These are scoped results, not whole-PR or live-provider approval.

An earlier contracts attempt has 11 cross-Own internal dependency links caused by parent preparation's
`/var` versus `/private/var` prefix handling. Its runtime results are invalid and excluded. It is released
and preserved unchanged; all 2,014 physical entries and the wrong links are verified. A wholly fresh clean
review replaces it. Its report is 12,545 bytes, SHA256 `a8022144b3ab2daf2449fb04ac667c6dac7895f2f60261caa00db544d999e80e`;
inventory is 352,736 bytes, SHA256 `f1beea626e1592bdbc5aa466a5b15ee32bf176d9b18e5346223339a9b84bf1b8`.
The runtime review's own pre-runtime wrong links are explicitly repaired and re-audited before execution;
its failed setup is retained. No invalid runtime is presented as clean acceptance.

## Follow-ups

Commit the verified corrections, then obtain two fresh complete corrective reviews. The three real overflow
artifacts remain byte-identical and do not establish the two missing captures. Steps 7–8, whole Step 12,
the systematic PR findings and all six W7 register items remain open.
