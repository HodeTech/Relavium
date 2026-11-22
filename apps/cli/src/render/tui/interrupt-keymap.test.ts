import { describe, expect, it } from 'vitest';

import {
  DISARMED,
  INTERRUPT_ARM_WINDOW_MS,
  decideExit,
  isArmed,
  isInterruptKey,
  pressExitGuardKey,
  pressInterrupt,
  pressOtherKey,
  type ExitDecision,
  type ExitGuardAnswer,
  type HostedLegState,
  type InterruptAction,
  type InterruptContext,
  type InterruptState,
} from './interrupt-keymap.js';

/**
 * ADR-0115 §1, row by row. The table is the contract: every surface (the standalone chat, the in-Home chat and the Home) feeds
 * this one reducer, so a row that moves here moves everywhere.
 */
const FIRST_PRESS: readonly {
  readonly row: string;
  readonly context: InterruptContext;
  readonly action: InterruptAction;
  readonly arms: boolean;
}[] = [
  { row: 'a card is open', context: { kind: 'card' }, action: 'stop-and-arm', arms: true },
  {
    row: 'a turn or a `!` command runs',
    context: { kind: 'work' },
    action: 'stop-and-arm',
    arms: true,
  },
  {
    row: 'idle, a draft in the prompt',
    context: { kind: 'prompt', hasText: true },
    action: 'clear-text',
    arms: false,
  },
  {
    row: 'idle, empty prompt',
    context: { kind: 'prompt', hasText: false },
    action: 'arm-hint',
    arms: true,
  },
  { row: 'an overlay is open', context: { kind: 'overlay' }, action: 'close-overlay', arms: false },
  {
    row: 'the Home, loaded',
    context: { kind: 'home', loading: false },
    action: 'arm-hint',
    arms: true,
  },
  {
    row: 'the Home, still loading',
    context: { kind: 'home', loading: true },
    action: 'exit-now',
    arms: false,
  },
];

describe('the first Ctrl+C (ADR-0115 §1)', () => {
  it.each(FIRST_PRESS)('$row: $action', ({ context, action, arms }) => {
    const result = pressInterrupt(DISARMED, context, 1000);
    expect(result.action).toBe(action);
    expect(result.state.armedAt, 'armed exactly when the table says so').toBe(
      arms ? 1000 : undefined,
    );
  });
});

describe('the second Ctrl+C', () => {
  const armed = (at: number): InterruptState => ({ armedAt: at });

  it.each(FIRST_PRESS.filter((row) => row.arms))(
    'ends the session wherever the person is ($row)',
    ({ context }) => {
      const first = pressInterrupt(DISARMED, context, 1000);
      const second = pressInterrupt(first.state, context, 1000 + 500);
      expect(second.action).toBe('end-session');
      expect(second.state, 'ending the session leaves nothing armed').toEqual(DISARMED);
    },
  );

  it('ends the session from a different context too: the person said "stop" twice', () => {
    // Stopped a running turn (work), and a moment later the prompt is idle (the turn ended): still the second press.
    const first = pressInterrupt(DISARMED, { kind: 'work' }, 1000);
    const second = pressInterrupt(first.state, { kind: 'prompt', hasText: false }, 1100);
    expect(second.action).toBe('end-session');
  });

  it('ends it even with a draft in the prompt: the person armed it a moment ago by stopping the turn', () => {
    expect(pressInterrupt(armed(1000), { kind: 'prompt', hasText: true }, 1100).action).toBe(
      'end-session',
    );
  });

  it('is a fresh first press once the window has run out', () => {
    const late = pressInterrupt(
      armed(1000),
      { kind: 'prompt', hasText: false },
      1000 + INTERRUPT_ARM_WINDOW_MS + 1,
    );
    expect(late.action).toBe('arm-hint'); // starts over: it did not end the session
    expect(late.state.armedAt).toBe(1000 + INTERRUPT_ARM_WINDOW_MS + 1);
  });

  it('still counts at exactly the end of the window, and not one millisecond after', () => {
    expect(
      pressInterrupt(armed(1000), { kind: 'work' }, 1000 + INTERRUPT_ARM_WINDOW_MS).action,
    ).toBe('end-session');
    expect(
      pressInterrupt(armed(1000), { kind: 'work' }, 1000 + INTERRUPT_ARM_WINDOW_MS + 1).action,
    ).toBe('stop-and-arm');
  });
});

describe('arming expires', () => {
  it('is armed for the window and no longer', () => {
    const state = { armedAt: 5000 };
    expect(isArmed(state, 5000)).toBe(true);
    expect(isArmed(state, 5000 + INTERRUPT_ARM_WINDOW_MS)).toBe(true);
    expect(isArmed(state, 5000 + INTERRUPT_ARM_WINDOW_MS + 1)).toBe(false);
    expect(isArmed(DISARMED, 5000)).toBe(false);
  });

  it('is two seconds, one named constant', () => {
    expect(INTERRUPT_ARM_WINDOW_MS).toBe(2000);
  });

  it('ends at any other key', () => {
    const first = pressInterrupt(DISARMED, { kind: 'work' }, 1000);
    expect(isArmed(first.state, 1100)).toBe(true);
    const afterOtherKey = pressOtherKey();
    expect(isArmed(afterOtherKey, 1100)).toBe(false);
    // So the next Ctrl+C is a first press again, not the second one.
    expect(pressInterrupt(afterOtherKey, { kind: 'prompt', hasText: false }, 1200).action).toBe(
      'arm-hint',
    );
  });
});

describe('what the first press does NOT do', () => {
  it('clearing a draft, closing an overlay and leaving a loading Home arm nothing, so a stray press cannot end a session', () => {
    for (const context of [
      { kind: 'prompt', hasText: true },
      { kind: 'overlay' },
      { kind: 'home', loading: true },
    ] as const) {
      const first = pressInterrupt(DISARMED, context, 1000);
      expect(isArmed(first.state, 1001), context.kind).toBe(false);
      // A second press right after is therefore ANOTHER first press, never an exit.
      expect(pressInterrupt(first.state, context, 1001).action).not.toBe('end-session');
    }
  });
});

describe('which key is the interrupt', () => {
  it('is Ctrl+C, in either case, and no other chord', () => {
    expect(isInterruptKey('c', { ctrl: true })).toBe(true);
    expect(isInterruptKey('C', { ctrl: true })).toBe(true);
    expect(isInterruptKey('c', {})).toBe(false); // a bare letter is typing
    expect(isInterruptKey('c', { ctrl: true, meta: true })).toBe(false); // Ctrl+Alt+C is another chord
    expect(isInterruptKey('d', { ctrl: true })).toBe(false);
    expect(isInterruptKey('', { ctrl: true })).toBe(false);
    // An unrelated flag on the key does not change what it is (the old Home reducer had a test for a coincident `return`).
    expect(isInterruptKey('c', { ctrl: true, return: true } as { ctrl: boolean })).toBe(true);
  });
});

/**
 * The exit guard, row by row (ADR-0139 §6, ADR-0122 §7.4). The first table is what a request to end the Home does for each state of
 * the run host; the second is what each key means at the card it opens. Both are enumerated in full, and the key table is also
 * checked against a universe of keys, so a row that is removed fails (its key answers `ignore`) and a row that is added fails too.
 */
const EXIT_REQUEST: readonly {
  readonly row: string;
  readonly leg: HostedLegState;
  readonly decision: ExitDecision;
}[] = [
  { row: 'no leg: the Home leaves as it always did', leg: 'none', decision: 'exit' },
  { row: 'a leg executing: ask first', leg: 'executing', decision: 'ask' },
  { row: 'a leg cancelling: ask first', leg: 'cancelling', decision: 'ask' },
];

describe('a request to end the Home (ADR-0139 §6)', () => {
  it.each(EXIT_REQUEST)('$row', ({ leg, decision }) => {
    expect(decideExit(leg)).toBe(decision);
  });
});

type GuardKey = { readonly ctrl?: boolean; readonly meta?: boolean; readonly escape?: boolean };
const EXIT_GUARD_KEYS: readonly {
  readonly row: string;
  readonly input: string;
  readonly key: GuardKey;
  readonly answer: ExitGuardAnswer;
}[] = [
  { row: 'Ctrl+Y cancels the run and leaves', input: 'y', key: { ctrl: true }, answer: 'confirm' },
  { row: 'Esc stays', input: '', key: { escape: true }, answer: 'stay' },
  {
    row: 'Ctrl+C stays (a confirmation treats both interrupt keys as cancel)',
    input: 'c',
    key: { ctrl: true },
    answer: 'stay',
  },
  { row: 'Ctrl+C in capitals stays', input: 'C', key: { ctrl: true }, answer: 'stay' },
  { row: 'Ctrl+N stays', input: 'n', key: { ctrl: true }, answer: 'stay' },
  { row: 'a bare y answers nothing', input: 'y', key: {}, answer: 'ignore' },
  { row: 'a bare n answers nothing', input: 'n', key: {}, answer: 'ignore' },
  { row: 'a bare c answers nothing', input: 'c', key: {}, answer: 'ignore' },
  {
    row: 'Ctrl+Alt+Y is another chord',
    input: 'y',
    key: { ctrl: true, meta: true },
    answer: 'ignore',
  },
  {
    row: 'Ctrl+Alt+N is another chord',
    input: 'n',
    key: { ctrl: true, meta: true },
    answer: 'ignore',
  },
  { row: 'Ctrl+D is not an answer', input: 'd', key: { ctrl: true }, answer: 'ignore' },
  {
    row: 'a pasted run that contains y is not the key',
    input: 'yy',
    key: { ctrl: true },
    answer: 'ignore',
  },
  { row: 'Enter answers nothing', input: '', key: {}, answer: 'ignore' },
];

describe('the exit-guard card keys (ADR-0139 §6)', () => {
  it.each(EXIT_GUARD_KEYS)('$row', ({ input, key, answer }) => {
    expect(pressExitGuardKey(input, key)).toBe(answer);
  });

  it('answers confirm to exactly one key, stay to exactly three, and ignore to every other key', () => {
    const letters = 'abcdefghijklmnopqrstuvwxyz0123456789 \u0019\u0003\u000e';
    const answers = new Map<string, ExitGuardAnswer>();
    for (const input of ['', ...letters])
      for (const ctrl of [false, true])
        for (const meta of [false, true])
          for (const escape of [false, true]) {
            const answer = pressExitGuardKey(input, { ctrl, meta, escape });
            if (answer !== 'ignore')
              answers.set(
                `${input}|${ctrl ? 'ctrl' : ''}|${meta ? 'meta' : ''}|${escape ? 'esc' : ''}`,
                answer,
              );
          }
    const confirm = [...answers].filter(([, a]) => a === 'confirm').map(([k]) => k);
    const stay = [...answers].filter(([, a]) => a === 'stay').map(([k]) => k);
    expect(confirm, 'only Ctrl+Y confirms').toEqual(['y|ctrl||']);
    // Esc (any input, either meta), Ctrl+C and Ctrl+N: nothing else stays.
    expect(
      stay.filter((k) => !k.endsWith('|esc')),
      'Ctrl+C and Ctrl+N stay',
    ).toEqual(['c|ctrl||', 'n|ctrl||']);
    expect(stay.every((k) => k.endsWith('|esc') || k === 'c|ctrl||' || k === 'n|ctrl||')).toBe(
      true,
    );
  });

  it('never confirms with Esc or Ctrl+C held at the same time', () => {
    expect(pressExitGuardKey('y', { ctrl: true, escape: true })).toBe('stay');
    expect(pressExitGuardKey('c', { ctrl: true, escape: true })).toBe('stay');
  });
});
