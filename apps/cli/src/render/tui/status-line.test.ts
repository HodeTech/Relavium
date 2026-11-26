/**
 * The one status line of the Home and of a chat ([ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §2): its wording, the order in which it gives parts up, the words and the cost that are never cut or made to look clean, and the hostile
 * text every free string of it can carry. Texts are written out in full, so a drifted wording or a changed order shows as a diff.
 */
import { describe, expect, it } from 'vitest';

import {
  type ChatStatusInput,
  type HomeStatusInput,
  keepEnds,
  keepStart,
  MODEL_FLOOR,
  PROVIDER_FLOOR,
  statusLine,
} from './status-line.js';
import { displayWidth } from './viewport.js';

/** The width the line has, written independently of the module: the columns less the margin (6 below 100 columns, 8 from 100). */
const budgetOf = (columns: number): number => columns - (columns >= 100 ? 8 : 6);

const KEY_SHAPED = ['sk', 'ant', 'api03', 'ABCDEFGHIJKLMNOPQRSTUVWX0123456789abcdef'].join('-');

const HOME: HomeStatusInput = {
  surface: 'home',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  mode: 'ask',
  directory: '~/acme-web',
};

const DEEP: HomeStatusInput = { ...HOME, directory: '~/work/clients/acme/web-frontend' };
const EFFORT: HomeStatusInput = { ...DEEP, effort: 'high' };

const CHAT: ChatStatusInput = {
  surface: 'chat',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  mode: 'ask',
  turns: 3,
  cost: { full: '$0.0123', short: '$0.01', qualified: false },
  contextPercent: 18,
};

const QUALIFIED_FULL = '$0.12 known; usage unverified';
const QUALIFIED_SHORT = '~$0.12?';
const QUALIFIED: ChatStatusInput = {
  ...CHAT,
  cost: { full: QUALIFIED_FULL, short: QUALIFIED_SHORT, qualified: true },
};

describe('the Home status line: its words', () => {
  it('says the defaults are for the next chat, then the directory after a gap of three spaces', () => {
    expect(statusLine(HOME, 120)).toEqual({
      text: 'next chat: anthropic · claude-sonnet-4-6 · ask mode   ~/acme-web',
      cut: [],
    });
  });

  it('keeps the effort inside the group of defaults, before the gap', () => {
    expect(statusLine({ ...HOME, effort: 'high' }, 120).text).toBe(
      'next chat: anthropic · claude-sonnet-4-6 · ask mode · effort high   ~/acme-web',
    );
  });

  it('writes every mode as "<mode> mode", so auto reads "auto mode"', () => {
    expect(statusLine({ ...HOME, mode: 'auto' }, 120).text).toContain(' · auto mode   ');
    expect(statusLine({ ...HOME, mode: 'accept-edits' }, 120).text).toContain(
      ' · accept-edits mode   ',
    );
  });

  it('leaves the provider and its separator out when the provider is unknown', () => {
    const input: HomeStatusInput = {
      surface: 'home',
      model: 'claude-sonnet-4-6',
      mode: 'ask',
      directory: '~/acme-web',
    };
    expect(statusLine(input, 120).text).toBe(
      'next chat: claude-sonnet-4-6 · ask mode   ~/acme-web',
    );
  });

  it('leaves the model and its separator out when the model is unknown', () => {
    const input: HomeStatusInput = {
      surface: 'home',
      provider: 'anthropic',
      mode: 'ask',
      directory: '~/acme-web',
    };
    expect(statusLine(input, 120).text).toBe('next chat: anthropic · ask mode   ~/acme-web');
  });

  it('drops the "next chat:" label too when there is neither a provider nor a model, and says nothing about a model', () => {
    const input: HomeStatusInput = { surface: 'home', mode: 'ask', directory: '~/acme-web' };
    expect(statusLine(input, 120).text).toBe('ask mode   ~/acme-web');
    expect(statusLine({ ...input, effort: 'high' }, 120).text).toBe(
      'ask mode · effort high   ~/acme-web',
    );
  });

  it('treats an empty or all-hostile provider, model and effort as unknown', () => {
    const input: HomeStatusInput = { ...HOME, provider: '', model: '\u202E\u200B', effort: ' ' };
    expect(statusLine(input, 120).text).toBe('ask mode   ~/acme-web');
  });

  it('draws no gap and no directory when there is no directory', () => {
    expect(statusLine({ ...HOME, directory: '' }, 120).text).toBe(
      'next chat: anthropic · claude-sonnet-4-6 · ask mode',
    );
  });
});

describe('the Home status line: what goes first, one step at a time', () => {
  it('fits the line exactly at its budget and cuts nothing: 70 columns hold 64', () => {
    expect(statusLine(HOME, 70)).toEqual({
      text: 'next chat: anthropic · claude-sonnet-4-6 · ask mode   ~/acme-web',
      cut: [],
    });
  });

  it('cuts the DIRECTORY first, its leading names becoming … and the last name staying whole', () => {
    expect(statusLine(DEEP, 80)).toEqual({
      text: 'next chat: anthropic · claude-sonnet-4-6 · ask mode   …/acme/web-frontend',
      cut: ['directory'],
    });
    expect(statusLine(DEEP, 74)).toEqual({
      text: 'next chat: anthropic · claude-sonnet-4-6 · ask mode   …/web-frontend',
      cut: ['directory'],
    });
  });

  it('keeps the directory whole while it fits and cuts it as soon as one column is missing', () => {
    expect(statusLine({ ...HOME, directory: '~/work/acme' }, 71)).toEqual({
      text: 'next chat: anthropic · claude-sonnet-4-6 · ask mode   ~/work/acme',
      cut: [],
    });
    expect(statusLine({ ...HOME, directory: '~/work/acme' }, 70)).toEqual({
      text: 'next chat: anthropic · claude-sonnet-4-6 · ask mode   …/acme',
      cut: ['directory'],
    });
  });

  it('cuts the MODEL id in its middle only after the directory is down to …/<last>, and keeps both ends', () => {
    expect(statusLine(DEEP, 72)).toEqual({
      text: 'next chat: anthropic · claude-sonn…4-6 · ask mode   …/web-frontend',
      cut: ['directory', 'model'],
    });
    expect(statusLine(DEEP, 69).text).toBe(
      'next chat: anthropic · claude-so…-6 · ask mode   …/web-frontend',
    );
  });

  it('cuts the model alone when the directory has nothing left to give', () => {
    expect(statusLine(HOME, 69)).toEqual({
      text: 'next chat: anthropic · claude-sonne…4-6 · ask mode   ~/acme-web',
      cut: ['model'],
    });
    expect(statusLine(HOME, 68).text).toBe(
      'next chat: anthropic · claude-sonn…4-6 · ask mode   ~/acme-web',
    );
  });

  it('cuts the PROVIDER at its end only after the model is down to its 12-column floor', () => {
    expect(statusLine(DEEP, 66)).toEqual({
      text: 'next chat: anthr… · claude-so…-6 · ask mode   …/web-frontend',
      cut: ['directory', 'model', 'provider'],
    });
    expect(statusLine(DEEP, 62).text).toBe(
      'next chat: a… · claude-so…-6 · ask mode   …/web-frontend',
    );
  });

  it('does not report the model cut while the model is already at or under its floor', () => {
    const short = statusLine(
      { ...HOME, model: 'haiku', directory: '~/a/very/deep/folder/name/here' },
      50,
    );
    expect(short).toEqual({
      text: 'next chat: anth… · haiku · ask mode   …/here',
      cut: ['directory', 'provider'],
    });
  });

  it('cuts the directory BY CHARACTERS only as the last resort, when the last name is wider than the rest can spare', () => {
    expect(statusLine(EFFORT, 80)).toEqual({
      text: 'next chat: anthr… · claude-so…-6 · ask mode · effort high   …/web-frontend',
      cut: ['directory', 'model', 'provider'],
    });
    expect(statusLine(EFFORT, 75).text).toBe(
      'next chat: a… · claude-so…-6 · ask mode · effort high   …web-frontend',
    );
    expect(statusLine(EFFORT, 70).text).toBe(
      'next chat: a… · claude-so…-6 · ask mode · effort high   …rontend',
    );
  });

  it('drops a directory that would be a lone … or a letter or two, and the gap with it', () => {
    expect(statusLine(EFFORT, 64).text).toBe(
      'next chat: a… · claude-so…-6 · ask mode · effort high',
    );
    expect(statusLine(EFFORT, 60).text).toBe(
      'next chat: a… · claude-so…-6 · ask mode · effort high',
    );
  });

  it('reports each part once, in the order it was given up', () => {
    expect(statusLine(EFFORT, 62).cut).toEqual(['directory', 'model', 'provider']);
  });

  it('flips the budget at 100 columns: the margin is 6 below it and 8 from it', () => {
    const wide: HomeStatusInput = { ...EFFORT, directory: `~/${'a'.repeat(22)}` };
    const fits = statusLine(wide, 100);
    expect(displayWidth(fits.text)).toBe(92);
    expect(fits.cut).toEqual([]);
    const over: HomeStatusInput = { ...EFFORT, directory: `~/${'a'.repeat(23)}` };
    expect(statusLine(over, 99).cut).toEqual([]);
    expect(displayWidth(statusLine(over, 99).text)).toBe(93);
    expect(statusLine(over, 100).cut).toContain('model');
  });
});

describe('the Home status line: mode and effort are never cut', () => {
  const crowded: HomeStatusInput = {
    surface: 'home',
    provider: 'a-provider-with-a-rather-long-name',
    model: 'a-model-id-that-is-much-too-long-to-ever-fit-in-a-status-line',
    mode: 'accept-edits',
    effort: 'medium',
    directory: `~/${'deep/'.repeat(30)}project`,
  };

  it('keeps "<mode> mode" and "effort <e>" whole at 60 and at 50 columns, however long everything else is', () => {
    for (const columns of [200, 120, 100, 80, 70, 60, 50, 40, 30]) {
      const { text } = statusLine(crowded, columns);
      expect(text, String(columns)).toContain(' · accept-edits mode · effort medium');
    }
  });

  it('fits the budget from 70 columns up and, below, only ever overflows by the parts that are never cut', () => {
    for (let columns = 70; columns <= 200; columns += 1) {
      expect(displayWidth(statusLine(crowded, columns).text), String(columns)).toBeLessThanOrEqual(
        budgetOf(columns),
      );
    }
  });

  it('cuts the model to its floor and the provider to its floor before it gives up a column of the mode', () => {
    const { text } = statusLine(crowded, 50);
    const [label, ...rest] = text.split(' · ');
    expect(label).toBe('next chat: a…');
    expect(rest[0]).toHaveLength(MODEL_FLOOR);
    expect(displayWidth('a…')).toBe(PROVIDER_FLOOR);
  });
});

describe('the chat status line: its words', () => {
  it('reads provider, model, mode, turns, cost and context in that order', () => {
    expect(statusLine(CHAT, 120)).toEqual({
      text: 'anthropic · claude-sonnet-4-6 · ask mode · 3 turns · $0.0123 · ctx 18% used',
      cut: [],
    });
  });

  it('puts the effort after the mode when it is set, and leaves it out when it is not', () => {
    expect(statusLine({ ...CHAT, effort: 'high' }, 120).text).toBe(
      'anthropic · claude-sonnet-4-6 · ask mode · effort high · 3 turns · $0.0123 · ctx 18% used',
    );
    expect(statusLine(CHAT, 120).text).not.toContain('effort');
  });

  it('writes auto as "auto mode"', () => {
    expect(statusLine({ ...CHAT, mode: 'auto' }, 120).text).toContain(' · auto mode · ');
  });

  it('writes 1 turn in the singular and 0 and 2 in the plural', () => {
    expect(statusLine({ ...CHAT, turns: 1 }, 120).text).toContain(' · 1 turn · ');
    expect(statusLine({ ...CHAT, turns: 0 }, 120).text).toContain(' · 0 turns · ');
    expect(statusLine({ ...CHAT, turns: 2 }, 120).text).toContain(' · 2 turns · ');
    expect(statusLine({ ...CHAT, turns: 12 }, 120).text).toContain(' · 12 turns · ');
  });

  it('treats a turn count that is not a count as 0 turns, never as NaN', () => {
    expect(statusLine({ ...CHAT, turns: Number.NaN }, 120).text).toContain(' · 0 turns · ');
    expect(statusLine({ ...CHAT, turns: -4 }, 120).text).toContain(' · 0 turns · ');
  });

  it('leaves the context out when it is unknown and clamps and rounds it when it is not', () => {
    const noContext: ChatStatusInput = {
      surface: 'chat',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      mode: 'ask',
      turns: 3,
      cost: { full: '$0.0123', short: '$0.01', qualified: false },
    };
    expect(statusLine(noContext, 120).text).toBe(
      'anthropic · claude-sonnet-4-6 · ask mode · 3 turns · $0.0123',
    );
    expect(statusLine({ ...CHAT, contextPercent: Number.NaN }, 120).text).not.toContain('ctx');
    expect(statusLine({ ...CHAT, contextPercent: 0 }, 120).text).toContain(' · ctx 0% used');
    expect(statusLine({ ...CHAT, contextPercent: 17.6 }, 120).text).toContain(' · ctx 18% used');
    expect(statusLine({ ...CHAT, contextPercent: 250 }, 120).text).toContain(' · ctx 100% used');
    expect(statusLine({ ...CHAT, contextPercent: -3 }, 120).text).toContain(' · ctx 0% used');
  });

  it('leaves the provider and its separator out when the provider is unknown', () => {
    const input: ChatStatusInput = {
      surface: 'chat',
      model: 'claude-sonnet-4-6',
      mode: 'ask',
      turns: 3,
      cost: { full: '$0.0123', short: '$0.01', qualified: false },
      contextPercent: 18,
    };
    expect(statusLine(input, 120).text).toBe(
      'claude-sonnet-4-6 · ask mode · 3 turns · $0.0123 · ctx 18% used',
    );
  });
});

describe('the chat status line: what goes first, one step at a time', () => {
  it('fits at its budget and cuts nothing: 81 columns hold 75', () => {
    expect(statusLine(CHAT, 81).cut).toEqual([]);
    expect(displayWidth(statusLine(CHAT, 81).text)).toBe(75);
  });

  it('drops the TURNS first', () => {
    expect(statusLine(CHAT, 80)).toEqual({
      text: 'anthropic · claude-sonnet-4-6 · ask mode · $0.0123 · ctx 18% used',
      cut: ['turns'],
    });
    expect(statusLine(CHAT, 71).cut).toEqual(['turns']);
  });

  it('drops the CONTEXT second, before the cost is touched (the ADR’s refinement of OD-9)', () => {
    // 65 columns (59 of budget) leave 9 free after both are dropped: the turns (10) do not fit back (`status-line-restore.test.ts`: at 70 they do).
    expect(statusLine(CHAT, 65)).toEqual({
      text: 'anthropic · claude-sonnet-4-6 · ask mode · $0.0123',
      cut: ['turns', 'context'],
    });
    expect(statusLine(CHAT, 56).text).toBe('anthropic · claude-sonnet-4-6 · ask mode · $0.0123');
  });

  it('switches the COST to its short form third', () => {
    expect(statusLine(CHAT, 50)).toEqual({
      text: 'anthropic · claude-so…4-6 · ask mode · $0.01',
      cut: ['turns', 'context', 'cost', 'model'],
    });
    expect(statusLine(CHAT, 55)).toEqual({
      text: 'anthropic · claude-sonnet-4-6 · ask mode · $0.01',
      cut: ['turns', 'context', 'cost'],
    });
  });

  it('cuts the MODEL in its middle fourth and the PROVIDER at its end fifth', () => {
    // 42 columns less the Home's margin of 6 are the 36 the two floors take; at 40 the old line was 36 wide in a budget of 34 (SE7-2: the
    // last resort now drops the provider there: `status-line-last-resort.test.ts`).
    expect(statusLine(CHAT, 42)).toEqual({
      text: 'a… · claude-so…-6 · ask mode · $0.01',
      cut: ['turns', 'context', 'cost', 'model', 'provider'],
    });
  });

  it('keeps the mode and the effort whole at 60 and 50 columns, and at 40 where the model and the provider are gone (SE7-2)', () => {
    for (const columns of [60, 50]) {
      const { text } = statusLine({ ...CHAT, mode: 'auto', effort: 'high' }, columns);
      expect(text, String(columns)).toContain(' · auto mode · effort high · ');
    }
    // 40 columns less the Home's margin are 34: the old line was 51 wide there and the view cut it; now nothing but the cost fits beside them.
    expect(statusLine({ ...CHAT, mode: 'auto', effort: 'high' }, 40).text).toBe(
      'auto mode · effort high · $0.01',
    );
  });

  it('does not switch to a short cost that is no shorter than the full one', () => {
    const input: ChatStatusInput = {
      ...CHAT,
      cost: { full: '$0.01', short: '$0.0123456', qualified: false },
    };
    expect(statusLine(input, 50).text).toContain(' · $0.01');
    expect(statusLine(input, 50).text).not.toContain('$0.0123456');
  });
});

describe('a qualified cost never reads as a clean amount', () => {
  it('shows the full qualified form while it fits', () => {
    expect(statusLine(QUALIFIED, 130).text).toBe(
      'anthropic · claude-sonnet-4-6 · ask mode · 3 turns · $0.12 known; usage unverified · ctx 18% used',
    );
  });

  it('gives up the turns and the context before it gives up the qualifier, and then uses the short form WITH ITS MARKER', () => {
    expect(statusLine(QUALIFIED, 100)).toEqual({
      text: 'anthropic · claude-sonnet-4-6 · ask mode · $0.12 known; usage unverified · ctx 18% used',
      cut: ['turns'],
    });
    // 84 columns (78 of budget) leave 6 free after both are dropped, and 62 (56) leave 6 free after the short form (`status-line-restore.test.ts`:
    // at 90 and at 70 the turns fit back).
    expect(statusLine(QUALIFIED, 84).cut).toEqual(['turns', 'context']);
    expect(statusLine(QUALIFIED, 62)).toEqual({
      text: 'anthropic · claude-sonnet-4-6 · ask mode · ~$0.12?',
      cut: ['turns', 'context', 'cost'],
    });
  });

  it('keeps the cost while it fits beside the mode and never shows its amount without a qualifier, at any width from 20 to 200', () => {
    // The cost goes only when not even its short form fits beside the mode word: `ask mode · ~$0.12?` is 18 columns, so 24 with the margin (SE7-2).
    for (let columns = 20; columns <= 200; columns += 1) {
      const { text } = statusLine(QUALIFIED, columns);
      if (columns >= 24)
        expect(
          text.includes(QUALIFIED_FULL) || text.includes(QUALIFIED_SHORT),
          String(columns),
        ).toBe(true);
      expect(text, String(columns)).not.toMatch(/\$0\.12(?! known; usage unverified)(?!\?)/u);
    }
  });

  it('refuses to draw a short form that is a bare amount for a qualified cost: it says unavailable instead', () => {
    const bug: ChatStatusInput = {
      ...CHAT,
      cost: { full: QUALIFIED_FULL, short: '$0.12', qualified: true },
    };
    for (let columns = 20; columns <= 200; columns += 1) {
      const { text } = statusLine(bug, columns);
      expect(text, String(columns)).not.toMatch(/\$0\.12(?! known; usage unverified)/u);
    }
    // 62 columns (56 of budget) leave 2 free: at 70 the turns fit back beside the word (`status-line-restore.test.ts`).
    expect(statusLine(bug, 62).text).toBe('anthropic · claude-sonnet-4-6 · ask mode · unavailable');
  });

  it('refuses a full form that is a bare amount too, and "free" in either form', () => {
    const bare: ChatStatusInput = {
      ...CHAT,
      cost: { full: '$3.40', short: '$3.40', qualified: true },
    };
    expect(statusLine(bare, 200).text).not.toContain('$3.40');
    expect(statusLine(bare, 200).text).toContain(' · unavailable · ');
    const free: ChatStatusInput = {
      ...CHAT,
      cost: { full: 'free', short: 'FREE', qualified: true },
    };
    expect(statusLine(free, 200).text).not.toMatch(/free/iu);
    expect(statusLine(free, 50).text).toContain('unavailable');
  });

  it('shows a clean amount, and "free", when the cost is NOT qualified', () => {
    const free: ChatStatusInput = {
      ...CHAT,
      cost: { full: 'free', short: 'free', qualified: false },
    };
    expect(statusLine(free, 200).text).toContain(' · free · ');
    expect(statusLine(CHAT, 200).text).toContain(' · $0.0123 · ');
  });

  it('keeps a cost that has no short form instead of dropping it', () => {
    const noShort: ChatStatusInput = {
      ...CHAT,
      cost: { full: '$0.0123', short: '', qualified: false },
    };
    expect(statusLine(noShort, 56).text).toBe('anthropic · claude-sonnet-4-6 · ask mode · $0.0123');
    expect(statusLine(noShort, 55)).toEqual({
      text: 'anthropic · claude-sonne…4-6 · ask mode · $0.0123',
      cut: ['turns', 'context', 'model'],
    });
    expect(statusLine(noShort, 40).text).toContain(' · $0.0123');
  });
});

describe('hostile values in the status line', () => {
  it('replaces a key-shaped model id with [REDACTED] on both surfaces', () => {
    const home = statusLine({ ...HOME, model: KEY_SHAPED }, 120).text;
    const chat = statusLine({ ...CHAT, model: KEY_SHAPED }, 120).text;
    for (const text of [home, chat]) {
      expect(text).toContain('[REDACTED]');
      expect(text).not.toContain('sk-ant');
      expect(text).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWX');
    }
  });

  it('removes bidirectional overrides and control characters from a directory and from every other value', () => {
    const hostile = [0x202e, 0x2067, 0x1b, 0x07, 0x00].map((code) => String.fromCharCode(code));
    const [bidi, isolate, escape, bell, nul] = hostile;
    const directory = statusLine(
      { ...HOME, directory: `~/a${bidi}b${escape}[31mred${bell}` },
      120,
    ).text;
    expect(directory).toContain('~/ab');
    const provider = statusLine({ ...HOME, provider: `any${isolate}thing${nul}` }, 120).text;
    expect(provider).toContain('next chat: anything · ');
    for (const text of [directory, provider]) {
      for (const character of hostile) expect(text.includes(character)).toBe(false);
    }
  });

  it('makes a " · " inside a value inert, so it adds no separator of the line', () => {
    const home = statusLine({ ...HOME, model: 'claude · evil', directory: '~/a · b' }, 120).text;
    expect(home).toBe('next chat: anthropic · claude - evil · ask mode   ~/a - b');
    expect(home.split(' · ')).toHaveLength(3);
    const chat = statusLine(
      { ...CHAT, provider: 'a · b', cost: { full: '$1 · $2', short: '$1', qualified: false } },
      160,
    ).text;
    expect(chat.split(' · ')).toHaveLength(6);
  });

  it('scrubs the mode word on both surfaces, and a mode that is nothing once scrubbed leaves only the directory', () => {
    expect(statusLine({ ...HOME, mode: 'a · b' }, 120).text).toBe(
      'next chat: anthropic · claude-sonnet-4-6 · a - b mode   ~/acme-web',
    );
    expect(statusLine({ ...CHAT, mode: 'a · b' }, 120).text).toContain(' · a - b mode · ');
    const bidi = String.fromCharCode(0x202e);
    expect(statusLine({ surface: 'home', mode: bidi, directory: '~/acme-web' }, 120).text).toBe(
      '~/acme-web',
    );
  });

  it('makes a chord token and a host glyph in a value inert', () => {
    const text = statusLine({ ...HOME, model: '[Ctrl+Y] allow', directory: '~/a│b✓c' }, 120).text;
    expect(text).not.toContain('[Ctrl+Y]');
    expect(text).not.toMatch(/[│✓]/u);
  });

  it('keeps the ellipsis the directory label itself starts with, and folds one inside a value into three dots', () => {
    expect(statusLine({ ...HOME, directory: '…/app' }, 120).text).toBe(
      'next chat: anthropic · claude-sonnet-4-6 · ask mode   …/app',
    );
    expect(statusLine({ ...HOME, model: 'a…b', directory: '~/x…y' }, 120).text).toBe(
      'next chat: anthropic · a...b · ask mode   ~/x...y',
    );
  });

  it('keeps a 300-character directory inside the budget at every width from 60 to 200, with the mode whole', () => {
    const input: HomeStatusInput = { ...HOME, effort: 'high', directory: `~/${'x'.repeat(300)}` };
    for (let columns = 60; columns <= 200; columns += 1) {
      const { text } = statusLine(input, columns);
      expect(displayWidth(text), String(columns)).toBeLessThanOrEqual(budgetOf(columns));
      expect(text, String(columns)).toContain(' · ask mode · effort high');
    }
  });

  it('keeps a long chat model and a long provider inside the budget from 60 to 200 columns', () => {
    const input: ChatStatusInput = {
      ...CHAT,
      provider: 'p'.repeat(80),
      model: 'm'.repeat(200),
      effort: 'high',
    };
    for (let columns = 60; columns <= 200; columns += 1) {
      const { text } = statusLine(input, columns);
      expect(displayWidth(text), String(columns)).toBeLessThanOrEqual(budgetOf(columns));
      expect(text, String(columns)).toContain(' · ask mode · effort high · ');
    }
  });

  it('measures DISPLAY columns, so wide characters never overflow the budget', () => {
    const cjk: HomeStatusInput = {
      ...HOME,
      effort: 'high',
      provider: '提供者提供者提供者',
      model: '模型模型模型模型模型模型模型模型',
      directory: '~/项目/客户端应用程序/前端项目/网站',
    };
    for (let columns = 60; columns <= 200; columns += 1) {
      const { text } = statusLine(cjk, columns);
      expect(displayWidth(text), String(columns)).toBeLessThanOrEqual(budgetOf(columns));
    }
    const chat: ChatStatusInput = {
      ...CHAT,
      provider: '提供者提供者提供者',
      model: '模型模型模型模型模型模型模型模型',
    };
    for (let columns = 60; columns <= 200; columns += 1) {
      expect(displayWidth(statusLine(chat, columns).text), String(columns)).toBeLessThanOrEqual(
        budgetOf(columns),
      );
    }
  });
});

describe('the status line at every width', () => {
  const inputs: readonly (HomeStatusInput | ChatStatusInput)[] = [
    HOME,
    DEEP,
    EFFORT,
    CHAT,
    QUALIFIED,
    { ...CHAT, mode: 'auto', effort: 'high' },
  ];

  it('never exceeds its budget from 60 columns up, and never loses the mode word, from 20 to 200', () => {
    for (const input of inputs) {
      for (let columns = 20; columns <= 200; columns += 1) {
        const { text } = statusLine(input, columns);
        expect(text, `${input.surface} ${String(columns)}`).toContain(`${input.mode} mode`);
        if (columns >= 60) {
          expect(displayWidth(text), `${input.surface} ${String(columns)}`).toBeLessThanOrEqual(
            budgetOf(columns),
          );
        }
      }
    }
  });

  it('reports a cut exactly when the text is narrower than the full line', () => {
    for (const input of inputs) {
      const full = statusLine(input, 400);
      expect(full.cut).toEqual([]);
      for (let columns = 40; columns <= 200; columns += 1) {
        const line = statusLine(input, columns);
        expect(line.cut.length === 0, `${input.surface} ${String(columns)}`).toBe(
          line.text === full.text,
        );
      }
    }
  });

  it('does not throw for a width that is not a number: it keeps the mode and cuts everything else to its floor', () => {
    expect(statusLine(EFFORT, Number.NaN)).toEqual({
      text: 'next chat: a… · claude-so…-6 · ask mode · effort high',
      cut: ['directory', 'model', 'provider'],
    });
    // A chat has a last resort the Home has not (SE7-2): with no room at all it is the mode word alone, never a line wider than its budget.
    expect(statusLine(CHAT, Number.NaN).text).toBe('ask mode');
  });
});

describe('keepEnds', () => {
  it('keeps both ends with a … between, the tail a quarter of what is kept', () => {
    expect(keepEnds('claude-haiku-5-5', 13)).toBe('claude-ha…5-5');
    expect(keepEnds('claude-sonnet-4-6', 12)).toBe('claude-so…-6');
    expect(keepEnds('abcdefghijklmnop', 9)).toBe('abcdef…op');
  });

  it('returns a text that fits unchanged, at the exact width too', () => {
    expect(keepEnds('abcdef', 6)).toBe('abcdef');
    expect(keepEnds('abcdef', 20)).toBe('abcdef');
    expect(keepEnds('', 0)).toBe('');
  });

  it('keeps the start behind a … below three columns, and nothing below one', () => {
    expect(keepEnds('abcdefghijklmnop', 3)).toBe('a…p');
    expect(keepEnds('abcdefghijklmnop', 2)).toBe('a…');
    expect(keepEnds('abcdefghijklmnop', 1)).toBe('…');
    expect(keepEnds('abcdefghijklmnop', 0)).toBe('');
    expect(keepEnds('abcdefghijklmnop', -4)).toBe('');
  });

  it('cuts wide characters whole: a character that would straddle the cut is left out, never split', () => {
    expect(keepEnds('漢字漢字漢字漢字', 9)).toBe('漢字漢…字');
    expect(displayWidth(keepEnds('漢字漢字漢字漢字', 9))).toBe(9);
    expect(keepEnds('漢字漢字', 4)).toBe('漢…');
    expect(displayWidth(keepEnds('漢字漢字', 4))).toBe(3);
    expect(keepEnds('漢字漢字', 2)).toBe('…');
  });

  it('never exceeds the width, for widths 0 to 30 over ASCII, CJK, emoji and combining marks', () => {
    const texts = [
      'claude-sonnet-4-6',
      '漢字漢字漢字漢字漢字漢字',
      'a漢b字c漢d字e漢f字g',
      '😀😀😀😀😀😀😀😀😀😀',
      'e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301',
      '👨\u200D👩\u200D👧\u200D👦👨\u200D👩\u200D👧\u200D👦👨\u200D👩\u200D👧\u200D👦👨\u200D👩\u200D👧\u200D👦',
    ];
    for (const text of texts) {
      for (let width = 0; width <= 30; width += 1) {
        expect(
          displayWidth(keepEnds(text, width)),
          `${text} in ${String(width)}`,
        ).toBeLessThanOrEqual(width);
      }
    }
  });

  it('never splits a combining sequence or an emoji family from its base', () => {
    expect(keepEnds('e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301', 5)).toBe(
      'e\u0301e\u0301e\u0301…e\u0301',
    );
    expect(
      keepEnds(
        '👨\u200D👩\u200D👧\u200D👦👨\u200D👩\u200D👧\u200D👦👨\u200D👩\u200D👧\u200D👦👨\u200D👩\u200D👧\u200D👦',
        5,
      ),
    ).toBe('👨\u200D👩\u200D👧\u200D👦…');
  });
});

describe('keepStart', () => {
  it('keeps the start behind a …', () => {
    expect(keepStart('anthropic', 6)).toBe('anthr…');
    expect(keepStart('anthropic', 2)).toBe('a…');
    expect(keepStart('anthropic', 1)).toBe('…');
    expect(keepStart('anthropic', 0)).toBe('');
  });

  it('returns a text that fits unchanged and cuts wide characters whole', () => {
    expect(keepStart('anthropic', 9)).toBe('anthropic');
    expect(keepStart('提供者提供者', 6)).toBe('提供…');
    expect(displayWidth(keepStart('提供者提供者', 6))).toBe(5);
  });
});
