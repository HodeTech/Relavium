import { legendStates, plainRows, styledRows } from '../frames.js';
import { label, type Producer, type Recorder } from '../golden.js';
import { sourceLiteral } from '../source-literal.js';
import type { ModelCatalogEntry } from '@relavium/llm';
import type { ReactElement } from 'react';

import { providerDisplayName } from '../../../../engine/providers.js';
import { EffortTierList } from '../../effort-tier-list.js';
import { ModelPickerView, type ModelPickerScope } from '../../model-picker-view.js';
import type { ModelPickerState } from '../../model-picker.js';
import { createNativePromptAcknowledgement } from '../../native-prompt-acknowledgement.js';
import {
  createNativePromptChannel,
  type NativePromptOption,
  type NativePromptSnapshot,
  type NativePromptUi,
} from '../../native-prompt-channel.js';
import { NativePromptView } from '../../native-prompt-view.js';
import { selectLegend } from '../../native-select-window.js';

/**
 * The recorders of the native prompt cards (the picker, select, text, password, busy and chord cards of `NativePromptView`), the windowed
 * select, the two input errors of the channel, the `/models` picker and the effort tier list. Every card is opened on the REAL
 * `createNativePromptChannel()` (so a snapshot is what a flow publishes), drawn by the real view with the real acknowledgement, and read
 * back as the legend rows of the frame. A snapshot a flow only reaches after an asynchronous read (a picker's results, its empty list,
 * its "could not be read" error) is the channel's own picker snapshot with those fields set by hand; that is said where it is done.
 */

/** A terminal the card believes it is drawn in. The test renderer is 100 columns wide, so a card is mounted at `cols` (at most 100). */
export interface CardSize {
  readonly cols: number;
  readonly rows: number;
}
export const SIZE_80: CardSize = { cols: 80, rows: 24 };
export const SIZE_100: CardSize = { cols: 100, rows: 30 };
/** Below 80 x 24 by a column and by a row: the two ways a terminal is too small for a card. */
const TOO_SMALL: readonly CardSize[] = [
  { cols: 70, rows: 20 },
  { cols: 80, rows: 23 },
];
const sizeName = (size: CardSize): string => `${String(size.cols)}x${String(size.rows)}`;

/** The real channel of one open flow; the card is whatever the caller opens on it. */
export type NativeChannel = ReturnType<typeof createNativePromptChannel>;

/** Opens the flow, lets `open` publish ONE card on it, hands the channel to `use`, and closes everything (no clock, no timer, no I/O). */
export function withCard<T>(
  open: (channel: NativeChannel) => void,
  use: (channel: NativeChannel) => T,
): T {
  const channel = createNativePromptChannel({ now: () => 0 });
  channel.flow.begin();
  try {
    open(channel);
    return use(channel);
  } finally {
    channel.ui.dispose();
  }
}

/** The legend rows of `snapshot` drawn by the real view at `size`, without colour and with it. */
export function cardStates(
  state: string,
  ui: NativePromptUi,
  snapshot: NativePromptSnapshot,
  size: CardSize,
): Record<string, readonly string[]> {
  const acknowledgement = createNativePromptAcknowledgement(ui, () => size);
  try {
    return legendStates(
      state,
      (color) => (
        <NativePromptView
          snapshot={snapshot}
          color={color}
          acknowledgement={acknowledgement}
          size={size}
        />
      ),
      { columns: size.cols },
    );
  } finally {
    acknowledgement.dispose();
  }
}

/** Every row of `element` (not only the legend rows), without colour and with it: for a frame that is one sentence. */
function frameStates(
  state: string,
  element: (color: boolean) => ReactElement,
  columns: number,
): Record<string, readonly string[]> {
  return {
    [`${state} colour=off`]: plainRows(element(false), { columns }),
    [`${state} colour=on`]: styledRows(element(true), { columns }),
  };
}

/** The same, for a card the view refuses to draw whole (too small a terminal, a card that does not fit): the sentence is the whole frame. */
function wholeCardStates(
  state: string,
  ui: NativePromptUi,
  snapshot: NativePromptSnapshot,
  size: CardSize,
  columns: number,
): Record<string, readonly string[]> {
  const acknowledgement = createNativePromptAcknowledgement(ui, () => size);
  try {
    return frameStates(
      state,
      (color) => (
        <NativePromptView
          snapshot={snapshot}
          color={color}
          acknowledgement={acknowledgement}
          size={size}
        />
      ),
      columns,
    );
  } finally {
    acknowledgement.dispose();
  }
}

const ESCAPES = ['cancel', 'back'] as const;
type Escape = (typeof ESCAPES)[number];

const MENU: readonly NativePromptOption[] = [
  { value: 'alpha', label: 'Alpha' },
  { value: 'beta', label: 'Beta' },
  { value: 'gamma', label: 'Gamma', hint: 'the last one' },
];
/** More options than a 24-row terminal can hold: the select draws a window of them. */
const LONG_MENU: readonly NativePromptOption[] = Array.from({ length: 40 }, (_, index) => ({
  value: `option-${String(index + 1)}`,
  label: `Option ${String(index + 1).padStart(2, '0')}`,
}));
/** A message taller than any terminal: the card cannot be measured to fit. */
const HUGE_MESSAGE = `Disclosure ${'s'.repeat(4000)}`;

type Opener = (channel: NativeChannel) => void;
const openSelect =
  (escape: Escape, options: readonly NativePromptOption[], message = 'Pick one'): Opener =>
  (channel) => {
    void channel.flow.select({ message, options, escape });
  };
const openText =
  (escape: Escape): Opener =>
  (channel) => {
    void channel.flow.text({ message: 'Name it', escape });
  };
const openPassword =
  (escape: Escape): Opener =>
  (channel) => {
    void channel.flow.password({ message: 'API key', escape });
  };
const openBusy: Opener = (channel) => {
  channel.flow.busy('Working');
};
const openChord =
  (escape: Escape): Opener =>
  (channel) => {
    void channel.flow.chord({
      message: 'Run this tool?',
      details: ['Tool: read_file'],
      allow: 'Allow',
      deny: 'Deny',
      escape,
    });
  };
const openPicker: Opener = (channel) => {
  void channel.flow.pick({
    message: 'Resume a session',
    // Never called: the card is read and closed in the same tick, before the picker's first read runs.
    load: () => Promise.resolve({ unavailable: true }),
  });
};

/**
 * The picker card as the channel publishes it while it loads (a real snapshot), with the fields a finished read would set. The channel
 * cannot be driven to them synchronously (its read is a promise), so these are the real snapshot's own fields set by hand.
 */
export function pickerSnapshot(
  base: NativePromptSnapshot,
  over: {
    readonly options?: readonly NativePromptOption[];
    readonly loading?: boolean;
    readonly error?: string;
    readonly retryable?: boolean;
    readonly escape?: Escape;
  },
): NativePromptSnapshot {
  return {
    ...base,
    options: over.options ?? [],
    selected: 0,
    error: over.error ?? '',
    escape: over.escape ?? base.escape,
    picker: {
      allDirectories: false,
      page: 1,
      cursor: base.display.length,
      loading: over.loading ?? false,
      hasNext: false,
      hasPrevious: false,
      retryable: over.retryable ?? false,
    },
  };
}

const SESSIONS: readonly NativePromptOption[] = [
  { value: 'session-1', label: 'Review the plan · 2h ago' },
  { value: 'session-2', label: 'Untitled — agent · 1d ago' },
];

/** The text of the picker's `error` for a read that failed, as `native-picker.ts` writes it (the source literal: the read is a promise). */
const pickerUnavailable = (): string =>
  sourceLiteral('render/tui/native-picker.ts', 'Session history could not be read');

/** Every kind of card, by escape, windowed, picker state, size and colour. */
const nativePromptView: Recorder = () => {
  const out: Record<string, readonly string[]> = {};
  for (const size of [SIZE_80, SIZE_100]) {
    const at = sizeName(size);
    for (const escape of ESCAPES) {
      const cards: readonly (readonly [string, Opener])[] = [
        [label({ kind: 'select', windowed: false }), openSelect(escape, MENU)],
        [label({ kind: 'select', windowed: true }), openSelect(escape, LONG_MENU)],
        [label({ kind: 'text' }), openText(escape)],
        [label({ kind: 'password' }), openPassword(escape)],
        [label({ kind: 'chord' }), openChord(escape)],
      ];
      for (const [kind, open] of cards)
        withCard(open, ({ ui }) =>
          Object.assign(
            out,
            cardStates(`${kind} escape=${escape} size=${at}`, ui, ui.getSnapshot(), size),
          ),
        );
    }
    // A busy card has no escape of its own: the channel always publishes it as `cancel`.
    withCard(openBusy, ({ ui }) =>
      Object.assign(
        out,
        cardStates(`kind=busy escape=cancel size=${at}`, ui, ui.getSnapshot(), size),
      ),
    );
    // The picker: the legend under a list, a list still loading, no match, a read that failed (retry), a filter that was refused (edit).
    withCard(openPicker, ({ ui }) => {
      const loading = ui.getSnapshot();
      const picker: readonly (readonly [string, NativePromptSnapshot])[] = [
        [label({ picker: 'results' }), pickerSnapshot(loading, { options: SESSIONS })],
        [label({ picker: 'loading' }), pickerSnapshot(loading, { loading: true })],
        [label({ picker: 'no-results' }), pickerSnapshot(loading, {})],
        [
          label({ picker: 'error', retryable: true }),
          pickerSnapshot(loading, { error: pickerUnavailable(), retryable: true }),
        ],
        // The channel's own snapshot after a refused filter; the one case a picker error is reached without a read.
        [label({ picker: 'error', retryable: false }), refusedFilterSnapshot(ui)],
        // `Esc` leaves a picker whatever the flow asked of other cards: the legend does not read `back`.
        [
          label({ picker: 'results', escape: 'back' }),
          pickerSnapshot(loading, { options: SESSIONS, escape: 'back' }),
        ],
      ];
      for (const [state, snapshot] of picker)
        Object.assign(out, cardStates(`kind=picker ${state} size=${at}`, ui, snapshot, size));
    });
  }
  // A terminal below 80 x 24 draws one sentence, whatever the card; and so does a card that cannot be measured to fit.
  for (const size of TOO_SMALL) {
    for (const escape of ESCAPES) {
      withCard(openSelect(escape, MENU), ({ ui }) =>
        Object.assign(
          out,
          wholeCardStates(
            label({ kind: 'select', escape, size: sizeName(size), view: 'too-small' }),
            ui,
            ui.getSnapshot(),
            size,
            100,
          ),
        ),
      );
    }
    withCard(openChord('back'), ({ ui }) =>
      Object.assign(
        out,
        wholeCardStates(
          label({ kind: 'chord', escape: 'back', size: sizeName(size), view: 'too-small' }),
          ui,
          ui.getSnapshot(),
          size,
          100,
        ),
      ),
    );
  }
  for (const size of [SIZE_80, SIZE_100]) {
    for (const escape of ESCAPES) {
      withCard(openSelect(escape, MENU, HUGE_MESSAGE), ({ ui }) =>
        Object.assign(
          out,
          wholeCardStates(
            label({ kind: 'select', escape, size: sizeName(size), view: 'does-not-fit' }),
            ui,
            ui.getSnapshot(),
            size,
            size.cols,
          ),
        ),
      );
    }
  }
  return out;
};

/** The channel's picker snapshot after the person pasted a line break into the filter: the real refusal, published synchronously. */
function refusedFilterSnapshot(ui: NativePromptUi): NativePromptSnapshot {
  ui.paste('a\nb');
  return ui.getSnapshot();
}

/** `selectLegend` for all four combinations, and the legend the real view draws under a select that is windowed or whole. */
const nativeSelectWindow: Recorder = () => {
  const out: Record<string, readonly string[] | string> = {};
  for (const back of [false, true]) {
    for (const windowed of [false, true]) {
      out[label({ fn: 'selectLegend', back, windowed })] = selectLegend(back, windowed);
      withCard(openSelect(back ? 'back' : 'cancel', windowed ? LONG_MENU : MENU), ({ ui }) =>
        Object.assign(
          out,
          cardStates(
            label({ view: 'mounted', back, windowed, size: sizeName(SIZE_80) }),
            ui,
            ui.getSnapshot(),
            SIZE_80,
          ),
        ),
      );
    }
  }
  return out;
};

/** The two sentences `native-picker.ts` writes into the card's `error`, and the card that draws each. */
const nativePicker: Recorder = () => {
  const out: Record<string, readonly string[] | string> = {};
  withCard(openPicker, ({ ui }) => {
    const loading = ui.getSnapshot();
    // The filter refusal is driven for real: a pasted line break reaches the picker, which refuses it and says so.
    const refused = refusedFilterSnapshot(ui);
    out['error=filter-refused text'] = refused.error;
    Object.assign(out, cardStates('error=filter-refused frame', ui, refused, SIZE_80));
    // The failed read is the source's own sentence (the read is a promise, and a card is read in the tick that opens it).
    out['error=unavailable text'] = pickerUnavailable();
    Object.assign(
      out,
      cardStates(
        'error=unavailable frame',
        ui,
        pickerSnapshot(loading, { error: pickerUnavailable(), retryable: true }),
        SIZE_80,
      ),
    );
  });
  return out;
};

/** The two sentences the channel writes into a text or a password card's `error`, by kind and by what `Esc` does. */
const nativePromptChannel: Recorder = () => {
  const out: Record<string, readonly string[] | string> = {};
  const rejected = [
    ['too-long', 'x'.repeat(4097)],
    ['control-character', 'a\u0001b'],
  ] as const;
  for (const kind of ['text', 'password'] as const) {
    for (const escape of ESCAPES) {
      for (const [reason, input] of rejected) {
        const open = kind === 'text' ? openText(escape) : openPassword(escape);
        withCard(open, ({ ui }) => {
          ui.paste(input);
          const snapshot = ui.getSnapshot();
          const state = label({ kind, escape, rejected: reason });
          out[`${state} text`] = snapshot.error;
          // The card's own legend does not depend on the kind, so only the text card is drawn; at 100 columns, because at 80 the longer
          // sentence wraps, which is the terminal's doing and not the sentence's.
          if (kind === 'text')
            Object.assign(out, cardStates(`${state} frame`, ui, snapshot, SIZE_100));
        });
      }
    }
  }
  return out;
};

// ---------------------------------------------------------------------------------------------------------------------------------
// The `/models` picker and the effort tier list.
// ---------------------------------------------------------------------------------------------------------------------------------

export const PICKER_BASE: ModelPickerState = {
  entries: [],
  filter: '',
  selected: 0,
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

const catalogEntry = (over: Partial<ModelCatalogEntry>): ModelCatalogEntry => ({
  modelId: 'claude-x',
  provider: 'anthropic',
  displayName: 'Claude X',
  pricingSource: 'catalog',
  priceKnown: true,
  available: true,
  deprecated: false,
  ...over,
});

export const PICKER_ENTRIES: readonly ModelCatalogEntry[] = [
  catalogEntry({}),
  catalogEntry({
    modelId: 'gpt-x',
    provider: 'openai',
    displayName: 'GPT X',
    available: false,
    unavailableReason: 'no-key',
  }),
  catalogEntry({ modelId: 'old-x', displayName: 'Old X', deprecated: true }),
  catalogEntry({
    modelId: 'free-x',
    displayName: 'Free X',
    pricingSource: 'none',
    priceKnown: false,
  }),
];

const SCOPES = ['next-chat', 'this-chat'] as const satisfies readonly ModelPickerScope[];

/** The legend rows of the picker in `state`, at `columns`, with both colours; the state label is the caller's. */
export function modelPickerStates(
  stateLabel: string,
  state: ModelPickerState,
  scope: ModelPickerScope,
  columns: number,
): Record<string, readonly string[]> {
  return legendStates(
    `${stateLabel} columns=${String(columns)}`,
    (color) => (
      <ModelPickerView
        state={state}
        color={color}
        nowMs={0}
        providerName={providerDisplayName}
        scope={scope}
      />
    ),
    { columns },
  );
}

/** The footers and hints of the picker, by scope and by every state of its view that changes them. */
const modelPickerView: Recorder = () => {
  const out: Record<string, readonly string[]> = {};
  const effort: ModelPickerState = {
    ...PICKER_BASE,
    entries: PICKER_ENTRIES,
    phase: 'effort',
    effortStep: true,
    effortTiers: ['low', 'medium', 'high'],
    effortSelected: 1,
    currentEffort: 'medium',
    pending: { modelId: 'claude-x', displayName: 'Claude X', provider: 'anthropic' },
  };
  for (const scope of SCOPES) {
    const scenarios: readonly (readonly [string, ModelPickerState, readonly number[]])[] = [
      ['list=empty', PICKER_BASE, [80, 100]],
      ['list=loading', { ...PICKER_BASE, loading: true }, [100]],
      ['list=rows', { ...PICKER_BASE, entries: PICKER_ENTRIES, currentDefault: 'claude-x' }, [100]],
      [
        'list=rows filter=none-match',
        { ...PICKER_BASE, entries: PICKER_ENTRIES, filter: 'zzzz' },
        [100],
      ],
      [
        'list=rows refreshing',
        { ...PICKER_BASE, entries: PICKER_ENTRIES, loading: true, refreshedAt: 0 },
        [100],
      ],
      ['phase=effort', effort, [100]],
    ];
    for (const [state, picker, widths] of scenarios)
      for (const columns of widths)
        Object.assign(out, modelPickerStates(`scope=${scope} ${state}`, picker, scope, columns));
  }
  return out;
};

/** The footer line each of the three hosts of the tier list passes it, drawn by the real list under the tiers. */
const effortTierList: Recorder = () => {
  const out: Record<string, readonly string[]> = {};
  const callers = [
    ['chat-ink overlay', sourceLiteral('render/tui/chat-ink.tsx', '↑/↓ select · Enter apply')],
    ['home-app overlay', sourceLiteral('render/tui/home-app.tsx', '↑/↓ select · Enter apply')],
    [
      'model-picker sub-step',
      sourceLiteral('render/tui/model-picker-view.tsx', '↑/↓ select · Enter apply'),
    ],
  ] as const;
  for (const [caller, footer] of callers) {
    Object.assign(
      out,
      legendStates(
        `caller=${caller}`,
        (color) => (
          <EffortTierList
            tiers={['low', 'medium', 'high']}
            model="claude-sonnet-4-6"
            selected={0}
            current="medium"
            labelSuffix="claude-sonnet-4-6"
            footer={footer}
            color={color}
          />
        ),
        { columns: 100 },
      ),
    );
  }
  return out;
};

/** The standalone `/effort` overlay's footer in a stand-alone chat: an inline literal of the chat host, passed whole. */
const chatEffortOverlay: Recorder = () => ({
  'footer (source literal)': sourceLiteral('render/tui/chat-ink.tsx', '↑/↓ select · Enter apply'),
});

/** The standalone `/effort` overlay's footer in a chat the Home hosts: an inline literal of the Home host, passed whole. */
const homeEffortOverlay: Recorder = () => ({
  'footer (source literal)': sourceLiteral('render/tui/home-app.tsx', '↑/↓ select · Enter apply'),
});

export const PROMPTS_PRODUCERS: readonly Producer[] = [
  {
    id: 'native-prompt-view',
    file: 'render/tui/native-prompt-view.tsx',
    describe:
      'The legend under a native card (select, text, password, chord, busy, picker and its error/empty/loading states), by escape, windowed, size and colour; the too-small and does-not-fit sentences.',
  },
  {
    id: 'native-select-window',
    file: 'render/tui/native-select-window.ts',
    describe:
      'selectLegend(back, windowed) for the four combinations, and the legend the view draws under a whole and a windowed select.',
  },
  {
    id: 'native-picker',
    file: 'render/tui/native-picker.ts',
    describe:
      'The two sentences of the picker card’s error (a failed read: Enter/Esc; a refused filter: Esc) and the card that draws each.',
  },
  {
    id: 'native-prompt-channel',
    file: 'render/tui/native-prompt-channel.ts',
    describe:
      'The two input errors of a text or password card (too long, a control character), naming Backspace and Esc, by escape.',
  },
  {
    id: 'model-picker-view',
    file: 'render/tui/model-picker-view.tsx',
    describe:
      'The /models picker’s footer by scope, its no-models-yet hint, and the effort sub-step footer, by list state, width and colour.',
  },
  {
    id: 'effort-tier-list',
    file: 'render/tui/effort-tier-list.tsx',
    describe:
      'The tier list draws the footer its caller passes (chat overlay, Home overlay, model-picker sub-step) as its last row.',
  },
  {
    id: 'chat-effort-overlay',
    file: 'render/tui/chat-ink.tsx',
    describe:
      'The footer the chat host passes the standalone /effort overlay (a source literal, passed on whole to the tier list).',
  },
  {
    id: 'home-effort-overlay',
    file: 'render/tui/home-app.tsx',
    describe:
      'The footer the Home host passes the standalone /effort overlay of a hosted chat (a source literal, passed on whole).',
  },
];

export const PROMPTS_RECORDERS = {
  'native-prompt-view': nativePromptView,
  'native-select-window': nativeSelectWindow,
  'native-picker': nativePicker,
  'native-prompt-channel': nativePromptChannel,
  'model-picker-view': modelPickerView,
  'effort-tier-list': effortTierList,
  'chat-effort-overlay': chatEffortOverlay,
  'home-effort-overlay': homeEffortOverlay,
} as const satisfies Readonly<Record<string, Recorder>>;
