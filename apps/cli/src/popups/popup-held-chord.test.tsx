/**
 * A key held through a popup cannot answer its confirmation line, and a key that resolved nothing does not lock one
 * ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3, §8; MVP-11 step 4, review round 1),
 * on the real `/doctor` and `/cost` popups through their test rigs (read only):
 *
 * - **A held `Ctrl+Y`** (an OS key repeat of about a second) that lands on the step that ARMS the line answers nothing there, and each of its
 *   repeats is a refused affirmative on the host's history, so the lockout restarts on every repeat and the first repeat on the line, however
 *   long after the line's frame, is refused. Nothing is sent, nothing is released.
 * - **A control letter resolves nothing** (`[r]` runs the quick check, `[d]` arms the line): it does not lock the line it leads to, so a patient
 *   `Ctrl+Y` 900 ms after the line's frame answers; a key that DID resolve something (`Enter` on a row) still locks it for the lockout.
 * - **A popup that OPENS on its line** (`/doctor --deep`, `/cost --release`; MVP-11 step 4 round 2, security F2): the keys that typed the
 *   command went to the composer, which stamps them as keys, never as resolutions, so a `Ctrl+Y` held there through the popup's code load
 *   reached the line with no lockout to meet. The last key before the open now starts the line's lockout, the same 2 s the `[d]` path has: a
 *   held key's repeat within 2 s of it is refused (and disarms the line), a patient press after it answers.
 */
import '../render/tui/force-color.js';

import { describe, expect, it, vi } from 'vitest';

import { createChordGuard } from '../render/tui/chord-guard.js';
import { mountHostedChat, mountStandaloneChat } from '../render/tui/surface-matrix/chat-host.js';
import { KEYS, mountHome } from '../render/tui/surface-matrix/home-host.js';
import type { Variant } from '../render/tui/surface-matrix/variants.js';
import { COST_STEP } from './cost-popup.js';
import type { DoctorPort } from './doctor-port.js';
import { DOCTOR_STEP } from './doctor-popup.js';
import {
  CTRL,
  ENTER,
  ESC,
  doctorRig,
  recordingProvider,
  settleWork,
  stubProbes,
  stubResolver,
} from './doctor.test-support.js';
import { fakeCost, reportRig, type ReportRig } from './report.test-support.js';

// Built at runtime (no contiguous secret literal: leakwatch).
const KEY = ['sk', 'ant', 'held', 'ABCDEF1234567890'].join('-');

/** The doctor on the Home with one keyed provider, its checks landed and its settle time passed. */
async function doctorOpened() {
  const r = doctorRig();
  const anthropic = recordingProvider('anthropic');
  const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
  expect(r.open({ probes: stubProbes(seam.resolver) }).opened).toBe(true);
  r.show();
  await settleWork();
  r.clock.advance(600);
  return { r, anthropic };
}

/** `/cost` with something held, its reading landed and its settle time passed. */
async function costOpened(): Promise<{ r: ReportRig; fake: ReturnType<typeof fakeCost> }> {
  const r = reportRig();
  const fake = fakeCost({ held: 450 });
  r.open({ cost: fake.port }, { kind: 'cost', release: false });
  r.show();
  await settleWork();
  r.clock.advance(600);
  return { r, fake };
}

describe('a Ctrl+Y held through the step that arms the line answers nothing (H1)', () => {
  it.each([900, 1000, 1500, 1800])(
    'the doctor: repeats every %i ms across [d] send nothing',
    async (every) => {
      const { r, anthropic } = await doctorOpened();
      // The key goes down on the checks step and repeats; `[d]` is pressed a moment after one repeat.
      r.clock.advance(every);
      r.press('y', CTRL);
      r.clock.advance(50);
      r.press('d');
      await settleWork();
      expect(r.step()).toBe(DOCTOR_STEP.line);
      r.show();
      for (let repeat = 0; repeat < 8; repeat += 1) {
        r.clock.advance(repeat === 0 ? every - 50 : every);
        r.press('y', CTRL);
        await settleWork();
      }
      expect(anthropic.requests).toHaveLength(0);
    },
  );

  it.each([900, 1000, 1500, 1800])(
    '/cost: repeats every %i ms across [r] release nothing',
    async (every) => {
      const { r, fake } = await costOpened();
      r.clock.advance(every);
      r.press('y', CTRL);
      r.clock.advance(50);
      r.press('r');
      // The line is offered once the reading `[r]` takes has landed, as the doctor's is: its repeats must meet a line that can be answered.
      await settleWork();
      expect(r.step()).toBe(COST_STEP.release);
      expect(r.content().kind).toBe('report');
      r.show();
      for (let repeat = 0; repeat < 8; repeat += 1) {
        r.clock.advance(repeat === 0 ? every - 50 : every);
        r.press('y', CTRL);
      }
      expect(fake.release).not.toHaveBeenCalled();
      expect(fake.heldNow()).toBe(450);
    },
  );

  it('each repeat on a step that is not a line is a resolution on the host’s history', async () => {
    const { r } = await doctorOpened();
    for (let repeat = 0; repeat < 3; repeat += 1) {
      r.clock.advance(1000);
      r.press('y', CTRL);
      expect(r.history.lastResolvedAt).toBe(r.clock.now());
    }
    expect(r.step()).toBe(DOCTOR_STEP.checks);
  });

  it('released for the whole lockout, a deliberate Ctrl+Y on a line armed afresh answers', async () => {
    const { r, anthropic } = await doctorOpened();
    r.clock.advance(1000);
    r.press('y', CTRL);
    r.clock.advance(2100);
    r.press('d');
    await settleWork();
    r.show();
    r.clock.advance(900);
    r.press('y', CTRL);
    expect(anthropic.requests).toHaveLength(1);
  });
});

describe('a control letter resolves nothing; a key that resolved something does lock the line (H2)', () => {
  it('[r], then [d] 600 ms later, then Ctrl+Y 900 ms after the line’s frame: the line is answered', async () => {
    const { r, anthropic } = await doctorOpened();
    r.press('r');
    await settleWork();
    r.clock.advance(600);
    r.press('d');
    await settleWork();
    r.show();
    r.clock.advance(900);
    r.press('y', CTRL);
    expect(anthropic.requests).toHaveLength(1);
  });

  it('Enter on a row, back, [d], then Ctrl+Y within two seconds of the Enter: refused early, nothing sent', async () => {
    const { r, anthropic } = await doctorOpened();
    r.press('', ENTER);
    expect(r.step()).toBe(DOCTOR_STEP.detail);
    const enteredAt = r.clock.now();
    r.clock.advance(100);
    r.press('', ESC);
    expect(r.step()).toBe(DOCTOR_STEP.checks);
    r.clock.advance(100);
    r.press('d');
    await settleWork();
    r.show();
    r.clock.advance(900);
    expect(r.clock.now() - enteredAt).toBeLessThan(2000);
    r.press('y', CTRL);
    expect(anthropic.requests).toHaveLength(0);
    expect(r.step()).toBe(DOCTOR_STEP.checks);
  });

  it('a control letter leaves the history’s last resolution where it was', async () => {
    const { r } = await doctorOpened();
    const before = r.history.lastResolvedAt;
    r.press('r');
    await settleWork();
    expect(r.history.lastResolvedAt).toBe(before);
  });
});

/**
 * Keys the COMPOSER took before a popup opened: the chat store stamps each on the host's one key history as a key (`previousKeyAt`), never as
 * a resolution. `at` are the times, on the rig's clock.
 */
function composerKeys(
  r: { readonly history: ReturnType<typeof doctorRig>['history'] },
  clock: { readonly now: () => number; readonly advance: (ms: number) => void },
  times: readonly number[],
): void {
  const composer = createChordGuard({ now: clock.now, history: r.history });
  for (const at of times) {
    clock.advance(at - clock.now());
    composer.stamp();
  }
}

/** The doctor opened ON its line (`/doctor --deep`) 30 ms after the last composer key (the code's first-use import), its frame acknowledged 10 ms later. */
async function deepOpenedAfter(times: readonly number[]) {
  const r = doctorRig();
  const anthropic = recordingProvider('anthropic');
  const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
  composerKeys(r, r.clock, times);
  const last = r.clock.now();
  r.clock.advance(30);
  expect(r.open({ probes: stubProbes(seam.resolver) }, true).opened).toBe(true);
  await settleWork();
  expect(r.step()).toBe(DOCTOR_STEP.line);
  r.clock.advance(10);
  r.show();
  return { r, anthropic, last };
}

describe('a popup that opens on its line: the last key before the open starts its lockout (MVP-11 step 4 round 2, F2)', () => {
  it.each([850, 1200, 1800, 1990])(
    'a Ctrl+Y held in the composer through the open: its repeat %i ms after the last key is refused, the line is disarmed, nothing is sent',
    async (repeatAt) => {
      // The key went down in the composer 4 s ago and repeats every `repeatAt` ms; the line opens on itself between two repeats.
      const { r, anthropic, last } = await deepOpenedAfter([
        1000,
        1000 + repeatAt,
        1000 + 2 * repeatAt,
      ]);
      r.clock.advance(last + repeatAt - r.clock.now());
      r.press('y', CTRL);
      await settleWork();
      expect(anthropic.requests).toHaveLength(0);
      expect(r.step()).toBe(DOCTOR_STEP.checks);
      // It goes on repeating on the checks, where each repeat is a refused affirmative: nothing is ever sent.
      for (let repeat = 0; repeat < 6; repeat += 1) {
        r.clock.advance(repeatAt);
        r.press('y', CTRL);
        await settleWork();
      }
      expect(anthropic.requests).toHaveLength(0);
    },
  );

  it('a patient press 2.1 s after the last key before the open answers', async () => {
    const { r, anthropic, last } = await deepOpenedAfter([1000]);
    r.clock.advance(last + 2100 - r.clock.now());
    r.press('y', CTRL);
    await settleWork();
    expect(anthropic.requests).toHaveLength(1);
  });

  it('the line of `/cost --release` the same way: refused 1.9 s after the typed line, released 2.1 s after it', async () => {
    for (const [after, released] of [
      [1900, false],
      [2100, true],
    ] as const) {
      const r = reportRig();
      const fake = fakeCost({ held: 450 });
      composerKeys(r, r.clock, [1000]);
      r.clock.advance(30);
      r.open({ cost: fake.port }, { kind: 'cost', release: true });
      await settleWork();
      expect(r.step()).toBe(COST_STEP.release);
      r.clock.advance(10);
      r.show();
      r.clock.advance(1000 + after - r.clock.now());
      r.press('y', CTRL);
      expect(fake.release.mock.calls.length, `${String(after)} ms`).toBe(released ? 1 : 0);
    }
  });
});

describe('typed `/doctor --deep` in a real chat, then Ctrl+Y (MVP-11 step 4 round 2, F2)', () => {
  // Built at runtime (no contiguous secret literal: leakwatch).
  const MOUNTED_KEY = ['sk', 'ant', 'typed', 'ABCDEF1234567890'].join('-');

  it.each([
    [900, 0],
    [1200, 0],
    [1900, 0],
    [2100, 1],
  ] as const)(
    'a Ctrl+Y %i ms after the line appeared sends %i request(s): the Enter that typed the line locks it for 2 s',
    async (wait, sent) => {
      const variant: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };
      const anthropic = recordingProvider('anthropic');
      const seam = stubResolver({ keys: { anthropic: MOUNTED_KEY }, providers: { anthropic } });
      const port: DoctorPort = {
        scope: {},
        surface: 'standalone-chat',
        resultKey: 'session',
        probes: stubProbes(seam.resolver),
      };
      const m = mountStandaloneChat(variant, { standalone: { doctor: port } });
      try {
        await m.settle();
        await m.typeLine('/doctor --deep');
        await m.until(() => m.frame().join('\n').includes('https://api.anthropic.com'));
        await m.settle();
        m.skip(wait);
        m.key(KEYS.ctrlY);
        await m.settle();
        await settleWork();
        await m.settle();
        expect(anthropic.requests).toHaveLength(sent);
      } finally {
        m.unmount();
      }
    },
  );
});

describe('the Home: its landing and its chat’s lists stamp their keys too, so a line typed there is locked the same 2 s (MVP-11 step 4 round 2, F2)', () => {
  // Built at runtime (no contiguous secret literal: leakwatch).
  const HOME_KEY = ['sk', 'ant', 'home', 'ABCDEF1234567890'].join('-');
  const doctorOnHome = (surface: 'home' | 'home-chat') => {
    const anthropic = recordingProvider('anthropic');
    const seam = stubResolver({ keys: { anthropic: HOME_KEY }, providers: { anthropic } });
    const port: DoctorPort = {
      scope: {},
      surface,
      resultKey: surface === 'home' ? 'home' : 'session',
      probes: stubProbes(seam.resolver),
    };
    return { anthropic, port };
  };
  const variant: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };

  it.each([
    [900, 0],
    [2100, 1],
  ] as const)(
    'typed on the landing, then a Ctrl+Y %i ms after the line appeared: %i request(s)',
    async (wait, sent) => {
      const { anthropic, port } = doctorOnHome('home');
      const m = mountHome(variant, { doctor: port });
      try {
        await m.settle();
        m.key('\u001b[200~/doctor --deep\u001b[201~');
        await m.until(() => m.controller.getSnapshot().input.text === '/doctor --deep');
        m.key(KEYS.enter);
        await m.until(() => m.frame().join('\n').includes('https://api.anthropic.com'));
        await m.settle();
        m.skip(wait);
        m.key(KEYS.ctrlY);
        await m.settle();
        await settleWork();
        await m.settle();
        expect(anthropic.requests).toHaveLength(sent);
      } finally {
        m.unmount();
      }
    },
  );

  it.each([
    [900, 0],
    [2100, 1],
  ] as const)(
    'chosen from the palette of the chat the Home hosts (the `/` 2.5 s before), then a Ctrl+Y %i ms after the line appeared: %i request(s)',
    async (wait, sent) => {
      // One clock for every guard of the host (the chat's store, the Home's lists, the popup), moved by hand: the `/` that opened the palette
      // is long past, so only the keys the palette took (its filter, its `Enter`) can lock the line.
      vi.useFakeTimers({ toFake: ['performance'] });
      const { anthropic, port } = doctorOnHome('home-chat');
      const m = await mountHostedChat(variant, { doctor: port });
      try {
        await m.settle();
        m.key('/');
        await m.settle();
        vi.advanceTimersByTime(2500);
        m.key('doctor --deep');
        await m.settle();
        m.key(KEYS.enter);
        await m.until(() => m.frame().join('\n').includes('https://api.anthropic.com'));
        await m.settle();
        vi.advanceTimersByTime(wait);
        m.key(KEYS.ctrlY);
        await m.settle();
        await settleWork();
        await m.settle();
        expect(anthropic.requests).toHaveLength(sent);
      } finally {
        m.unmount();
        vi.useRealTimers();
      }
    },
  );
});
