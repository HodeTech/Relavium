# Review: W7 Sonar raw-observer disposition

- **Type**: Code + Security
- **Date**: 2026-10-08
- **Reviewer(s)**: `/root`
- **Subject**: PR #90; eleven new labels after `51b2d356`, current source through `acbbfd51`
- **Outcome**: One caller-scoped false positive applied and independently read back; current Sonar gate green, required CI still red

## Applied observer decision

`AaEdX9OFE3G1IiUCi_9W`, TypeScript S4822 at `host-work-registry.ts:98`, flags the try
that obtains the exact raw Promise. That boundary deliberately catches only a synchronous
factory throw. Captured native Promise observation separately handles fulfillment and
rejection without replacing the raw identity required by ADR-0103. Adding an `await` or
substituted catch-chain here would change the obligation being observed.

The [foundation round 1](2026-10-08T21-01-09-w7-delivery-foundation-round-1-review.md)
and [fresh round 2](2026-10-08T21-12-58-w7-delivery-foundation-round-2-review.md)
independently cover this boundary, including observer-setup failures. The registry source
is unchanged between `51b2d356` and `acbbfd51`. Parent rechecks its producer and observer
before applying this caller-scoped judgment through the authorised Sonar session, following
the [code-review durable-note procedure](../../.claude/skills/code-review/SKILL.md).
No global rule, scanner setting, source suppression or security protection changes.
Sharing the comment with Sonar for analyser improvement is explicitly unchecked.

Visible UI confirmation is followed by a separate public PR-scoped API read: `RESOLVED`,
`FALSE-POSITIVE`, `issueStatus: FALSE_POSITIVE`, update time **2026-10-08T21:38:29Z**.
The quality-gate API returns `OK`, ratings of 1, duplication 0.2% and reviewed hotspots
100%; the GitHub Sonar check for `acbbfd51` separately succeeds. The unresolved inventory
is 190. This does not turn the
[red required typecheck](2026-10-08T21-48-00-w7-step-7-round-2-review.md) green or establish
whole-wave acceptance.

## Individual new-label adjudication

The earlier [security dispositions](2026-10-08T20-54-08-w7-sonar-disposition-application-review.md)
remain separate historical records. Parent individually reads all eleven newer source
spans; only the observer label above receives a remote disposition.

| Key suffix | Source / rule | Adjudication |
| --- | --- | --- |
| `_9d` | `chat.ts:2611`, S3776 | Policy-aware failed-turn printing has complexity 16 versus 15; no behavior defect is verified. |
| `_9e` | `chat.ts:2639`, S3358 | Three explicit memory-policy hint conditions are preserved. |
| `_9f` | `chat-projection.ts:176`, S3358 | The three memory-policy hint branches are covered by projection and lifecycle controls. |
| `_9Y` | `anthropic.ts:237`, S3358 | Structured classification deliberately falls back across provider status fields. |
| `_9Z` | `anthropic.ts:238`, S3358 | The same provider-status fallback is intentional. |
| `_9a` | `anthropic.ts:822`, S3776 | Stream complexity separates native handoff, ordinary terminals and cleanup; fresh cumulative controls verify these branches. |
| `_9b` | `stream-grammar.ts:98`, S3776 | Ordered grammar distinguishes first owned terminal, confirming read and protocol tails. |
| `_9c` | `stream-grammar.ts:115`, S3358 | The diagnostic may retain first terminal usage but cannot replace its quantities. |
| `_9W` | `host-work-registry.ts:98`, S4822 | Scoped false positive applied as detailed above. |
| `_9V` | `host-work-registry.ts:88`, S9382 | Quiescence deliberately awaits and rechecks the active obligation set. |
| `_9X` | `agent-turn.ts:663`, S1788 | Current callers explicitly supply the commitment argument; its default placement establishes no current behavior defect. |

These are judgments about the reviewed source, not a blanket dismissal of future labels.
No new verified product obligation is deferred on the basis of these metrics. New source
requires fresh analysis. SDK/core ownership, actual engine host closure, Step 8 and Step 12
remain open; no provider, keychain or live invoice verification is performed here.
