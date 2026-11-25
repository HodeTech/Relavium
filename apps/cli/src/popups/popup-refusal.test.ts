/**
 * The one refusal of the open gate (`popup-refusal.ts`; [ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2): every combination of the facts gives exactly one reason, the first of the one order that holds, and `undefined` only when none does.
 * The order is written here as the specification, independently of the code: a branch dropped or two reasons swapped fails a row.
 */
import { describe, expect, it } from 'vitest';

import type { PopupRefusal } from './popup-host.js';
import { popupRefusal, type PopupRefusalFacts } from './popup-refusal.js';

const IDLE: PopupRefusalFacts = {
  starting: false,
  cards: false,
  sheet: false,
  turn: { running: false, shellBusy: false, submitBusy: false, nativeActionBusy: false },
  armed: false,
  overlay: false,
};

/** The nine facts a host can report, each as the patch that sets it. */
const FACTS = {
  starting: { starting: true },
  cards: { cards: true },
  sheet: { sheet: true },
  running: { turn: { ...IDLE.turn, running: true } },
  shellBusy: { turn: { ...IDLE.turn, shellBusy: true } },
  submitBusy: { turn: { ...IDLE.turn, submitBusy: true } },
  nativeActionBusy: { turn: { ...IDLE.turn, nativeActionBusy: true } },
  armed: { armed: true },
  overlay: { overlay: true },
} as const satisfies Readonly<Record<string, Partial<PopupRefusalFacts>>>;
type Fact = keyof typeof FACTS;
const NAMES: readonly Fact[] = [
  'starting',
  'cards',
  'sheet',
  'running',
  'shellBusy',
  'submitBusy',
  'nativeActionBusy',
  'armed',
  'overlay',
];

/** The specification: the reasons in their order, and the facts that give each one. */
const ORDER: readonly (readonly [PopupRefusal, readonly Fact[]])[] = [
  ['starting', ['starting']],
  ['card-open', ['cards']],
  ['sheet-open', ['sheet']],
  ['turn-running', ['running', 'shellBusy', 'submitBusy', 'nativeActionBusy']],
  ['armed', ['armed']],
  ['overlay-open', ['overlay']],
];

/** The facts with exactly `set` true, every other one false. */
function factsOf(set: ReadonlySet<Fact>): PopupRefusalFacts {
  let facts: PopupRefusalFacts = IDLE;
  for (const name of NAMES) {
    if (!set.has(name)) continue;
    const patch: Partial<PopupRefusalFacts> = FACTS[name];
    facts = {
      ...facts,
      ...patch,
      // The four turn facts accumulate: setting one never clears another.
      turn: {
        running: facts.turn.running || name === 'running',
        shellBusy: facts.turn.shellBusy || name === 'shellBusy',
        submitBusy: facts.turn.submitBusy || name === 'submitBusy',
        nativeActionBusy: facts.turn.nativeActionBusy === true || name === 'nativeActionBusy',
      },
    };
  }
  return facts;
}

function expected(set: ReadonlySet<Fact>): PopupRefusal | undefined {
  for (const [reason, causes] of ORDER) if (causes.some((cause) => set.has(cause))) return reason;
  return undefined;
}

describe('popupRefusal', () => {
  it('opens on a host where nothing holds', () => {
    expect(popupRefusal(IDLE)).toBeUndefined();
    // A stand-alone chat reports no `starting` and no native action at all.
    expect(
      popupRefusal({
        cards: false,
        sheet: false,
        turn: { running: false, shellBusy: false, submitBusy: false },
        armed: false,
        overlay: false,
      }),
    ).toBeUndefined();
  });

  it.each([
    ['starting', 'starting'],
    ['cards', 'card-open'],
    ['sheet', 'sheet-open'],
    ['running', 'turn-running'],
    ['shellBusy', 'turn-running'],
    ['submitBusy', 'turn-running'],
    ['nativeActionBusy', 'turn-running'],
    ['armed', 'armed'],
    ['overlay', 'overlay-open'],
  ] satisfies readonly (readonly [Fact, PopupRefusal])[])(
    '%s alone refuses as %s',
    (fact, reason) => {
      expect(popupRefusal(factsOf(new Set([fact])))).toBe(reason);
    },
  );

  it.each([
    // Each adjacent pair of the order: the earlier reason wins.
    [['starting', 'cards'], 'starting'],
    [['cards', 'sheet'], 'card-open'],
    [['sheet', 'running'], 'sheet-open'],
    [['submitBusy', 'armed'], 'turn-running'],
    [['armed', 'overlay'], 'armed'],
    // And the last against the first.
    [['overlay', 'starting'], 'starting'],
  ] satisfies readonly (readonly [readonly Fact[], PopupRefusal])[])(
    '%j refuses as %s',
    (set, reason) => {
      expect(popupRefusal(factsOf(new Set(set)))).toBe(reason);
    },
  );

  it('every one of the 512 combinations of the nine facts gives the first reason of the order that holds', () => {
    let checked = 0;
    for (let mask = 0; mask < 1 << NAMES.length; mask += 1) {
      const set = new Set(NAMES.filter((_name, index) => (mask & (1 << index)) !== 0));
      expect(popupRefusal(factsOf(set)), [...set].join('+') || '(none)').toBe(expected(set));
      checked += 1;
    }
    expect(checked).toBe(512);
  });
});
