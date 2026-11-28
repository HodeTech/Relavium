import { afterEach } from 'vitest';

/**
 * A long synchronous test file starves the test runner's worker. Vitest runs one file's synchronous tests back to back with no turn of the
 * event loop between them, so the worker cannot read the runner's answers, and a call it made waits past its 60-second timeout
 * (`[vitest-worker]: Timeout calling "onTaskUpdate"`): the run fails although every test passed (the CI failure of PR #103, on a runner about
 * two times slower per file than a developer machine; one file here ran 47 s without a turn). A file whose tests together run for seconds
 * calls {@link yieldBetweenTests}; a test with a long loop awaits {@link yieldToRunner} inside it.
 */

const realSetTimeout = globalThis.setTimeout;
const now = performance.now.bind(performance);
/** At most this long between turns of the event loop: far below the runner's 60 s, on any machine. */
const BUDGET_MS = 250;
let lastTurn = now();

/**
 * A full turn of the event loop once {@link BUDGET_MS} have passed since the last: a timer, so the turn passes the I/O poll where the worker
 * reads the runner's answers (an immediate can run before the timers it should let fire). The timer is the real one, captured before any
 * test fakes timers; the clock is checked first, so a call between turns costs no time.
 */
export async function yieldToRunner(): Promise<void> {
  if (now() - lastTurn < BUDGET_MS) return;
  await new Promise<void>((resolve) => {
    realSetTimeout(resolve, 0);
  });
  lastTurn = now();
}

/** Registers {@link yieldToRunner} after every test of the calling file. */
export function yieldBetweenTests(): void {
  afterEach(yieldToRunner);
}
