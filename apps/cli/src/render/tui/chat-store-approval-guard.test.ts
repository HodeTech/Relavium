/**
 * The approval card counts only a key the person AIMED at it (PR #99 security sittings E1 and the corrective sitting G1).
 * Every key that ANSWERS a card is a Ctrl chord — Ctrl+Y allows once, Ctrl+G asks for the session-wide grant, Ctrl+N denies,
 * Ctrl+R opens the reason box — and a bare letter answers nothing: it is a FOREIGN key, evidence of typing. An affirmative
 * chord (Ctrl+Y, Ctrl+G) still needs, together: the card on screen for APPROVAL_SETTLE_MS since its acknowledged frame, the
 * previous key of any kind at least APPROVAL_QUIET_MS old, no FOREIGN key (a key the card has no use for) in the last
 * APPROVAL_TYPEAHEAD_MS, and no card resolved by a key in the last APPROVAL_LOCKOUT_MS. The session-wide Ctrl+G is a two-step
 * answer: the first Ctrl+G asks, and only ENTER — no other key between, 800 ms to 5 s later — grants (PR #99 security sitting
 * H1: a second Ctrl+G is the same key twice or held, so it can never be the confirmation). Deny and navigation stay
 * immediate.
 *
 * The clock is the only thing faked, and it is the MONOTONIC one (`performance.now()`, G3): `vi.advanceTimersByTime` moves
 * it, `vi.setSystemTime` steps only the wall clock, so each case reads like the timeline it reproduces and a wall-clock step
 * can be shown to change nothing.
 */
import type { AskUserRequest, ToolApprovalRequest, ToolPreview } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChatStore, type ChatStoreController } from './chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import {
  toolReviewPage,
  APPROVAL_CONFIRM_MAX_MS,
  APPROVAL_CONFIRM_MIN_MS,
  APPROVAL_LOCKOUT_MS,
  APPROVAL_QUIET_MS,
  APPROVAL_SETTLE_MS,
  APPROVAL_TYPEAHEAD_MS,
  DEFAULT_APPROVAL_GUARD,
  type ApprovalGuard,
} from './tool-review-model.js';
import { CARD_ENTER_NOTE, CARD_LOCKOUT_NOTE, CARD_TYPEAHEAD_NOTE } from './tool-review-card.js';
import { editedFilePreview } from './fixtures/edit-diff.js';

const START = Date.parse('2026-11-17T10:00:00.000Z');
/** Where the current case's timeline begins on the monotonic clock. */
let origin = 0;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance'] });
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});
/** Move the (monotonic) clock to `ms` after the start of the case. It only ever moves forward. */
const at = (ms: number): void => {
  const delta = origin + ms - performance.now();
  if (delta < -1e-6) throw new Error(`the case's clock cannot run backwards (${delta} ms)`);
  vi.advanceTimersByTime(Math.max(0, delta));
};

const REQUEST: ToolApprovalRequest = {
  toolId: 'edit_file',
  action: 'fs_write',
  preview: { path: 'src/app.ts' },
  unredactedPreview: { path: 'src/app.ts' },
};
const SMALL: ToolPreview = editedFilePreview(8, { 4: 'four' });
/** A change the 80x24 card cannot draw whole: no Ctrl+G is offered for it. */
const CLIPPED: ToolPreview = editedFilePreview(100, { 5: 'five', 90: 'ninety' });

/** Every layer off: a case switches on only the one it isolates. */
const OFF: Required<ApprovalGuard> = {
  settleMs: 0,
  quietMs: 0,
  typeaheadMs: 0,
  lockoutMs: 0,
  confirmAlways: false,
};
/** The letters of the approval card's answer chords: Ctrl+Y allows once, Ctrl+G asks for the session-wide grant, Ctrl+N denies, Ctrl+R denies with a reason. */
type Chord = 'y' | 'g' | 'n' | 'r';
type Rig = {
  readonly store: ChatStoreController;
  /** Whether the pending approval was answered, and how. */
  readonly answers: unknown[];
  /** Open a card (the engine asked): the person has not seen it yet. */
  open: (callId: string, preview?: ToolPreview) => void;
  /** The host flushed the frame of the card that is current now (an acknowledged frame). */
  show: () => void;
  key: (input: string, key?: Parameters<ChatStoreController['handleReviewInput']>[1]) => string;
  /** An answer key: Ctrl+`letter` (Y allow once, G ask for the session-wide grant, N deny, R deny with a reason). */
  chord: (letter: Chord) => string;
  pending: () => boolean;
  /** The card's current note (`review.message`), `''` when none. */
  note: () => string;
};

/**
 * A store wired the way the host wires it: the review is visible exactly while the current review has been shown. With no
 * argument the guard is the product's real one; with layers named, those layers are on and every other one is off.
 */
function rig(layers?: Partial<ApprovalGuard>, exact?: ApprovalGuard): Rig {
  origin = performance.now(); // every rig starts its own timeline
  const approvalGuard = exact ?? (layers === undefined ? undefined : { ...OFF, ...layers });
  const store = createChatStore(
    false,
    undefined,
    INLINE_TRANSCRIPT_BOUND,
    approvalGuard === undefined ? undefined : { approvalGuard },
  );
  let shown: unknown;
  store.bindReviewVisibility(() => shown !== undefined && store.getSnapshot().review === shown);
  const answers: unknown[] = [];
  return {
    store,
    answers,
    open: (callId, preview = SMALL) => {
      void store
        .requestApproval(REQUEST, true, undefined, { callId, preview })
        .then((answer) => answers.push(answer));
    },
    show: () => {
      const review = store.getSnapshot().review;
      if (review === undefined) return;
      shown = review;
      store.acknowledgeReviewFrame(review, toolReviewPage(review, 80, 24));
    },
    key: (input, key = {}) => String(store.handleReviewInput(input, key)),
    chord: (letter) => String(store.handleReviewInput(letter, { ctrl: true })),
    pending: () => store.getSnapshot().approval !== undefined,
    note: () => store.getSnapshot().review?.message ?? '',
  };
}

const settled = async (r: Rig): Promise<unknown[]> => {
  await Promise.resolve();
  return r.answers;
};
const approvals = (answers: readonly unknown[]): { outcome: string; scope?: string }[] =>
  answers.filter((a): a is { outcome: string; scope?: string } => {
    return (
      typeof a === 'object' && a !== null && (a as { outcome?: unknown }).outcome === 'approve'
    );
  });

describe('the real defaults', () => {
  it('are named, exported numbers', () => {
    expect(APPROVAL_SETTLE_MS).toBe(400);
    expect(APPROVAL_QUIET_MS).toBe(300);
    expect(APPROVAL_TYPEAHEAD_MS).toBe(1500);
    expect(APPROVAL_LOCKOUT_MS).toBe(2000);
    expect(APPROVAL_CONFIRM_MIN_MS).toBe(800);
    expect(APPROVAL_CONFIRM_MAX_MS).toBe(5000);
    expect(DEFAULT_APPROVAL_GUARD).toEqual({
      settleMs: 400,
      quietMs: 300,
      typeaheadMs: 1500,
      lockoutMs: 2000,
      confirmAlways: true,
    });
  });

  it('keep the new layers on when a caller names only the two original ones', () => {
    // `chat-app.test.tsx` passes `{ settleMs: 0, quietMs: 0 }`: the layers it does not name must stay the product's own.
    const r = rig(undefined, { settleMs: 0, quietMs: 0 });
    expect(r.store.handleReviewInput('x', {})).toBeUndefined(); // typed while no card exists
    r.open('card');
    r.show();
    at(100);
    r.chord('y');
    expect(r.pending(), 'the typeahead layer is still on').toBe(true);
    r.show();
    at(100 + APPROVAL_TYPEAHEAD_MS);
    r.chord('y');
    expect(r.pending(), 'and it releases after its window').toBe(false);
  });
});

describe('a key typed ahead cannot approve (E1: type-ahead)', () => {
  // The person types their next instruction at ~80 ms per key while the turn runs; the model's write card opens after the
  // first keys and its frame is acknowledged at once — the worst case. The reported sequences both reached `always`
  // by key #3.
  it.each([
    'please also add tests',
    'great, thanks',
    'okay, yes please',
    'yay! try again maybe',
    'also add tests',
  ])('never approves the card while %j is typed at 80 ms per key', async (text) => {
    const r = rig();
    for (const [index, char] of [...text].entries()) {
      at(index * 80);
      if (index === 2) {
        r.open('card');
        r.show();
      }
      r.key(char);
      r.show();
      // A bare `n` is no deny any more (Ctrl+N is): every key of the sentence leaves the card pending.
      // No card exists for the first two keys (the composer owns them); from the third on it must stay pending.
      expect(r.pending(), `key #${index} '${char}' must not answer the card`).toBe(index >= 2);
    }
    expect(approvals(await settled(r)), 'nothing was approved').toEqual([]);
  });

  it('consumes the refused key: it is handled, so it can never become composer text', () => {
    const r = rig();
    r.open('card');
    r.show();
    at(10);
    const before = r.store.getSnapshot().review;
    expect(r.chord('y')).toBe('handled');
    expect(
      r.store.getSnapshot().review,
      'a key refused only because the card is new changes nothing',
    ).toBe(before);
    expect(r.chord('g')).toBe('handled');
    expect(r.pending()).toBe(true);
    expect(r.answers).toEqual([]);
  });
});

/** A seeded generator (the reviewer's probes use the same one), so every sequence below is reproducible. */
const lcg = (seed: number): (() => number) => {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
};
/** A log-normal-ish gap around `mean` (sd about 40 %), never below 40 ms. */
const gap = (rnd: () => number, mean: number): number => {
  const u1 = Math.max(1e-9, rnd());
  const u2 = rnd();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(40, Math.round(mean * Math.exp(0.4 * z - 0.08)));
};
/**
 * What the card itself uses as a BARE key — navigation and the full view's own keys: any other key typed is, by the oracle's
 * own reckoning, typing. The answers are Ctrl chords, so a bare `y`, `a` or `n` is typing too.
 */
const CARD_KEYS = new Set(['v', 'b', 'r', 'p', 'c', '/']);

interface Trial {
  readonly text: string;
  readonly index: number;
  readonly char: string;
  readonly answer: { outcome: string; scope?: string } | undefined;
  /** How long before the resolving key the oracle's last foreign key was. */
  readonly sinceForeignMs: number;
  /** Whether the always question was raised while a foreign key was fresh. */
  readonly raisedInsideWindow: boolean;
}
/** Type `text` into a store whose card opens at key `openAt` (acknowledged at once), with `gapAfter(i)` ms after key `i`. */
async function typeAhead(
  text: string,
  openAt: number,
  gapAfter: (index: number) => number,
): Promise<Trial> {
  const r = rig();
  let t = 0;
  let lastForeignAt = Number.NEGATIVE_INFINITY;
  let wasRaised = false;
  let raisedInsideWindow = false;
  for (const [index, char] of [...text].entries()) {
    at(t);
    if (index === openAt) {
      r.open('card');
      r.show();
    }
    const cardOpen = index >= openAt;
    const sinceForeign = t - lastForeignAt;
    r.key(char);
    r.show(); // the host acknowledges any new review object
    const raised = r.store.getSnapshot().alwaysConfirm === true;
    if (raised && !wasRaised && sinceForeign < APPROVAL_TYPEAHEAD_MS) raisedInsideWindow = true;
    wasRaised = raised;
    if (cardOpen && !r.pending()) {
      const answer = approvals(await settled(r))[0];
      return { text, index, char, answer, sinceForeignMs: sinceForeign, raisedInsideWindow };
    }
    if (!cardOpen || !CARD_KEYS.has(char)) lastForeignAt = t;
    t += gapAfter(index);
  }
  return {
    text,
    index: -1,
    char: '',
    answer: undefined,
    sinceForeignMs: 0,
    raisedInsideWindow,
  };
}

const SENTENCES = [
  'please also add tests',
  'yes please do that also',
  'try it again maybe',
  'okay, yes please',
  'great, thanks',
  'also fix the typo in the header',
  'and add a changelog entry',
  'looks good, now do the same for the api',
  'what about the other file',
  'fix it also add tests',
  'yay! try again maybe',
  'make sure it works on windows too',
];

describe('typing never answers the card (G1)', () => {
  // The reviewer's measurement on the unfixed code: 9/24 approvals (all session-wide `a`) at a 300 ms mean gap, 2/24 at 200.
  it.each([300, 200, 130])(
    'at a %i ms mean gap: never approves always, never approves inside a typing window, never even asks',
    async (mean) => {
      const failures: string[] = [];
      for (const text of SENTENCES) {
        for (const seed of [1, 2, 3, 4, 5, 6]) {
          const rnd = lcg(seed * 7919 + mean);
          const openAt = Math.floor(rnd() * Math.min(6, text.length));
          const trial = await typeAhead(text, openAt, () => gap(rnd, mean));
          const where = `${JSON.stringify(text)} seed ${seed} open@${openAt}`;
          // Typed text is only bare keys, and a bare key answers nothing: not even a deny (`n`) or a reason box (`c`).
          if (trial.index !== -1)
            failures.push(`${where}: the card was resolved by '${trial.char}' #${trial.index}`);
          if (trial.answer?.scope === 'always')
            failures.push(`${where}: approved ALWAYS by '${trial.char}'`);
          else if (trial.answer !== undefined && trial.sinceForeignMs < APPROVAL_TYPEAHEAD_MS)
            failures.push(
              `${where}: approved by '${trial.char}' #${trial.index} ${trial.sinceForeignMs} ms after a foreign key`,
            );
          if (trial.raisedInsideWindow)
            failures.push(`${where}: asked "press Ctrl+G again" while a foreign key was fresh`);
        }
      }
      expect(failures).toEqual([]);
    },
  );

  it('the reviewer reproductions: "fix it also add tests" (120 ms, 450 ms pause) and "please also add tests" (mean 300)', async () => {
    // typing.mts "fix it also add tests" 120 1 6 450 — the card opens at key #1; `a` of "also" arrives after the pause.
    const paused = await typeAhead('fix it also add tests', 1, (index) =>
      index === 6 ? 450 : 120,
    );
    expect(paused.answer, 'no approval').toBeUndefined();
    expect(paused.raisedInsideWindow).toBe(false);
    // typing-cmd.mts "please also add tests" mean:300 1 -1 0 1
    const rnd = lcg(1);
    const cmd = await typeAhead('please also add tests', 1, () => gap(rnd, 300));
    expect(cmd.answer, 'no approval').toBeUndefined();
    expect(cmd.raisedInsideWindow).toBe(false);
  });

  it('refuses a Ctrl+Y pressed right after another key even when the quiet gap and the dwell are long past', () => {
    // Only the typeahead layer is on: 'k' (foreign) at 600, Ctrl+Y at 1000 — 400 ms later, dwell and quiet gap both long met.
    const r = rig({ typeaheadMs: APPROVAL_TYPEAHEAD_MS });
    r.open('card');
    r.show();
    at(600);
    r.key('k');
    at(1000);
    r.chord('y');
    expect(r.pending()).toBe(true);
    at(600 + APPROVAL_TYPEAHEAD_MS - 1);
    r.chord('y');
    expect(r.pending(), '1499 ms after the foreign key is not enough').toBe(true);
  });

  it('counts the typeahead window to the millisecond', () => {
    const exact = rig({ typeaheadMs: APPROVAL_TYPEAHEAD_MS });
    exact.open('card');
    exact.show();
    at(100);
    exact.key('k');
    at(100 + APPROVAL_TYPEAHEAD_MS);
    exact.chord('y');
    expect(exact.pending(), '1500 ms after the foreign key is').toBe(false);
  });

  it('lets a deliberate Ctrl+Y approve once the person has stopped typing for the whole window', async () => {
    const r = rig();
    // Typing, then a pause: the next instruction was typed while the card was on screen.
    for (const [index, char] of [...'okay go'].entries()) {
      at(index * 120);
      if (index === 1) {
        r.open('card');
        r.show();
      }
      r.key(char);
      r.show();
    }
    expect(r.pending()).toBe(true);
    at(6 * 120 + APPROVAL_TYPEAHEAD_MS - 1);
    r.chord('y');
    expect(r.pending(), 'still inside the window').toBe(true);
    r.show(); // the refusal note replaced the review; the host acknowledges the new frame
    at(6 * 120 + APPROVAL_TYPEAHEAD_MS + 1000);
    r.chord('y');
    expect(await settled(r)).toEqual([{ outcome: 'approve', scope: 'once' }]);
  });

  describe('what counts as a foreign key', () => {
    it('is every key typed while no card exists (the composer drops them: that is typing ahead)', () => {
      const r = rig({ typeaheadMs: APPROVAL_TYPEAHEAD_MS });
      expect(r.store.handleReviewInput('x', {})).toBeUndefined();
      at(50);
      r.open('card');
      r.show();
      at(1000);
      r.chord('y');
      expect(r.pending(), 'a key typed before the card existed').toBe(true);
    });

    it('is every key the card has no use for', () => {
      const r = rig({ typeaheadMs: APPROVAL_TYPEAHEAD_MS });
      r.open('card');
      r.show();
      at(100);
      expect(r.key('x')).toBe('handled');
      at(1000);
      r.chord('y');
      expect(r.pending()).toBe(true);
    });

    it('is not a key the card acts on: [v] and [b] navigate, and Ctrl+Y is then answered', () => {
      const r = rig({ typeaheadMs: APPROVAL_TYPEAHEAD_MS });
      r.open('card');
      r.show();
      at(100);
      r.key('v');
      r.show();
      at(200);
      r.key('b');
      r.show();
      at(300);
      r.chord('y');
      expect(r.pending(), 'navigation is not typing').toBe(false);
    });

    it('is not an affirmative key the guard itself refused (a person who pressed Ctrl+Y early may press it again)', () => {
      const r = rig({ typeaheadMs: APPROVAL_TYPEAHEAD_MS });
      r.open('card');
      r.show();
      at(100);
      r.key('k'); // foreign
      at(1000);
      r.chord('y'); // refused; the note replaces the review, so the frame is not yet acknowledged again
      expect(r.pending()).toBe(true);
      at(1100);
      r.chord('y'); // the card cannot act on it yet (not visible): still the person's own answer key, never typing
      expect(r.pending()).toBe(true);
      r.show();
      // Had either refused Ctrl+Y been recorded as typing, this key (about half a second after them) would still be refused.
      at(100 + APPROVAL_TYPEAHEAD_MS + 1);
      r.chord('y');
      expect(r.pending(), 'a refused Ctrl+Y is not typing').toBe(false);
    });

    it('is not an answer key the card could not use: Ctrl+G on a change it cannot show whole is the answer key, not typing', () => {
      const r = rig({ typeaheadMs: APPROVAL_TYPEAHEAD_MS });
      r.open('card', CLIPPED); // no Ctrl+G is offered, so the card maps it to nothing
      r.show();
      at(600);
      r.chord('g');
      expect(r.pending()).toBe(true);
      at(600 + 1000);
      r.chord('y');
      expect(r.pending(), 'the Ctrl+G was not typing, so Ctrl+Y 1000 ms later is the answer').toBe(
        false,
      );
    });

    // PR #99 security sitting H3: text typed into a text field is typing, whatever the card is doing with it.
    it('is text typed into the reason box, and the Enter that submits it (H3)', () => {
      const answered = (): Rig => {
        const r = rig({ typeaheadMs: APPROVAL_TYPEAHEAD_MS });
        r.open('A');
        r.show();
        at(100);
        r.chord('r'); // Ctrl+R opens the box: the card in use, not typing
        r.show();
        for (let i = 0; i < 3; i++) {
          at(200 + i * 100);
          r.key('q');
          r.show();
        }
        expect(r.store.getSnapshot().review?.denial).toBe('qqq');
        at(500);
        r.key('', { return: true }); // Enter denies and continues
        expect(r.pending()).toBe(false);
        at(505);
        r.open('B');
        r.show();
        return r;
      };
      const refused = answered();
      at(500 + 1000);
      refused.chord('y');
      expect(refused.pending(), 'a Ctrl+Y 1000 ms after the Enter that submitted a reason').toBe(
        true,
      );
      const accepted = answered();
      at(500 + APPROVAL_TYPEAHEAD_MS);
      accepted.chord('y');
      expect(accepted.pending(), 'a Ctrl+Y once the typing window is over').toBe(false);
    });
  });
});

describe('a double tap or a held key cannot approve the next card (E1: carry-over, G1)', () => {
  const approveFirst = (r: Rig): void => {
    r.open('A');
    r.show();
    at(600); // the person reads A
    expect(r.chord('y')).toBe('handled');
    expect(r.pending(), 'a deliberate Ctrl+Y approves A').toBe(false);
  };

  it.each([100, 200, 300, 400, 500, 650])(
    'leaves card B pending for a second Ctrl+Y %i ms after the first (B opened 55 ms after A)',
    (gapMs) => {
      const r = rig();
      approveFirst(r);
      at(655);
      r.open('B');
      r.show();
      at(600 + gapMs);
      r.chord('y');
      expect(r.pending(), `B has been on screen ${gapMs - 55} ms`).toBe(true);
    },
  );

  it.each([15, 45, 90])(
    'leaves card B pending for the whole time a key is held at a %i ms repeat',
    (interval) => {
      const r = rig();
      approveFirst(r);
      at(605);
      r.open('B');
      r.show();
      // Far longer than the dwell: only the quiet gap and the lockout stand between the repeat and the approval.
      let last = 600;
      for (let time = 600 + interval; time <= 600 + 2500; time += interval) {
        at(time);
        r.chord('y');
        r.show();
        last = time;
        expect(r.pending(), `repeat at +${time - 600} ms`).toBe(true);
      }
      // The lockout restarts with every refused repeat (H2), so the release is what ends it: the whole window after the last one.
      at(last + APPROVAL_LOCKOUT_MS);
      r.chord('y');
      expect(
        r.pending(),
        'a fresh, deliberate Ctrl+Y a whole lockout after the release answers B',
      ).toBe(false);
    },
  );

  // held.mts <initialDelay> <interval> <engineMs>: the reviewer measured B approved 472 ms after it appeared at 500/33/30.
  it.each([
    [225, 33, 30],
    [375, 33, 30],
    [500, 33, 30],
    [660, 40, 150],
    [1000, 30, 5],
    [1020, 30, 5],
    [1410, 30, 5],
    [1800, 30, 5],
  ])(
    'leaves card B pending when the OS repeats after an initial delay of %i ms (every %i ms, B opens %i ms after A)',
    (initial, interval, engine) => {
      const r = rig();
      approveFirst(r);
      at(600 + engine);
      r.open('B');
      r.show();
      at(600 + initial);
      for (let time = 600 + initial; time <= 600 + initial + 3000; time += interval) {
        at(time);
        r.chord('y');
        r.show();
        expect(r.pending(), `repeat at +${time - 600} ms`).toBe(true);
      }
    },
  );

  describe('the lockout stands on its own', () => {
    const lockoutOnly = { lockoutMs: APPROVAL_LOCKOUT_MS };
    /** Card A resolved by the chord `resolvingKey` (Ctrl+Y or Ctrl+N) at 100 ms; card B opened and shown at 150 ms. */
    const afterAnswer = (resolvingKey: 'y' | 'n'): Rig => {
      const r = rig(lockoutOnly);
      r.open('A');
      r.show();
      at(100);
      r.chord(resolvingKey);
      expect(r.pending()).toBe(false);
      at(150);
      r.open('B');
      r.show();
      return r;
    };
    it.each([
      ['an approval', 'y'],
      ['a denial', 'n'],
    ] as const)(
      'after %s by key, an affirmative key is refused until the window ends',
      (_label, resolvingKey) => {
        const refused = afterAnswer(resolvingKey);
        at(100 + APPROVAL_LOCKOUT_MS - 1);
        refused.chord('y');
        expect(refused.pending(), '1999 ms after the answer').toBe(true);
        const accepted = afterAnswer(resolvingKey);
        at(100 + APPROVAL_LOCKOUT_MS);
        accepted.chord('y');
        expect(accepted.pending(), '2000 ms after it').toBe(false);
      },
    );

    it('after a denial WITH a typed reason, an affirmative key is refused until the window ends', () => {
      const answered = (): Rig => {
        const r = rig(lockoutOnly);
        r.open('A');
        r.show();
        at(100);
        r.chord('r');
        r.show();
        at(150);
        r.key('q');
        r.show();
        at(200);
        r.key('', { return: true });
        expect(r.pending(), 'the reason answered A').toBe(false);
        at(250);
        r.open('B');
        r.show();
        return r;
      };
      const refused = answered();
      at(200 + APPROVAL_LOCKOUT_MS - 1);
      refused.chord('y');
      expect(refused.pending()).toBe(true);
      const accepted = answered();
      at(200 + APPROVAL_LOCKOUT_MS);
      accepted.chord('y');
      expect(accepted.pending()).toBe(false);
    });

    // PR #99 security sitting H2: the window counted from the resolving key only, so a held key whose OS repeat interval is
    // 300 ms or more (every repeat after the first falls outside the window) passed the quiet gap and approved the next card.
    describe('a refused affirmative key restarts the window (H2)', () => {
      it('a key pressed 1999 ms after the answer is refused, and so is one 2000 ms after it: the window now counts from the refused key', () => {
        const r = afterAnswer('y');
        at(100 + APPROVAL_LOCKOUT_MS - 1);
        r.chord('y');
        expect(r.pending(), 'refused at 1999 ms').toBe(true);
        r.show(); // the refusal note replaced the review
        at(100 + APPROVAL_LOCKOUT_MS);
        r.chord('y');
        expect(r.pending(), 'refused again at 2000 ms: the window restarted at 1999 ms').toBe(true);
        r.show();
        at(100 + APPROVAL_LOCKOUT_MS + APPROVAL_LOCKOUT_MS);
        r.chord('y');
        expect(r.pending(), 'two seconds after the last refused key it ends').toBe(false);
      });

      it('a Ctrl+G refused by the window restarts it too', () => {
        const r = afterAnswer('y');
        at(1000);
        r.chord('g');
        r.show();
        at(1000 + APPROVAL_LOCKOUT_MS - 1);
        r.chord('y');
        expect(r.pending(), 'the window counts from the refused Ctrl+G').toBe(true);
      });

      it('a repeat that lands on a frame not yet acknowledged restarts it as well', () => {
        const r = afterAnswer('y'); // B is shown at 150 ms
        at(1500);
        r.store.invalidateToolReview(); // B's frame must be flushed again: nothing can answer it until it is
        r.chord('y'); // no answer (not visible), but the held key goes on
        at(1500 + APPROVAL_LOCKOUT_MS - 1);
        r.show();
        r.chord('y');
        expect(r.pending(), 'the unacknowledged repeat let the window restart').toBe(true);
      });

      it('a key that is not affirmative does not restart it', () => {
        const r = afterAnswer('y');
        at(1000);
        r.key('x');
        at(100 + APPROVAL_LOCKOUT_MS);
        r.chord('y');
        expect(r.pending(), 'a foreign key is no repeat of the answering key').toBe(false);
      });

      it('has no effect once the window has ended: a later deliberate press approves', () => {
        const r = afterAnswer('y');
        at(100 + APPROVAL_LOCKOUT_MS);
        r.chord('y');
        expect(r.pending()).toBe(false);
      });

      // held.mts <initial> <interval> <engine> 4000: the reviewer measured B approved 2104 ms after it was shown at 500/400/5.
      it.each([
        [500, 400, 5],
        [1800, 450, 5],
        [1800, 900, 5],
        [375, 1800, 5],
        [1800, 1800, 5],
        [500, 400, 800],
      ])(
        'a key held at an initial delay of %i ms and a repeat interval of %i ms (B opens %i ms after A) never answers B',
        (initial, interval, engine) => {
          const r = rig();
          approveFirst(r);
          const repeats = [600 + initial];
          while ((repeats.at(-1) ?? 0) + interval <= 600 + initial + 4000)
            repeats.push((repeats.at(-1) ?? 0) + interval);
          // B is opened by the engine `engine` ms after A was answered, whatever the held key is doing by then.
          let opened = false;
          const openB = (): void => {
            at(600 + engine);
            r.open('B');
            r.show();
            opened = true;
          };
          for (const time of repeats) {
            if (!opened && time > 600 + engine) openB();
            at(time);
            r.chord('y');
            r.show();
            if (opened)
              expect(r.pending(), `B is still pending after the repeat at +${time - 600} ms`).toBe(
                true,
              );
          }
          if (!opened) openB();
          // ... and a deliberate press two seconds after the last refused repeat does answer it.
          at((repeats.at(-1) ?? 0) + APPROVAL_LOCKOUT_MS);
          r.chord('y');
          expect(r.pending(), 'a press a whole lockout after the last repeat approves').toBe(false);
        },
      );
    });

    it('does not start for a card answered by the host rather than by a key', () => {
      const r = rig(lockoutOnly);
      r.open('A');
      r.show();
      at(100);
      r.store.answerApproval({ outcome: 'reject' });
      at(150);
      r.open('B');
      r.show();
      at(200);
      r.chord('y');
      expect(r.pending(), 'no key resolved A, so nothing is held over').toBe(false);
    });

    it('does not stop Ctrl+N, which grants nothing', () => {
      const r = rig(lockoutOnly);
      r.open('A');
      r.show();
      at(100);
      r.chord('y');
      at(150);
      r.open('B');
      r.show();
      at(200);
      r.chord('n');
      expect(r.pending()).toBe(false);
    });
  });
});

describe('a deliberate answer still works', () => {
  it('approves once on Ctrl+Y after the dwell and the quiet gap', async () => {
    const r = rig();
    r.open('card');
    r.show();
    at(APPROVAL_SETTLE_MS);
    r.chord('y');
    expect(await settled(r)).toEqual([{ outcome: 'approve', scope: 'once' }]);
  });

  it('counts the settle time to the millisecond', () => {
    const early = rig();
    early.open('card');
    early.show();
    at(APPROVAL_SETTLE_MS - 1);
    early.chord('y');
    expect(early.pending(), '399 ms is not enough').toBe(true);
    const exact = rig();
    exact.open('card');
    exact.show();
    at(APPROVAL_SETTLE_MS);
    exact.chord('y');
    expect(exact.pending(), '400 ms is').toBe(false);
  });

  it('counts the quiet gap to the millisecond, for a key the card swallowed too', () => {
    const early = rig({ quietMs: APPROVAL_QUIET_MS });
    early.open('card');
    early.show();
    at(2000);
    expect(early.key('x'), 'a stray key the card does not use').toBe('handled');
    at(2000 + APPROVAL_QUIET_MS - 1);
    early.chord('y');
    expect(early.pending(), '299 ms after a swallowed key is not enough').toBe(true);
    const exact = rig({ quietMs: APPROVAL_QUIET_MS });
    exact.open('card');
    exact.show();
    at(2000);
    exact.key('x');
    at(2000 + APPROVAL_QUIET_MS);
    exact.chord('y');
    expect(exact.pending(), '300 ms is').toBe(false);
  });

  it('lets the very first key of the session approve once the card has settled', () => {
    const r = rig();
    r.open('card');
    r.show();
    at(APPROVAL_SETTLE_MS);
    r.chord('y');
    expect(r.pending(), 'no previous key means an infinite quiet gap').toBe(false);
  });

  it('lets a deliberate Ctrl+Y approve after a foreign key once the typeahead window has passed', async () => {
    const r = rig();
    expect(r.store.handleReviewInput('x', {})).toBeUndefined();
    at(50);
    r.open('card');
    r.show();
    at(APPROVAL_TYPEAHEAD_MS + 1);
    r.chord('y');
    expect(await settled(r)).toEqual([{ outcome: 'approve', scope: 'once' }]);
  });
});

/** Enter, as the host delivers it. */
const ENTER = { return: true } as const;

describe('the session-wide Ctrl+G is asked with Ctrl+G and granted only by Enter (G1, H1)', () => {
  /** The first `Ctrl+G` of the case, at `time` ms after the card opened. */
  const ask = (r: Rig, time = APPROVAL_SETTLE_MS): void => {
    r.open('card');
    r.show();
    at(time);
    r.chord('g');
  };
  const enter = (r: Rig): string => r.key('', ENTER);
  /** Where the first `Ctrl+G` of a default `ask` lands on the case's clock. */
  const ASKED_AT = APPROVAL_SETTLE_MS;

  it('the first Ctrl+G resolves nothing and asks; Enter grants always', async () => {
    const r = rig();
    ask(r);
    expect(r.pending(), 'the first press only asks').toBe(true);
    expect(r.answers).toEqual([]);
    expect(r.store.getSnapshot().alwaysConfirm, 'and the card says so').toBe(true);
    at(ASKED_AT + APPROVAL_CONFIRM_MIN_MS);
    expect(enter(r)).toBe('handled');
    expect(await settled(r)).toEqual([{ outcome: 'approve', scope: 'always' }]);
  });

  it('Ctrl+Y stays one step', async () => {
    const r = rig();
    r.open('card');
    r.show();
    at(APPROVAL_SETTLE_MS);
    r.chord('y');
    expect(await settled(r)).toEqual([{ outcome: 'approve', scope: 'once' }]);
  });

  it.each([800, 1500, 3000, 5000])(
    'an Enter %i ms after the first Ctrl+G grants always',
    async (after) => {
      const r = rig();
      ask(r);
      at(ASKED_AT + after);
      enter(r);
      expect(await settled(r)).toEqual([{ outcome: 'approve', scope: 'always' }]);
    },
  );

  it.each([0, 1, 100, 300, 500, 700, 799])(
    'an Enter only %i ms after the first Ctrl+G does not grant, and ends the question',
    async (after) => {
      // Only the confirm window can refuse here (every other layer is off).
      const r = rig({ confirmAlways: true });
      ask(r);
      at(ASKED_AT + after);
      enter(r);
      expect(r.pending()).toBe(true);
      expect(r.answers).toEqual([]);
      expect(r.store.getSnapshot().alwaysConfirm, 'the prompt is gone').toBe(false);
      // A later Enter finds no question: it never grants either.
      at(ASKED_AT + 2000);
      enter(r);
      expect(await settled(r)).toEqual([]);
      expect(r.pending()).toBe(true);
    },
  );

  it('an Enter that comes too early says nothing was allowed; any other key that ends the question says nothing', () => {
    const early = rig({ confirmAlways: true });
    ask(early);
    at(ASKED_AT + APPROVAL_CONFIRM_MIN_MS - 100);
    enter(early);
    expect(early.note()).toBe(CARD_ENTER_NOTE);
    const other = rig({ confirmAlways: true });
    ask(other);
    at(ASKED_AT + 300);
    other.key('x');
    expect(
      other.note(),
      'a key that is not Enter needs no note: the card already says it cancels',
    ).toBe('');
  });

  it('counts the minimum to the millisecond', async () => {
    const early = rig({ confirmAlways: true });
    ask(early);
    at(ASKED_AT + APPROVAL_CONFIRM_MIN_MS - 1);
    enter(early);
    expect(early.pending(), '799 ms is not enough').toBe(true);
    const exact = rig({ confirmAlways: true });
    ask(exact);
    at(ASKED_AT + APPROVAL_CONFIRM_MIN_MS);
    enter(exact);
    expect(await settled(exact), '800 ms is').toEqual([{ outcome: 'approve', scope: 'always' }]);
  });

  it('an Enter 5 s after the first Ctrl+G still grants; one later does not, and the prompt is gone', async () => {
    const onTime = rig();
    ask(onTime);
    at(ASKED_AT + APPROVAL_CONFIRM_MAX_MS);
    enter(onTime);
    expect(await settled(onTime)).toEqual([{ outcome: 'approve', scope: 'always' }]);

    const late = rig({ confirmAlways: true });
    ask(late);
    at(ASKED_AT + APPROVAL_CONFIRM_MAX_MS + 1);
    enter(late);
    expect(late.pending(), 'an Enter after the window does not grant').toBe(true);
    expect(late.answers).toEqual([]);
    expect(
      late.store.getSnapshot().alwaysConfirm,
      'and the prompt is gone at once, without waiting for another repaint',
    ).toBe(false);
    // The Enter that came too late says nothing was allowed; the host draws that note, and a card is answerable once it is shown.
    expect(late.note()).toBe(CARD_ENTER_NOTE);
    // The press is over: a new first Ctrl+G asks again, and ITS Enter grants.
    late.show();
    at(ASKED_AT + APPROVAL_CONFIRM_MAX_MS + 100);
    late.chord('g');
    expect(late.store.getSnapshot().alwaysConfirm, 'it is a new first press').toBe(true);
    at(ASKED_AT + APPROVAL_CONFIRM_MAX_MS + 100 + APPROVAL_CONFIRM_MIN_MS);
    enter(late);
    expect(await settled(late)).toEqual([{ outcome: 'approve', scope: 'always' }]);
  });

  it('the question lapses on the card after 5 s (the next repaint no longer shows it)', () => {
    const r = rig();
    ask(r);
    expect(r.store.getSnapshot().alwaysConfirm).toBe(true);
    at(ASKED_AT + APPROVAL_CONFIRM_MAX_MS + 1);
    r.store.flush();
    expect(r.store.getSnapshot().alwaysConfirm).toBe(false);
  });

  it('a second Ctrl+G is NOT the confirmation: it cancels the question, however late it comes', async () => {
    for (const after of [APPROVAL_CONFIRM_MIN_MS, 1000, 3000, APPROVAL_CONFIRM_MAX_MS]) {
      const r = rig({ confirmAlways: true });
      ask(r);
      at(ASKED_AT + after);
      r.chord('g');
      expect(r.pending(), `a second Ctrl+G ${after} ms after the first grants nothing`).toBe(true);
      expect(await settled(r)).toEqual([]);
      expect(r.store.getSnapshot().alwaysConfirm, 'and it ends the question').toBe(false);
    }
  });

  it('any other key cancels the question and is then handled normally: a foreign key, then Enter', async () => {
    const r = rig();
    ask(r);
    at(ASKED_AT + 1000);
    r.key('x');
    expect(r.store.getSnapshot().alwaysConfirm, 'x cancelled it').toBe(false);
    at(ASKED_AT + 2000);
    enter(r);
    expect(r.pending(), 'an Enter with no question open grants nothing').toBe(true);
    expect(r.answers).toEqual([]);
    r.show();
    at(ASKED_AT + 2000 + APPROVAL_TYPEAHEAD_MS + 1000);
    r.chord('y');
    expect(await settled(r)).toEqual([{ outcome: 'approve', scope: 'once' }]);
  });

  it.each([
    ['a letter', 'x', {}],
    ['a bare a (it asked nothing, so it is typing)', 'a', {}],
    ['a space', ' ', {}],
    ['an arrow', '', { upArrow: true }],
    ['a tab', '', { tab: true }],
    ['a modified key', 'k', { ctrl: true }],
    ['a held second Ctrl+G', 'g', { ctrl: true }],
  ])('%s between the first Ctrl+G and Enter means Enter grants nothing', async (_n, input, key) => {
    // Only the confirm window is on: nothing but the cancelling key can be what stops the grant.
    const r = rig({ confirmAlways: true });
    ask(r);
    at(ASKED_AT + 100);
    r.key(input, key);
    expect(r.store.getSnapshot().alwaysConfirm, 'the key cancelled the question').toBe(false);
    at(ASKED_AT + 1500);
    enter(r);
    expect(await settled(r)).toEqual([]);
    expect(r.pending()).toBe(true);
  });

  it('Ctrl+G, Ctrl+G, Enter grants nothing: the second Ctrl+G cancelled and the Enter is then only an Enter', async () => {
    const r = rig();
    ask(r);
    at(ASKED_AT + 1000);
    r.chord('g');
    at(ASKED_AT + 2000);
    enter(r);
    expect(await settled(r)).toEqual([]);
    expect(r.pending()).toBe(true);
    expect(r.store.getSnapshot().alwaysConfirm).toBe(false);
  });

  it('Ctrl+Y after the first Ctrl+G cancels the question and approves once', async () => {
    const r = rig();
    ask(r);
    at(ASKED_AT + 1000);
    r.chord('y');
    expect(await settled(r)).toEqual([{ outcome: 'approve', scope: 'once' }]);
  });

  it('Ctrl+N after the first Ctrl+G denies', async () => {
    const r = rig();
    ask(r);
    at(ASKED_AT + 1000);
    r.chord('n');
    expect(await settled(r)).toEqual([{ outcome: 'reject' }]);
  });

  it('[v] after the first Ctrl+G cancels the question; coming back, Ctrl+G asks again', async () => {
    const r = rig();
    ask(r);
    at(ASKED_AT + 500);
    r.key('v');
    r.show();
    expect(r.store.getSnapshot().alwaysConfirm).toBe(false);
    at(ASKED_AT + 600);
    r.key('b');
    r.show();
    at(ASKED_AT + 600 + APPROVAL_SETTLE_MS);
    enter(r);
    expect(r.answers, 'an Enter after navigation grants nothing').toEqual([]);
    r.show();
    at(ASKED_AT + 600 + APPROVAL_SETTLE_MS + APPROVAL_TYPEAHEAD_MS);
    r.chord('g');
    expect(r.answers, 'the first press after coming back only asks').toEqual([]);
    expect(r.store.getSnapshot().alwaysConfirm).toBe(true);
    at(ASKED_AT + 600 + APPROVAL_SETTLE_MS + APPROVAL_TYPEAHEAD_MS + APPROVAL_CONFIRM_MIN_MS);
    enter(r);
    expect(await settled(r)).toEqual([{ outcome: 'approve', scope: 'always' }]);
  });

  it('a resize (a new review object) cancels the question', async () => {
    const r = rig();
    ask(r);
    at(ASKED_AT + 100);
    r.store.invalidateToolReview();
    expect(
      r.store.getSnapshot().alwaysConfirm,
      'the resized frame is not the one that was asked',
    ).toBe(false);
    r.show();
    // Far past the dwell and the minimum, inside the 5 s: were the question still alive this Enter would grant.
    at(ASKED_AT + 100 + APPROVAL_SETTLE_MS + APPROVAL_CONFIRM_MIN_MS);
    enter(r);
    expect(await settled(r), 'the Enter finds no question on the resized frame').toEqual([]);
    expect(r.pending()).toBe(true);
  });

  it('a new card starts with no question open', () => {
    const r = rig();
    ask(r);
    at(ASKED_AT + 100);
    r.chord('n'); // deny card A
    expect(r.pending()).toBe(false);
    at(ASKED_AT + 200);
    r.open('B');
    r.show();
    expect(r.store.getSnapshot().alwaysConfirm).toBe(false);
    at(ASKED_AT + 200 + APPROVAL_SETTLE_MS + APPROVAL_CONFIRM_MIN_MS);
    enter(r);
    expect(r.pending(), 'an Enter on a card whose question was never asked grants nothing').toBe(
      true,
    );
  });

  it('a first Ctrl+G needs every guard a Ctrl+Y needs (dwell)', () => {
    const r = rig();
    r.open('card');
    r.show();
    at(APPROVAL_SETTLE_MS - 1);
    r.chord('g');
    expect(r.store.getSnapshot().alwaysConfirm).toBe(false);
  });

  it('Enter is checked against the quiet gap too, and a refused Enter ends the question (d)', async () => {
    // The previous key is the first Ctrl+G: a quiet gap longer than the wait refuses an Enter sent inside it.
    const r = rig({ quietMs: 1500, confirmAlways: true });
    r.open('card');
    r.show();
    at(APPROVAL_SETTLE_MS);
    r.chord('g');
    expect(r.store.getSnapshot().alwaysConfirm).toBe(true);
    at(APPROVAL_SETTLE_MS + 1000);
    enter(r);
    expect(await settled(r)).toEqual([]);
    expect(r.store.getSnapshot().alwaysConfirm).toBe(false);
  });

  it('does not ask for a change the card cannot show whole (no Ctrl+G is offered), and Enter grants nothing', () => {
    const r = rig();
    r.open('card', CLIPPED);
    r.show();
    at(APPROVAL_SETTLE_MS);
    r.chord('g');
    expect(r.store.getSnapshot().alwaysConfirm).toBe(false);
    expect(r.pending()).toBe(true);
    at(APPROVAL_SETTLE_MS + 1000);
    enter(r);
    expect(r.pending()).toBe(true);
  });

  it('with confirmAlways off, the first Ctrl+G grants (what the existing host tests rely on)', async () => {
    const r = rig({ confirmAlways: false });
    r.open('card');
    r.show();
    r.chord('g');
    expect(await settled(r)).toEqual([{ outcome: 'approve', scope: 'always' }]);
  });

  describe('Enter is only the confirmation (it is no answer key anywhere else)', () => {
    it('does nothing on a card whose question is not open, and is a foreign key like any other', () => {
      const r = rig();
      r.open('card');
      r.show();
      at(1000);
      expect(enter(r)).toBe('handled');
      expect(r.pending()).toBe(true);
      r.show();
      at(1500);
      r.chord('y');
      expect(r.pending(), 'a Ctrl+Y 500 ms after a stray Enter is typing').toBe(true);
    });

    it('still denies in the reason box (Enter denies and continues)', async () => {
      const r = rig();
      r.open('card');
      r.show();
      at(APPROVAL_SETTLE_MS);
      r.chord('g'); // the question is open ...
      at(APPROVAL_SETTLE_MS + 100);
      r.chord('r'); // ... Ctrl+R opens the reason box and cancels it
      r.show();
      expect(r.store.getSnapshot().review?.denial).toBe('');
      expect(r.store.getSnapshot().alwaysConfirm).toBe(false);
      at(APPROVAL_SETTLE_MS + 200);
      r.key('o');
      r.show();
      at(APPROVAL_SETTLE_MS + 1000);
      enter(r);
      expect(await settled(r)).toEqual([{ outcome: 'reject', reason: 'o' }]);
    });

    it('still submits the search query in the full view (Enter finds)', () => {
      const r = rig();
      r.open('card', editedFilePreview(40, { 20: 'twenty' }));
      r.show();
      at(100);
      r.key('v');
      r.show();
      at(200);
      r.key('/');
      r.show();
      for (const [index, char] of [...'twenty'].entries()) {
        at(300 + index * 50);
        r.key(char);
        r.show();
      }
      expect(r.store.getSnapshot().review?.searching).toBe(true);
      expect(r.store.getSnapshot().review?.query).toBe('twenty');
      at(1000);
      enter(r);
      const review = r.store.getSnapshot().review;
      expect(review?.searching, 'Enter closed the search').toBe(false);
      expect(review?.message).toBe('Match found');
      expect(review?.cursor.line, 'and moved to the match').toBeGreaterThan(0);
      expect(r.pending(), 'and answered nothing').toBe(true);
    });

    it('confirms in the full view too, where the legend asks the same question', async () => {
      const r = rig();
      r.open('card');
      r.show();
      at(100);
      r.key('v');
      r.show();
      at(1000);
      r.chord('g');
      expect(r.store.getSnapshot().alwaysConfirm).toBe(true);
      at(1000 + APPROVAL_CONFIRM_MIN_MS);
      enter(r);
      expect(await settled(r)).toEqual([{ outcome: 'approve', scope: 'always' }]);
    });
  });
});

describe('typing and a held key never grant the session-wide answer (H1)', () => {
  /** A `run_command` call: its arguments are a field, not a diff — the card still offers `Ctrl+G` for it. */
  const COMMAND: ToolPreview = {
    kind: 'operation',
    target: 'git',
    fields: [{ name: 'args', value: '["push","--force"]' }],
  };
  /** One Ctrl+G in a `typeAfterIdle` script (the only chord that script can press); every other character is a bare key. */
  const CTRL_G = '\x07';
  /** The card has been open and untouched for `idle` ms (the person reads it), then `text` is typed (`\n` is Enter). */
  async function typeAfterIdle(
    text: string,
    idle: number,
    gapAfter: (index: number) => number,
    preview: ToolPreview,
  ): Promise<{ answers: readonly unknown[]; asked: boolean }> {
    const r = rig();
    r.open('card', preview);
    r.show();
    let t = idle;
    let asked = false;
    for (const [index, char] of [...text].entries()) {
      at(t);
      if (char === '\n') r.key('', ENTER);
      else if (char === CTRL_G) r.chord('g');
      else r.key(char);
      r.show();
      asked ||= r.store.getSnapshot().alwaysConfirm;
      if (!r.pending()) break;
      t += gapAfter(index);
    }
    return { answers: await settled(r), asked };
  }

  // The reviewer's repro (the grant was a bare `a` then): card open 1 s, then "aanpassen de tests" at 350 ms per key. The first
  // `a` passed every layer and asked; the second `a` 350 ms later granted {"outcome":"approve","scope":"always"}. The chord
  // keeps the rule: Ctrl+G twice is a double tap or a held key, and the second never confirms.
  it.each([300, 350, 1000])('Ctrl+G twice, %i ms apart, never grants', async (gapMs) => {
    const r = rig();
    r.open('card');
    r.show();
    at(1000);
    r.chord('g');
    expect(r.store.getSnapshot().alwaysConfirm, 'the first Ctrl+G asks').toBe(true);
    at(1000 + gapMs);
    r.chord('g');
    expect(r.pending(), 'the second Ctrl+G is not an answer').toBe(true);
    expect(await settled(r)).toEqual([]);
    for (const after of [500, 1500, 4000]) {
      at(1000 + gapMs + after);
      r.key('', ENTER);
      expect(r.pending(), `and no Enter ${after} ms later finds a question to confirm`).toBe(true);
    }
    expect(r.answers).toEqual([]);
  });

  it.each(['aanpassen de tests\n', 'aanmaken een bestand\n', 'aa tamam devam et\n'])(
    'the phrase %j, typed at a 300 ms mean gap after the card was open for 1 s, never grants (20 trials, edit and run_command)',
    async (text) => {
      const grants: string[] = [];
      for (const [label, preview] of [
        ['edit', SMALL],
        ['run', COMMAND],
      ] as const) {
        for (let seed = 1; seed <= 20; seed++) {
          const rnd = lcg(seed * 104729);
          const { answers } = await typeAfterIdle(text, 1000, () => gap(rnd, 300), preview);
          if (approvals(answers).length > 0)
            grants.push(`${label} seed ${seed}: ${JSON.stringify(answers)}`);
        }
      }
      expect(grants).toEqual([]);
    },
  );

  it.each(['\x07\x07\n', '\x07x\n'])(
    'the keys %j, however they are spaced (300 ms mean), never grant: a key between Ctrl+G and Enter cancels the question',
    async (text) => {
      for (const [label, preview] of [
        ['edit', SMALL],
        ['run', COMMAND],
      ] as const) {
        for (let seed = 1; seed <= 20; seed++) {
          const rnd = lcg(seed * 7727);
          const { answers } = await typeAfterIdle(text, 1000, () => gap(rnd, 300), preview);
          expect(answers, `${label} seed ${seed}`).toEqual([]);
        }
      }
    },
  );

  it('a single Ctrl+G then a pause and Enter — the way it is meant — still grants', async () => {
    const { answers, asked } = await typeAfterIdle('\x07\n', 1000, () => 1200, SMALL);
    expect(asked).toBe(true);
    expect(answers).toEqual([{ outcome: 'approve', scope: 'always' }]);
  });

  it.each([300, 500, 700])(
    'Ctrl+G then Enter within %i ms is typing: it grants nothing',
    async (ms) => {
      const { answers } = await typeAfterIdle('\x07\n', 1000, () => ms, SMALL);
      expect(answers).toEqual([]);
    },
  );

  // held-a.mts <initialDelay> <interval>: the reviewer measured the first auto-repeat granting at +379/+503/+664/+1022 ms.
  describe('a held Ctrl+G', () => {
    const holdA = (initial: number, interval: number): { granted: boolean; keys: number } => {
      const r = rig();
      r.open('card');
      r.show();
      const down = 1000;
      at(down);
      r.chord('g');
      let keys = 1;
      // The first auto-repeat comes one initial delay after the key went down, the rest one interval apart.
      const repeats = [down + initial];
      while ((repeats.at(-1) ?? 0) + interval <= down + 6000)
        repeats.push((repeats.at(-1) ?? 0) + interval);
      for (const time of repeats) {
        at(time);
        r.chord('g');
        r.show();
        keys++;
        if (!r.pending()) return { granted: true, keys };
      }
      return { granted: false, keys };
    };

    it.each(
      [225, 375, 500, 660, 1020, 1800].flatMap((initial) =>
        [30, 400, 900].map((interval) => [initial, interval] as const),
      ),
    )(
      'never grants, at an initial repeat delay of %i ms and a repeat interval of %i ms',
      (initial, interval) => {
        const held = holdA(initial, interval);
        expect(held.granted, `${held.keys} repeats`).toBe(false);
      },
    );

    it('and a person who held it then presses Enter 1 s after the last repeat still grants nothing', () => {
      const r = rig();
      r.open('card');
      r.show();
      at(1000);
      r.chord('g');
      at(1500);
      r.chord('g');
      at(1530);
      r.chord('g');
      at(2530);
      r.key('', ENTER);
      expect(r.pending(), 'the repeats cancelled the question: this Enter confirms nothing').toBe(
        true,
      );
      expect(r.answers).toEqual([]);
    });
  });
});

/** One question with two options: what a model's `ask_user` call looks like when the person types an answer of their own. */
const QUESTION: AskUserRequest = {
  questions: [
    {
      header: 'Pick',
      question: 'Which file?',
      multiSelect: false,
      options: [
        { label: 'alpha.ts', description: 'The first file' },
        { label: 'beta.ts', description: 'The second file' },
      ],
    },
  ],
};

describe('text typed into a text field is typing, not the card in use (H3)', () => {
  /** Press the keys of `text` (`\n` is Enter) one `gapMs` apart from `from`; every key's frame is acknowledged. */
  const typeText = (r: Rig, text: string, from: number, gapMs: number): number => {
    let time = from;
    for (const char of text) {
      at(time);
      if (char === '\n') r.key('', ENTER);
      else r.key(char);
      r.show();
      time += gapMs;
    }
    return time - gapMs;
  };

  describe('the full view\u2019s search query', () => {
    const searched = (layers?: Partial<ApprovalGuard>): { r: Rig; enterAt: number } => {
      const r = layers === undefined ? rig() : rig(layers);
      r.open('card');
      r.show();
      // script.mts: typing the next instruction after the card opened. `v` opens the full view, `/` the search, and
      // the rest of the sentence goes into the query until the Enter.
      const enterAt = typeText(r, 'move it to src/lib then rerun tests\n', 1000, 150);
      return { r, enterAt };
    };

    it('the sentence ends in a card that is still open (the scenario is what the reviewer ran)', () => {
      const { r } = searched();
      expect(r.pending()).toBe(true);
      expect(r.store.getSnapshot().review?.screen).toBe('full');
      expect(r.store.getSnapshot().review?.searching, 'the Enter closed the search').toBe(false);
    });

    it('a Ctrl+Y 500 ms after the Enter that submitted it is refused (a y approved once before the answers were chords)', () => {
      const { r, enterAt } = searched();
      at(enterAt + 500);
      r.chord('y');
      expect(r.pending(), 'a Ctrl+Y that follows the typing of a sentence is not a decision').toBe(
        true,
      );
    });

    it('a Ctrl+Y once the typing window is over approves', () => {
      const { r, enterAt } = searched();
      at(enterAt + APPROVAL_TYPEAHEAD_MS + 1);
      r.chord('y');
      expect(r.pending(), 'a deliberate Ctrl+Y after the pause').toBe(false);
    });

    it('is typing for the typeahead layer alone: the text in the box and its Enter', () => {
      const refused = (): Rig => {
        const r = rig({ typeaheadMs: APPROVAL_TYPEAHEAD_MS });
        r.open('card', editedFilePreview(40, { 20: 'twenty' }));
        r.show();
        at(100);
        r.key('v'); // navigation: not typing
        r.show();
        at(200);
        r.key('/');
        r.show();
        typeText(r, 'twenty', 300, 50);
        expect(r.store.getSnapshot().review?.query).toBe('twenty');
        at(1000);
        r.key('', ENTER);
        r.show();
        expect(r.store.getSnapshot().review?.searching).toBe(false);
        return r;
      };
      const early = refused();
      at(1000 + 1000);
      early.chord('y');
      expect(early.pending(), '1000 ms after the Enter').toBe(true);
      const late = refused();
      at(1000 + APPROVAL_TYPEAHEAD_MS);
      late.chord('y');
      expect(late.pending(), '1500 ms after it').toBe(false);
    });

    it('control: navigating with [v] and [b] and no typing still lets a plain Ctrl+Y approve after the quiet period', () => {
      const r = rig();
      r.open('card');
      r.show();
      at(1000);
      r.key('v');
      r.show();
      at(1100);
      r.key('b');
      r.show();
      at(1100 + APPROVAL_SETTLE_MS);
      r.chord('y');
      expect(r.pending(), 'navigation is the card in use').toBe(false);
    });
  });

  describe('an own answer typed into an ask_user card', () => {
    /** question-then-card.mts: the person types `text` into the question's own-answer field and submits it. */
    const answered = (
      layers: Partial<ApprovalGuard> | undefined,
      text = 'use the second one',
    ): { r: Rig; enterAt: number } => {
      const r = layers === undefined ? rig() : rig(layers);
      r.store.bindQuestionVisibility(() => true);
      void r.store.requestQuestion(QUESTION);
      let time = 600; // reading the question
      for (const char of text) {
        at(time);
        r.store.handleReviewInput(char, {});
        time += 200;
      }
      let enters = 0;
      while (r.store.getSnapshot().question !== undefined && enters < 4) {
        at(time);
        r.store.handleReviewInput('\r', ENTER);
        enters++;
        time += 200;
      }
      expect(r.store.getSnapshot().question, 'the answer was submitted').toBeUndefined();
      const enterAt = time - 200;
      // The model's governed call comes right behind the question: its card opens 5 ms later.
      at(enterAt + 5);
      r.open('B');
      r.show();
      return { r, enterAt };
    };

    it('a Ctrl+Y 500 ms after the Enter is refused with the product defaults (a y approved once before the answers were chords)', () => {
      const { r, enterAt } = answered(undefined);
      at(enterAt + 500);
      r.chord('y');
      expect(r.pending(), 'a Ctrl+Y that follows the typing of an answer is not a decision').toBe(
        true,
      );
    });

    it('is typing for the typeahead layer alone, and the window ends 1500 ms after the Enter', () => {
      const early = answered({ typeaheadMs: APPROVAL_TYPEAHEAD_MS });
      at(early.enterAt + 1000);
      early.r.chord('y');
      expect(early.r.pending(), '1000 ms after the Enter').toBe(true);
      const late = answered({ typeaheadMs: APPROVAL_TYPEAHEAD_MS });
      at(late.enterAt + APPROVAL_TYPEAHEAD_MS);
      late.r.chord('y');
      expect(late.r.pending(), '1500 ms after it').toBe(false);
    });

    it('a question submitted by a key also starts the lockout, for the lockout layer alone', () => {
      const early = answered({ lockoutMs: APPROVAL_LOCKOUT_MS });
      at(early.enterAt + APPROVAL_LOCKOUT_MS - 1);
      early.r.chord('y');
      expect(early.r.pending(), '1999 ms after the Enter').toBe(true);
      const late = answered({ lockoutMs: APPROVAL_LOCKOUT_MS });
      at(late.enterAt + APPROVAL_LOCKOUT_MS);
      late.r.chord('y');
      expect(late.r.pending(), '2000 ms after it').toBe(false);
    });

    it('a skipped question (Ctrl+S) starts the lockout too', () => {
      const r = rig({ lockoutMs: APPROVAL_LOCKOUT_MS });
      r.store.bindQuestionVisibility(() => true);
      void r.store.requestQuestion(QUESTION);
      at(600);
      r.store.handleReviewInput('s', { ctrl: true });
      expect(r.store.getSnapshot().question).toBeUndefined();
      at(605);
      r.open('B');
      r.show();
      at(600 + APPROVAL_LOCKOUT_MS - 1);
      r.chord('y');
      expect(r.pending()).toBe(true);
    });

    it('every key the question card takes is typing, a key typed before it settled included (never the stop keys)', () => {
      const typedAhead = (): Rig => {
        const r = rig({ typeaheadMs: APPROVAL_TYPEAHEAD_MS });
        const controller = new AbortController();
        void r.store.requestQuestion(QUESTION, controller.signal).catch(() => undefined);
        // Its frame was never acknowledged visible: the card consumes the key and takes no action on it.
        at(100);
        expect(r.store.handleReviewInput('x', {})).toBe('handled');
        expect(r.store.getSnapshot().question?.index).toBe(0);
        at(200);
        controller.abort(); // the host stops the turn
        expect(r.store.getSnapshot().question).toBeUndefined();
        at(210);
        r.open('B');
        r.show();
        return r;
      };
      const early = typedAhead();
      at(1000);
      early.chord('y');
      expect(
        early.pending(),
        'a Ctrl+Y 900 ms after a key typed at a question that had not settled',
      ).toBe(true);
      const late = typedAhead();
      at(200 + APPROVAL_TYPEAHEAD_MS);
      late.chord('y');
      expect(late.pending(), 'and it ends 1500 ms after that key').toBe(false);

      const stop = rig({ typeaheadMs: APPROVAL_TYPEAHEAD_MS });
      const controller = new AbortController();
      void stop.store.requestQuestion(QUESTION, controller.signal).catch(() => undefined);
      at(100);
      expect(stop.store.handleReviewInput('', { escape: true })).toBe('abort');
      controller.abort();
      at(110);
      stop.open('B');
      stop.show();
      at(200);
      stop.chord('y');
      expect(
        stop.pending(),
        'Esc leaves the turn: it is no typing, so a Ctrl+Y 90 ms later answers',
      ).toBe(false);
    });
  });
});

describe('a refused key shows one short note on the card (G1)', () => {
  it('names the typing on the first refusal, once per card, and not again per key', () => {
    const r = rig();
    r.open('card');
    r.show();
    at(100);
    r.key('x'); // typed
    r.show();
    expect(r.note(), 'a foreign key alone says nothing').toBe('');
    at(700);
    r.chord('y'); // refused: a foreign key is fresh
    expect(r.pending()).toBe(true);
    expect(r.note()).toBe(CARD_TYPEAHEAD_NOTE);
    const withNote = r.store.getSnapshot().review;
    r.show(); // the host acknowledges the replaced review
    at(900);
    r.chord('y');
    r.show();
    at(1100);
    r.chord('y');
    expect(r.pending()).toBe(true);
    expect(r.store.getSnapshot().review, 'no second note: the review is untouched').toBe(withNote);
  });

  it('names the previous answer when the card opened right after it', () => {
    const r = rig();
    r.open('A');
    r.show();
    at(600);
    r.chord('y');
    at(655);
    r.open('B');
    r.show();
    at(1300);
    r.chord('y');
    expect(r.pending()).toBe(true);
    expect(r.note()).toBe(CARD_LOCKOUT_NOTE);
  });

  it('names the keyboard when a key follows another within the quiet gap', () => {
    const r = rig({ quietMs: APPROVAL_QUIET_MS });
    r.open('card');
    r.show();
    at(100);
    r.key('x');
    at(200);
    r.chord('y');
    expect(r.note()).toBe(CARD_TYPEAHEAD_NOTE);
  });

  it('says nothing for a key that is only early (the dwell)', () => {
    const r = rig();
    r.open('card');
    r.show();
    at(APPROVAL_SETTLE_MS - 1);
    r.chord('y');
    expect(r.pending()).toBe(true);
    expect(r.note()).toBe('');
  });

  it('is gone when the card is answered, and a new card starts clean', () => {
    const r = rig();
    r.open('A');
    r.show();
    at(100);
    r.key('x');
    at(700);
    r.chord('y');
    expect(r.note()).toBe(CARD_TYPEAHEAD_NOTE);
    r.show();
    at(710);
    r.chord('n');
    expect(r.store.getSnapshot().review, 'the card is gone and so is its note').toBeUndefined();
    at(2000);
    r.open('B');
    r.show();
    expect(r.note()).toBe('');
    at(2500);
    r.chord('y'); // refused again (lockout, 1790 ms after the denial): B is a card of its own and gets its own note
    expect(r.pending()).toBe(true);
    expect(r.note()).toBe(CARD_LOCKOUT_NOTE);
  });

  it('fits one row of an 80-column card', () => {
    for (const note of [CARD_TYPEAHEAD_NOTE, CARD_LOCKOUT_NOTE])
      expect(note.length, note).toBeLessThanOrEqual(78);
  });
});

describe('deny and navigation stay immediate', () => {
  it('lets Ctrl+N deny at once, even straight after another key', async () => {
    const r = rig();
    r.open('card');
    r.show();
    at(1);
    r.key('x');
    at(2);
    expect(r.chord('n')).toBe('handled');
    expect(await settled(r)).toEqual([{ outcome: 'reject' }]);
  });

  it('lets Ctrl+R open the reason box at once, and types y and a into it without answering (a chord is no answer there either)', () => {
    const r = rig();
    r.open('card');
    r.show();
    at(1);
    r.chord('r');
    expect(r.store.getSnapshot().review?.denial).toBe('');
    r.show();
    at(2);
    r.key('y');
    r.show(); // every typed character is a new frame the host acknowledges
    at(3);
    r.key('a');
    expect(r.store.getSnapshot().review?.denial, 'y and a are reason text, not answers').toBe('ya');
    expect(r.pending()).toBe(true);
    // Inside the box the chords are not answers either: the box owns the keyboard.
    r.show();
    at(4);
    r.chord('y');
    r.chord('g');
    r.chord('n');
    expect(r.store.getSnapshot().review?.denial, 'a chord adds no text to the reason').toBe('ya');
    expect(r.pending(), 'and answers nothing').toBe(true);
  });

  it('a bare n does not deny, even at once, and a bare c opens no reason box', async () => {
    const r = rig();
    r.open('card');
    r.show();
    at(1);
    expect(r.key('n')).toBe('handled');
    expect(r.key('c')).toBe('handled');
    expect(r.pending()).toBe(true);
    expect(r.store.getSnapshot().review?.denial).toBeUndefined();
    expect(await settled(r)).toEqual([]);
  });

  it('lets [v] and [b] navigate at once', () => {
    const r = rig();
    r.open('card');
    r.show();
    at(1);
    r.key('v');
    expect(r.store.getSnapshot().review?.screen).toBe('full');
    r.show();
    at(2);
    r.key('b');
    expect(r.store.getSnapshot().review?.screen).toBe('card');
  });

  it('lets Esc and Ctrl+C stop the turn at once, each on a card of its own, and rejects the call first (ADR-0115 §2)', () => {
    const r = rig();
    r.open('card');
    r.show();
    at(1);
    expect(r.key('', { escape: true })).toBe('abort');
    expect(r.pending(), 'the rejection is settled before the abort is signalled').toBe(false);
    r.open('card two');
    r.show();
    at(2);
    expect(r.key('c', { ctrl: true })).toBe('abort');
    expect(r.pending()).toBe(false);
  });
});

describe('the dwell restarts whenever a new frame has to be acknowledged', () => {
  // Isolated from every other layer so that only the dwell can refuse.
  const dwellOnly: Partial<ApprovalGuard> = { settleMs: APPROVAL_SETTLE_MS };

  it('restarts for a new card', () => {
    const r = rig(dwellOnly);
    r.open('A');
    r.show();
    at(1000);
    r.chord('n'); // A is denied; the person moves on
    r.open('B');
    r.show();
    at(1000 + APPROVAL_SETTLE_MS - 1);
    r.chord('y');
    expect(r.pending(), 'B has not been on screen long enough').toBe(true);
    at(1000 + APPROVAL_SETTLE_MS);
    r.chord('y');
    expect(r.pending()).toBe(false);
  });

  it('restarts for a resize (the frame has to be flushed again)', () => {
    const r = rig(dwellOnly);
    r.open('card');
    r.show();
    at(1000); // long past the dwell
    r.store.invalidateToolReview();
    r.show();
    at(1000 + APPROVAL_SETTLE_MS - 1);
    r.chord('y');
    expect(r.pending(), 'the resized frame has not settled').toBe(true);
    at(1000 + APPROVAL_SETTLE_MS);
    r.chord('y');
    expect(r.pending()).toBe(false);
  });

  it('restarts for a screen change to the full view and back', () => {
    const r = rig(dwellOnly);
    r.open('card');
    r.show();
    at(1000);
    r.key('v');
    r.show();
    at(1100);
    r.key('b');
    r.show();
    at(1100 + APPROVAL_SETTLE_MS - 1);
    r.chord('y');
    expect(r.pending(), 'the card the person returned to is a new frame').toBe(true);
    at(1100 + APPROVAL_SETTLE_MS);
    r.chord('y');
    expect(r.pending()).toBe(false);
  });

  it('does not restart for the same frame acknowledged again (every host render acknowledges it)', () => {
    const r = rig(dwellOnly);
    r.open('card');
    r.show();
    for (let time = 80; time < APPROVAL_SETTLE_MS; time += 80) {
      at(time);
      r.show(); // the same review object, flushed again by a spinner-driven re-render
    }
    at(APPROVAL_SETTLE_MS);
    r.chord('y');
    expect(r.pending(), 'repeated acknowledgements must not starve the dwell').toBe(false);
  });

  it('refuses an affirmative key for a frame that was never acknowledged', () => {
    const r = rig(dwellOnly);
    r.open('card');
    r.store.bindReviewVisibility(() => true); // a host that reports visible without ever acknowledging
    at(10_000);
    r.chord('y');
    expect(r.pending()).toBe(true);
  });
});

describe('each guard stands on its own', () => {
  it('the dwell refuses a settled-looking key when only the dwell is on', () => {
    const r = rig({ settleMs: APPROVAL_SETTLE_MS });
    r.open('card');
    r.show();
    at(APPROVAL_SETTLE_MS - 1);
    r.chord('y');
    expect(r.pending()).toBe(true);
  });

  it('the quiet gap refuses a key that follows another within it, when only the gap is on', () => {
    const r = rig({ quietMs: APPROVAL_QUIET_MS });
    r.open('card');
    r.show();
    at(1);
    r.key('x');
    at(1 + APPROVAL_QUIET_MS - 1);
    r.chord('y');
    expect(r.pending()).toBe(true);
  });

  it('counts a key typed BEFORE the card existed (the composer drops it, the store still hears it)', () => {
    const r = rig({ quietMs: APPROVAL_QUIET_MS });
    // The person is typing the next instruction while the turn runs: no review, so the composer handles the key.
    expect(r.store.handleReviewInput('x', {})).toBeUndefined();
    at(50);
    r.open('card');
    r.show();
    at(100);
    r.chord('y');
    expect(r.pending(), 'the key typed 100 ms ago is a previous key').toBe(true);
    r.show(); // the refusal note replaced the review
    at(100 + APPROVAL_QUIET_MS);
    r.chord('y');
    expect(r.pending(), 'after the gap the answer counts').toBe(false);
  });

  it('every layer off turns the guard off (what the existing host tests use)', () => {
    const r = rig({});
    r.open('card');
    r.show();
    r.chord('y');
    expect(r.pending()).toBe(false);
  });
});

describe('the guards read the monotonic clock, not the wall clock (G3)', () => {
  const HOUR = 3_600_000;

  it('a wall clock stepped BACK an hour while the card is open does not silence a deliberate Ctrl+Y', () => {
    const r = rig();
    r.open('card');
    r.show();
    at(1000);
    vi.setSystemTime(Date.now() - HOUR);
    r.chord('y');
    expect(r.pending(), 'the dwell is measured on the monotonic clock').toBe(false);
  });

  it('a wall clock stepped FORWARD ten seconds does not let a Ctrl+Y 150 ms after the card opened approve', () => {
    const r = rig();
    r.open('card');
    r.show();
    at(150);
    vi.setSystemTime(Date.now() + 10_000);
    r.chord('y');
    expect(r.pending(), '150 ms is still inside the dwell').toBe(true);
  });

  it('a wall-clock step does not stretch the quiet gap', () => {
    const r = rig({ quietMs: APPROVAL_QUIET_MS });
    r.open('card');
    r.show();
    at(1000);
    r.key('x');
    vi.setSystemTime(Date.now() + HOUR);
    at(1100);
    r.chord('y');
    expect(r.pending(), 'the previous key was 100 ms ago').toBe(true);
  });

  it('a wall-clock step does not shrink the typeahead window or the lockout', () => {
    const typed = rig({ typeaheadMs: APPROVAL_TYPEAHEAD_MS });
    typed.open('card');
    typed.show();
    at(100);
    typed.key('x');
    vi.setSystemTime(Date.now() + HOUR);
    at(600);
    typed.chord('y');
    expect(typed.pending(), 'the foreign key was 500 ms ago').toBe(true);

    const locked = rig({ lockoutMs: APPROVAL_LOCKOUT_MS });
    locked.open('A');
    locked.show();
    at(100);
    locked.chord('y');
    locked.open('B');
    locked.show();
    vi.setSystemTime(Date.now() - HOUR);
    at(600);
    locked.chord('y');
    expect(locked.pending(), 'the previous answer was 500 ms ago').toBe(true);
    vi.setSystemTime(Date.now() + 2 * HOUR);
    // The refused Ctrl+Y at 600 ms restarted the window (H2), so it ends a whole window after THAT key.
    at(600 + APPROVAL_LOCKOUT_MS);
    locked.show();
    locked.chord('y');
    expect(locked.pending(), 'and the window ends on the monotonic clock').toBe(false);
  });

  it('a wall-clock step does not move the confirmation window', async () => {
    const stepped = rig();
    stepped.open('card');
    stepped.show();
    at(APPROVAL_SETTLE_MS);
    stepped.chord('g');
    vi.setSystemTime(Date.now() - HOUR);
    at(APPROVAL_SETTLE_MS + APPROVAL_CONFIRM_MIN_MS);
    stepped.key('', ENTER);
    expect(await settled(stepped), 'a step back does not make the gap negative').toEqual([
      { outcome: 'approve', scope: 'always' },
    ]);

    const early = rig();
    early.open('card');
    early.show();
    at(APPROVAL_SETTLE_MS);
    early.chord('g');
    vi.setSystemTime(Date.now() + HOUR);
    at(APPROVAL_SETTLE_MS + APPROVAL_CONFIRM_MIN_MS - 1);
    early.key('', ENTER);
    expect(early.pending(), 'a step forward does not make 799 ms look like an hour').toBe(true);
    expect(early.answers).toEqual([]);

    const forward = rig();
    forward.open('card');
    forward.show();
    at(APPROVAL_SETTLE_MS);
    forward.chord('g');
    vi.setSystemTime(Date.now() + HOUR);
    at(APPROVAL_SETTLE_MS + APPROVAL_CONFIRM_MIN_MS);
    forward.key('', ENTER);
    expect(await settled(forward), 'nor 800 ms look like past the 5 s window').toEqual([
      { outcome: 'approve', scope: 'always' },
    ]);

    const lapsing = rig();
    lapsing.open('card');
    lapsing.show();
    at(APPROVAL_SETTLE_MS);
    lapsing.chord('g');
    vi.setSystemTime(Date.now() + HOUR);
    at(APPROVAL_SETTLE_MS + APPROVAL_CONFIRM_MAX_MS + 1);
    lapsing.store.flush();
    expect(lapsing.store.getSnapshot().alwaysConfirm, 'it lapses on the monotonic clock').toBe(
      false,
    );
  });
});

describe('approval answers are Ctrl chords (bare letters never answer)', () => {
  // While a turn runs the person is often typing the next instruction, and a letter typed at a card that has just appeared is
  // indistinguishable from a deliberate answer. Timing cannot tell them apart, so the answer keys are ones typing cannot
  // produce. Everything here asserts on the store's own result: whether the approval settled, how, and what the snapshot says.
  type Screen = 'card' | 'full';
  const SCREENS: readonly Screen[] = ['card', 'full'];
  /** Every printable ASCII character (U+0020..U+007E, the digits among them) and a few letters of other scripts. */
  const PRINTABLE: readonly string[] = [
    ...new Set([
      ...Array.from({ length: 0x7e - 0x20 + 1 }, (_, index) => String.fromCodePoint(0x20 + index)),
      ...'0123456789',
      'é', // é
      'ı', // ı
      'ÿ', // ÿ
      'ß', // ß
      '你', // 你
      '\u{1f600}', // 😀
    ]),
  ];
  /** An open card whose frame was acknowledged long ago, on `screen`: with `layers` named, only those guard layers are on. */
  const openOn = (screen: Screen, layers: Partial<ApprovalGuard> = {}): Rig => {
    const r = rig(layers);
    r.open('card');
    r.show();
    if (screen === 'full') {
      at(100);
      r.key('v'); // inspection only
      r.show();
      expect(r.store.getSnapshot().review?.screen).toBe('full');
    }
    at(10_000);
    return r;
  };
  /** What a snapshot says about a card nothing has answered: pending, no reason box, no session-wide question. */
  const untouched = (r: Rig): string[] => {
    const snapshot = r.store.getSnapshot();
    const problems: string[] = [];
    if (snapshot.approval === undefined || snapshot.review === undefined)
      problems.push('the approval was resolved');
    if (snapshot.review?.denial !== undefined) problems.push('the reason box opened');
    if (snapshot.alwaysConfirm === true) problems.push('the session-wide question was asked');
    if (r.answers.length > 0) problems.push(`it was answered ${JSON.stringify(r.answers)}`);
    return problems;
  };
  const ONCE = { outcome: 'approve', scope: 'once' } as const;
  const ALWAYS = { outcome: 'approve', scope: 'always' } as const;
  const REJECT = { outcome: 'reject' } as const;

  describe('the exhaustive bare-key oracle (every guard layer off, the frame acknowledged long ago)', () => {
    it('covers every printable character, the digits and a few non-ASCII letters', () => {
      expect(PRINTABLE).toHaveLength(0x7e - 0x20 + 1 + 6);
      for (const char of [
        'y',
        'Y',
        'a',
        'n',
        'c',
        'r',
        'g',
        '1',
        '2',
        '3',
        ' ',
        'v',
        '/',
        'é',
        '\u{1f600}',
      ])
        expect(PRINTABLE, JSON.stringify(char)).toContain(char);
    });

    it.each(SCREENS)(
      'control: with the same guards off, the card on the %s screen IS answered by Ctrl+Y (so the oracle below is not vacuous)',
      async (screen) => {
        const r = openOn(screen);
        r.chord('y');
        expect(await settled(r)).toStrictEqual([ONCE]);
      },
    );

    it.each(SCREENS)(
      'no bare character answers the card on the %s screen, each sent to a card of its own',
      async (screen) => {
        const failures: string[] = [];
        for (const char of PRINTABLE) {
          // An upper-case letter arrives from a terminal with `shift` set; every other key is sent as it is, bare.
          const keys = /^[A-Z]$/.test(char) ? [{}, { shift: true }] : [{}];
          for (const key of keys) {
            const r = openOn(screen);
            r.key(char, key);
            r.show();
            await settled(r);
            for (const problem of untouched(r))
              failures.push(`${JSON.stringify(char)} ${JSON.stringify(key)}: ${problem}`);
          }
        }
        expect(failures).toEqual([]);
      },
    );

    it.each(SCREENS)(
      'the card on the %s screen is still pending after every bare character has been sent to it, one after another',
      async (screen) => {
        // Some of these keys navigate (`v`, `b`) or open the search box (`/`): the point is that, wherever they leave the
        // review, none of them has answered it and none opened the reason box.
        const r = openOn(screen);
        const failures: string[] = [];
        for (const [index, char] of PRINTABLE.entries()) {
          at(10_000 + index * 50);
          r.key(char, {});
          r.show();
          for (const problem of untouched(r)) failures.push(`${JSON.stringify(char)}: ${problem}`);
        }
        expect(failures).toEqual([]);
        expect(await settled(r)).toEqual([]);
        expect(r.pending()).toBe(true);
      },
    );

    it('consumes a bare letter as a foreign key: handled, never composer text, and it changes no card state', () => {
      const r = rig({});
      r.open('card');
      r.show();
      at(10_000);
      const before = r.store.getSnapshot().review;
      for (const char of ['y', 'a', 'n', 'c', 'r', '1', '2', '3']) {
        expect(r.key(char), JSON.stringify(char)).toBe('handled');
        expect(
          r.store.getSnapshot().review,
          `${JSON.stringify(char)} left the review as it was`,
        ).toBe(before);
      }
    });
  });

  describe('words typed at a settled, quiet card', () => {
    const WORDS = ['yes do it', 'always', 'no', 'can you', 'now'] as const;
    /**
     * The card has been open and untouched for 2 s; the person then types `word` one character at a time, 80 ms apart, and
     * presses Enter. `problems` collects anything the card did about a key; `enterAt` is when the Enter arrived.
     */
    const typed = (
      word: string,
      layers?: Partial<ApprovalGuard>,
    ): { r: Rig; enterAt: number; problems: string[] } => {
      const r = layers === undefined ? rig() : rig(layers);
      r.open('card');
      r.show();
      const problems: string[] = [];
      let time = 2000;
      for (const char of word) {
        at(time);
        r.key(char);
        r.show();
        for (const problem of untouched(r)) problems.push(`${JSON.stringify(char)}: ${problem}`);
        time += 80;
      }
      at(time);
      r.key('', ENTER);
      r.show();
      for (const problem of untouched(r)) problems.push(`Enter: ${problem}`);
      return { r, enterAt: time, problems };
    };

    it.each(WORDS)(
      'typing %j and pressing Enter never settles the card or opens the reason box (every guard layer off)',
      async (word) => {
        const { r, problems } = typed(word, {});
        expect(problems).toEqual([]);
        expect(await settled(r)).toEqual([]);
        expect(r.pending()).toBe(true);
        expect(r.store.getSnapshot().review?.denial).toBeUndefined();
      },
    );

    it.each(WORDS)(
      'after typing %j, a Ctrl+Y inside the typeahead window is refused and one after it is accepted',
      async (word) => {
        const early = typed(word);
        expect(early.problems, 'the real guard: typing alone changes nothing').toEqual([]);
        at(early.enterAt + APPROVAL_TYPEAHEAD_MS - 1);
        early.r.chord('y');
        expect(early.r.pending(), '1499 ms after the last typed key').toBe(true);
        expect(early.r.note(), 'and it is the typing the card names').toBe(CARD_TYPEAHEAD_NOTE);
        expect(await settled(early.r)).toEqual([]);

        const late = typed(word);
        at(late.enterAt + APPROVAL_TYPEAHEAD_MS);
        late.r.chord('y');
        expect(await settled(late.r), '1500 ms after it').toStrictEqual([ONCE]);
      },
    );
  });

  describe('what each chord does at a settled card (every guard layer on)', () => {
    /** Open, shown and untouched for a second: every layer would pass a first answer chord. */
    const SETTLED_AT = 1000;
    const settledCard = (preview?: ToolPreview): Rig => {
      const r = rig();
      r.open('card', preview);
      r.show();
      at(SETTLED_AT);
      return r;
    };

    it('Ctrl+Y allows the call once', async () => {
      const r = settledCard();
      expect(r.chord('y')).toBe('handled');
      expect(await settled(r)).toStrictEqual([ONCE]);
      expect(r.pending()).toBe(false);
    });

    it('Ctrl+G only asks; an Enter 800 ms later grants the session-wide answer', async () => {
      const r = settledCard();
      expect(r.chord('g')).toBe('handled');
      expect(r.pending(), 'the first Ctrl+G settles nothing').toBe(true);
      expect(r.store.getSnapshot().alwaysConfirm, 'and the card asks').toBe(true);
      expect(await settled(r)).toEqual([]);
      at(SETTLED_AT + APPROVAL_CONFIRM_MIN_MS);
      expect(r.key('', ENTER)).toBe('handled');
      expect(await settled(r)).toStrictEqual([ALWAYS]);
    });

    it.each([
      ['a bare a', 1000, 'a', {}],
      ['a bare g', 1000, 'g', {}],
      ['a bare y', 1000, 'y', {}],
      ['another Ctrl+G', 1000, 'g', { ctrl: true }],
      ['another Ctrl+G, a held key repeating at once', 40, 'g', { ctrl: true }],
      ['a bare letter', 1000, 'x', {}],
      ['an arrow', 1000, '', { downArrow: true }],
      ['an Enter sooner than the minimum', APPROVAL_CONFIRM_MIN_MS - 1, '', { return: true }],
      ['an Enter later than the maximum', APPROVAL_CONFIRM_MAX_MS + 1, '', { return: true }],
    ] as const)(
      'Ctrl+G followed by %s grants nothing, and a later Enter finds no question',
      async (_label, afterMs, input, key) => {
        const r = settledCard();
        r.chord('g');
        expect(r.store.getSnapshot().alwaysConfirm).toBe(true);
        at(SETTLED_AT + afterMs);
        r.key(input, key);
        r.show();
        expect(r.pending(), 'the second key granted nothing').toBe(true);
        expect(r.store.getSnapshot().alwaysConfirm, 'and ended the question').toBe(false);
        // Inside the 800 ms .. 5 s window of the FIRST Ctrl+G, where an Enter grants if the question were still open.
        at(SETTLED_AT + Math.max(afterMs, APPROVAL_CONFIRM_MIN_MS) + 1000);
        r.key('', ENTER);
        expect(await settled(r)).toEqual([]);
        expect(r.pending()).toBe(true);
      },
    );

    it('Ctrl+N denies without a reason', async () => {
      const r = settledCard();
      expect(r.chord('n')).toBe('handled');
      expect(await settled(r)).toStrictEqual([REJECT]);
    });

    it('Ctrl+N works on a frame that is not on screen, whereas Ctrl+Y and Ctrl+G do not', async () => {
      // Every guard layer off: only the visibility of the frame can refuse an answer.
      const r = rig({});
      r.open('card'); // the host has not flushed this frame: there is nothing the person could have read
      at(5000);
      r.chord('y');
      expect(r.pending(), 'Ctrl+Y needs the frame on screen').toBe(true);
      r.chord('g');
      expect(r.pending(), 'Ctrl+G needs it too').toBe(true);
      expect(r.store.getSnapshot().alwaysConfirm).toBe(false);
      expect(await settled(r)).toEqual([]);
      r.chord('n');
      expect(await settled(r), 'a deny grants nothing, so it needs no frame').toStrictEqual([
        REJECT,
      ]);

      const shown = rig({});
      shown.open('card');
      shown.show();
      at(5000);
      shown.chord('y');
      expect(
        await settled(shown),
        'control: the same card with its frame on screen is answered',
      ).toStrictEqual([ONCE]);
    });

    it('Ctrl+R opens the reason box on the card; the typed letters (y, n, a included) are the reason and Enter denies with it', async () => {
      // Every layer off: nothing but the open box can stop a chord.
      const r = rig({});
      r.open('card');
      r.show();
      at(SETTLED_AT);
      expect(r.chord('r')).toBe('handled');
      expect(r.store.getSnapshot().review?.denial).toBe('');
      expect(r.pending()).toBe(true);
      r.show();
      let time = SETTLED_AT;
      for (const char of 'yna ok') {
        at((time += 50));
        r.key(char);
        r.show();
      }
      expect(r.store.getSnapshot().review?.denial, 'every letter went into the reason').toBe(
        'yna ok',
      );
      for (const letter of ['y', 'g', 'n'] as const) {
        at((time += 50));
        r.chord(letter);
        r.show();
        expect(r.pending(), `Ctrl+${letter.toUpperCase()} inside the box answers nothing`).toBe(
          true,
        );
        expect(
          r.store.getSnapshot().review?.denial,
          'the box is still open, its text unchanged',
        ).toBe('yna ok');
        expect(r.store.getSnapshot().alwaysConfirm).toBe(false);
      }
      expect(r.answers).toEqual([]);
      at((time += 50));
      r.key('', ENTER);
      expect(await settled(r)).toStrictEqual([{ outcome: 'reject', reason: 'yna ok' }]);
    });

    it('inside the full view’s search box (opened with /) the letters are the query and a chord answers nothing', async () => {
      const r = rig({});
      r.open('card');
      r.show();
      at(SETTLED_AT);
      r.key('v');
      r.show();
      at(SETTLED_AT + 50);
      r.key('/');
      r.show();
      expect(r.store.getSnapshot().review?.searching).toBe(true);
      let time = SETTLED_AT + 50;
      for (const char of 'yna') {
        at((time += 50));
        r.key(char);
        r.show();
      }
      expect(r.store.getSnapshot().review?.query).toBe('yna');
      for (const letter of ['y', 'g', 'n', 'r'] as const) {
        at((time += 50));
        r.chord(letter);
        r.show();
        const review = r.store.getSnapshot().review;
        expect(r.pending(), `Ctrl+${letter.toUpperCase()} in the search box answers nothing`).toBe(
          true,
        );
        expect(review?.searching, 'the search box is still open').toBe(true);
        expect(review?.query, 'its query unchanged').toBe('yna');
        expect(review?.denial, 'and no reason box').toBeUndefined();
      }
      at((time += 50));
      r.key('', ENTER); // Enter finds; it answers nothing
      expect(r.store.getSnapshot().review?.searching).toBe(false);
      expect(r.pending()).toBe(true);
      expect(await settled(r)).toEqual([]);
    });

    it('Ctrl+R opens no reason box on the full view', () => {
      const r = rig({});
      r.open('card');
      r.show();
      at(SETTLED_AT);
      r.key('v');
      r.show();
      at(SETTLED_AT + 50);
      r.chord('r');
      r.show();
      const review = r.store.getSnapshot().review;
      expect(review?.screen).toBe('full');
      expect(review?.denial).toBeUndefined();
      expect(r.pending()).toBe(true);
    });

    it.each(['y', 'g', 'n', 'r'] as const)(
      'Ctrl+Alt+%s, and Alt+%s alone, answer nothing; the card is still answered by the plain chord afterwards',
      async (letter) => {
        const r = rig({});
        r.open('card');
        r.show();
        at(SETTLED_AT);
        for (const key of [{ ctrl: true, meta: true }, { meta: true }] as const) {
          expect(r.key(letter, key), JSON.stringify(key)).toBe('handled');
          r.show();
          expect(untouched(r), JSON.stringify(key)).toEqual([]);
        }
        at(SETTLED_AT + 100);
        r.chord('y');
        expect(await settled(r), 'control').toStrictEqual([ONCE]);
      },
    );
  });

  describe('a held chord does not carry over onto the next card', () => {
    it.each([15, 33, 45, 90, 400])(
      'a Ctrl+Y that resolved card A, repeated every %i ms onto card B, never settles B while it keeps repeating',
      async (interval) => {
        const r = rig();
        r.open('A');
        r.show();
        at(600); // the person reads A
        expect(r.chord('y')).toBe('handled');
        expect(r.pending(), 'a deliberate Ctrl+Y allows A').toBe(false);
        at(605);
        r.open('B');
        r.show();
        let last = 600;
        for (let time = 600 + interval; time <= 600 + 4000; time += interval) {
          at(time);
          r.chord('y');
          r.show();
          last = time;
          expect(r.pending(), `B survived the repeat at +${time - 600} ms`).toBe(true);
        }
        expect(await settled(r), 'only A was ever answered').toStrictEqual([ONCE]);
        // Released for a whole lockout: a deliberate Ctrl+Y answers B.
        at(last + APPROVAL_LOCKOUT_MS);
        r.chord('y');
        expect(await settled(r)).toStrictEqual([ONCE, ONCE]);
        expect(r.pending()).toBe(false);
      },
    );

    it.each([45, 400])(
      'a Ctrl+G repeated every %i ms after Ctrl+G and Enter granted card A never asks about card B',
      async (interval) => {
        const r = rig();
        r.open('A');
        r.show();
        at(600);
        r.chord('g');
        at(600 + APPROVAL_CONFIRM_MIN_MS);
        r.key('', ENTER);
        expect(await settled(r), 'Ctrl+G then Enter granted A').toStrictEqual([ALWAYS]);
        const resolvedAt = 600 + APPROVAL_CONFIRM_MIN_MS;
        at(resolvedAt + 5);
        r.open('B');
        r.show();
        for (let time = resolvedAt + interval; time <= resolvedAt + 4000; time += interval) {
          at(time);
          r.chord('g');
          r.show();
          expect(r.pending(), `B survived the repeat at +${time - resolvedAt} ms`).toBe(true);
          expect(r.store.getSnapshot().alwaysConfirm, 'and the held key asked nothing').toBe(false);
        }
        expect(r.answers).toStrictEqual([ALWAYS]);
      },
    );
  });
});

describe('a sealed store cancels a pending approval; it does not reject it (ADR-0115 §2, ADR-0132 §4)', () => {
  it('settles the hook with an AbortError, so a teardown that seals and aborts in one stack is recorded cancelled, never "declined"', async () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    const pending = store.requestApproval(REQUEST, false);
    let outcome: unknown = 'pending';
    void pending.then(
      (answer) => {
        outcome = answer;
      },
      (error: unknown) => {
        outcome = error;
      },
    );
    store.sealToolPreviews();
    await Promise.resolve();
    await Promise.resolve();
    expect(outcome).toMatchObject({ name: 'AbortError' });
    expect(store.getSnapshot().approval).toBeUndefined();
    expect(store.getSnapshot().review).toBeUndefined();
  });

  it('refuses a later approval on the sealed store as a cancellation too', async () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    store.sealToolPreviews();
    await expect(store.requestApproval(REQUEST, false)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
