# W7 publication quality gate — four-label correction

- **Type**: Code + Security
- **Date**: 2026-10-10
- **Reviewer(s)**: author/Parent `/root`; fresh independent reviews remain required
- **Subject**: published `a733bdba` Sonar gate, corrected at `e10d66c7`
- **Outcome**: bounded tool corrections verified; two NEW complete clean cumulative rounds required

Both published-head GitHub CI runs pass all five jobs each at `a733bdba`; SonarCloud fails
reliability/security ratings on four new labels. Complete API/rollup snapshots are retained.
This failure is not erased, counted as a pass, or replaced with a classification-only waiver.

| Exact Sonar key | Rule and verified disposition | Correction |
| --- | --- | --- |
| `AaEl9EDRUU98Px-l1ka2` | S2871: producer string keys intentionally use UTF-16 lexical set ordering; no numeric sort defect | Explicit shared comparison preserves that ordering |
| `AaEl9EDRUU98Px-l1ka3` | S2871: required keys use the same intentional ordering | Same comparison on both copies |
| `AaEl9EPBUU98Px-l1ka4` | S4036: optional diagnostic metadata locates Git by inherited PATH | Reuse canonical `systemTool('git')` OS-owned absolute executable |
| `AaEl9EPBUU98Px-l1ka5` | S4036: status metadata has the same lookup | Reuse the same resolved executable |

No runtime/provider behaviour, dependency, archive, task threshold or security policy changes.
The PATH control runs the actual corrected optional tool with an executable trap prepended to PATH:
no trap entry, six genuine causal assertion failures and restored 59-case pass. A separate external
projection removes only the resolved Git argument (plus disclosed location/import redirection);
it enters the trap and fails. Repository source hashes remain unchanged by the diagnostic.
Actual completed replay evidence passes all eleven negative inventory guards and twelve reordered
positive permutations. These are external controls, not new permanent Vitest case counts.
Tools lint/targeted format and root `pnpm run ci` pass at the correction source; root cache use
remains explicit in its retained raw log. Shipping production/tests remain unchanged from the fresh
447-file / 9,512-pass / eleven-existing-skip coverage source; tools are separately exercised here.

External evidence: `~/.codex/relavium-evidence/w7-new-review-20261010/sonar-{after,issues-after}.json`,
`remote-checks-*.json`, `sonar-controls/`, `sonar-inventory-control.mjs` and `sonar-ci.{json,log}`.
The preliminary fixed-tool path control is macOS/POSIX evidence, not a new Windows assertion.
The preceding W7 runtime acceptance remains historical scoped evidence. This publication increment,
its two NEW independent rounds and the exact next published-head Sonar/CI gates remain open.
PR #90 remains ready for maintainer review and unmerged; no paid/provider/key action is involved.
