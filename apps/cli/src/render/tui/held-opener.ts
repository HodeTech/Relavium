/**
 * The key that OPENED a native flow, still held down ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3; MVP-11 unit 7, round 2: security F2). `r` on a History run's detail (and on a Defined row) opens the launch form, and a person who keeps
 * the key down while it opens sends the form its auto-repeats: the first field would be typed `rrrrrrr…` (a masked one with as many bullets, which
 * nobody can read back). Nothing started (the start is the form's own `Ctrl+Y`, past its guards), but the field was the person's to fill, not the
 * key's.
 *
 * **The rule.** Only the key that opened the flow (a plain character, recorded by the surface that took it, see {@link OpenerKey}) is judged, and
 * only while the flow's first keys arrive:
 *
 * - the FIRST arrival of that character after the open, within {@link OPENER_FIRST_REPEAT_MAX_MS} of it, is a CANDIDATE: it may be the person's
 *   own first letter or the first auto-repeat of the held key, and nothing about one key tells the two apart (a held key repeats only after its
 *   initial delay: 250 ms to 1.8 s by the terminal's settings, far past any gap between two repeats), so it is typed;
 * - a SECOND arrival of that character within {@link OPENER_CHAIN_GAP_MS} of the one before is a chain: no person types one letter twice that fast
 *   at the start of a field, a held key does at every rate a keyboard has (30 to 100 ms). The chain is dropped as long as it lasts, and the
 *   candidate that was typed is taken back ({@link OpenerVerdict} `retract`), so the field is empty again;
 * - a chunk of that character twice or more in ONE read, and a repeat a terminal reports as one (`eventType: 'repeat'`), are a chain at once;
 * - any other key, a gap of {@link OPENER_CHAIN_GAP_MS} or more, a paste, or a first arrival later than the bound ends the rule: the key after
 *   that types as any other.
 *
 * **What it costs, said plainly.** A deliberate single `r` typed after a pause still types (a candidate that no second `r` follows within 150 ms
 * stays), and so do two `r`s a person types more than 150 ms apart. The one thing lost is a field that begins with the opener's own character
 * twice in under 150 ms, within two seconds of the form opening (`rr…` typed in a burst). The candidate is typed for as long as it takes the second
 * repeat to arrive (33 to 100 ms at the rates a keyboard has), so a held key's field shows one character (a masked field one bullet) for that
 * moment before it is emptied. The rule and its cost are the same for a text field and a masked one: the machine never reads which it is.
 *
 * Pure: the clock is the caller's (`at`), the field is the caller's (the channel takes the candidate back, from a text or a masked field alike,
 * and republishes what the field shows). No import: it is a data module
 * ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §10).
 */

/** The plain key that opened a flow, and when (the channel's clock): left on the Home's shared key history by the surface that took it. */
export interface OpenerKey {
  readonly input: string;
  readonly at: number;
}

/** The two keys, or two reads of one, that are a held key's repeats rather than a person's typing: closer together than this. 150 ms. */
export const OPENER_CHAIN_GAP_MS = 150;

/**
 * How long after the open the first arrival of the opener's character may still be a held key's first repeat: the longest initial delay a
 * keyboard setting offers is 1.8 s, and the form's own first paint comes after the key. Two seconds.
 */
export const OPENER_FIRST_REPEAT_MAX_MS = 2_000;

/**
 * What to do with a key of the flow's first moments: `type` it as any other key, `drop` it (it is a held key's repeat), or `retract` (it
 * is the second of a chain: drop it AND take back the one character the first of the chain typed, if it is still the whole field).
 */
export type OpenerVerdict = 'type' | 'drop' | 'retract';

/** The fields of a key this rule reads: an Ink key reaches it as is. */
export interface OpenerKeyEvent {
  readonly ctrl?: boolean | undefined;
  readonly meta?: boolean | undefined;
  readonly eventType?: 'press' | 'repeat' | 'release' | undefined;
}

export interface HeldOpener {
  /** The character that opened the flow, or `undefined` when no key did (or the rule is over). */
  readonly character: () => string | undefined;
  /** One key that reached the flow, at `at` on the clock the opener was recorded on. Call it for every key, typed or dropped. */
  readonly observe: (input: string, key: OpenerKeyEvent | undefined, at: number) => OpenerVerdict;
  /** Something that is not the opener's repeat happened (a paste): the rule is over. */
  readonly end: () => void;
}

/** Whether `input` is the character `character` and nothing else, once or repeated (a read that coalesced a held key's repeats). */
function isOnly(input: string, character: string): boolean {
  if (input.length === 0) return false;
  for (const next of input) if (next !== character) return false;
  return true;
}

/** The rule for the flow `opener` opened; with no opener (a flow no key opened) every key is typed. */
export function createHeldOpener(opener: OpenerKey | undefined): HeldOpener {
  let stage: 'waiting' | 'candidate' | 'chain' | 'over' = opener === undefined ? 'over' : 'waiting';
  let last = Number.NEGATIVE_INFINITY;
  return {
    character: () => (stage === 'over' ? undefined : opener?.input),
    end: () => {
      stage = 'over';
    },
    observe: (input, key, at) => {
      if (opener === undefined || stage === 'over') return 'type';
      const same = key?.ctrl !== true && key?.meta !== true && isOnly(input, opener.input);
      if (!same) {
        stage = 'over';
        return 'type';
      }
      const reported = key?.eventType === 'repeat';
      const burst = Array.from(input).length >= 2;
      if (stage === 'waiting') {
        if (at - opener.at > OPENER_FIRST_REPEAT_MAX_MS) {
          stage = 'over';
          return 'type';
        }
        last = at;
        if (reported || burst) {
          stage = 'chain';
          return 'drop';
        }
        stage = 'candidate';
        return 'type';
      }
      const continues = at - last < OPENER_CHAIN_GAP_MS;
      last = at;
      if (!continues && !reported && !burst) {
        stage = 'over';
        return 'type';
      }
      const was = stage;
      stage = 'chain';
      return was === 'candidate' ? 'retract' : 'drop';
    },
  };
}
