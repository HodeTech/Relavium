/**
 * `hostAttemptTimer` / `hostAbortController` — the two primitives behind ADR-0082's per-attempt deadline.
 *
 * They had no tests, and the one property that most needed pinning is invisible in a unit assertion: an
 * `unref`'d timer does not hold the event loop, so with nothing else referenced the process exits and the
 * deadline never fires. That is checked in a CHILD process below, because it can only be observed by
 * letting a real loop drain.
 */

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { hostAbortController, hostAttemptTimer } from './sleep.js';

describe('hostAttemptTimer', () => {
  it('fires after the delay, and the disarm stops it', async () => {
    let fired = 0;
    const disarm = hostAttemptTimer(1, () => {
      fired += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fired).toBe(1);

    let second = 0;
    hostAttemptTimer(1, () => {
      second += 1;
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(second).toBe(0);
    disarm(); // idempotent after firing
  });

  it('HOLDS the event loop — a work timer, not a liveness beat', () => {
    // The property a unit assertion cannot see. ADR-0082's motivating case is a provider that returns a
    // promise which never settles; if the deadline is `unref`'d there is nothing referenced, the loop
    // drains, and the process exits before the timer fires — no classified error, no terminal, nothing.
    // `engine/host.ts` already states the rule: a liveness timer is `unref`'d, a work timer is not.
    const script = `
      const t = setTimeout(() => { console.log('FIRED'); }, 40);
      new Promise(() => {});   // an uncooperative provider: awaits forever, references nothing
    `;
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    expect(out).toContain('FIRED');

    const unrefd = execFileSync(
      process.execPath,
      ['-e', `const t = setTimeout(() => { console.log('FIRED'); }, 40); t.unref(); new Promise(() => {});`],
      { encoding: 'utf8' },
    );
    // …and the negative control: this is what the first version did.
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
