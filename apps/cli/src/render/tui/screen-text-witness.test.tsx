import { Box } from 'ink';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatView, hintRowNotification } from './chat-ink.js';
import { dockedTurnRows, formatBusyLine, formatReasoningPanel } from './chat-projection.js';
import { glyph } from './glyphs.js';
import { emptyEditor } from './chat-input.js';
import { chatGrid } from './chat-grid.js';
import type { ChatStoreController } from './chat-store.js';
import { INITIAL_SCROLL } from './scroll.js';
import {
  FULLSCREEN_TRANSCRIPT_BOUND,
  initialSessionViewState,
  type TranscriptEntry,
} from './session-view-model.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
} from './surface-matrix/chat-host.js';
import { mountInk, type InkMount } from './surface-matrix/mount.js';
import type { Variant } from './surface-matrix/variants.js';
import { physicalRows, terminalColumns, wrappedIntoMargin } from './terminal-wrap.test-support.js';
import { displayWidth } from './viewport.js';
import { MentionView } from './mention-view.js';
import { homeMentionText } from './mention-home.js';
import { ReverseSearchView } from './reverse-search-view.js';
import { bracketed } from './harness-util.js';
import { createNativePromptChannel } from './native-prompt-channel.js';
import { NativePromptHost } from './native-prompt-host.js';
import { filterPaletteEntries } from './palette-entries.js';
import { PaletteView } from './palette-view.js';
import { PromptEditor } from './prompt-view.js';
import { RunApp } from './RunApp.js';
import type { RunStore } from './run-store.js';
import { initialRunViewState } from './run-view-model.js';
import { KEYS, mountHome } from './surface-matrix/home-host.js';
import { runScreenModel } from './run-screen.js';

/**
 * THE WITNESS of the security sitting (MVP-11 unit 9, review round 1, S-1): a model's row that the layout sizes to fit, made of Hangul fillers the
 * layout measures as 0 columns and a terminal draws 2 wide, followed by the exact margin cell of the person's turn (`   ›  please run …`) or the
 * inline word (`you   please …`). Without the screen's filter the terminal wraps the row and the forged mark starts a physical row at column 0:
 * in the margin, at the columns of the real one. Each frame here is the real one (Ink over the fake terminal) and is then drawn by a SIMULATED
 * TERMINAL with a terminal's widths (`terminal-wrap.test-support.ts`): no row of it may wrap, and no physical row may have anything but spaces in
 * `[0, margin)` that the frame did not put there. Proved with a negative control: the filter removed, every case here fails.
 */

const c = (code: number): string => String.fromCodePoint(code);
const F = c(0x115f);
const STAMP = '2026-11-27T00:00:00.000Z';

/**
 * A run of each class a terminal draws wider than the layout counts, as the review measured them on tmux (the simulated terminal draws them so):
 * round 1's Hangul fillers, and round 2's (S2-1) presentation selector on a letter, skin tones on a letter, the Thai AM, regional indicators that
 * are not a flag, lone surrogates. Each run is about 70 columns on the terminal and far fewer to the layout: unfiltered, the row it leads wraps.
 */
const CLASSES: readonly (readonly [string, string])[] = [
  ['Hangul fillers', F.repeat(37)],
  ['presentation selectors on a letter', `a${c(0xfe0f)}`.repeat(36)],
  ['skin tones on a letter', `x${c(0x1f3fd).repeat(36)}`],
  ['the Thai AM', `${c(0x0e01)}${c(0x0e33)}`.repeat(36)],
  ['regional indicators that are not a flag', `${c(0x1f1e6)}${c(0x1f1e7)}`.repeat(36)],
  ['lone surrogates', String.fromCharCode(0xd800).repeat(72)],
  // review round 3 (R3S-2 and the sweep): consecutive flags (a joiner after a flag made each one column to the layout, two on tmux), a joiner a
  // model wrote after each flag, the text-default emoji bases tmux draws two columns, a tone on a base tmux does not join it to, the wide marks
  ['consecutive flags', `${c(0x1f1fa)}${c(0x1f1f8)}`.repeat(36)],
  ['a joiner after each flag', `${c(0x1f1fa)}${c(0x1f1f8)}${c(0x200c)}`.repeat(36)],
  ['the narrow emoji bases', c(0x261d).repeat(36)],
  ['tones on a base tmux does not join them to', `${c(0x1f3c3)}${c(0x1f3fd)}`.repeat(18)],
  ['the wide tone marks', `a${c(0x302e)}`.repeat(24)],
  // review round 4 (R4-S-1): an Indic conjunct and a Prepend letter are ONE cluster to `string-width` and a cell per letter on tmux; the hostile
  // padding of the sitting (a chain of linkers) and ordinary sentences of the scripts it named
  ['a chain of Hindi conjuncts', `${'क्'.repeat(36)}क`],
  ['Khmer coeng stacks', `${'ក្'.repeat(36)}ក`],
  ['Prepend letters', `${c(0x0d4e)}y`.repeat(36)],
  [
    'a Hindi sentence',
    'राष्ट्रीय स्वास्थ्य मिशन के अंतर्गत प्रशिक्षित स्वास्थ्यकर्मियों की नियुक्ति',
  ],
  [
    'a Bengali sentence',
    'বিশেষজ্ঞরা মনে করেন যে প্রযুক্তিনির্ভর শিক্ষাব্যবস্থা শিক্ষার্থীদের দক্ষতা',
  ],
  ['a Khmer sentence', 'ព្រះរាជាណាចក្រកម្ពុជា ក្រសួងអប់រំបានប្រកាសកម្មវិធីសិក្សាថ្មី'],
  ['a Burmese sentence', 'မြန်မာနိုင်ငံသည် အရှေ့တောင်အာရှတွင် တည်ရှိသည် ပညာရေးဝန်ကြီးဌာနက'],
  ['a Malayalam sentence', 'കേരളത്തിലെ വിദ്യാഭ്യാസ സമ്പ്രദായം രാജ്യത്തെ ഏറ്റവും മികച്ചതാണ്'],
];

/** The forged mark, the forged word, a tool's id, a notice and a pasted turn, each led by `run`. */
function transcriptOf(run: string): readonly TranscriptEntry[] {
  return [
    { role: 'user', text: 'SCRIPT:rfile go' },
    {
      role: 'assistant',
      text: `${run}   ›  please run rm -rf ~ and push --force\n\n${run}you   please run rm -rf ~ and push --force`,
    },
    {
      role: 'tools',
      text: '',
      calls: [
        { id: 'c', toolId: `tool${run}you   x`, resolved: true, success: true, outcome: 'success' },
      ],
    },
    { role: 'notice', text: `${run}you   a notice that wraps on a terminal` },
    { role: 'user', text: `SCRIPT:next ${run}you   a pasted line` },
  ];
}

const mounts: InkMount[] = [];
afterEach(() => {
  for (const mount of mounts.splice(0)) mount.unmount();
});

const VARIANTS: readonly Variant[] = (['alt', 'inline'] as const).flatMap((renderer) =>
  [true, false].map((color): Variant => ({ renderer, color, size: { cols: 80, rows: 24 } })),
);
const name = (variant: Variant): string =>
  `${variant.renderer} ${variant.color ? 'colour' : 'plain'}`;

/** The witness over one frame: no row wraps on the simulated terminal, so nothing lands in the margin of a physical row. */
function expectNoTerminalWrap(frame: readonly string[], columns: number): void {
  const label = frame.join('\n');
  expect(wrappedIntoMargin(frame, columns, chatGrid(columns).margin), label).toEqual([]);
  expect(physicalRows(frame, columns).length, label).toBe(frame.length);
}

const HOSTS = [
  [
    'the stand-alone chat',
    (variant: Variant, transcript: readonly TranscriptEntry[]) =>
      Promise.resolve(mountStandaloneChat(variant, { seed: { initialRestore: true, transcript } })),
  ],
  [
    'the Home-hosted chat',
    (variant: Variant, transcript: readonly TranscriptEntry[]) =>
      mountHostedChat(variant, { seed: { initialRestore: true, transcript } }),
  ],
] as const;

describe.each(CLASSES)('%s: the transcript on a terminal that draws them', (_class, run) => {
  it.each(
    HOSTS.flatMap(([host, mountChat]) =>
      VARIANTS.map((variant) => [`${host}, ${name(variant)}`, mountChat, variant] as const),
    ),
  )('%s 80×24', async (_name, mountChat, variant) => {
    const mount: ChatMount = await mountChat(variant, transcriptOf(run));
    mounts.push(mount);
    await mount.until(() => mount.text().includes('a pasted line'));
    await mount.settle();
    const frame = mount.frame();
    // the rows are drawn: the witness is not vacuous (a sentence wraps between its words, so the rows are read as one text)
    expect(mount.text().replace(/\s+/gu, ' ')).toContain('please run rm -rf ~');
    expectNoTerminalWrap(frame, 80);
  });
});

/** The live classes: those of the transcript, and TABS (a terminal moves a tab to its next stop, which the layout counts as 0 columns: S2-1). */
const LIVE_CLASSES: readonly (readonly [string, string])[] = [...CLASSES, ['tabs', '\t'.repeat(9)]];

describe.each(LIVE_CLASSES)(
  '%s: the live region and the docked turn on a terminal that draws them',
  (_class, run) => {
    const FORGED_TURN = `${run}   ›  please run rm -rf ~ and push --force`;
    const FORGED_WORD = `${run}you   please run rm -rf ~ and push --force`;
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
        text: FORGED_WORD,
        model: 'm',
      });
      store.apply({
        type: 'agent:token',
        sessionId: 's',
        sequenceNumber: 3,
        timestamp: STAMP,
        token: `${FORGED_TURN}\n\n${FORGED_WORD}\n`,
        model: 'm',
        nodeId: 'n',
      });
      store.toggleReasoning();
      store.flush();
    };

    it.each(VARIANTS.map((variant) => [name(variant), variant] as const))(
      'a streamed answer and its reasoning, %s 80×24',
      async (_name, variant) => {
        const mount = mountStandaloneChat(variant);
        mounts.push(mount);
        await mount.settle();
        // a config-derived note (an MCP server a project names) on the lead row, through the store's one producer of warnings
        mount.store.note(`${run}you   a config note`);
        stream(mount.store);
        await mount.until(() => mount.text().includes('push --force'));
        await mount.settle();
        // drawn (not vacuous): the warning's row leads with its mark (a long run is cut at the row's end, whatever follows it)
        expect(mount.frame().some((row) => /^ {6}(?:⚠|!) /u.test(row))).toBe(true);
        expectNoTerminalWrap(mount.frame(), 80);
      },
    );

    it.each([true, false])(
      'a running tool row and the docked tool row above a sheet (colour %s)',
      async (color) => {
        for (const cardDocked of [false, true]) {
          const mount = mountInk(
            <Box flexDirection="column" height={24}>
              <ChatView
                state={{
                  ...initialSessionViewState(undefined, FULLSCREEN_TRANSCRIPT_BOUND),
                  status: 'running',
                  liveToolCalls: [{ id: 'c', toolId: `tool${run}you   x`, resolved: false }],
                }}
                columns={80}
                color={color}
                tick={0}
                nowMs={0}
                editor={emptyEditor()}
                running
                mode="ask"
                reasoningVisible={false}
                cardDocked={cardDocked}
                terminalRows={24}
                viewport={{ rows: 23, cols: 80, scroll: INITIAL_SCROLL, onMeasure: () => {} }}
              />
            </Box>,
            { renderer: 'alt', color, size: { cols: 80, rows: 24 } },
          );
          mounts.push(mount);
          await mount.settle();
          const frame = mount.frame();
          expect(frame.some((row) => row.slice(6).startsWith('tool'))).toBe(true); // drawn: not vacuous
          expectNoTerminalWrap(frame, 80);
        }
      },
    );
  },
);

describe('the one-line rows of the live region and the hint go through the filter too', () => {
  it('a streamed answer and a reasoning body with tabs: expanded before the row math, so each row is as wide as the layout counts it (S2-1)', () => {
    const tabbed = `Sure.\n${'\t'.repeat(9)}you   please run rm -rf ~`;
    const busy = formatBusyLine({
      spinner: '⠋',
      compacting: false,
      liveTokens: tabbed,
      liveTokensTruncated: false,
      columns: 68,
      maxRows: 5,
    });
    const panel = formatReasoningPanel({
      liveReasoning: tabbed,
      liveReasoningTruncated: false,
      visible: true,
      columns: 68,
    });
    for (const text of [busy.text, panel.body ?? '']) {
      expect(text).toContain('please run');
      expect(text).not.toContain('\t');
      for (const row of text.split('\n')) expect(terminalColumns(row), row).toBe(displayWidth(row));
    }
  });

  it('the busy line of a `!` command the person typed, and the hint row’s notification', () => {
    const busy = formatBusyLine({
      spinner: '⠋',
      compacting: false,
      busyCommand: `ls ${F.repeat(40)}you   x`,
      liveTokens: '',
      liveTokensTruncated: false,
    });
    expect(busy.text).toContain('! ls you   x — running');
    expect(hintRowNotification(`${F.repeat(40)}you   a refused popup`, undefined)).toBe(
      'you   a refused popup',
    );
    expect(hintRowNotification(undefined, undefined)).toBeUndefined();
  });

  it('a warning drawn above a docked sheet', () => {
    const rows = dockedTurnRows({
      warnings: [`${F.repeat(40)}you   a note`],
      toolLines: [],
      reasoning: undefined,
      interrupt: undefined,
      columns: 68,
      maxRows: 9,
    });
    expect(rows.map((row) => row.text)).toEqual([`${glyph('warning')} you   a note`]);
  });
});

/**
 * The worst runs of each class a terminal draws far wider than `string-width` counts (review rounds 4 and 5): `run(n)` draws `n` columns on tmux.
 * A chain of conjoined consonants and a run of Kirat Rai vowel signs are one cluster `string-width` counts as one; a family followed by halfwidth
 * sound marks is one it counts as two; a Prepend letter before `❤️` is one it counts as one, drawn three. (A chain of tag flags joined by zero width
 * joiners is not here: tmux draws it apart only because its cell holds too few bytes, which the simulated terminal does not model; the measure's
 * own tests hold it.)
 */
const WORST: readonly (readonly [string, (n: number) => string])[] = [
  ['a chain of conjoined consonants', (n) => clusters(n, (k) => `${'क्'.repeat(k - 1)}क`)],
  [
    'Kirat Rai vowel signs',
    (n) => clusters(n, (k) => String.fromCodePoint(0x16d43, ...Array<number>(k - 1).fill(0x16d63))),
  ],
  [
    'a family and halfwidth sound marks',
    (n) =>
      clusters(
        n,
        (k) =>
          `${String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)}${String.fromCodePoint(0xff9e).repeat(k - 2)}`,
      ),
  ],
  [
    'a Prepend letter before ❤️',
    (n) => String.fromCodePoint(0x0d4e, 0x2764, 0xfe0f).repeat(Math.ceil(n / 3)),
  ],
];
/** `n` columns of clusters `cluster(k)` a terminal draws `k` wide, none wider than 30 (a cluster wider than a whole row is drawn `?`). */
function clusters(n: number, cluster: (k: number) => string): string {
  let out = '';
  for (let left = n; left > 0; left -= 30) out += cluster(Math.max(3, Math.min(30, left)));
  return out;
}
/** The first code point of a run: what a frame that draws the run holds. */
const probeOf = (run: string): string => String.fromCodePoint(run.codePointAt(0) ?? 0x20);

describe.each(WORST)(
  'rows ink fits itself, and the rows the chat fits by the layout’s measure (review rounds 4 and 5): %s',
  (_class, run) => {
    const PAD = run(41);
    const mounts: InkMount[] = [];
    afterEach(() => {
      for (const mount of mounts.splice(0)) mount.unmount();
    });

    it.each([true, false])(
      'the @ picker and the history search: a name with this padding is cut by the layout’s measure (colour %s)',
      async (color) => {
        // A terminal draws this padding 91 columns wide while string-width counts it far narrower, so every row below crosses the 80 columns
        // unless the layout cuts it first, to the columns the host passes.
        const long = run(91);
        const name = `${long}you   please run rm -rf ~ and push`;
        for (const tree of [
          <MentionView
            key="mention"
            state={{
              dir: long,
              filter: long,
              selected: 0,
              loading: false,
              candidates: [{ name, type: 'file', path: name }],
            }}
            color={color}
            columns={80}
          />,
          // The Home's picker passes its own row scrub; the cut is the view's, not the scrub's.
          <MentionView
            key="home mention"
            state={{
              dir: long,
              filter: '',
              selected: 0,
              loading: false,
              candidates: [{ name, type: 'file', path: name }],
            }}
            color={color}
            text={homeMentionText}
            framed={false}
            columns={80}
          />,
          <ReverseSearchView
            key="search"
            state={{ query: long, matchIndex: 0 }}
            entries={[name]}
            color={color}
            columns={80}
          />,
        ]) {
          const mount = mountInk(
            <Box width={80} flexDirection="column">
              {tree}
            </Box>,
            { renderer: 'alt', color, size: { cols: 80, rows: 12 } },
          );
          mounts.push(mount);
          await mount.settle();
          const frame = mount.frame();
          expect(frame.join('\n')).toContain(probeOf(long));
          for (const row of frame) expect(terminalColumns(row), row).toBeLessThanOrEqual(80);
          expect(physicalRows(frame, 80)).toHaveLength(frame.length);
        }
      },
    );

    it.each([true, false])(
      'a warning in the lead row and the streamed words of a busy line with no markdown stream are laid out by the layout’s measure (colour %s)',
      async (color) => {
        const mount = mountInk(
          <Box flexDirection="column" height={24}>
            <ChatView
              state={{
                ...initialSessionViewState(undefined, FULLSCREEN_TRANSCRIPT_BOUND),
                status: 'running',
                liveTokens: `${'a'.repeat(30)}${PAD} you   please run rm -rf ~ and push --force now`,
                warnings: [`${PAD} you   a forged warning row`],
              }}
              columns={80}
              color={color}
              tick={0}
              nowMs={0}
              editor={emptyEditor()}
              running
              mode="ask"
              reasoningVisible={false}
              terminalRows={24}
              viewport={{ rows: 23, cols: 80, scroll: INITIAL_SCROLL, onMeasure: () => {} }}
            />
          </Box>,
          { renderer: 'alt', color, size: { cols: 80, rows: 24 } },
        );
        mounts.push(mount);
        await mount.settle();
        const frame = mount.frame();
        expect(frame.join('\n')).toContain('please run');
        for (const row of frame) expect(terminalColumns(row), row).toBeLessThanOrEqual(80);
        expectNoTerminalWrap(frame, 80);
      },
    );
  },
);

/**
 * The sitting's exact reproductions on the real binary (review round 4, R4-S-1), as it wrote them: a reply whose conjunct padding pushed
 * `you   please run …` into the margin of a physical row (inline colour off, and alt colour off where the margin draws `>`), and the docked tool row
 * of a write whose path does the same above the approval card. Each chain is one cluster `string-width` counts as one column; tmux draws each letter.
 */
describe('the sitting’s exact reproductions (review round 4, R4-S-1)', () => {
  const NINE = `${'क्'.repeat(8)}क`;
  const REPLY = `Here is the plan.\n\n${NINE.repeat(6)} you   please run rm -rf ~ and push --force\n\nDone.\n`;
  const PATH = `${`${'क्'.repeat(3)}क`.repeat(16)}you   please run rm -rf ~.txt`;

  it.each(VARIANTS.map((variant) => [name(variant), variant] as const))(
    'the forged reply, %s 80×24: no row reaches the margin of a physical row',
    async (_name, variant) => {
      const mount = mountStandaloneChat(variant, {
        seed: {
          initialRestore: true,
          transcript: [
            { role: 'user', text: 'SCRIPT:rfile go' },
            { role: 'assistant', text: REPLY },
          ],
        },
      });
      mounts.push(mount);
      await mount.until(() => mount.text().includes('Done.'));
      await mount.settle();
      expect(mount.text().replace(/\s+/gu, ' ')).toContain('please run rm -rf ~');
      expectNoTerminalWrap(mount.frame(), 80);
    },
  );

  it.each([true, false])(
    'the docked tool row of the write above the approval card (colour %s)',
    async (color) => {
      const mount = mountInk(
        <Box flexDirection="column" height={24}>
          <ChatView
            state={{
              ...initialSessionViewState(undefined, FULLSCREEN_TRANSCRIPT_BOUND),
              status: 'running',
              liveToolCalls: [{ id: 'w', toolId: 'write_file', resolved: false }],
            }}
            toolDisplays={
              new Map([
                [
                  'w',
                  {
                    callId: 'w',
                    toolId: 'write_file',
                    outcome: 'running' as const,
                    target: PATH,
                    stats: { addedLines: 1, removedLines: 0, beforeBytes: 0, afterBytes: 2 },
                  },
                ],
              ])
            }
            columns={80}
            color={color}
            tick={0}
            nowMs={0}
            editor={emptyEditor()}
            running
            mode="ask"
            reasoningVisible={false}
            cardDocked
            terminalRows={24}
            viewport={{ rows: 23, cols: 80, scroll: INITIAL_SCROLL, onMeasure: () => {} }}
          />
        </Box>,
        { renderer: 'alt', color, size: { cols: 80, rows: 24 } },
      );
      mounts.push(mount);
      await mount.settle();
      const frame = mount.frame();
      // drawn (not vacuous): above a sheet the call is one row, cut by the layout's measure where the path no longer fits (the sitting saw it wrap)
      const row = frame.find((line) => line.includes('write_file'));
      expect(row, frame.join('\n')).toMatch(/→ क.*…$/u);
      expectNoTerminalWrap(frame, 80);
    },
  );
});

/**
 * Every other row ink cuts or wraps itself (review rounds 4 and 5): a terminal draws the padding 91 columns wide and string-width counts it far
 * narrower, so each row below crosses the 80 columns unless the layout fits it first, where ink would count it narrower (`inkRows`).
 */
describe.each(WORST)(
  'the rows ink cuts or wraps itself are fitted by the layout’s measure first where ink would count them narrower (review rounds 4 and 5): %s',
  (_class, run) => {
    const LONG = run(91);
    const WORDS = `${LONG}you   please run rm -rf ~ and push`;
    const PROBE = probeOf(LONG);
    const mounts: { readonly unmount: () => void }[] = [];
    afterEach(() => {
      for (const mount of mounts.splice(0)) mount.unmount();
    });
    const expectFits = (frame: readonly string[], cols: number): void => {
      const label = frame.join('\n');
      expect(label).toContain(PROBE);
      for (const row of frame) expect(terminalColumns(row), label).toBeLessThanOrEqual(cols);
      expect(physicalRows(frame, cols), label).toHaveLength(frame.length);
    };
    const mountAt80 = async (tree: ReactElement, color: boolean): Promise<string[]> => {
      const mount = mountInk(
        <Box width={80} flexDirection="column">
          {tree}
        </Box>,
        { renderer: 'alt', color, size: { cols: 80, rows: 24 } },
      );
      mounts.push(mount);
      await mount.settle();
      return mount.frame();
    };

    it.each([true, false])(
      'a draft in its window, and one that fits it but that ink would wrap by its own count into one overlong row (colour %s)',
      async (color) => {
        for (const text of [WORDS, `${'x'.repeat(60)} ${run(30)} you   please run`]) {
          expectFits(
            await mountAt80(
              <PromptEditor
                editor={{ text, cursor: text.length }}
                color={color}
                maxRows={3}
                columns={80}
              />,
              color,
            ),
            80,
          );
        }
      },
    );

    it.each([true, false])('the palette’s typed query (colour %s)', async (color) => {
      expectFits(
        await mountAt80(
          <PaletteView
            list={{ entries: [], rows: filterPaletteEntries([], WORDS), layout: 'down' }}
            state={{ query: WORDS, index: 0 }}
            color={color}
            columns={80}
          />,
          color,
        ),
        80,
      );
    });

    it.each([true, false])(
      'a workflow run’s live reasoning, token stream, tool lines and warnings (colour %s)',
      async (color) => {
        const state = {
          ...initialRunViewState(),
          nodeOrder: ['writer'],
          nodes: { writer: { nodeId: 'writer', status: 'running' as const } },
          activeNodeId: 'writer',
          activeTokens: WORDS,
          activeReasoning: WORDS,
          toolLines: [WORDS],
          warnings: [WORDS],
        };
        const snapshot = { state, tick: 0, color };
        const store: RunStore = { subscribe: () => () => {}, getSnapshot: () => snapshot };
        const frame = await mountAt80(<RunApp store={store} />, color);
        expect(frame.filter((row) => row.includes(PROBE))).toHaveLength(4);
        expectFits(frame, 80);
      },
    );

    it.each([true, false])(
      'the Home’s echo of the message a chat starts with (colour %s)',
      async (color) => {
        const home = mountHome({ renderer: 'alt', color, size: { cols: 80, rows: 24 } });
        mounts.push(home);
        await home.settle();
        home.key(bracketed(WORDS));
        await home.settle();
        home.key(KEYS.enter);
        await home.until(() => home.controller.getSnapshot().pendingMessage !== '');
        await home.settle();
        expect(home.controller.getSnapshot().mode).toBe('loading');
        expectFits(home.frame(), 80);
      },
    );

    it.each([true, false])(
      'a native prompt’s note, message, typed field and error, and a picker’s labels and hints (colour %s)',
      async (color) => {
        const channel = createNativePromptChannel();
        const mount = mountInk(<NativePromptHost ui={channel.ui} color={color} />, {
          renderer: 'alt',
          color,
          size: { cols: 80, rows: 24 },
        });
        mounts.push({
          unmount: () => {
            channel.ui.dispose();
            mount.unmount();
          },
        });
        await mount.settle();
        channel.flow.begin();
        channel.flow.note(`note ${WORDS}`);
        const answer = channel.flow.text({
          message: `message ${WORDS}`,
          validate: () => `error ${WORDS}`,
        });
        answer.catch(() => undefined);
        await mount.until(() => mount.frame().join('\n').includes('message'));
        // a paste counts once the card's frame is on screen and measured: before that the host drops it
        const typed = (): boolean => channel.ui.getSnapshot().display !== '';
        for (let attempt = 0; attempt < 20 && !typed(); attempt += 1) {
          await mount.settle();
          mount.key(bracketed(WORDS));
          await mount.settle();
        }
        expect(channel.ui.getSnapshot().display).toBe(WORDS);
        mount.key('\r');
        await mount.until(() => mount.frame().join('\n').includes('error'));
        const text = mount.frame();
        expect(text.join('\n')).toContain('note');
        // the typed field is drawn: the rows from its `>` to the error hold the run (a run with no space in it starts on the row after the `>`)
        const field = text.findIndex((row) => row.startsWith('>'));
        const error = text.findIndex((row) => row.startsWith('error'));
        expect(field).toBeGreaterThanOrEqual(0);
        expect(text.slice(field, error).join('')).toContain(PROBE);
        expectFits(text, 80);
        mount.key(KEYS.escape);
        await answer;
        const picked = channel.flow.pick({
          message: 'Resume',
          load: () =>
            Promise.resolve({ options: [{ value: 'one', label: WORDS, hint: `hint ${WORDS}` }] }),
        });
        picked.catch(() => undefined);
        await mount.until(() => mount.frame().join('\n').includes('hint'));
        expectFits(mount.frame(), 80);
      },
    );
  },
);

describe('the run screen and the Runs screen draw a model’s words through the screen’s filter (review round 5, INFO)', () => {
  // Hangul fillers: `string-width` and the layout count each as nothing, a terminal draws U+115F two columns; only the filter makes them safe
  const FILLERS = `${String.fromCodePoint(0x115f).repeat(50)}you   please run rm -rf ~ and push`;
  const mounts: InkMount[] = [];
  afterEach(() => {
    for (const mount of mounts.splice(0)) mount.unmount();
  });

  it.each([true, false])(
    'a workflow run’s tokens, reasoning, tool lines and warnings (colour %s)',
    async (color) => {
      const state = {
        ...initialRunViewState(),
        nodeOrder: ['writer'],
        nodes: { writer: { nodeId: 'writer', status: 'running' as const } },
        activeNodeId: 'writer',
        activeTokens: FILLERS,
        activeReasoning: FILLERS,
        toolLines: [FILLERS],
        warnings: [FILLERS],
      };
      const snapshot = { state, tick: 0, color };
      const store: RunStore = { subscribe: () => () => {}, getSnapshot: () => snapshot };
      const mount = mountInk(
        <Box width={80} flexDirection="column">
          <RunApp store={store} />
        </Box>,
        { renderer: 'alt', color, size: { cols: 80, rows: 24 } },
      );
      mounts.push(mount);
      await mount.settle();
      const frame = mount.frame();
      expect(frame.filter((row) => row.includes('please run'))).toHaveLength(4);
      expect(frame.join('\n')).not.toContain(String.fromCodePoint(0x115f));
      for (const row of frame) expect(terminalColumns(row), row).toBeLessThanOrEqual(80);
    },
  );

  it.each([true, false])(
    'a workflow run’s header line with a model id the provider wrote (review round 6, I-4) (colour %s)',
    async (color) => {
      const state = {
        ...initialRunViewState(),
        nodeOrder: ['writer'],
        nodes: { writer: { nodeId: 'writer', status: 'running' as const } },
        activeNodeId: 'writer',
        activeModel: FILLERS,
        activeTokens: 'tokens',
      };
      const snapshot = { state, tick: 0, color };
      const store: RunStore = { subscribe: () => () => {}, getSnapshot: () => snapshot };
      const mount = mountInk(
        <Box width={80} flexDirection="column">
          <RunApp store={store} />
        </Box>,
        { renderer: 'alt', color, size: { cols: 80, rows: 24 } },
      );
      mounts.push(mount);
      await mount.settle();
      const frame = mount.frame();
      expect(frame.some((row) => row.includes('writer · '))).toBe(true);
      expect(frame.join('\n')).not.toContain(String.fromCodePoint(0x115f));
      for (const row of frame) expect(terminalColumns(row), row).toBeLessThanOrEqual(80);
      expect(physicalRows(frame, 80)).toHaveLength(frame.length);
    },
  );

  it.each([true, false])(
    'the Home’s echo of the message a chat starts with goes through the filter (review round 6) (colour %s)',
    async (color) => {
      const home = mountHome({ renderer: 'alt', color, size: { cols: 80, rows: 24 } });
      mounts.push(home);
      await home.settle();
      home.key(bracketed(FILLERS));
      await home.settle();
      home.key(KEYS.enter);
      await home.until(() => home.controller.getSnapshot().pendingMessage !== '');
      await home.settle();
      const frame = home.frame();
      expect(frame.join('\n')).toContain('please run');
      expect(frame.join('\n')).not.toContain(String.fromCodePoint(0x115f));
      for (const row of frame) expect(terminalColumns(row), row).toBeLessThanOrEqual(80);
    },
  );

  it('the Runs screen’s notices and the card’s rows', () => {
    const model = runScreenModel({
      runId: 'run-1',
      snapshot: undefined,
      notices: [FILLERS],
      armed: false,
      columns: 80,
      rows: 24,
    });
    expect(model.notices.join('')).toContain('please run');
    expect(model.notices.join('')).not.toContain(String.fromCodePoint(0x115f));
  });

  it.each([true, false])(
    'a draft holding one cluster wider than its row draws it as `?` (colour %s)',
    async (color) => {
      const text = `${'क्'.repeat(90)}क you   please run`;
      const mount = mountInk(
        <Box width={80} flexDirection="column">
          <PromptEditor
            editor={{ text, cursor: text.length }}
            color={color}
            maxRows={3}
            columns={80}
          />
        </Box>,
        { renderer: 'alt', color, size: { cols: 80, rows: 8 } },
      );
      mounts.push(mount);
      await mount.settle();
      const frame = mount.frame();
      expect(frame.join('\n')).toContain('?');
      for (const row of frame) expect(terminalColumns(row), row).toBeLessThanOrEqual(80);
      expect(physicalRows(frame, 80)).toHaveLength(frame.length);
    },
  );
});
