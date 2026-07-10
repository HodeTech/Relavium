# ADR-0069: `string-width` for the CLI renderer's display-width measurement

- **Status**: Proposed
- **Date**: 2026-07-10
- **Related**: [ADR-0068](0068-full-screen-tui-renderer-ink7-harness.md) · [ADR-0047](0047-cli-render-seam-and-framework-free-cores.md) · [ADR-0067](0067-node-supported-floor-22-reaffirm-better-sqlite3.md)

> **Awaiting maintainer approval.** [CLAUDE.md](../../CLAUDE.md) rule 2 gates every new runtime dependency behind an
> ADR. The code in 2.6.F Step 6g already depends on this decision; if it is rejected, the revert is `viewport.ts`'s
> width functions plus the one manifest line.

## Context

The full-screen renderer ([ADR-0068](0068-full-screen-tui-renderer-ink7-harness.md) §c) rests on one invariant:

> **1 `DisplayLine` == 1 real terminal row.**

`viewport.ts` wraps the transcript into `DisplayLine`s, and the scroll state machine, the row-measurement, and (since
Step 6) the mouse row→line mapping all count those lines as terminal rows. If a `DisplayLine` is in fact *wider* than
`cols`, ink re-wraps that `<Text>` into two real rows, the viewport's `overflowY: hidden` clips the tail, and every
offset and mouse mapping below it is off by one — silently, and permanently for that session.

So the wrap's width function must never **under-count** relative to the width function *ink* measures with. ink's
`Output` (`ink/build/output.js`) imports **`string-width`**.

Relavium hand-rolled its own table instead, under the rule "build in-house; minimise dependencies". The module's own
docstring recorded the debt:

> *"Display width is a PRAGMATIC hand-roll … the repo deliberately avoids a `string-width` runtime dependency … the
> table should be hardened … so it never under-counts. **Tracked as a Step-4b-2 obligation.**"*

It also claimed the table "never under-counts vs ink". The whole-phase adversarial review disputed that, and a
measurement over every assigned code point in the BMP and SMP settled it:

| Direction | Code points | Consequence |
|---|---:|---|
| We over-count (safe) | 3 716 | The wrap breaks a cell early — a slightly narrow line. |
| **We under-count (unsafe)** | **8 539** | **The `DisplayLine` overflows its row.** |

The under-counts are not exotic combining marks. They are East-Asian **Wide** characters we called narrow:

- `U+17000..U+18CD5` — **Tangut**, 7 382 of them
- `U+1B000..U+1B2FB` — Kana Supplement / Kana Extended
- `U+4DC0..U+4DFF` — Yijing hexagrams
- `U+A960..U+A97C` — Hangul Jamo Extended-A
- `U+FE10..U+FE19`, `U+FE50..U+FE6B` — vertical and small form variants
- `U+1D300..U+1D376` — Tai Xuan Jing symbols, counting rods

The table had already been patched twice by review — Step 4b-2's Opus fold added a hand-transcribed
`isBmpEmojiPresentation` set after that review found *the same class of bug*. A Unicode width table is a moving target:
it changes with every Unicode release, and each release we do not track becomes a new under-count.

## Decision

**`apps/cli` declares `string-width` (`catalog: ^8.2.0`) as a direct runtime dependency, and `viewport.ts`'s
`displayWidth` / `graphemeWidth` become thin calls to it.** The hand-rolled `codePointWidth` / `isWide` /
`isBmpEmojiPresentation` tables (128 lines) are deleted.

`displayWidth` is now, by construction, the same function ink measures with. The two cannot disagree about where a
line ends.

Three things make this a narrower decision than "add a dependency":

1. **It adds nothing to the install.** `string-width@^8.2.0` is *already* a runtime dependency of the shipped CLI —
   `ink` depends on it, at the same range. Declaring it directly removes a phantom dependency; it does not add a
   package, install weight, or supply-chain surface.
2. **It stays out of the engine.** `packages/core` and `packages/llm` remain platform-free and dependency-free. This
   is a *renderer* dependency, in `apps/cli` only, where ink already lives.
3. **It is not the core.** [CLAUDE.md](../../CLAUDE.md) rule 2 says "write our own better implementations **for the
   core**", and rule 3 says never reinvent primitives that must be exactly right. A Unicode width table is the second
   kind: not Relavium's value, exactly right or the renderer corrupts, and already vendored.

`countAnsiEscapeCodes: true` is passed at both call sites: the text is already stripped of ANSI/C0/C1 by
`sanitizeInline`, so `string-width`'s `strip-ansi` pass is dead work on the hot path.

### Alternatives considered

- **Keep the table, widen it.** Rejected. It is the third patch to the same class of bug, and it rots on a schedule we
  do not control (Unicode 16 added Tangut components; 17 will add more).
- **Keep the table, but bias every unknown to width 2.** Safe against under-counting, but it over-counts most of the
  BMP, so ordinary CJK and emoji lines wrap far too early. The cure is worse.
- **Vendor `string-width`'s tables into the repo.** All of the rot, none of the upstream fixes, and a licence header
  to carry.
- **Use it as a `devDependency` only, to test the hand-rolled table.** This pins the bug in place rather than fixing
  it, and every future Unicode release turns CI red with no fix available but the one above.

## Consequences

### Positive

- The 1-`DisplayLine`-==-1-row invariant becomes **structural**, not asserted: the wrap and ink measure with the same
  function. The Step-4b-2 obligation recorded in `viewport.ts` is closed.
- 128 lines of table, and the class of bug it produced, are deleted.
- The common line gets *faster*: `string-width` short-circuits pure-ASCII input with one regex, where the table ran a
  per-code-point loop.
- Unicode releases arrive through a dependency bump rather than through a review finding.

### Negative

- One more directly-declared runtime dependency in `apps/cli` — mitigated by it already shipping via `ink`, and by
  `packages/core` / `packages/llm` staying untouched.
- Relavium now inherits `string-width`'s judgement calls. One is user-visible today: a **lone** regional indicator
  (`U+1F1F9` with no pair) is 1 cell, where the old table said 2. `string-width` is right that it is not an RGI emoji;
  which is *rendered* correctly is terminal-dependent, and matching ink is what the invariant requires.
- A future ink major that swaps its width library would silently re-open the disagreement. `viewport.test.ts` pins the
  contract against `string-width` directly (`inkWidth`), so the drift fails a test rather than a user's scroll.
