/**
 * OB7-L3 (the observation of unit 7's chat half): the ladder of a chat's status line gives parts up in a fixed order (the turns, then the context,
 * then the cost's reasons, then the model and the provider) until the line fits, and it is not minimal: it dropped `3 turns` AND `ctx 18% used`
 * to find the 11 columns it needed, and then never looked again, so a line with room for the turns (55 of 80 columns used) read shorter than it had
 * to. After the ladder the line now tries to take back what it dropped while it still fits, in the reverse of the loss order (the context, which the
 * ADR's order values over the turns, first), and never what the ladder did to the model, the provider or the cost: a cost that was shortened stays in
 * its short form WITH ITS MARKER (it is never re-expanded into a clean-looking amount), and a line whose model was cut has no room left to give.
 * The wording and the order of the steps themselves are `status-line.test.ts`'s.
 */
import { describe, expect, it } from 'vitest';

import { type ChatStatusInput, statusLine } from './status-line.js';
import { displayWidth } from './viewport.js';

const CHAT: ChatStatusInput = {
  surface: 'chat',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  mode: 'ask',
  turns: 3,
  cost: { full: '$0.0123', short: '$0.01', qualified: false },
  contextPercent: 18,
};

const QUALIFIED: ChatStatusInput = {
  ...CHAT,
  cost: { full: '$0.12 known; usage unverified', short: '~$0.12?', qualified: true },
};

/** A chat draws its status line at column 0, so its budget is the terminal's width. */
const line = (input: ChatStatusInput, columns: number) => statusLine(input, columns, 0);

const TURNS = ' · 3 turns';
const CONTEXT = ' · ctx 18% used';

describe('a chat line takes back what it dropped while it fits', () => {
  it('restores the turns when the ladder dropped them together with the context and the room that frees would hold them', () => {
    // 75 columns hold everything; at 64 the ladder drops the turns (10) and the context (15) for the 11 it needs, and 14 columns are then free.
    expect(line(CHAT, 75).cut).toEqual([]);
    expect(line(CHAT, 64)).toEqual({
      text: 'anthropic · claude-sonnet-4-6 · ask mode · 3 turns · $0.0123',
      cut: ['context'],
    });
  });

  it('restores the context first when only one of the two fits: the loss order values it over the turns', () => {
    // The ladder shortens the cost for 22 columns and leaves 20 free at 70: room for the context (15) or the turns (10), not for both (25).
    expect(line(QUALIFIED, 70)).toEqual({
      text: 'anthropic · claude-sonnet-4-6 · ask mode · ~$0.12? · ctx 18% used',
      cut: ['turns', 'cost'],
    });
  });

  it('leaves what the ladder left when no dropped part fits in the room that is free', () => {
    // at 58 the ladder stops at 50 columns and 8 are free: neither the turns (10) nor the context (15) fits
    expect(line(CHAT, 58)).toEqual({
      text: 'anthropic · claude-sonnet-4-6 · ask mode · $0.0123',
      cut: ['turns', 'context'],
    });
    expect(line(CHAT, 48)).toEqual({
      text: 'anthropic · claude-sonnet-4-6 · ask mode · $0.01',
      cut: ['turns', 'context', 'cost'],
    });
  });

  it('keeps a shortened cost in its short form with its marker while it takes the turns back', () => {
    const { text, cut } = line(QUALIFIED, 64);
    expect(text).toBe('anthropic · claude-sonnet-4-6 · ask mode · 3 turns · ~$0.12?');
    expect(cut).toEqual(['context', 'cost']);
    expect(text).not.toMatch(/\$0\.12(?! known; usage unverified)(?!\?)/u);
  });

  it('never leaves a clean-looking amount for a qualified cost at any width, restored parts or not', () => {
    for (let columns = 20; columns <= 200; columns += 1) {
      const { text } = line(QUALIFIED, columns);
      expect(text, String(columns)).not.toMatch(/\$0\.12(?! known; usage unverified)(?!\?)/u);
    }
  });
});

describe('the restore leaves no room it could have used, and the line never grows past its budget', () => {
  const INPUTS: readonly { readonly name: string; readonly input: ChatStatusInput }[] = [
    { name: 'a clean cost', input: CHAT },
    { name: 'a qualified cost', input: QUALIFIED },
    { name: 'an effort', input: { ...CHAT, mode: 'accept-edits', effort: 'high' } },
    { name: 'no provider', input: { ...CHAT, provider: undefined } },
    {
      name: 'a long model id',
      input: { ...CHAT, model: 'claude-sonnet-4-6-extended-identifier-0123456789-abcdefghij' },
    },
  ];

  /** The words that are never cut, written independently of the module. */
  const neverCut = (input: ChatStatusInput): number =>
    displayWidth(
      input.effort === undefined
        ? `${input.mode} mode`
        : `${input.mode} mode · effort ${input.effort}`,
    );

  it.each(INPUTS)(
    '$name: from 30 to 200 columns no dropped part would also fit in the room the line leaves',
    ({ input }) => {
      for (let columns = 30; columns <= 200; columns += 1) {
        const { text } = line(input, columns);
        const wide = displayWidth(text);
        const turnsDropped = !/\d+ turns?/u.test(text);
        const contextDropped = !text.includes('ctx ');
        if (turnsDropped)
          expect(wide + displayWidth(TURNS), `${String(columns)} turns`).toBeGreaterThan(columns);
        if (contextDropped)
          expect(wide + displayWidth(CONTEXT), `${String(columns)} ctx`).toBeGreaterThan(columns);
      }
    },
  );

  it.each(INPUTS)(
    '$name: reports as cut exactly the parts that are not in the text',
    ({ input }) => {
      for (let columns = 30; columns <= 200; columns += 1) {
        const { text, cut } = line(input, columns);
        expect(cut.includes('turns'), `${String(columns)} turns`).toBe(!/\d+ turns?/u.test(text));
        expect(cut.includes('context'), `${String(columns)} context`).toBe(!text.includes('ctx '));
      }
    },
  );

  it.each(INPUTS)(
    '$name: the line fits its budget from the width of the words that are never cut up',
    ({ input }) => {
      for (let columns = Math.max(30, neverCut(input)); columns <= 200; columns += 1)
        expect(displayWidth(line(input, columns).text), String(columns)).toBeLessThanOrEqual(
          columns,
        );
    },
  );

  it('gives nothing back to a line whose model or provider was cut to fit, at any width', () => {
    const cases: readonly ChatStatusInput[] = [
      { ...CHAT, model: 'claude-sonnet-4-6-extended-identifier-0123456789-abcdefghij' },
      {
        ...CHAT,
        provider: 'a-provider-with-a-rather-long-name',
        model: 'gpt-5',
        cost: { full: '$12.34 known; usage unverified', short: '$12.34 known', qualified: true },
      },
    ];
    let reached = 0;
    for (const input of cases) {
      for (let columns = 1; columns <= 200; columns += 1) {
        const { text, cut } = line(input, columns);
        if (!cut.includes('model') && !cut.includes('provider')) continue;
        reached += 1;
        expect(text, String(columns)).not.toMatch(/\d+ turns?/u);
        expect(text, String(columns)).not.toContain('ctx ');
      }
    }
    expect(reached, 'the probe reaches lines with a cut model or provider').toBeGreaterThan(60);
  });

  it('shows no counter once the cost was replaced by its word or dropped, in the room that gave up', () => {
    // no provider and no model: the last resort goes straight to the cost, and 13 columns are free at 21 (the turns take 10)
    const bare: ChatStatusInput = {
      ...CHAT,
      provider: undefined,
      model: '',
      cost: { full: '$12.34 known; usage unverified', short: '$12.34 known', qualified: true },
    };
    expect(line(bare, 21)).toEqual({ text: 'ask mode', cut: ['turns', 'context', 'cost'] });
    expect(line(bare, 22)).toEqual({
      text: 'ask mode · unavailable',
      cut: ['turns', 'context', 'cost'],
    });
    // and beside a cost that fits, the same chat takes the turns back
    expect(line(bare, 33).text).toBe('ask mode · 3 turns · $12.34 known');
  });
});
