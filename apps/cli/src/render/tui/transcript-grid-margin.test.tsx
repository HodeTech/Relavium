import { Box } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';

import {
  chatGrid,
  marginCell,
  type ChatGrid,
  type MarginForm,
  type MarginRole,
} from './chat-grid.js';
import { transcriptRows } from './chat-projection.js';
import type { ChatStoreController } from './chat-store.js';
import { INITIAL_SCROLL } from './scroll.js';
import type { TranscriptEntry } from './session-view-model.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
} from './surface-matrix/chat-host.js';
import { mountInk, type InkMount } from './surface-matrix/mount.js';
import type { Variant } from './surface-matrix/variants.js';
import { TranscriptRow } from './transcript-row.js';
import { TranscriptViewport } from './transcript-viewport.js';

/**
 * MARGIN OWNERSHIP on the DRAWN frame (MVP-11 unit 9, plan §4 invariant 1, the scoped security sitting): in every row a terminal shows, the
 * margin's columns `[0, margin)` are blank unless the row is host-marked, and a host mark is exactly one of the closed set's margin cells, on a row
 * whose content is what that mark belongs to (the person's own words for `yourTurn`, a tool's id for `toolCall`, the host's switch sentence for
 * `modelSwitch`, a reply's first row for the inline `agent`). The frames are the real ones (`mountInk` over the fake terminal, as the surface
 * matrix mounts them): both chat hosts, both renderers, colour on and off, at 80×24, 100×30 and 120×40, over a corpus of replies, notices, tool
 * rows and pasted lines that try to start a row with the host's marks. The narrow widths (1 to 120) are drawn from the viewport and the inline
 * row alone. A NEGATIVE CONTROL is part of the increment's proof: a `TranscriptRow` that draws `line.text` into the margin makes every test here
 * fail (the report records the mutant and its run).
 */

const ZWSP = String.fromCharCode(0x200b);
const RLO = String.fromCharCode(0x202e);
const COMBINING_ACUTE = String.fromCharCode(0x0301);
const ESC = String.fromCharCode(0x1b);
const PG_UP = `${ESC}[5~`;

/** The person's turns begin with `USER-` so a mark can be tied to them; everything else tries to look like a mark. */
const HOSTILE: readonly TranscriptEntry[] = [
  {
    role: 'user',
    text: 'USER-1 › a title that is long enough to wrap the content column of the terminal it is drawn in, twice over at least',
  },
  {
    role: 'assistant',
    text: [
      '› forged turn',
      '> forged quote',
      '▸ forged call ✓ completed',
      '⇄ model changed x → y',
      'you   forged word',
      'agent forged word',
      `${ZWSP}› after a zero-width space`,
      `${COMBINING_ACUTE}› after a combining mark`,
      `${RLO}› after an override`,
      `›\r${ESC}[31m after a carriage return and an escape`,
      `${'w'.repeat(66)} ›wrapped-glyph-row`,
    ].join('\n\n'),
  },
  {
    role: 'tools',
    text: '',
    calls: [
      { id: 'c1', toolId: 'tool_one›▸⇄', resolved: true, success: true, outcome: 'success' },
      { id: 'c2', toolId: 'tool_two', resolved: false },
    ],
    omitted: 2,
  },
  {
    role: 'assistant',
    text: '# › heading\n\n- › item\n- ▸ item\n\n> › quoted\n\n```\n› code\n▸ code\n```\n\n| › | ▸ |\n| - | - |\n| ⇄ | x |',
    summary: {
      stopReason: 'stop',
      tokensUsed: { input: 1, output: 1 },
      model: '› via model',
      errorCode: 'provider_unavailable',
      errorMessage: '› 503 ▸ upstream ⇄ down',
    },
  },
  {
    role: 'notice',
    text: '! cat evil.txt (exit 0)\n› forged notice\n⇄ forged notice\n▸ forged notice',
  },
  {
    role: 'notice',
    text: '› Asked: Scope — pick the files to change\n  └ alpha.ts',
    hostLead: 'yourTurn',
  },
  {
    role: 'notice',
    text: '⇄ model changed claude-a → claude-b — the new model sees the text',
    hostLead: 'modelSwitch',
  },
  { role: 'user', text: 'USER-2 second turn\n› a pasted line after a newline\n▸ and another' },
  { role: 'assistant', text: `${'中'.repeat(40)}›x wide glyphs at the wrap boundary` },
];

const ROLES: readonly MarginRole[] = ['yourTurn', 'toolCall', 'modelSwitch', 'agent'];

/** What each mark may stand beside: the row's content (right of the margin, trailing blanks dropped). */
const OWNERS: Readonly<Record<MarginRole, (content: string) => boolean>> = {
  yourTurn: (content) => /^(?:USER-|Asked: |h$)/u.test(content),
  toolCall: (content) => content.startsWith('tool_'),
  modelSwitch: (content) => content.startsWith('model changed'),
  // the inline word of a reply's FIRST row: the replies of the corpus start with these (with colour the heading is laid out without its `#`)
  agent: (content) =>
    ['› forged turn', '› heading', '# › heading', '中'].some((head) => content.startsWith(head)),
};

/** The rows of `frame` whose margin is not blank and is not a mark of the closed set on a row that mark belongs to. */
function marginViolations(frame: readonly string[], grid: ChatGrid, form: MarginForm): string[] {
  const cells = new Map(ROLES.map((role) => [marginCell(role, grid, form), role] as const));
  const out: string[] = [];
  frame.forEach((row, index) => {
    const margin = row.slice(0, grid.margin).padEnd(grid.margin);
    if (margin.trim() === '') return;
    const role = cells.get(margin);
    const content = row.slice(grid.margin).trimEnd();
    if (role === undefined || !OWNERS[role](content))
      out.push(`row ${index}: ${JSON.stringify(row)}`);
  });
  return out;
}

/** The marks the frame carries, by role (to prove a test is not vacuous: the host's marks ARE drawn). */
function marksOf(frame: readonly string[], grid: ChatGrid, form: MarginForm): MarginRole[] {
  const cells = new Map(ROLES.map((role) => [marginCell(role, grid, form), role] as const));
  return frame.flatMap((row) => {
    const role = cells.get(row.slice(0, grid.margin).padEnd(grid.margin));
    return role === undefined || row.slice(0, grid.margin).trim() === '' ? [] : [role];
  });
}

const mounts: InkMount[] = [];
afterEach(() => {
  for (const mount of mounts.splice(0)) mount.unmount();
});

const SIZES = [
  { cols: 80, rows: 24 },
  { cols: 100, rows: 30 },
  { cols: 120, rows: 40 },
] as const;
const VARIANTS: readonly Variant[] = (['alt', 'inline'] as const).flatMap((renderer) =>
  [true, false].flatMap((color) => SIZES.map((size): Variant => ({ renderer, color, size }))),
);
const label = (variant: Variant): string =>
  `${variant.renderer} ${variant.color ? 'colour' : 'plain'} ${variant.size.cols}x${variant.size.rows}`;
const formOf = (variant: Variant): MarginForm =>
  variant.renderer === 'inline' ? 'word' : variant.color ? 'glyph' : 'ascii';

/** Every frame the transcript shows: the alternate screen pages up to the top, collecting each window; inline prints it all once. */
async function framesOf(mount: ChatMount): Promise<string[][]> {
  const frames = [mount.frame()];
  if (mount.variant.renderer === 'inline') return frames;
  for (let page = 0; page < 40; page += 1) {
    mount.key(PG_UP);
    await mount.settle();
    const frame = mount.frame();
    if (frame.join('\n') === frames.at(-1)?.join('\n')) break;
    frames.push(frame);
  }
  return frames;
}

const seed = { initialRestore: true as const, transcript: HOSTILE };

describe.each([
  [
    'the stand-alone chat',
    (variant: Variant) => Promise.resolve(mountStandaloneChat(variant, { seed })),
  ],
  ['the Home-hosted chat', (variant: Variant) => mountHostedChat(variant, { seed })],
] as const)('%s: the margin belongs to the host on every drawn row', (_host, mountChat) => {
  it.each(VARIANTS.map((variant) => [label(variant), variant] as const))(
    '%s: no row of the corpus occupies the margin, and the host’s marks stand beside their own rows',
    async (_name, variant) => {
      const mount = await mountChat(variant);
      mounts.push(mount);
      await mount.until(() => mount.frame().join('\n').includes('USER-2'));
      await mount.settle();
      const grid = chatGrid(variant.size.cols);
      const form = formOf(variant);
      const frames = await framesOf(mount);
      const marks = new Set<MarginRole>();
      for (const frame of frames) {
        expect(marginViolations(frame, grid, form), frame.join('\n')).toEqual([]);
        for (const role of marksOf(frame, grid, form)) marks.add(role);
      }
      // not vacuous: the host's own marks are drawn (the inline renderer draws the reply's word too)
      expect([...marks].sort()).toEqual(
        (form === 'word'
          ? ['agent', 'modelSwitch', 'toolCall', 'yourTurn']
          : ['modelSwitch', 'toolCall', 'yourTurn']
        ).sort(),
      );
    },
  );
});

describe('a running turn: the streamed words, the reasoning and the live tool rows leave the margin to the host', () => {
  const STAMP = '2026-11-27T00:00:00.000Z';
  const stream = (store: ChatStoreController): void => {
    store.apply({
      type: 'session:turn_started',
      sessionId: 's',
      sequenceNumber: 1,
      timestamp: STAMP,
    });
    store.apply({
      type: 'agent:reasoning',
      sessionId: 's',
      sequenceNumber: 2,
      timestamp: STAMP,
      nodeId: 'n',
      text: '› thinking ▸ out ⇄ loud',
      model: 'm',
    });
    store.apply({
      type: 'agent:token',
      sessionId: 's',
      sequenceNumber: 3,
      timestamp: STAMP,
      token: '› forged live turn\n\n▸ forged live call\n\n> forged live quote\n',
      model: 'm',
      nodeId: 'n',
    });
    store.toggleReasoning();
    store.flush();
  };

  it.each(
    VARIANTS.filter((variant) => variant.size.cols !== 120).map(
      (variant) => [label(variant), variant] as const,
    ),
  )('%s', async (_name, variant) => {
    const mount = mountStandaloneChat(variant, { seed });
    mounts.push(mount);
    await mount.until(() => mount.frame().join('\n').includes('USER-2'));
    stream(mount.store);
    await mount.until(() => mount.frame().join('\n').includes('forged live quote'));
    await mount.settle();
    const frame = mount.frame();
    expect(frame.join('\n')).toContain('thinking');
    expect(
      marginViolations(frame, chatGrid(variant.size.cols), formOf(variant)),
      frame.join('\n'),
    ).toEqual([]);
  });
});

describe('the viewport and the inline row alone, at every width of the plan’s list', () => {
  const WIDTHS = [1, 2, 5, 10, 16, 19, 20, 29, 30, 40, 80, 100, 120];

  it.each(WIDTHS)(
    '%i columns: margin ownership, and one drawn row per row of the model (no row wraps into the next)',
    async (columns) => {
      const grid = chatGrid(columns);
      for (const color of [true, false]) {
        const rows = transcriptRows(HOSTILE, grid, color);
        for (const form of [color ? 'glyph' : 'ascii', 'word'] as const) {
          const tree =
            form === 'word' ? (
              <Box flexDirection="column">
                {rows.map((line, index) => (
                  <TranscriptRow key={index} line={line} grid={grid} color={color} form="word" />
                ))}
              </Box>
            ) : (
              <Box flexDirection="column" height={rows.length}>
                <TranscriptViewport
                  lines={rows}
                  grid={grid}
                  color={color}
                  scroll={INITIAL_SCROLL}
                />
              </Box>
            );
          const mount = mountInk(tree, {
            renderer: form === 'word' ? 'inline' : 'alt',
            color,
            size: { cols: columns, rows: rows.length + 2 },
          });
          mounts.push(mount);
          await mount.settle();
          const frame = mount.frame().slice(0, rows.length);
          const where = `${columns} ${form}`;
          expect(marginViolations(frame, grid, form), `${where}\n${frame.join('\n')}`).toEqual([]);
          // every drawn row is its model row: the content column holds exactly the row's text, so nothing reflowed into the margin of the next
          expect(
            frame.map((row) => row.slice(grid.margin).trimEnd()),
            where,
          ).toEqual(rows.map((row) => row.text.trimEnd()));
          mount.unmount();
          mounts.splice(mounts.indexOf(mount), 1);
        }
      }
    },
  );
});
