import { legendStates } from '../frames.js';
import { label, type Producer, type Recorder } from '../golden.js';
import type { PaletteSurface } from '../../../../commands/repl-commands.js';
import { INITIAL_REVERSE_SEARCH, reverseSearchExtendQuery } from '../../input-history.js';
import { MentionView } from '../../mention-view.js';
import { ChatView } from '../../chat-ink.js';
import { createChatStore } from '../../chat-store.js';
import { buildPaletteEntries, filterPaletteEntries } from '../../palette-entries.js';
import type { PaletteLayout, PaletteList } from '../../palette-reducer.js';
import { PaletteView } from '../../palette-view.js';
import { ReverseSearchView } from '../../reverse-search-view.js';
import { FULLSCREEN_TRANSCRIPT_BOUND } from '../../session-view-model.js';

export const INPUT_PRODUCERS: readonly Producer[] = [
  {
    id: 'palette-view',
    file: 'render/tui/palette-view.tsx',
    describe:
      'the `/` palette’s legend, on the Home (list runs down: its own legend line) and in a chat (list runs up: the hint row of the real chat view, which the list does not draw), with a match and with none',
  },
  {
    id: 'reverse-search-view',
    file: 'render/tui/reverse-search-view.tsx',
    describe: 'the `Ctrl+R` search line’s hint, with a match and with none',
  },
  {
    id: 'mention-view',
    file: 'render/tui/mention-view.tsx',
    describe: 'the `@` completion’s hint under its candidates, loading, listing and empty',
  },
];

/** The rows the open palette of a chat gets with its prompt row, rule and hint row (the chat view is drawn 100 columns wide here). */
const CHAT_PALETTE_ROWS = 12;

/**
 * The open palette in a chat, drawn by the real chat view: the list runs up and draws no legend of its own (ADR-0146 §4), so the legend is the
 * HINT ROW of the prompt block, which says it while the palette is open. The view is the chat's own, over a fresh store, with the typed `/query`
 * on its prompt row, as the host draws it.
 */
function chatWithPalette(list: PaletteList, query: string, color: boolean) {
  const text = `/${query}`;
  return (
    <ChatView
      state={createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND).getSnapshot().state}
      tick={0}
      nowMs={5000}
      color={color}
      editor={{ text, cursor: text.length }}
      running={false}
      mode="ask"
      reasoningVisible={false}
      interruptArmed={false}
      surface="standalone-chat"
      palette={{ list, state: { query, index: 0 }, maxRows: CHAT_PALETTE_ROWS }}
      columns={100}
    />
  );
}

/** The `/` palette: its one legend line, on both surfaces' directions, and the line it draws when no command matches. */
const palette: Recorder = () => {
  const out: Record<string, readonly string[]> = {};
  for (const [surface, layout] of [
    ['home', 'down'],
    ['standalone-chat', 'up'],
  ] as const satisfies readonly (readonly [PaletteSurface, PaletteLayout])[]) {
    const entries = buildPaletteEntries(surface, { hasKey: true });
    // One row only (`/exit`): the registry's own descriptions that name a key are the registry's to record, not the view's.
    const listOf = (query: string): PaletteList => ({
      entries,
      rows: filterPaletteEntries(entries, query),
      layout,
    });
    for (const [query, kind] of [
      ['exit', 'a-match'],
      ['zzzz', 'no-match'],
    ] as const) {
      Object.assign(
        out,
        legendStates(
          label({ surface, layout, query: kind }),
          (color) =>
            layout === 'up' ? (
              chatWithPalette(listOf(query), query, color)
            ) : (
              <PaletteView list={listOf(query)} state={{ query, index: 0 }} color={color} />
            ),
          layout === 'up' ? { columns: 100 } : {},
        ),
      );
    }
  }
  return out;
};

/** `Ctrl+R`'s search line and the hint under it, with a match and with none. */
const reverseSearch: Recorder = () => {
  const entries = ['git status', 'npm test'];
  const matched = { query: 'npm', matchIndex: 1 };
  const failed = reverseSearchExtendQuery(entries, INITIAL_REVERSE_SEARCH, 'zz');
  return {
    ...legendStates('match=found', (color) => (
      <ReverseSearchView state={matched} entries={entries} color={color} />
    )),
    ...legendStates('match=none', (color) => (
      <ReverseSearchView state={failed} entries={entries} color={color} />
    )),
  };
};

/** The `@` completion's hint under its candidates, while loading, with candidates and with none. */
const mention: Recorder = () => {
  const base = { dir: '', filter: '', selected: 0 };
  const candidates = [
    { name: 'src', type: 'directory' as const, path: 'src' },
    { name: 'a.md', type: 'file' as const, path: 'a.md' },
  ];
  return {
    ...legendStates('list=loading', (color) => (
      <MentionView state={{ ...base, candidates: [], loading: true }} color={color} />
    )),
    ...legendStates('list=candidates', (color) => (
      <MentionView state={{ ...base, candidates, loading: false }} color={color} />
    )),
    ...legendStates('list=none', (color) => (
      <MentionView state={{ ...base, candidates: [], loading: false }} color={color} />
    )),
  };
};

export const INPUT_RECORDERS = {
  'palette-view': palette,
  'reverse-search-view': reverseSearch,
  'mention-view': mention,
} as const satisfies Readonly<Record<string, Recorder>>;
