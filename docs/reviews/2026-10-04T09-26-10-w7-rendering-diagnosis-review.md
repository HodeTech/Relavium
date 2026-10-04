# W7 post-PR rendering diagnosis

- **Type**: Code
- **Date**: 2026-10-04
- **Reviewer(s)**: `/root/w7_linux_ci_diagnosis`; parent `/root` verifies findings and evidence
- **Subject**: `development` at `95137c34`, required Linux CI run `37187858326`, session disclosure rendering
- **Outcome**: Changes requested; diagnosis supplies no implementation acceptance

## Findings

The diagnostic reviewer (`gpt-6-astra`, xhigh) reproduces the four GitHub failures locally
by setting `CI=true`: interactive injected CLI contexts disagree with Ink's ambient CI
predicate. Dynamic transcript output is buffered until unmount, while an Ink flush can
resolve earlier. The four failures and two late synthetic output errors have this cause;
increasing waits or weakening notice assertions would not repair it.

A separate **High, merge-blocking production defect** is reproduced under `CI=''` and
`CONTINUOUS_INTEGRATION=true`, with the injected context matching the same clean process
environment. Standalone chat and the actual default Home mount sweep committed evidence
before any notice frame. Both environments are interactive under the existing
[ADR-0054 policy](../decisions/0054-cli-bare-invocation-interactive-home.md); adopting Ink's
different predicate would change that policy. Both composition roots must own Ink's
interactivity through the CLI's resolved output mode.

The parent subsequently widens the production Home controls to inline reseat and finds
another disclosure defect: the old Static cursor skips the new store's notice. Resetting
the transcript view for its new store owner fixes this without remounting the root input
owner or reprinting the earlier exchange. The [canonical contract](../reference/shared-core/effect-journal.md#8-needs_attention)
remains disclose before sweep.

## Verification and evidence integrity

The parent fully reads the 23,716-byte diagnostic report, then independently verifies
all **2,172 sealed physical entries**: 1,563 files, 530 directories and 79 literal named
dependency links. Root, hidden entries, full logs, failures, generated artifacts and
restored source are included; only the inventory excludes itself. All 1,080 source pins
match SHA256, bytes and modes, and their file identities are independent of Original.
The clean Original source, HEAD and `development` are checked before parent edits.

- Report SHA256: `c1438ac3aa28c0ada8659ea7ac671b625b7eab26facb67b41a0f6b2bbce74c13`.
- Inventory: 454,800 bytes; SHA256 `b24279f4935b2607a497361016406ce46c313db4ab6f5a8e7a7568304c0a51e5`.

The reviewer releases all runtime, handles and future access before verification.
Its release audit records no remaining runtime PID/handle; the nonzero final lsof result
and checker-only observations are retained. No sealed root is executed or mutated.

Fresh parent-owned Shared/LLM/Core/DB/MCP builds and CLI strict types pass. All **104 selected
tests** pass separately under `CI=true`, empty CI and CONTINUOUS_INTEGRATION. Removing the
production interactivity options fails 14 selected regressions, including explicit option
ownership assertions; this does not claim fourteen distinct evidence-loss cases. Removing
the transcript-owner key fails both inline production controls. Exact restoration passes.
The inline controls observe both notices and exactly one prior assistant reply. Existing
raw Ctrl-Z, closed-before/during and output-error retention assertions remain in force.
The parent's first expanded run fails strict types and three tests: a misplaced option
assertion is corrected, render-overload assertions become type-safe, and the two inline
failures supply the additional production finding above. Those failed logs are retained.

## Limits and follow-ups

The diagnostic reproduction is macOS with controlled CI environments, not a new Linux
runner pass. Its initial preload did not cover Vitest workers; fake provider ports made
no requests, but native keyring loading was not initially blocked. Decisive runs use an
explicit worker guard and throwing native-keyring mock. Network denial allows only embedded
data URLs and a synthetic localhost resolution; it is not an OS sandbox. Parent selected
controls use the same explicit worker defense in a separate physical source copy.

Failed DNS/WASM/setup controls, truncated reads, and the source-mode restoration discrepancy
are preserved in the complete report. Own modes are normalized to the bootstrap pins before
the final full audit; failed attempts contribute no green acceptance. No provider API,
credential, user configuration or private live-capture artifact is accessed by the reviewer.

Required full repository checks, implementation commits and **two fresh independent
post-commit review rounds** remain required. This diagnosis and its temporary hypothesis
patches do not count as either round. Live provider captures and whole-wave Step 12 remain
separate obligations; no W7 register item closes here.
