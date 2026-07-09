/**
 * Shared helpers for the ink-7 TUI component-test harness (2.6.F Step 3, ADR-0068 part f). The `.test.tsx` suites
 * (`harness-smoke`, `chat-app`, `home-app`) import these so the flush/wait timing contract and the bracketed-paste
 * framing have ONE home — a drift in either would otherwise have to be fixed in three places.
 *
 * Not a test file itself (no `.test.` suffix), so the runner never collects it; it lives under apps/cli, which the
 * coverage config excludes, so it never affects the engine coverage floor, and it is unreachable from the tsup
 * entry so it is never bundled.
 *
 * TEARDOWN: every suite calls `afterEach(cleanup)` (from `ink-testing-library`) so a failing assertion cannot leak a
 * live ink tree. Note a vendor quirk — ink-testing-library's `cleanup()` never clears its module-level `instances`
 * array, so it re-`unmount()`s EVERY instance the worker has ever mounted on each `afterEach`, not just the current
 * test's. Harmless today (ink's `unmount()` is idempotent: it early-returns when already unmounted), but if a future
 * release makes a double-unmount throw, `afterEach(cleanup)` would start failing every test after the first — that
 * is where to look.
 */

/**
 * Yield the macrotask queue ONCE. This drains the pending MICROTASK chain — a synchronous state change plus a
 * settled promise `.then` (e.g. a resolved `requestApproval`) both surface after one yield. Use it to let a
 * synchronous+microtask effect settle; do NOT rely on it for a rendered FRAME (use {@link waitFor} — React's commit
 * timing is not guaranteed within a single macrotask under load, see below).
 */
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Yield the macrotask queue `frames` times (4 by default) so a FULL-SCREEN frame settles. One {@link flush} drains
 * the microtask chain, but the alt-screen viewport needs a round-trip the inline renderer does not: commit → the
 * post-commit `measureElement` effect → `setHeight` → re-window → re-render. Four yields cover that with slack under
 * parallel-worker CPU contention. Prefer {@link waitFor} whenever the settled state is OBSERVABLE in the frame (it
 * returns the instant the commit lands); reach for this only when the assertion is about the ABSENCE of an effect
 * (no bytes typed, no scroll) — where there is nothing to poll for and the bad outcome needs a bounded window to
 * fail to manifest. Lives here, not in each suite, so the 4 is a single number rather than a dozen copies that drift.
 */
export const settleFrames = async (frames = 4): Promise<void> => {
  for (let i = 0; i < frames; i += 1) await flush();
};

/**
 * Poll until `predicate` holds, yielding the macrotask queue between checks, bounded by `maxYields`. Returns as soon
 * as the predicate is true; if it never becomes true it returns anyway, so the CALLER's own `expect` fails against
 * the actual (stale) frame for a useful diff — this helper never throws or asserts.
 *
 * WHY (not a fixed single `flush`): ink renders through React 19's reconciler + scheduler, whose commit for a store
 * / stdin-driven update can be deferred PAST one macrotask under CPU contention — empirically flaky when the three
 * `.test.tsx` files run in parallel (the default). So a FRAME assertion (`lastFrame()` shows X) must WAIT for the
 * commit, not assume one yield landed it. Two shapes:
 *   • POSITIVE — `await waitFor(() => frame().includes('X'))` then `expect(frame()).toContain('X')`: returns the
 *     instant the commit lands (fast) and tolerates a slow one (robust).
 *   • NEGATIVE — `await waitFor(() => badThingHappened(), 12)` then `expect(!badThingHappened())`: gives the bad
 *     outcome a bounded window to manifest, then confirms it did not (a leak / an erroneous answer would commit
 *     within that window; its absence after it is the guarantee).
 */
export async function waitFor(predicate: () => boolean, maxYields = 100): Promise<void> {
  for (let i = 0; i < maxYields; i += 1) {
    if (predicate()) return;
    await flush();
  }
}

/**
 * Wrap a payload in the DECSET-2004 bracketed-paste markers ink 7's input parser recognizes, so `stdin.write` of
 * the result surfaces as a SINGLE `usePaste` event and NEVER reaches `useInput` — the channel separation that is
 * the ADR-0057 fail-closed foundation (a pasted approval token cannot answer the per-tool floor).
 */
export const bracketed = (body: string): string => `\x1b[200~${body}\x1b[201~`;
