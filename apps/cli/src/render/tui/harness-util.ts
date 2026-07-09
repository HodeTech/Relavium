/**
 * Shared helpers for the ink-7 TUI component-test harness (2.6.F Step 3, ADR-0068 part f). The `.test.tsx` suites
 * (`harness-smoke`, `chat-app`, `home-app`) import these so the flush-timing contract and the bracketed-paste
 * framing have ONE home — a drift in either would otherwise have to be fixed in three places.
 *
 * Not a test file itself (no `.test.` suffix), so the runner never collects it; it lives under apps/cli, which the
 * coverage config excludes, so it never affects the engine coverage floor.
 */

/**
 * Yield until ink's React-19 reconciler has committed the frame scheduled by the preceding `stdin.write` / store
 * change. ink 7 runs a synchronous LegacyRoot (`updateContainerSync`/`flushSyncWork`) and ink-testing-library
 * renders in debug mode (no frame throttle), so ONE macrotask yield (`setImmediate`) reliably lands the commit AND
 * any settled promise `.then` (e.g. a resolved `requestApproval`) — a second yield is never needed. Read frames /
 * assert AFTER awaiting this, never synchronously on the same tick as the write.
 */
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Wrap a payload in the DECSET-2004 bracketed-paste markers ink 7's input parser recognizes, so `stdin.write` of
 * the result surfaces as a SINGLE `usePaste` event and NEVER reaches `useInput` — the channel separation that is
 * the ADR-0057 fail-closed foundation (a pasted approval token cannot answer the per-tool floor).
 */
export const bracketed = (body: string): string => `\x1b[200~${body}\x1b[201~`;
