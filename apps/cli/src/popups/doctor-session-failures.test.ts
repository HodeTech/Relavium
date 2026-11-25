/**
 * What the `/doctor` popup does when its work fails or is overtaken ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §8): a failure is the owner's (never an unhandled rejection) and the step says it; a result for a run that was replaced lands nowhere; and the
 * deep run counts every request it retained until each has settled, on every path (a request that rejects, a retain that throws, an entry
 * that throws), so one that failed can never leave the host believing a run is still stopping.
 */
import { describe, expect, it } from 'vitest';

import { DOCTOR_STEP } from './doctor-popup.js';
import type { DoctorWorkOwner } from './doctor-port.js';
import { deepRunInFlight } from './doctor-session.js';
import {
  CTRL,
  ESC,
  doctorRig,
  recordingProvider,
  settleWork,
  stubProbes,
  stubResolver,
} from './doctor.test-support.js';
import { currentStep } from './popup-reducer.js';

const KEY = ['sk', 'ant', 'failures', 'ABCDEF1234567890'].join('-');

type Rig = ReturnType<typeof doctorRig>;

/** A work owner that records the faults it is told of, counts what it retained, and can be told to fail in each place. */
function ownerOf(
  over: {
    readonly enter?: DoctorWorkOwner['enter'];
    readonly retainWork?: <T>(factory: () => Promise<T>) => Promise<T>;
    readonly assertAdmitting?: () => void;
  } = {},
) {
  const failures: unknown[] = [];
  const controller = new AbortController();
  let retained = 0;
  const owner: DoctorWorkOwner = {
    signal: controller.signal,
    work: {
      retainWork:
        over.retainWork ??
        (<T>(factory: () => Promise<T>): Promise<T> => {
          retained += 1;
          return factory();
        }),
    },
    assertAdmitting: over.assertAdmitting ?? ((): void => undefined),
    enter: over.enter ?? (<T>(operation: () => Promise<T>): Promise<T> => operation()),
    failure: (cause) => {
      failures.push(cause);
    },
  };
  return { owner, failures, controller, retained: () => retained };
}

/** A loop whose pauses can be held: while held, a pause waits until `release`; `fail` makes a pause reject. */
function loopOf() {
  let held = false;
  let failWith: Error | undefined;
  const waiting: (() => void)[] = [];
  return {
    yieldToLoop: (): Promise<void> => {
      if (failWith !== undefined) return Promise.reject(failWith);
      return held
        ? new Promise<void>((resolve) => {
            waiting.push(resolve);
          })
        : Promise.resolve();
    },
    hold: (): void => {
      held = true;
    },
    release: (): void => {
      held = false;
      for (const resume of waiting.splice(0)) resume();
    },
    fail: (cause: Error): void => {
      failWith = cause;
    },
  };
}

const ctrlY = (r: Rig): boolean => r.press('y', CTRL);

/** The letters the checks step answers to now. */
function controlKeys(r: Rig): string[] {
  const frame = r.host.getSnapshot().frame;
  if (frame === undefined) throw new Error('no popup is open');
  return (currentStep(frame).spec.controls ?? []).map((control) => control.key);
}

/** Open the doctor with one keyed provider, show it, let the quick tier land and the settle time pass. */
async function opened(
  over: Parameters<typeof ownerOf>[0] = {},
  loop = loopOf(),
  surface: 'home' | 'home-chat' = 'home',
  deepMcp?: () => Promise<readonly never[]>,
) {
  const r = doctorRig();
  const anthropic = recordingProvider('anthropic');
  const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
  const probes = stubProbes(seam.resolver, deepMcp === undefined ? {} : { deepMcp });
  const owned = ownerOf(over);
  const result = r.open({ probes, workOwner: owned.owner, surface }, false, loop.yieldToLoop);
  if (!result.opened) throw new Error('open');
  r.show();
  await settleWork();
  r.clock.advance(600);
  return { r, anthropic, seam, probes, loop, ...owned };
}

/** `[d]`, the line's frame acknowledged, the dwell, and `Ctrl+Y`: the deep run starts. */
async function answerTheLine(r: Rig): Promise<void> {
  r.press('d');
  await settleWork();
  r.show();
  r.clock.advance(1000);
  ctrlY(r);
  await settleWork();
}

describe('the quick tier’s failures are the owner’s, and a stale one lands nowhere', () => {
  it('an entry that throws at once says the checks could not run, and the owner is told', async () => {
    const cause = new TypeError('the owner is closing');
    const { r, failures } = await opened({
      enter: () => {
        throw cause;
      },
    });
    expect(failures).toEqual([cause]);
    expect(r.content(DOCTOR_STEP.checks).kind).toBe('error');
    expect(r.words()).toContain('The checks could not run.');
    expect(controlKeys(r)).toEqual(['r', 'd']);
  });

  it('an entry that rejects says the same, and the owner is told', async () => {
    const cause = new TypeError('the work was refused');
    const { r, failures } = await opened({ enter: () => Promise.reject(cause) });
    expect(failures).toEqual([cause]);
    expect(r.content(DOCTOR_STEP.checks).kind).toBe('error');
  });

  describe('a quick run that a newer one overtook', () => {
    // `[r]` does nothing while the checks load, so a run is overtaken only from a step that is not loading: `/doctor --deep` opens on the line
    // while the quick tier is still in its first pause, the deep run is answered and fails, and its error step offers `[r]`.
    async function overtaken() {
      let calls = 0;
      let first: { resolve: () => void; reject: (cause: Error) => void } | undefined;
      const yieldToLoop = (): Promise<void> => {
        calls += 1;
        if (calls > 1) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          first = { resolve, reject };
        });
      };
      let admitting = 0;
      const closing = new TypeError('the owner stopped admitting work');
      const owned = ownerOf({
        assertAdmitting: () => {
          admitting += 1;
          if (admitting === 3) throw closing;
        },
      });
      const r = doctorRig();
      const anthropic = recordingProvider('anthropic');
      const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
      const probes = stubProbes(seam.resolver);
      r.open({ probes, workOwner: owned.owner }, true, yieldToLoop);
      await settleWork();
      r.show();
      expect(r.step()).toBe(DOCTOR_STEP.line);
      expect(r.content(DOCTOR_STEP.checks).kind).toBe('loading');
      r.clock.advance(1000);
      ctrlY(r);
      await settleWork();
      expect(r.content(DOCTOR_STEP.checks).kind).toBe('error');
      expect(controlKeys(r)).toEqual(['r', 'd']);
      // The first quick run is still held in its first pause. [r] starts a second, which lands.
      r.clock.advance(600);
      r.press('r');
      await settleWork();
      expect(r.content(DOCTOR_STEP.checks).kind).toBe('list');
      expect(probes.keychainReads()).toBe(1);
      return { r, probes, closing, first: () => first, ...owned };
    }

    it('is abandoned when it wakes: only the newer run reads the keychain', async () => {
      const { r, probes, first } = await overtaken();
      first()?.resolve();
      await settleWork();
      expect(probes.keychainReads()).toBe(1);
      expect(r.content(DOCTOR_STEP.checks).kind).toBe('list');
    });

    it('that fails late is still the owner’s to be told, but puts no error over the newer checks', async () => {
      const { r, closing, failures, first } = await overtaken();
      const late = new TypeError('the first run failed late');
      first()?.reject(late);
      await settleWork();
      expect(failures).toEqual([closing, late]);
      expect(r.content(DOCTOR_STEP.checks).kind).toBe('list');
      expect(controlKeys(r)).toEqual(['r', 'd', 'c']);
    });
  });
});

describe('a quick tier that failed stays failed, whatever lands after it', () => {
  /** An owner that refuses the FIRST thing entered on it (the quick tier) and runs everything after (the deep run, a second quick tier). */
  function refusingTheFirst() {
    const cause = new TypeError('the checks could not be started');
    let entered = 0;
    return {
      cause,
      enter: <T>(operation: () => Promise<T>): Promise<T> => {
        entered += 1;
        return entered === 1 ? Promise.reject(cause) : operation();
      },
    };
  }

  it('[d] and a landed deep result leave the step saying the checks could not run, with [r] and [d], and never the loading words', async () => {
    const owned = refusingTheFirst();
    const { r, anthropic, failures } = await opened({ enter: owned.enter });
    expect(failures).toEqual([owned.cause]);
    expect(r.content(DOCTOR_STEP.checks).kind).toBe('error');
    await answerTheLine(r);
    // The deep tier ran and landed: its one request was sent and answered.
    expect(anthropic.requests).toHaveLength(1);
    expect(deepRunInFlight(r.scope)).toBe(false);
    expect(r.step()).toBe(DOCTOR_STEP.checks);
    expect(r.content(DOCTOR_STEP.checks).kind).toBe('error');
    expect(r.words()).toContain('The checks could not run.');
    expect(r.words()).not.toContain('Checking your setup');
    expect(controlKeys(r)).toEqual(['r', 'd']);
  });

  it('[r] then runs the checks, and the deep rows that landed meanwhile are shown with them', async () => {
    const owned = refusingTheFirst();
    const { r } = await opened({ enter: owned.enter });
    await answerTheLine(r);
    expect(r.content(DOCTOR_STEP.checks).kind).toBe('error');
    r.clock.advance(600);
    r.press('r');
    await settleWork();
    expect(r.content(DOCTOR_STEP.checks).kind).toBe('list');
    expect(r.words()).toContain('OS keychain');
    expect(r.words()).toContain('Anthropic key works');
    expect(controlKeys(r)).toEqual(['r', 'd', 'c']);
  });

  it('a deep run that cannot start leaves it saying the same, not the loading words', async () => {
    // Every entry is refused: the quick tier first, then the deep run's own.
    const cause = new TypeError('the owner is closing');
    const { r } = await opened({
      enter: () => {
        throw cause;
      },
    });
    await answerTheLine(r);
    expect(r.content(DOCTOR_STEP.checks).kind).toBe('error');
    expect(r.words()).not.toContain('Checking your setup');
  });
});

describe('the line’s failures, and the line that was overtaken', () => {
  it('a presence read that fails says the providers could not be read, and the owner is told', async () => {
    const cause = new TypeError('the keychain read failed');
    const { r, failures, loop } = await opened();
    loop.fail(cause);
    r.press('d');
    await settleWork();
    expect(r.step()).toBe(DOCTOR_STEP.line);
    expect(failures).toEqual([cause]);
    expect(r.content().kind).toBe('error');
    expect(r.words()).toContain('The providers could not be read.');
  });

  it('a line that was left before its providers were read never lands: its words stay the loading words', async () => {
    const { r, loop, seam } = await opened();
    loop.hold();
    r.press('d');
    await settleWork();
    expect(r.step()).toBe(DOCTOR_STEP.line);
    r.press('', ESC);
    expect(r.step()).toBe(DOCTOR_STEP.checks);
    loop.release();
    await settleWork();
    expect(r.content(DOCTOR_STEP.line).kind).toBe('loading');
    expect(seam.keyFor).not.toHaveBeenCalled();
  });
});

describe('the deep run counts what it retained, on every path', () => {
  it('every request goes through the owner’s retained work, once per provider named', async () => {
    const { r, retained, anthropic } = await opened();
    await answerTheLine(r);
    expect(anthropic.requests).toHaveLength(1);
    expect(retained()).toBe(1);
    expect(r.words()).toContain('Anthropic key works');
    expect(deepRunInFlight(r.scope)).toBe(false);
  });

  it('a request that is refused as it starts says the deep check could not run, tells the owner, and leaves nothing in flight', async () => {
    let admitting = 0;
    const closing = new TypeError('the owner stopped admitting work');
    const { r, failures } = await opened({
      // The third check is the request's own, inside the work the run retained: its refusal rejects that work.
      assertAdmitting: () => {
        admitting += 1;
        if (admitting === 3) throw closing;
      },
    });
    await answerTheLine(r);
    expect(failures).toEqual([closing]);
    expect(r.content(DOCTOR_STEP.checks).kind).toBe('error');
    expect(r.words()).toContain('The deep check could not run.');
    expect(deepRunInFlight(r.scope)).toBe(false);
    // The failure took the run's state with it: [r] works again.
    expect(controlKeys(r)).toEqual(['r', 'd']);
    r.clock.advance(600);
    r.press('r');
    await settleWork();
    expect(r.content(DOCTOR_STEP.checks).kind).toBe('list');
  });

  it('a retain that throws as it is asked leaves nothing in flight either', async () => {
    const refused = new TypeError('the owner is closing');
    const { r, failures } = await opened({
      retainWork: () => {
        throw refused;
      },
    });
    await answerTheLine(r);
    expect(failures).toEqual([refused]);
    expect(r.content(DOCTOR_STEP.checks).kind).toBe('error');
    expect(deepRunInFlight(r.scope)).toBe(false);
  });

  it('an entry that throws as the deep run starts tells the owner, leaves nothing in flight, and shows the checks again', async () => {
    const refused = new TypeError('the owner refused the deep run');
    let entered = 0;
    const { r, failures, anthropic } = await opened({
      enter: <T>(operation: () => Promise<T>): Promise<T> => {
        entered += 1;
        // The quick tier is entered first; the deep run is the second entry, and it throws at once.
        if (entered === 2) throw refused;
        return operation();
      },
    });
    await answerTheLine(r);
    expect(failures).toEqual([refused]);
    expect(anthropic.requests).toHaveLength(0);
    expect(deepRunInFlight(r.scope)).toBe(false);
    expect(r.content(DOCTOR_STEP.checks).kind).toBe('list');
    expect(controlKeys(r)).toEqual(['r', 'd', 'c']);
  });

  it('a deep run that fails after its owner stopped it tells the owner and lands nothing: the step is not turned into an error', async () => {
    const cause = new TypeError('the MCP report failed after the stop');
    let failMcp: (cause: unknown) => void = () => undefined;
    const deepMcp = (): Promise<readonly never[]> =>
      new Promise<readonly never[]>((_resolve, reject) => {
        failMcp = reject;
      });
    const { r, failures, controller } = await opened({}, loopOf(), 'home-chat', deepMcp);
    await answerTheLine(r);
    // The providers answered; the MCP report is pending. The owner stops the host, and the report then fails.
    expect(r.content(DOCTOR_STEP.checks).kind).toBe('loading');
    controller.abort();
    failMcp(cause);
    await settleWork();
    expect(failures).toEqual([cause]);
    expect(r.content(DOCTOR_STEP.checks).kind).toBe('loading');
    expect(deepRunInFlight(r.scope)).toBe(false);
  });
});
