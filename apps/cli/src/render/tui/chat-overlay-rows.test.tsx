import './force-color.js';

import type { ModelCatalogEntry } from '@relavium/llm';
import { Box, Text } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { boundAgentView } from '../../chat/bound-agent-view.js';
import { buildDefaultChatAgent } from '../../chat/default-agent.js';
import type { ReplCommand } from '../../commands/repl-commands.js';
import { agentChatSheet } from './chat-sheet.js';
import { ChatSheetView } from './chat-sheet-view.js';
import { EffortTierList } from './effort-tier-list.js';
import { settleFrames } from './harness-util.js';
import { MentionView } from './mention-view.js';
import { ModelPickerView } from './model-picker-view.js';
import type { ModelPickerState } from './model-picker.js';
import { filterPaletteEntries, type PaletteEntry } from './palette-entries.js';
import type { PaletteList } from './palette-reducer.js';
import { PaletteView } from './palette-view.js';
import { ReverseSearchView } from './reverse-search-view.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
  type ChatSetup,
} from './surface-matrix/chat-host.js';
import { CHAT_SURFACES } from './surface-matrix/surfaces-chat.js';
import { SIZES, type Variant } from './surface-matrix/variants.js';
import { withoutStyles } from './harness-util.js';

/**
 * An overlay of the full-screen chat keeps its own rows ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §10; observed in the real CLI at 80×24 and 100×30): the chat's box is `rows` tall and the viewport inside it is the part that gives way, so
 * an overlay opened over a conversation must be drawn exactly as it is over an empty one. Yoga shrinks every flex item that has not said
 * `flexShrink={0}`, in proportion to its size, so an overlay that did not say it was squeezed onto its neighbours' rows (two rows on one line:
 * `/exit  End the chat session.lose`, the legend overwritten, the `▲ N more` count wrong) for as long as the transcript above it was long enough
 * to keep the squeeze going.
 *
 * Two levels. Through the mounted chats (`ChatApp` and the Home's chat, at both sizes, over a short and a long transcript), where the oracle is
 * the overlay over an EMPTY conversation, in which nothing is squeezed; and, view by view, in a box that is too small for the view and a greedy
 * sibling, so that the property does not rest on a terminal that happens to be tall enough.
 */
afterEach(cleanup);

/** The overlays that sit in the chat's box, below the conversation: the surface names the matrix gives them. */
const OVERLAYS = [
  'palette',
  'model-picker',
  'effort-picker',
  'mention',
  'reverse-search',
  'sheet-permissions',
  'sheet-agent',
] as const;

const OVERLAY_SURFACES = CHAT_SURFACES.filter((entry) =>
  OVERLAYS.some((name) => entry.id.endsWith(`.${name}`)),
);

/** The chat's footer line: the row that sits directly above the overlays. */
const isFooter = (line: string): boolean => / · \d+ turns? · /u.test(line);

async function frameWithTranscript(
  entry: (typeof OVERLAY_SURFACES)[number],
  variant: Variant,
  notices: number,
): Promise<string[]> {
  const base: ChatSetup =
    (typeof entry.setup === 'function' ? await entry.setup(variant) : entry.setup) ?? {};
  const setup: ChatSetup = {
    ...base,
    prepare: (store) => {
      base.prepare?.(store);
      for (let index = 0; index < notices; index += 1) store.notice(`transcript row ${index}`);
    },
  };
  const mount: ChatMount =
    entry.host === 'chat'
      ? await mountHostedChat(variant, setup)
      : mountStandaloneChat(variant, setup);
  try {
    await mount.settle();
    await entry.open(mount);
    await mount.settle();
    return mount.frame();
  } finally {
    mount.unmount();
  }
}

describe.each(OVERLAY_SURFACES)('$id', (entry) => {
  it.each(SIZES)(
    'is drawn over a conversation exactly as over an empty one, at $cols×$rows',
    async (size) => {
      const variant: Variant = { renderer: 'alt', color: true, size };
      const reference = await frameWithTranscript(entry, variant, 0);
      const footerAt = reference.findIndex(isFooter);
      expect(footerAt, 'the empty conversation has its footer').toBeGreaterThanOrEqual(0);
      const overlay = reference.slice(footerAt + 1);
      expect(overlay.length, 'an overlay is open').toBeGreaterThan(0);
      for (const notices of [3, 30]) {
        const frame = await frameWithTranscript(entry, variant, notices);
        const shown = `${String(notices)} transcript rows:\n${frame.join('\n')}`;
        expect(frame.length, `the frame keeps its height\n${shown}`).toBe(reference.length);
        expect(isFooter(frame[frame.length - overlay.length - 1] ?? ''), shown).toBe(true);
        expect(frame.slice(frame.length - overlay.length), shown).toEqual(overlay);
      }
    },
  );
});

describe('the / palette over a conversation, as observed', () => {
  const LEGEND_ROW = '↑/↓ select · Enter run · Esc close';
  const ENTRY_ROW = /^[› ] \/[a-z]+ {2}\S/u;

  it.each(
    CHAT_SURFACES.filter((entry) => entry.id.endsWith('.palette')).flatMap((entry) =>
      SIZES.map((size) => ({ entry, size })),
    ),
  )(
    'keeps the legend row whole and every entry on a line of its own, $entry.id at $size.cols×$size.rows',
    async ({ entry, size }) => {
      const variant: Variant = { renderer: 'alt', color: true, size };
      const frame = await frameWithTranscript(entry, variant, 3);
      const shown = frame.join('\n');
      expect(
        frame.filter((line) => line === LEGEND_ROW),
        shown,
      ).toHaveLength(1);
      const entries = frame.filter((line) => ENTRY_ROW.test(line));
      expect(entries.length, shown).toBeGreaterThan(8);
      // One entry per line: a line that holds a second `/name  ` start was two rows on the same y.
      for (const line of entries) {
        const starts = line.match(/(?:^|[›\s])\/[a-z]+ {2}/gu) ?? [];
        expect(starts, `${line}\n${shown}`).toHaveLength(1);
      }
      // The window counts what it hides: the entries drawn, and the `▲`/`▼` rows, are every entry of the list, once.
      const tall = await frameWithTranscript(
        entry,
        { ...variant, size: { cols: 100, rows: 60 } },
        0,
      );
      const total = tall.filter((line) => ENTRY_ROW.test(line)).length;
      const hidden = frame
        .map((line) => /^\s*[▲▼] (\d+) more/u.exec(line)?.[1])
        .reduce<number>((sum, count) => sum + (count === undefined ? 0 : Number(count)), 0);
      expect(entries.length + hidden, `the window's count\n${shown}`).toBe(total);
    },
  );
});

// ---- view by view: a box too small for the view and a greedy sibling ------------------------------------------------------

/**
 * `overlay` in a box `extra` rows taller than the overlay itself, under a sibling that wants far more rows than the box has and may be
 * clipped (the chat's viewport). The overlay's own rows must come out exactly as they do alone.
 */
function squeezed(overlay: ReactElement, extra = 2): { alone: string[]; inside: string[] } {
  const alone = render(overlay);
  const natural = withoutStyles(alone.lastFrame() ?? '').split('\n');
  alone.unmount();
  const box = render(
    <Box flexDirection="column" height={natural.length + extra} width={100}>
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {Array.from({ length: natural.length * 3 }, (_, index) => (
          <Text key={index}>{`filler ${String(index)}`}</Text>
        ))}
      </Box>
      {overlay}
    </Box>,
  );
  const inside = withoutStyles(box.lastFrame() ?? '').split('\n');
  box.unmount();
  return { alone: natural, inside: inside.slice(inside.length - natural.length) };
}

const command = (name: string): ReplCommand => ({
  name,
  label: name,
  description: `Does ${name}.`,
  effect: 'read',
  availableIn: ['home'],
  run: () => undefined,
});
const paletteEntry = (name: string, groupStart = false): PaletteEntry => ({
  command: command(name),
  description: `Does ${name}.`,
  group: 'work',
  groupStart,
  enabled: true,
});
const PALETTE_ENTRIES = ['run', 'doctor', 'help', 'cost', 'mode', 'models'].map((name, index) =>
  paletteEntry(name, index === 3),
);
const PALETTE: PaletteList = {
  entries: PALETTE_ENTRIES,
  rows: filterPaletteEntries(PALETTE_ENTRIES, ''),
  layout: 'up',
};

const modelEntry = (modelId: string): ModelCatalogEntry => ({
  modelId,
  provider: 'anthropic',
  displayName: modelId,
  pricingSource: 'catalog',
  priceKnown: true,
  available: true,
  deprecated: false,
});
const MODEL_STATE: ModelPickerState = {
  entries: ['claude-a', 'claude-b', 'claude-c'].map(modelEntry),
  filter: '',
  selected: 1,
  loading: false,
  currentDefault: undefined,
  refreshedAt: undefined,
  banner: undefined,
  hint: undefined,
  effortTiers: [],
  phase: 'model',
  effortStep: false,
  pending: undefined,
  effortSelected: 0,
  currentEffort: undefined,
};

const VIEWS: readonly { readonly name: string; readonly view: () => ReactElement }[] = [
  {
    name: 'the / palette',
    view: () => <PaletteView list={PALETTE} state={{ query: '', index: 0 }} color />,
  },
  {
    name: 'the @ mention list',
    view: () => (
      <MentionView
        state={{
          dir: '',
          filter: '',
          candidates: [
            { name: 'src', type: 'directory', path: 'src' },
            { name: 'app.ts', type: 'file', path: 'app.ts' },
            { name: 'README.md', type: 'file', path: 'README.md' },
          ],
          selected: 0,
          loading: false,
        }}
        color
      />
    ),
  },
  {
    name: 'the /models picker',
    view: () => <ModelPickerView state={MODEL_STATE} color nowMs={0} scope="this-chat" />,
  },
  {
    name: 'the /effort tiers',
    view: () => (
      <EffortTierList
        tiers={['low', 'medium', 'high']}
        model="claude-sonnet-4-5"
        selected={1}
        current={undefined}
        footer="↑/↓ select · Enter apply · Esc close"
        color
      />
    ),
  },
  {
    name: 'the Ctrl+R search',
    view: () => (
      <ReverseSearchView state={{ query: 'ab', matchIndex: 1 }} entries={['abc', 'abd']} color />
    ),
  },
  {
    name: 'the docked agent sheet',
    view: () => (
      <ChatSheetView
        state={agentChatSheet(
          boundAgentView(buildDefaultChatAgent('claude-opus-4-8', 'high', 'anthropic'), 'high'),
        )}
        color
        columns={100}
        rows={40}
      />
    ),
  },
];

describe('an overlay under a sibling that wants more rows than the box has', () => {
  it.each(VIEWS)('$name keeps every one of its rows on a line of its own', async ({ view }) => {
    const { alone, inside } = squeezed(view());
    await settleFrames();
    expect(alone.length, 'the view draws its rows').toBeGreaterThanOrEqual(3);
    expect(inside).toEqual(alone);
  });
});
