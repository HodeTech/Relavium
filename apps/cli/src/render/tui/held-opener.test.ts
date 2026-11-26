/**
 * The key that opened a native flow, still held down (MVP-11 unit 7, round 2: security F2). The rule is a pure machine over the key's character, its
 * arrival time and the moment the flow opened, so the grid of initial delays and repeat rates runs here without a channel: what a held `r` is
 * judged as at each of its arrivals, and what a person's own `r` is judged as instead.
 */
import { describe, expect, it } from 'vitest';

import {
  OPENER_CHAIN_GAP_MS,
  OPENER_FIRST_REPEAT_MAX_MS,
  createHeldOpener,
  type OpenerKey,
  type OpenerVerdict,
} from './held-opener.js';

const OPENED_AT = 10_000;
const R: OpenerKey = { input: 'r', at: OPENED_AT };
const INITIAL_DELAYS_MS = [0, 250, 500, 660, 1_800] as const;
const REPEAT_INTERVALS_MS = [30, 100] as const;
/** How long a key stays down after its first repeat. */
const HOLD_MS = 4_000;

/** The verdicts a held `r` is judged as, arrival by arrival: first repeat after `initial`, then every `every`. */
function held(initial: number, every: number): readonly OpenerVerdict[] {
  const rule = createHeldOpener(R);
  const verdicts: OpenerVerdict[] = [];
  for (let at = OPENED_AT + initial; at <= OPENED_AT + initial + HOLD_MS; at += every)
    verdicts.push(rule.observe('r', {}, at));
  return verdicts;
}

describe('a key held down through the open is a chain: the first repeat is typed, the second takes it back, the rest are dropped', () => {
  for (const initial of INITIAL_DELAYS_MS)
    for (const every of REPEAT_INTERVALS_MS)
      it(`first repeat after ${String(initial)} ms, then every ${String(every)} ms`, () => {
        const verdicts = held(initial, every);
        expect(verdicts.length).toBeGreaterThan(30);
        expect(verdicts[0], 'one key cannot be told from a person’s own').toBe('type');
        expect(verdicts[1], 'the second repeat shows the key is held').toBe('retract');
        expect(verdicts.slice(2).every((verdict) => verdict === 'drop')).toBe(true);
        // What the field holds at the end: the candidate typed once, taken back once, and nothing typed after.
        expect(verdicts.filter((verdict) => verdict === 'type')).toHaveLength(1);
        expect(verdicts.filter((verdict) => verdict === 'retract')).toHaveLength(1);
      });

  it('a repeat that comes in the same instant as the key (a read that coalesced them) is a chain too', () => {
    const rule = createHeldOpener(R);
    expect(rule.observe('r', {}, OPENED_AT)).toBe('type');
    expect(rule.observe('r', {}, OPENED_AT)).toBe('retract');
    expect(rule.observe('r', {}, OPENED_AT + 33)).toBe('drop');
  });
});

describe('a person’s own `r` types', () => {
  it('a single `r` after any pause is typed, and so is whatever follows', () => {
    for (const pause of [0, 100, 300, 700, 1_500, OPENER_FIRST_REPEAT_MAX_MS]) {
      const rule = createHeldOpener(R);
      expect(rule.observe('r', {}, OPENED_AT + pause), String(pause)).toBe('type');
      expect(rule.observe('x', {}, OPENED_AT + pause + 200), 'the next key ends the rule').toBe(
        'type',
      );
      expect(rule.observe('r', {}, OPENED_AT + pause + 230), 'and it stays ended').toBe('type');
      expect(rule.character()).toBeUndefined();
    }
  });

  it('two `r`s at least 150 ms apart are two letters', () => {
    const rule = createHeldOpener(R);
    expect(rule.observe('r', {}, OPENED_AT + 400)).toBe('type');
    expect(rule.observe('r', {}, OPENED_AT + 400 + OPENER_CHAIN_GAP_MS)).toBe('type');
    expect(rule.observe('r', {}, OPENED_AT + 400 + OPENER_CHAIN_GAP_MS + 10)).toBe('type');
  });

  it('the first `r` later than the bound is a letter, and a chain that has ended does not begin again', () => {
    const late = createHeldOpener(R);
    expect(late.observe('r', {}, OPENED_AT + OPENER_FIRST_REPEAT_MAX_MS + 1)).toBe('type');
    expect(late.observe('r', {}, OPENED_AT + OPENER_FIRST_REPEAT_MAX_MS + 31)).toBe('type');
    const broken = createHeldOpener(R);
    broken.observe('r', {}, OPENED_AT + 500);
    broken.observe('r', {}, OPENED_AT + 530); // the chain
    expect(broken.observe('r', {}, OPENED_AT + 530 + OPENER_CHAIN_GAP_MS)).toBe('type');
    expect(broken.observe('r', {}, OPENED_AT + 530 + OPENER_CHAIN_GAP_MS + 30)).toBe('type');
  });

  it('a different key first ends the rule: the key held after it is the person’s typing', () => {
    const rule = createHeldOpener(R);
    expect(rule.observe('x', {}, OPENED_AT + 300)).toBe('type');
    for (let n = 0; n < 5; n += 1)
      expect(rule.observe('r', {}, OPENED_AT + 400 + n * 30)).toBe('type');
  });

  it('a chord, a key with Ctrl or Alt, is not the opener’s repeat', () => {
    for (const key of [{ ctrl: true }, { meta: true }]) {
      const rule = createHeldOpener(R);
      expect(rule.observe('r', key, OPENED_AT + 300)).toBe('type');
      expect(rule.observe('r', {}, OPENED_AT + 330), 'the rule ended at the chord').toBe('type');
    }
  });

  it('a flow no key opened types every key', () => {
    const rule = createHeldOpener(undefined);
    expect(rule.character()).toBeUndefined();
    for (let n = 0; n < 6; n += 1) expect(rule.observe('r', {}, OPENED_AT + n * 10)).toBe('type');
  });

  it('a paste ends the rule', () => {
    const rule = createHeldOpener(R);
    rule.end();
    expect(rule.observe('r', {}, OPENED_AT + 500)).toBe('type');
    expect(rule.observe('r', {}, OPENED_AT + 530)).toBe('type');
  });
});

describe('a terminal that says what a key is, and a read that holds several', () => {
  it('a repeat the terminal reports is dropped at once, with nothing typed before it to take back', () => {
    const rule = createHeldOpener(R);
    expect(rule.observe('r', { eventType: 'repeat' }, OPENED_AT + 500)).toBe('drop');
    expect(rule.observe('r', { eventType: 'repeat' }, OPENED_AT + 533)).toBe('drop');
  });

  it('a read of the opener’s character twice or more is a chain at once, however it was split', () => {
    const rule = createHeldOpener(R);
    expect(rule.observe('rrrr', {}, OPENED_AT + 700)).toBe('drop');
    expect(rule.observe('r', {}, OPENED_AT + 733)).toBe('drop');
    const mixed = createHeldOpener(R);
    expect(
      mixed.observe('rrx', {}, OPENED_AT + 700),
      'a read that holds another key is typing',
    ).toBe('type');
  });

  it('a read of another character is not the opener’s, and an empty read is none', () => {
    const rule = createHeldOpener(R);
    expect(rule.observe('', {}, OPENED_AT + 100)).toBe('type');
    expect(rule.character(), 'an empty read ends the rule: it is not the key').toBeUndefined();
  });
});
