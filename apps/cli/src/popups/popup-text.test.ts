/**
 * The text of every popup that shows a project's, a provider's or a catalog's words ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §8):
 * the width every popup line is written for, the one wrap, and the ONE scrub every untrusted string passes. The scrub is held here for every
 * sink of both callers (the doctor's list row, detail and copy; the four reports), so a change to it that lets one string through anywhere fails
 * in this file.
 */
import { describe, expect, it } from 'vitest';

import { boundAgentView, type BoundAgentView } from '../chat/bound-agent-view.js';
import { displayWidth } from '../render/tui/viewport.js';
import { agentReportLines } from './agent-popup.js';
import { costReportLines } from './cost-popup.js';
import { checksContent, detailContent, doctorCopyText } from './doctor-popup.js';
import { check } from './doctor.test-support.js';
import { POPUP_NOTICE_MAX_COLUMNS } from './geometry.js';
import { helpLines } from './help-popup.js';
import { POPUP_TEXT_COLUMNS, scrubPopupText, wrapHanging, wrapPopupText } from './popup-text.js';
import { catalogEntry, costReading, costRow } from './report.test-support.js';
import { workflowsContent } from './workflows-popup.js';

describe('the width', () => {
  it('is the inner width of a standard popup at the 80-column floor: 66', () => {
    expect(POPUP_TEXT_COLUMNS).toBe(66);
    // A notification is drawn beside the way back in the legend row, so it has less room than a line of text has.
    expect(POPUP_NOTICE_MAX_COLUMNS).toBeLessThan(POPUP_TEXT_COLUMNS);
  });
});

describe('wrapPopupText', () => {
  it('breaks between words, at most `columns` wide, and ends no line with a space', () => {
    const lines = wrapPopupText('one two three four five six', 12);
    expect(lines).toEqual(['one two', 'three four', 'five six']);
    for (const line of lines) expect(line).toBe(line.trimEnd());
  });

  it('breaks a word wider than the room where it must, and loses nothing', () => {
    const lines = wrapPopupText(`x${'y'.repeat(30)}z`, 10);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(10);
    expect(lines.join('')).toBe(`x${'y'.repeat(30)}z`);
  });

  it('starts every continuation line where the first starts: a line that ended before a space does not leave it as an indent', () => {
    // 'aaaa bbbb' is exactly 9 wide, so the break falls on the space that follows it and `wrapWords` keeps that space at the head of the next line.
    expect(wrapPopupText('aaaa bbbb cccc', 9)).toEqual(['aaaa bbbb', 'cccc']);
    // The first line keeps its own indent (a caller indents what it wraps), the lines after it have none.
    expect(wrapPopupText('  aaaa bbbb cccc', 11)).toEqual(['  aaaa bbbb', 'cccc']);
  });

  it('uses the popup’s width when it is not given one', () => {
    const lines = wrapPopupText('word '.repeat(40));
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(POPUP_TEXT_COLUMNS);
  });
});

describe('wrapHanging', () => {
  it('keeps a text that fits as one line, and indents what continues under its first line by `hang`', () => {
    expect(wrapHanging('short row', 20)).toEqual(['short row']);
    expect(wrapHanging('aaaa bbbb cccc dddd', 10, 4)).toEqual([
      'aaaa bbbb',
      '    cccc',
      '    dddd',
    ]);
  });

  it('indents by four columns unless told otherwise, and never lets a continuation pass the width', () => {
    const lines = wrapHanging(`${'word '.repeat(30)}end`, 30);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines.slice(1)) expect(line.startsWith('    ')).toBe(true);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(30);
    expect(lines.join(' ').replaceAll(/\s+/gu, ' ')).toBe(`${'word '.repeat(30)}end`);
  });
});

describe('wrapHanging: every line after the first starts at the hang (found on the real binary, review round 1)', () => {
  it('a chain that breaks just before a space does not start the next line one column deeper than the others', () => {
    const chain = [
      'start',
      ...Array.from({ length: 12 }, (_, at) => `step-${String(at + 1)}`),
      'out',
    ].join(' → ');
    // As the detail wraps its rows: two columns less than a line of text has (a section row is drawn two columns in).
    const lines = wrapHanging(`Nodes    ${chain}`, POPUP_TEXT_COLUMNS - 2, 9);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines.slice(1)) {
      expect(line.startsWith(' '.repeat(9)), line).toBe(true);
      expect(line.slice(9).startsWith(' '), `no extra space: "${line}"`).toBe(false);
    }
    for (const line of lines)
      expect(displayWidth(line)).toBeLessThanOrEqual(POPUP_TEXT_COLUMNS - 2);
  });

  it('holds wherever the break falls: for every width the continuation lines all start at the hang', () => {
    const text =
      'Nodes    start → step-1 → step-2 → step-3 → step-4 → step-5 → step-6 → step-7 → out';
    for (let columns = 24; columns <= 80; columns += 1)
      for (const line of wrapHanging(text, columns, 9).slice(1))
        expect(/^ {9}\S/u.test(line), `${String(columns)}: "${line}"`).toBe(true);
  });
});

describe('no wrap leaves a line that starts with a lone slash', () => {
  it('moves the break to before the word in front of it, so a slash that means "or" stays with the word it follows', () => {
    // `off / low / medium / high / max.`: a break before the fourth `/` would leave `/ high / max.` at the head of a line, which reads as a command.
    expect(wrapPopupText('Set the tier: off / low / medium / high / max.', 31)).toEqual([
      'Set the tier: off / low /',
      'medium / high / max.',
    ]);
    expect(wrapPopupText('one two three / four', 14)).toEqual(['one two', 'three / four']);
    // A line that does not start with a lone slash is left where `wrapWords` broke it: a path, a command and a slash glued to a word are words.
    expect(wrapPopupText('see the file /etc/hosts and /help now', 18)).toEqual([
      'see the file',
      '/etc/hosts and',
      '/help now',
    ]);
  });

  it('holds for the hanging form too, and for a slash that would head the first continuation or a later one', () => {
    // The slash would head the first continuation (`aaa bbb ccc ` fills the first row): `ccc` goes down with it.
    expect(wrapHanging('aaa bbb ccc / eee', 12, 4)).toEqual(['aaa bbb', '    ccc /', '    eee']);
    // And one that would head a later continuation moves its word down the same way.
    expect(wrapHanging('aaa bbb ccc ddd eee / fff', 12, 4)).toEqual([
      'aaa bbb ccc',
      '    ddd',
      '    eee /',
      '    fff',
    ]);
    for (const columns of [10, 11, 12, 13, 14, 16, 20, 25]) {
      for (const lines of [
        wrapPopupText('aa bb / cc dd / ee ff / gg hh / ii', columns),
        wrapHanging('aa bb / cc dd / ee ff / gg hh / ii', columns, 2),
      ])
        for (const line of lines.slice(1))
          expect(line.trim(), `${String(columns)}: ${JSON.stringify(lines)}`).not.toMatch(
            /^\/(?:\s|$)/u,
          );
    }
  });

  it('keeps every word, in order, and no line wider than the columns, where a break was moved', () => {
    const text = 'aa bb / cc dd / ee ff / gg hh / ii';
    for (const columns of [10, 12, 14, 16]) {
      const lines = wrapPopupText(text, columns);
      expect(lines.join(' ').replaceAll(/\s+/gu, ' ')).toBe(text);
      for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(columns);
    }
  });

  it('leaves a slash that cannot move: a line of one word has no earlier word to break before', () => {
    expect(wrapPopupText('aaaaaaaaaa / bb', 10)).toEqual(['aaaaaaaaaa', '/ bb']);
    // The same where the one word has the space of the break in front of it (`wrapWords` keeps it): a break "before the word" would be at the
    // space, and leave an empty row. The slash stays, and no row is empty.
    expect(wrapPopupText('ccc a ccc / b', 5)).toEqual(['ccc a', 'ccc', '/ b']);
  });

  it('a lone slash that ENDS the text is moved too: the row `/` alone is a row that starts with one', () => {
    expect(wrapPopupText('aaa bbbb /', 8)).toEqual(['aaa', 'bbbb /']);
  });

  it('holds for every width from 20 to 69 over generated texts: the words keep their order and their single spaces, no row is empty or wider than the width, and a row starts with a lone slash only where the row before it is one word', () => {
    // A seeded generator: the same texts on every run.
    let seed = 20_251_124;
    const next = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 4_294_967_296;
    };
    const words = [
      '/',
      '/',
      'off',
      'low',
      'medium',
      'high',
      'max',
      'a',
      'bb',
      'ccc',
      'dddd',
      'eeeee',
      '/x',
    ];
    let slashEnded = 0;
    let moved = 0;
    for (let columns = 20; columns <= 69; columns += 1) {
      for (let sample = 0; sample < 300; sample += 1) {
        const count = 2 + Math.floor(next() * 30);
        // No two lone slashes side by side: a slash whose word in front is itself a slash has no word to move down (`a / / b`), and that is a form
        // the wrap leaves (pinned as a limit below).
        const picked: string[] = [];
        while (picked.length < count) {
          const word = words[Math.floor(next() * words.length)] ?? 'a';
          if (word === '/' && picked.at(-1) === '/') continue;
          picked.push(word);
        }
        const text = picked.join(' ');
        const rows = wrapPopupText(text, columns);
        const label = `${String(columns)} columns, ${JSON.stringify(text)} -> ${JSON.stringify(rows)}`;
        // Nothing lost, nothing added: the same words in the same order, and every space single (a row joined to the next one with one).
        expect(rows.join(' '), label).toBe(text);
        for (const row of rows) {
          expect(row, label).not.toBe('');
          expect(displayWidth(row), label).toBeLessThanOrEqual(columns);
          expect(row, label).not.toContain('  ');
        }
        // A row after the first starts with a lone slash only where the row before it is a single word: nothing earlier to break before.
        for (let at = 1; at < rows.length; at += 1) {
          if (!/^\/(?:\s|$)/u.test(rows[at] ?? '')) continue;
          expect((rows[at - 1] ?? '').trim().includes(' '), label).toBe(false);
        }
        if (picked.at(-1) === '/') slashEnded += 1;
        if (rows.some((row, at) => at > 0 && /\s\/$/u.test(row))) moved += 1;
      }
    }
    // The generator reached what it is for: texts that end with a lone slash, and slashes that had to be moved down.
    expect(slashEnded).toBeGreaterThan(200);
    expect(moved).toBeGreaterThan(200);
  });
});

describe('the one form the lone-slash rule leaves', () => {
  it('two lone slashes side by side: the slash in front is itself the word that would move down, so a row can still start with one (a limit, pinned)', () => {
    expect(wrapPopupText('medium max /x high / / /x off ccc low', 20)).toEqual([
      'medium max /x high',
      '/ / /x off ccc low',
    ]);
  });
});

describe('scrubPopupText', () => {
  it('takes the escapes, the forged key tokens and separators out of a string a project wrote', () => {
    const scrubbed = scrubPopupText('a\u001b[31m [Ctrl+Y] allow · [d] b');
    expect(scrubbed).not.toContain('\u001b');
    expect(scrubbed).not.toContain('[Ctrl+Y]');
    expect(scrubbed).not.toContain(' · ');
    expect(scrubbed).not.toContain('[d]');
    expect(scrubbed.startsWith('a')).toBe(true);
    expect(scrubbed.endsWith('b')).toBe(true);
  });
});

describe('the one scrub holds every sink of every popup that has it', () => {
  // Built at runtime (no contiguous secret literal: leakwatch).
  const SECRET = ['sk', 'ant', 'scrub', 'ABCDEF1234567890XYZ'].join('-');
  /** What a project, a provider, a model or a catalog could write: an escape, a forged answer chord, a forged field, a secret, a glyph, a bidi mark. */
  const EVIL = `x\u001b[31m [Ctrl+Y] allow · [d] ${SECRET} ✓› \u202E`;

  /** The agent a hostile project defined: every string of its view is hostile. */
  const hostileAgent = (): BoundAgentView => {
    const base = boundAgentView(
      {
        id: 'reviewer',
        name: 'Code reviewer',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        system_prompt: 'You review code.',
        tools: ['read_file'],
      },
      'high',
    );
    return {
      ...base,
      id: EVIL,
      name: EVIL,
      sourceLabel: EVIL,
      detail: { ...base.detail, model: EVIL, provider: EVIL, tools: [EVIL], promptHead: EVIL },
    };
  };

  /** Each place a popup draws or copies a string it did not write, with the hostile text in it: the doctor's three sinks, then the four reports. */
  const SINKS: readonly (readonly [name: string, drawn: () => string])[] = [
    [
      'the doctor’s list row (label and detail)',
      () => {
        const content = checksContent({ quick: [check('a', 'warn', EVIL, EVIL)] });
        if (content.kind !== 'list') throw new Error('a list');
        return content.rows.map((row) => `${row.label ?? ''} ${row.detail ?? ''}`).join('\n');
      },
    ],
    [
      'the doctor’s detail step',
      () => {
        const content = detailContent('quick', check('a', 'warn', EVIL, EVIL), 'home', {
          offered: false,
        });
        if (content.kind !== 'report') throw new Error('a report');
        return content.lines.join('\n');
      },
    ],
    [
      'the doctor’s copy',
      () =>
        doctorCopyText(
          {
            quick: [check('a', 'warn', EVIL, EVIL)],
            deep: { checks: [check('provider:x', 'fail', EVIL, EVIL)], ageMs: 5 },
          },
          false,
        ),
    ],
    [
      '/cost: a model id',
      () =>
        costReportLines(
          costReading(450, undefined, [
            costRow({ model: EVIL, costMicrocents: 12_000, conservativeMicrocents: 450 }),
          ]),
        ).join('\n'),
    ],
    ['/agent: every field of the view', () => agentReportLines(hostileAgent()).join('\n')],
    [
      '/workflows: a slug',
      () => {
        const content = workflowsContent({
          kind: 'catalog',
          workflows: [catalogEntry(EVIL, false)],
          agents: [catalogEntry(EVIL)],
        });
        if (content.kind !== 'report') throw new Error('a report');
        return content.lines.join('\n');
      },
    ],
    [
      '/workflows: the words of a fault',
      () => {
        const content = workflowsContent({ kind: 'fault', reason: EVIL });
        if (content.kind !== 'error') throw new Error('an error');
        return `${content.what}\n${content.next}`;
      },
    ],
    [
      '/help: the verb of a key the port handed in',
      () => helpLines('standalone-chat', [{ keys: 'Ctrl+K', verb: EVIL }]).join('\n'),
    ],
  ];

  it.each(SINKS)('%s carries none of it', (_name, drawn) => {
    const text = drawn();
    // The sink has something to be clean of: the visible start of the hostile text is there.
    expect(text).toContain('x');
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\u202E');
    // The forged answer chord and the forged field, as written: the product's own words (a legend, a title) may have a key or a separator.
    expect(text).not.toContain('[Ctrl+Y]');
    expect(text).not.toContain('allow ·');
    expect(text).not.toContain('· [d]');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('ABCDEF1234567890XYZ');
    expect(text).not.toContain('›');
  });

  it('is the same function the sinks call: a row’s label is exactly the scrubbed text', () => {
    const content = checksContent({ quick: [check('a', 'ok', EVIL, 'detail')] });
    if (content.kind !== 'list') throw new Error('a list');
    expect(content.rows[0]?.label).toBe(scrubPopupText(EVIL));
  });
});
