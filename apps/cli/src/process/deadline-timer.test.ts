/**
 * `hostDeadlineTimer` / `hostAbortController` — the two primitives behind ADR-0082's per-attempt deadline.
 *
 * They had no tests, and the one property that most needed pinning is invisible in a unit assertion: an
 * `unref`'d timer does not hold the event loop, so with nothing else referenced the process exits and the
 * deadline never fires. That is checked in a CHILD process below, because it can only be observed by
 * letting a real loop drain.
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { hostAbortController, hostDeadlineTimer } from './sleep.js';

describe('hostDeadlineTimer', () => {
  it('fires after the delay, and the disarm stops it', async () => {
    let fired = 0;
    const disarm = hostDeadlineTimer(1, () => {
      fired += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fired).toBe(1);

    let second = 0;
    hostDeadlineTimer(1, () => {
      second += 1;
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(second).toBe(0);
    disarm(); // idempotent after firing
  });

  it('HOLDS the event loop — a work timer, not a liveness beat', () => {
    // The property a unit assertion cannot see: it needs a real loop to drain. ADR-0082's motivating case is
    // a provider returning a promise that never settles; if the deadline is `unref`'d there is nothing
    // referenced, the loop drains, and the process exits before the timer fires — no classified error, no
    // terminal, nothing. `engine/host.ts` states the rule: a liveness timer is `unref`'d, a work timer is not.
    //
    // **The child imports the REAL function.** A first version of this test inlined a hand-written
    // `setTimeout` and merely restated Node's own semantics — a review put `timer.unref()` back into
    // `hostDeadlineTimer` and all three tests here stayed green. It was measuring the runtime, not the code.
    // `--experimental-strip-types` EXPLICITLY, because the child imports a `.ts` file. Node unflagged type
    // stripping in 22.18, and this project's floor is 22.13 (ADR-0067) — where the flag exists but is off,
    // so the child died with `ERR_UNKNOWN_FILE_EXTENSION` on the one CI leg that runs the exact floor. The
    // flag has been available since 22.6, so passing it works on the floor and on every newer runtime.
    const child = (source: string): string =>
      execFileSync(
        process.execPath,
        ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', source],
        { encoding: 'utf8' },
      );
    const importReal = `import { hostDeadlineTimer } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'sleep.ts')).href)};`;

    const out = child(`
      ${importReal}
      hostDeadlineTimer(40, () => { console.log('FIRED'); });
      new Promise(() => {});   // an uncooperative provider: awaits forever, references nothing
    `);
    expect(out).toContain('FIRED');

    // The negative control — what the first version of `hostDeadlineTimer` did — proving the assertion above
    // discriminates rather than merely observing that timers fire.
    const unrefd = child(`
      const t = setTimeout(() => { console.log('FIRED'); }, 40);
      t.unref();
      new Promise(() => {});
    `);
    expect(unrefd).not.toContain('FIRED');
  });
});

describe('hostAbortController', () => {
  it('exposes an abortable signal the seam can observe', () => {
    const controller = hostAbortController();
    let observed = 0;
    controller.signal.addEventListener('abort', () => {
      observed += 1;
    });

    expect(controller.signal.aborted).toBe(false);
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
    expect(observed).toBe(1);
  });
});
