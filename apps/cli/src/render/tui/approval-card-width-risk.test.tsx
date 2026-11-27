import type { AskUserRequest, ToolApprovalRequest, ToolPreview } from '@relavium/core';
import { afterEach, describe, expect, it } from 'vitest';

import { initialQuestionCard } from './question-card-model.js';
import { projectQuestionCard } from './question-card.js';
import { projectRunCard } from './run-card-model.js';
import { isWidthRiskCodePoint } from './screen-text.js';
import { mountStandaloneChat, type ChatMount } from './surface-matrix/chat-host.js';
import type { Variant } from './surface-matrix/variants.js';
import { physicalRows, terminalColumns } from './terminal-wrap.test-support.js';
import { escapeReviewCharacter } from './tool-review-projection.js';
import { displayWidth } from './viewport.js';

/**
 * The approval card is a CONSENT surface: it ESCAPES what a terminal may draw wider than its layout counts, and never drops it (MVP-11 unit 9,
 * review round 2, S2-4, the lead's ruling). The review's proof (`out-r2s9-dock2.txt`, the fake's `rwpath`): a write to `report` followed by 31 skin
 * tones on a letter and `.txt  [Ctrl+Y] Allow means deny`. The layout counts the tones on a letter as nothing, the terminal draws each two
 * columns: the title row wrapped, the host's numbers `+1 -0 · 2 bytes` were pushed to the next physical row at column 37, the rest of the path
 * stood on a row of its own and the whole frame shifted. Escaped, every tone is `<U+1F3FD>`: the person sees each code point of what they approve,
 * and the row is as wide on the terminal as the card measured it. Each frame here is the real one, drawn again by the simulated terminal
 * (`terminal-wrap.test-support.ts`, built from tmux's measurements): no row of the card may wrap.
 */

const c = (code: number): string => String.fromCodePoint(code);
const TONE = c(0x1f3fd);
const TAIL = '.txt  [Ctrl+Y] Allow means deny';

/** The review's path, and the same with each of the other classes the screen filter rewrites (here escaped, never rewritten). */
const PATHS: readonly (readonly [string, string, string])[] = [
  ['skin tones on a letter (the review’s proof)', `report${TONE.repeat(31)}${TAIL}`, '<U+1F3FD>'],
  [
    'regional indicators that are not a flag',
    `report${`${c(0x1f1e6)}${c(0x1f1e7)}`.repeat(31)}${TAIL}`,
    '<U+1F1E6><U+1F1E7>',
  ],
  ['the Thai AM', `report${`${c(0x0e01)}${c(0x0e33)}`.repeat(31)}${TAIL}`, `${c(0x0e01)}<U+0E33>`],
  // review round 3: a text-default emoji base tmux draws two columns is drawn with its selector (legible, two columns to both)
  ['the narrow emoji bases', `report${c(0x261d).repeat(31)}${TAIL}`, `${c(0x261d)}${c(0xfe0f)}`],
  ['the wide tone marks', `report${`a${c(0x302e)}`.repeat(31)}${TAIL}`, 'a<U+302E>'],
];

const VARIANTS: readonly Variant[] = [true, false].flatMap((color) =>
  (['alt', 'inline'] as const).map(
    (renderer): Variant => ({ renderer, color, size: { cols: 80, rows: 24 } }),
  ),
);

/** A write that creates `path` with one line, `x`: the card's numbers read `+1 -0 · 2 bytes`. */
function createPreview(path: string): ToolPreview {
  return {
    kind: 'operation',
    target: path,
    fields: [],
    diff: {
      before: null,
      after: 'x\n',
      beforeEndings: 'empty',
      afterEndings: 'lf',
      stats: { addedLines: 1, removedLines: 0, beforeBytes: 0, afterBytes: 2 },
      lines: [{ kind: 'added', text: 'x', ending: 'lf', after: { line: 1, start: 0, end: 2 } }],
    },
  };
}

describe('the escape covers every code point the screen filter treats as a width risk', () => {
  it('a skin tone, a regional indicator, the Thai and Lao AM, U+FE0F and a lone surrogate: `<U+XXXX>`', () => {
    for (const [code, token] of [
      [0x1f3fb, '<U+1F3FB>'],
      [0x1f3ff, '<U+1F3FF>'],
      [0x1f1e6, '<U+1F1E6>'],
      [0x1f1ff, '<U+1F1FF>'],
      [0x0e33, '<U+0E33>'],
      [0x0eb3, '<U+0EB3>'],
      [0xfe0f, '<U+FE0F>'],
    ] as const) {
      expect(isWidthRiskCodePoint(c(code))).toBe(true);
      expect(escapeReviewCharacter(c(code), false)).toBe(token);
    }
    expect(escapeReviewCharacter(String.fromCharCode(0xd800), false)).toBe('<U+D800>');
    // ordinary text, an emoji and a CJK character are drawn as they are: the layout counts them as the terminal draws them
    for (const text of ['a', 'é', c(0x1f44d), c(0x4e2d), c(0x0e01)])
      expect(escapeReviewCharacter(text, false)).toBe(text);
  });
});

describe.each(PATHS)('a write to a path with %s', (_name, path, token) => {
  const mounts: ChatMount[] = [];
  afterEach(() => {
    for (const mount of mounts.splice(0)) mount.unmount();
  });

  it.each(
    VARIANTS.map(
      (variant) => [`${variant.renderer}, colour ${String(variant.color)}`, variant] as const,
    ),
  )(
    '%s, 80×24: the card escapes it, holds the host’s numbers and does not wrap',
    async (_label, variant) => {
      const mount = mountStandaloneChat(variant);
      mounts.push(mount);
      await mount.settle();
      const request: ToolApprovalRequest = {
        toolId: 'write_file',
        action: 'fs_write',
        preview: { path },
        unredactedPreview: { path },
      };
      mount.store
        .requestApproval(request, true, undefined, { callId: 'rw', preview: createPreview(path) })
        .catch(() => undefined);
      await mount.until(() => mount.text().includes('Approval needed'));
      await mount.settle();
      const frame = mount.frame();
      const label = frame.join('\n');
      const title = frame.find((row) => row.includes('Create report')) ?? '';
      // escaped, never dropped: the code points are on the card as tokens
      expect(title, label).toContain(`report${token}`);
      expect(label).toContain('+1 -0 · 2 bytes');
      // the card's header is drawn and no row of the frame is wider than the terminal draws it
      expect(label).toContain('Approval needed');
      for (const row of frame) expect(terminalColumns(row), row).toBeLessThanOrEqual(80);
      expect(physicalRows(frame, 80).length, label).toBe(frame.length);
    },
  );
});

/**
 * The other sheets that draw a model's words (S2-4's search): the question card (`ask_user`: the model's header, question, option labels and
 * descriptions) and a workflow gate's card (its message, which a template can fill with a node's output). Neither shows a target the person
 * approves: their words are prose, and they go through the screen's filter as a reply's do (the gate's card already removed the invisible code
 * points from author text). The checkpoint card draws no text of a model's; the docked tool row above a sheet is the turn's row, filtered.
 */
/**
 * What the core lets a question hold (`plainTextRefusal`: 150 bytes, at most four code points to a character): five letters with three tones
 * each (5 columns to the layout, 35 on the terminal), then a word that fills the rest of the card's row as the layout measures it.
 */
const TONED_QUESTION = `${`x${TONE.repeat(3)}`.repeat(5)} ${'a'.repeat(80)}`;

describe('a question with letters of three skin tones each before a long word (what the core’s refusal rules let through)', () => {
  const mounts: ChatMount[] = [];
  afterEach(() => {
    for (const mount of mounts.splice(0)) mount.unmount();
  });

  it.each(
    VARIANTS.map(
      (variant) => [`${variant.renderer}, colour ${String(variant.color)}`, variant] as const,
    ),
  )('%s, 80×24: no row of the card wraps', async (_label, variant) => {
    const mount = mountStandaloneChat(variant);
    mounts.push(mount);
    await mount.settle();
    const question: AskUserRequest = {
      questions: [
        {
          header: 'Pick',
          question: TONED_QUESTION,
          multiSelect: false,
          options: [
            { label: `alpha${TONE.repeat(3)}`, description: `first${TONE.repeat(3)}` },
            { label: 'beta', description: 'The second' },
          ],
        },
      ],
    };
    mount.store.requestQuestion(question).catch(() => undefined);
    await mount.until(() => mount.text().includes('beta'));
    await mount.settle();
    const frame = mount.frame();
    const label = frame.join('\n');
    expect(label).toContain('alpha');
    for (const row of frame) expect(terminalColumns(row), row).toBeLessThanOrEqual(80);
    expect(physicalRows(frame, 80).length, label).toBe(frame.length);
  });
});

describe('a workflow gate whose message carries skin tones on a letter or indicators that are not a flag (a template can fill it with a node’s output)', () => {
  it.each([
    [`x${TONE.repeat(40)} ${'a'.repeat(70)}`, 'a'.repeat(10)],
    [`Ship it? ${`${c(0x1f1e6)}${c(0x1f1e7)}`.repeat(40)}`, 'Ship it?'],
  ])(
    'no row of the card is wider on the terminal than the card measured it (%#)',
    (message, landmark) => {
      const projection = projectRunCard(
        {
          runId: 'run-0001',
          gates: [
            {
              runId: 'run-0001',
              gateId: 'g1',
              nodeId: 'review',
              gateType: 'approval',
              message,
              accepts: ['approved', 'rejected'],
            },
          ],
          cursor: 0,
          phase: 'open',
          notice: undefined,
          refused: false,
        },
        { columns: 80, rows: 24, nowMs: 0 },
      );
      const rows = projection.rows.map((row) => row.text);
      expect(rows.join('\n')).toContain(landmark);
      for (const row of rows) expect(terminalColumns(row), row).toBeLessThanOrEqual(80);
    },
  );
});

describe('the question card: two labels the core admits as different never draw alike (review round 3, R3S-4)', () => {
  const card = (labels: readonly string[], header = 'Pick'): readonly string[] =>
    projectQuestionCard(
      initialQuestionCard({
        questions: [
          {
            header,
            question: 'Which one?',
            multiSelect: false,
            options: labels.map((label) => ({ label, description: 'An option' })),
          },
        ],
      }),
      80,
    ).body.map((row) => row.text);

  it('`Ok` and `Ok🏽` (the filter drops the tone): every label of the question is written with what the filter drops escaped', () => {
    const rows = card(['Ok', `Ok${TONE}`]);
    const options = rows.filter((row) => /\b[12] /u.test(row));
    expect(options).toHaveLength(2);
    expect(options[0]).toMatch(/Ok$/u);
    expect(options[1]).toMatch(/Ok<U\+1F3FD>$/u);
    // a literal token cannot pose as one: it is escaped itself
    const forged = card(['Ok<U+1F3FD>', `Ok${TONE}`]).filter((row) => /\b[12] /u.test(row));
    expect(new Set(forged.map((row) => row.slice(row.indexOf('Ok')))).size).toBe(2);
  });

  it('labels that stay distinct draw as every row does: filtered, no escape', () => {
    const options = card([`Yes${TONE}`, 'No']).filter((row) => /\b[12] /u.test(row));
    expect(options[0]).toMatch(/Yes$/u);
    expect(options[1]).toMatch(/No$/u);
  });

  it('a label the escapes make wider than its row is cut with an ellipsis, never silently', () => {
    const wide = `x${TONE.repeat(3)}`.repeat(4); // 52 bytes: admitted; twelve escapes
    // the filter draws the first as `xxxx`: the two collide, so both are escaped and the first no longer fits its row
    const options = card([wide, 'xxxx']).filter((row) => /\b[12] /u.test(row));
    expect(options[0]?.endsWith('…')).toBe(true);
    for (const row of options) expect(displayWidth(row)).toBeLessThanOrEqual(78);
  });
});
