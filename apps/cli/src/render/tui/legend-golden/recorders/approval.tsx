import { hintRowsOfFrame, settled } from '../frames.js';
import { label, type Producer, type Recorder, type Rows, type StateRows } from '../golden.js';
import type { ToolApprovalRequest, ToolPreview } from '@relavium/core';
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import type { CommandCardFacts } from '../../../../chat/command-facts.js';
import { createChatStore, type ChatStoreController } from '../../chat-store.js';
import { FULLSCREEN_TRANSCRIPT_BOUND } from '../../session-view-model.js';
import {
  CARD_ENTER_NOTE,
  CARD_LOCKOUT_NOTE,
  CARD_TYPEAHEAD_NOTE,
  cardKeyLegend,
  cardKeyRows,
  cardScopePhrase,
  cardWarnings,
  commandFactRows,
  type CardKeyInput,
} from '../../tool-review-card.js';
import type { ApprovalGuard } from '../../tool-review-model.js';
import { createReviewDocument } from '../../tool-review-projection.js';
import {
  DETAILS_CLOSE_NOTE,
  FULL_COMMAND_NOTE,
  FULL_CONFIRM_ANY_ROW,
  FULL_CONFIRM_ENTER_LEGEND,
  FULL_CONFIRM_ENTER_ROW,
  FULL_DENY_LEGEND,
  FULL_DENY_ROW,
  FULL_PROTECTED_NOTE,
  callListView,
  fullAnswerRows,
  fullNavLegend,
  fullNavRows,
  fullSearchRows,
  fullWarnings,
} from '../../tool-review-screen.js';
import type { LegendRender } from '../../legend.js';
import { rowSegments } from '../../legend-row.js';
import {
  ToolReviewHost,
  keyTone,
  reviewScreen,
  reviewUnavailableText,
} from '../../tool-review-view.js';

/**
 * The approval card family ([ADR-0129](../../../../../../../docs/decisions/0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md),
 * ADR-0134): the card's two key rows, its warnings, the full view's answer rows, navigation legend and warnings, the call list's hint,
 * the sentences that say a review cannot be shown, and the mounted host for the rows only the view writes (the exit hint, the
 * denial box, the search line). The pure functions are called with every input that changes their words; the host is mounted over the
 * real store, with the approval guard off so a recorded key is applied at once.
 */

export const APPROVAL_PRODUCERS: readonly Producer[] = [
  {
    id: 'approval-card-keys',
    file: 'render/tui/tool-review-card.ts',
    describe:
      'the card’s two key rows (grants, then refusals and Esc) by kind x locked x cacheable x remember x confirmation',
  },
  {
    id: 'approval-card-notes',
    file: 'render/tui/tool-review-card.ts',
    describe: 'the three one-line notes shown when an affirmative key was not counted',
  },
  {
    id: 'approval-card-warnings',
    file: 'render/tui/tool-review-card.ts',
    describe:
      'the warning rows that name [v] / [r] or say Allow is locked, by cause and by whether the call was inspected',
  },
  {
    id: 'approval-full-keys',
    file: 'render/tui/tool-review-screen.ts',
    describe:
      'the full view’s answer rows, its two confirm rows, the search rows and the closing notes',
  },
  {
    id: 'approval-full-nav',
    file: 'render/tui/tool-review-screen.ts',
    describe:
      'the full view’s navigation legend (`[↑↓] scroll`, `[r]`, `[p]`, `[c]`) by what the document offers and by width',
  },
  {
    id: 'approval-full-warnings',
    file: 'render/tui/tool-review-screen.ts',
    describe: 'the full view’s lock sentences that name Home, PgDn, [r] by what is still owed',
  },
  {
    id: 'approval-call-list',
    file: 'render/tui/tool-review-screen.ts',
    describe:
      'the tool-call list’s hint row (select, open, oldest/newest, close), with and without calls',
  },
  {
    id: 'approval-unavailable',
    file: 'render/tui/tool-review-view.tsx',
    describe:
      'what the card says in place of itself when it cannot be shown (names [v] and [p] only on the card)',
  },
  {
    id: 'approval-key-roles',
    file: 'render/tui/tool-review-view.tsx',
    describe:
      'how each part of a key row is toned: allow green, deny red, exits yellow, other keys cyan, words dim',
  },
  {
    id: 'approval-host',
    file: 'render/tui/tool-review-view.tsx',
    describe:
      'the mounted card, full view, search line, denial box, details list and the below-80x24 refusal, with the exit hint each carries',
  },
];

// ── the pure functions ───────────────────────────────────────────────────────────────────────────────────────────────────

const SCOPES = [cardScopePhrase('write_file'), cardScopePhrase('a_tool_with_a_very_long_name')];

type Confirm = 'none' | 'always' | 'remember';

/** Every `CardKeyInput` a card can be in: remember is a command's, and each confirmation needs the key that asks it. */
function keyInputs(): { state: string; input: CardKeyInput }[] {
  const out: { state: string; input: CardKeyInput }[] = [];
  for (const command of [false, true]) {
    for (const inspected of [true, false]) {
      for (const cacheable of [true, false]) {
        for (const remember of command ? [false, true] : [false]) {
          const confirms: readonly Confirm[] = [
            'none',
            ...(cacheable ? (['always'] as const) : []),
            ...(remember ? (['remember'] as const) : []),
          ];
          for (const confirm of confirms) {
            for (const scope of SCOPES) {
              if (command && scope !== SCOPES[0]) continue;
              out.push({
                state: label({ command, inspected, cacheable, remember, confirm, scope }),
                input: {
                  inspected,
                  cacheable,
                  scope,
                  ...(command ? { command: true, remember } : {}),
                  confirmAlways: confirm === 'always',
                  ...(command ? { confirmRemember: confirm === 'remember' } : {}),
                },
              });
            }
          }
        }
      }
    }
  }
  return out;
}

const cardKeys: Recorder = () => {
  const out: Record<string, readonly string[]> = {};
  for (const { state, input } of keyInputs()) out[state] = cardKeyRows(input);
  return out;
};

const cardNotes: Recorder = () => ({
  'typeahead note': CARD_TYPEAHEAD_NOTE,
  'lockout note': CARD_LOCKOUT_NOTE,
  'enter note': CARD_ENTER_NOTE,
});

/**
 * The sentences of rows the card wrapped to its width: a continuation row starts with two spaces. The wording is what is recorded; where
 * a sentence breaks is the layout's, which the frame states of the mounted host cover.
 */
function sentences(rows: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row.startsWith('  ') && out.length > 0) out[out.length - 1] += ` ${row.trim()}`;
    else out.push(row);
  }
  return out;
}

const SECRET = 'Bearer sk-proj-abcdefghijklmnopqrstuvw';

function diffPreview(after: string, extraLines = 0): ToolPreview {
  const added = [
    after,
    ...Array.from({ length: extraLines }, (_, index) => `line ${String(index)}`),
  ];
  let at = 0;
  const lines = added.map((text, index) => {
    const start = at;
    at += text.length + 1;
    return {
      kind: 'added' as const,
      text,
      ending: 'lf' as const,
      after: { line: index + 1, start, end: at },
    };
  });
  return {
    kind: 'operation',
    target: 'notes.md',
    fields: [],
    diff: {
      before: null,
      after: `${added.join('\n')}\n`,
      beforeEndings: 'empty',
      afterEndings: 'lf',
      stats: {
        addedLines: added.length,
        removedLines: 0,
        beforeBytes: 0,
        afterBytes: at,
      },
      lines,
    },
  };
}

/** A call with no diff: the rows of a command or a tool whose preview is its fields. */
const FIELDS_PREVIEW: ToolPreview = {
  kind: 'operation',
  target: 'git',
  fields: [{ name: 'args', value: '["status"]' }],
};

const FACTS: CommandCardFacts = {
  standing: 'not-pre-approved',
  runsCode: false,
  protectedPath: false,
  cwd: '/work/project',
  offers: { session: true, remember: true },
};

const warnings: Recorder = () => {
  const base = {
    shortenedTarget: false,
    targetHiddenBytes: 0,
    inspected: false,
    changesNotShown: 0,
    columns: 78,
  };
  const out: Record<string, readonly string[]> = {};
  const secret = createReviewDocument(diffPreview(SECRET));
  const plain = createReviewDocument(diffPreview('hello'));
  const fields = createReviewDocument(FIELDS_PREVIEW);
  const command = createReviewDocument(FIELDS_PREVIEW, { command: true });
  for (const inspected of [false, true]) {
    out[label({ cause: 'shortened target', inspected })] = sentences(
      cardWarnings({
        ...base,
        inspected,
        document: plain,
        shortenedTarget: true,
        targetHiddenBytes: 120,
      }),
    );
    out[label({ cause: 'masked values in a change', inspected })] = sentences(
      cardWarnings({
        ...base,
        inspected,
        document: secret,
      }),
    );
    out[label({ cause: 'masked values in a command', inspected })] = sentences(
      cardWarnings({
        ...base,
        inspected,
        document: createReviewDocument(
          { kind: 'operation', target: 'curl', fields: [{ name: 'args', value: SECRET }] },
          { command: true },
        ),
        commandFacts: FACTS,
      }),
    );
    out[label({ cause: 'no cause named', inspected })] = sentences(
      cardWarnings({
        ...base,
        inspected,
        document: plain,
      }),
    );
  }
  for (const count of [1, 3]) {
    out[label({ cause: 'changed lines not shown', count })] = sentences(
      cardWarnings({
        ...base,
        inspected: true,
        document: plain,
        changesNotShown: count,
      }),
    );
  }
  for (const count of [1, 4]) {
    out[label({ cause: 'lines of a call not shown', count })] = sentences(
      cardWarnings({
        ...base,
        inspected: true,
        document: fields,
        linesNotShown: count,
      }),
    );
    for (const [offers, text] of [
      [{ session: true, remember: true }, 'session and remember offered'],
      [{ session: false, remember: false }, 'nothing to withhold'],
    ] as const) {
      out[label({ cause: 'rows of a command not shown', count, offers: text })] = sentences(
        cardWarnings({
          ...base,
          inspected: true,
          document: command,
          linesNotShown: count,
          commandFacts: { ...FACTS, offers },
        }),
      );
    }
  }
  out['command facts: runs code'] = commandFactRows({ ...FACTS, runsCode: true }, 78, true);
  out['command facts: protected path'] = commandFactRows(
    { ...FACTS, protectedPath: true },
    78,
    true,
  );
  return out;
};

const fullKeys: Recorder = () => {
  const out: Record<string, Rows> = {};
  for (const { state, input } of keyInputs()) {
    if (input.scope !== SCOPES[0]) continue;
    out[state] = fullAnswerRows(input);
  }
  out['search box open'] = fullSearchRows();
  out['constant: confirm (enter)'] = FULL_CONFIRM_ENTER_ROW;
  out['constant: confirm (any key)'] = FULL_CONFIRM_ANY_ROW;
  out['constant: deny row'] = FULL_DENY_ROW;
  out['constant: protected-path note'] = FULL_PROTECTED_NOTE;
  out['constant: command note'] = FULL_COMMAND_NOTE;
  out['constant: details close note'] = DETAILS_CLOSE_NOTE;
  return out;
};

const fullNav: Recorder = () => {
  const out: Record<string, readonly string[]> = {};
  for (const columns of [80, 100]) {
    for (const hasChanges of [false, true]) {
      for (const hasMasks of [false, true]) {
        for (const revealed of hasMasks ? [false, true] : [false]) {
          for (const numeric of [false, true]) {
            for (const canCopy of [false, true]) {
              out[label({ columns, hasChanges, hasMasks, revealed, numeric, canCopy })] =
                fullNavLegend({ columns, hasChanges, hasMasks, revealed, numeric, canCopy });
            }
          }
        }
      }
    }
  }
  return out;
};

const fullWarningStates: Recorder = () => {
  const out: Record<string, readonly string[]> = {};
  const secret = createReviewDocument(diffPreview(SECRET));
  const maskedTarget = createReviewDocument({
    kind: 'operation',
    target: SECRET,
    fields: [],
  });
  const plain = createReviewDocument(diffPreview('hello'));
  const approval = { kind: 'approval' as const, columns: 78 };
  out[label({ owed: 'whole target', masked: false })] = sentences(
    fullWarnings({
      ...approval,
      document: plain,
      pending: { target: true, masks: 0 },
    }),
  );
  out[label({ owed: 'whole target', masked: true })] = sentences(
    fullWarnings({
      ...approval,
      document: maskedTarget,
      pending: { target: true, masks: 1 },
    }),
  );
  for (const masks of [1, 2]) {
    out[label({ owed: 'masked values', masks })] = sentences(
      fullWarnings({
        ...approval,
        document: secret,
        pending: { target: false, masks },
      }),
    );
  }
  out[label({ owed: 'nothing' })] = sentences(
    fullWarnings({
      ...approval,
      document: plain,
      pending: { target: false, masks: 0 },
    }),
  );
  out[label({ kind: 'details' })] = sentences(
    fullWarnings({
      kind: 'details',
      columns: 78,
      document: plain,
      pending: { target: false, masks: 0 },
    }),
  );
  return out;
};

const callList: Recorder = () => {
  const out: Record<string, readonly string[]> = {};
  const calls = [
    { callId: 'a', toolId: 'write_file', outcome: 'success' as const, target: 'a.md' },
    { callId: 'b', toolId: 'run_command', outcome: 'failure' as const, target: 'npm' },
  ];
  for (const columns of [80, 100]) {
    const empty = callListView({ calls: [], selected: 0, columns, terminalRows: 24 });
    out[label({ columns, calls: 'none' })] = [empty.empty ?? '', empty.hint];
    const some = callListView({ calls, selected: 1, columns, terminalRows: 24 });
    out[label({ columns, calls: 'two' })] = [some.hint];
  }
  return out;
};

const unavailable: Recorder = () => {
  const out: Record<string, string> = {};
  for (const onCard of [true, false]) {
    for (const [cause, why] of [
      ['frame not measured', { identityInvalid: false, commandTooLarge: false }],
      ['identity', { identityInvalid: true, commandTooLarge: false }],
      ['command too large', { identityInvalid: false, commandTooLarge: true }],
    ] as const) {
      out[label({ onCard, cause })] = reviewUnavailableText({ ...why, onCard });
    }
  }
  return out;
};

/** What a tone object means, in words: `{ color: 'green', bold: true }` is `green+bold`. */
function toneName(tone: Record<string, unknown>): string {
  const parts = Object.entries(tone)
    .filter(([, value]) => value !== false && value !== undefined)
    .map(([key, value]) => (value === true ? key : String(value)));
  return parts.length === 0 ? 'none' : parts.join('+');
}

const keyRoles: Recorder = () => {
  const rows: Record<string, LegendRender> = {
    'card, tool, inspected': cardKeyLegend({
      inspected: true,
      cacheable: true,
      scope: SCOPES[0] ?? '',
    })[0],
    'card, tool, refusals': cardKeyLegend({
      inspected: true,
      cacheable: true,
      scope: SCOPES[0] ?? '',
    })[1],
    'card, command, remember': cardKeyLegend({
      inspected: true,
      cacheable: true,
      scope: '',
      command: true,
      remember: true,
    })[0],
    'full view, nav (all keys)': fullNavRows({
      columns: 100,
      hasChanges: true,
      hasMasks: true,
      revealed: false,
      numeric: false,
      canCopy: true,
    })[0] ?? { text: '', spans: [] },
    'full view, deny row': FULL_DENY_LEGEND,
    'full view, confirm row': FULL_CONFIRM_ENTER_LEGEND,
  };
  const out: Record<string, readonly string[]> = {};
  for (const [state, row] of Object.entries(rows)) {
    out[state] = rowSegments(row).map(
      (part) => `${JSON.stringify(part.text)} = ${toneName(keyTone(part.role, true))}`,
    );
  }
  out['colour off'] = rowSegments(FULL_DENY_LEGEND).map(
    (part) => `${JSON.stringify(part.text)} = ${toneName(keyTone(part.role, false))}`,
  );
  return out;
};

// ── the mounted host ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The guard off: a recorded key is the answer, as in the host's own tests. */
const NO_GUARD: ApprovalGuard = {
  settleMs: 0,
  quietMs: 0,
  typeaheadMs: 0,
  lockoutMs: 0,
  confirmAlways: false,
};

const REQUEST: ToolApprovalRequest = {
  toolId: 'write_file',
  action: 'fs_write',
  preview: { path: 'notes.md' },
  unredactedPreview: { path: 'notes.md' },
};
const COMMAND_REQUEST: ToolApprovalRequest = {
  toolId: 'run_command',
  action: 'process',
  preview: { command: 'npm test' },
  unredactedPreview: { command: 'npm test' },
  argv: ['npm', 'test'],
  commandAdmitted: false,
};
const COMMAND_PREVIEW: ToolPreview = {
  kind: 'operation',
  target: 'npm test',
  fields: [
    { name: '', value: 'npm' },
    { name: '', value: 'test' },
  ],
};

/** Wait for the host's frame to stop changing. */
const settle = (host: Host): Promise<void> => settled(() => host.raw());

interface Size {
  readonly cols: number;
  readonly rows: number;
}

const FLOOR: Size = { cols: 80, rows: 24 };
const TOO_SMALL: Size = { cols: 70, rows: 20 };

/**
 * The width the host is laid out in: the terminal's own when it is drawable (a card wider than the size it was measured against is
 * refused, so a wrapper wider than the terminal would make every card "unavailable"), else the test renderer's 100 columns, wide
 * enough for the one-line refusal.
 */
const frameWidth = (size: Size): number => (size.cols >= 80 ? size.cols : 100);

/** A host over a fresh store; `frame()` is the frame as it is now, plain or with its styled runs tagged. */
function openHost(color: boolean, size: Size, guard: ApprovalGuard, above: number) {
  const store = createChatStore(color, undefined, FULLSCREEN_TRANSCRIPT_BOUND, {
    approvalGuard: guard,
  });
  // `above` rows over the host leave a card no room inside the terminal it was measured against, and the host then says so.
  const mount = (current: Size) => (
    <Box flexDirection="column" width={frameWidth(current)}>
      {Array.from({ length: above }, (_, row) => (
        <Text key={`above-${String(row)}`}>·</Text>
      ))}
      <ToolReviewHost store={store} size={current} hasCustody={() => true} color={color} />
    </Box>
  );
  const view = render(mount(size));
  return {
    store,
    resize: (next: Size) => view.rerender(mount(next)),
    raw: () => view.lastFrame() ?? '',
    close: () => {
      store.sealToolPreviews();
      view.unmount();
    },
  };
}

type Host = ReturnType<typeof openHost>;

function openCall(
  host: Host,
  request: ToolApprovalRequest,
  preview: ToolPreview,
  facts?: CommandCardFacts,
): void {
  void host.store
    .requestApproval(
      request,
      facts?.offers.session ?? true,
      undefined,
      { callId: 'call', preview },
      facts,
    )
    .catch(() => undefined);
}

/**
 * What the host's measured-frame acknowledgement does once a frame has been flushed: the store is told this exact review is on screen.
 * The test renderer cannot confirm a flush, so the recorder says it itself, for the review and the page the host would draw now.
 */
function acknowledge(host: Host, size: Size = FLOOR): void {
  const snapshot = host.store.getSnapshot();
  if (snapshot.review === undefined) return;
  host.store.bindReviewVisibility(() => true);
  host.store.acknowledgeReviewFrame(snapshot.review, reviewScreen(snapshot, size, false).page);
}

const press = (
  store: ChatStoreController,
  input: string,
  key: Parameters<ChatStoreController['handleReviewInput']>[1] = {},
): void => {
  store.handleReviewInput(input, key);
};

interface Scenario {
  readonly state: string;
  readonly size?: Size;
  /** The rows the host drew are one sentence the renderer wrapped (the refusals), not separate legend rows. */
  readonly oneSentence?: boolean;
  /** Rows drawn above the host: enough of them and the card does not fit the terminal. */
  readonly above?: number;
  /** The guard the store runs with; absent ⇒ every layer off, except the Enter that confirms a session or remember grant. */
  readonly guard?: ApprovalGuard;
  readonly drive: (host: Host) => Promise<void>;
}

const SCENARIOS: readonly Scenario[] = [
  {
    state: 'card: a change',
    drive: async (host) => {
      openCall(host, REQUEST, diffPreview('hello'));
      await settle(host);
    },
  },
  {
    state: 'card: a change with a masked value (Allow locked)',
    drive: async (host) => {
      openCall(host, REQUEST, diffPreview(SECRET));
      await settle(host);
    },
  },
  {
    state: 'card: a command',
    drive: async (host) => {
      openCall(host, COMMAND_REQUEST, COMMAND_PREVIEW, FACTS);
      await settle(host);
    },
  },
  {
    state: 'card: a command that runs code (no remember)',
    drive: async (host) => {
      openCall(host, COMMAND_REQUEST, COMMAND_PREVIEW, {
        ...FACTS,
        runsCode: true,
        offers: { session: true, remember: false },
      });
      await settle(host);
    },
  },
  {
    state: 'card: the session grant is waiting for Enter',
    guard: { ...NO_GUARD, confirmAlways: true },
    drive: async (host) => {
      openCall(host, REQUEST, diffPreview('hello'));
      await settle(host);
      acknowledge(host);
      press(host.store, 'g', { ctrl: true });
      await settle(host);
    },
  },
  {
    state: 'card: a command, the session grant is waiting for Enter',
    guard: { ...NO_GUARD, confirmAlways: true },
    drive: async (host) => {
      openCall(host, COMMAND_REQUEST, COMMAND_PREVIEW, FACTS);
      await settle(host);
      acknowledge(host);
      press(host.store, 'g', { ctrl: true });
      await settle(host);
    },
  },
  {
    state: 'card: a command, remembering it is waiting for Enter',
    guard: { ...NO_GUARD, confirmAlways: true },
    drive: async (host) => {
      openCall(host, COMMAND_REQUEST, COMMAND_PREVIEW, FACTS);
      await settle(host);
      acknowledge(host);
      press(host.store, 'o', { ctrl: true });
      await settle(host);
    },
  },
  {
    state: 'full view: the session grant is waiting for Enter',
    guard: { ...NO_GUARD, confirmAlways: true },
    drive: async (host) => {
      openCall(host, REQUEST, diffPreview('hello'));
      await settle(host);
      acknowledge(host);
      press(host.store, 'v');
      await settle(host);
      acknowledge(host);
      press(host.store, 'g', { ctrl: true });
      await settle(host);
    },
  },
  {
    state: 'full view: a command, remembering it is waiting for Enter',
    guard: { ...NO_GUARD, confirmAlways: true },
    drive: async (host) => {
      openCall(host, COMMAND_REQUEST, COMMAND_PREVIEW, FACTS);
      await settle(host);
      acknowledge(host);
      press(host.store, 'v');
      await settle(host);
      acknowledge(host);
      press(host.store, 'o', { ctrl: true });
      await settle(host);
    },
  },
  {
    state: 'card: the denial reason box is open',
    drive: async (host) => {
      openCall(host, REQUEST, diffPreview('hello'));
      await settle(host);
      host.store.bindReviewVisibility(() => true);
      press(host.store, 'r', { ctrl: true });
      await settle(host);
    },
  },
  {
    state: 'full view',
    drive: async (host) => {
      openCall(host, REQUEST, diffPreview('hello'));
      await settle(host);
      host.store.bindReviewVisibility(() => true);
      press(host.store, 'v');
      await settle(host);
    },
  },
  {
    state: 'full view: a command',
    drive: async (host) => {
      openCall(host, COMMAND_REQUEST, COMMAND_PREVIEW, FACTS);
      await settle(host);
      host.store.bindReviewVisibility(() => true);
      press(host.store, 'v');
      await settle(host);
    },
  },
  {
    state: 'full view: the search box is open',
    drive: async (host) => {
      openCall(host, REQUEST, diffPreview('hello'));
      await settle(host);
      host.store.bindReviewVisibility(() => true);
      press(host.store, 'v');
      press(host.store, '/');
      await settle(host);
    },
  },
  {
    state: 'details list',
    drive: async (host) => {
      host.store.openDetails();
      await settle(host);
    },
  },
  {
    state: 'card, below 80x24',
    oneSentence: true,
    size: TOO_SMALL,
    drive: async (host) => {
      openCall(host, REQUEST, diffPreview('hello'));
      await settle(host);
    },
  },
  {
    state: 'full view, below 80x24',
    oneSentence: true,
    size: TOO_SMALL,
    drive: async (host) => {
      openCall(host, REQUEST, diffPreview('hello'));
      await settle(host);
      host.store.bindReviewVisibility(() => true);
      press(host.store, 'v');
      await settle(host);
    },
  },
  {
    state: 'denial box open, then below 80x24',
    oneSentence: true,
    drive: async (host) => {
      openCall(host, REQUEST, diffPreview('hello'));
      await settle(host);
      host.store.bindReviewVisibility(() => true);
      press(host.store, 'r', { ctrl: true });
      await settle(host);
      host.resize(TOO_SMALL);
      await settle(host);
    },
  },
  {
    state: 'search box open, then below 80x24',
    oneSentence: true,
    drive: async (host) => {
      openCall(host, REQUEST, diffPreview('hello'));
      await settle(host);
      host.store.bindReviewVisibility(() => true);
      press(host.store, 'v');
      press(host.store, '/');
      await settle(host);
      host.resize(TOO_SMALL);
      await settle(host);
    },
  },
  {
    state: 'card, no room for it',
    oneSentence: true,
    above: 22,
    drive: async (host) => {
      openCall(host, REQUEST, diffPreview('hello'));
      await settle(host);
    },
  },
  {
    state: 'a command card, no room for it',
    oneSentence: true,
    above: 22,
    drive: async (host) => {
      openCall(host, COMMAND_REQUEST, COMMAND_PREVIEW, FACTS);
      await settle(host);
    },
  },
  {
    state: 'full view, no room for it',
    oneSentence: true,
    above: 22,
    drive: async (host) => {
      openCall(host, REQUEST, diffPreview('hello'));
      await settle(host);
      acknowledge(host);
      press(host.store, 'v');
      await settle(host);
    },
  },
  {
    state: 'denial box open, no room for it',
    oneSentence: true,
    above: 22,
    drive: async (host) => {
      openCall(host, REQUEST, diffPreview('hello'));
      await settle(host);
      acknowledge(host);
      press(host.store, 'r', { ctrl: true });
      await settle(host);
    },
  },
  {
    state: 'details list, below 80x24',
    oneSentence: true,
    size: TOO_SMALL,
    drive: async (host) => {
      host.store.openDetails();
      await settle(host);
    },
  },
];

/** The hint-shaped rows of what a host drew, without colour and with it (`⟦style: run⟧`). */
async function hostStates(scenario: Scenario): Promise<StateRows> {
  const out: Record<string, readonly string[]> = {};
  for (const color of [false, true]) {
    const host = openHost(
      color,
      scenario.size ?? FLOOR,
      scenario.guard ?? NO_GUARD,
      scenario.above ?? 0,
    );
    try {
      await scenario.drive(host);
      const rows = hintRowsOfFrame(host.raw(), color);
      out[`${scenario.state} colour=${color ? 'on' : 'off'}`] =
        scenario.oneSentence === true ? [rows.join(' ')] : rows;
    } finally {
      host.close();
    }
  }
  return out;
}

const host: Recorder = async () => {
  const out: Record<string, readonly string[]> = {};
  for (const scenario of SCENARIOS) {
    Object.assign(out, await hostStates(scenario));
  }
  return out;
};

export const APPROVAL_RECORDERS = {
  'approval-card-keys': cardKeys,
  'approval-card-notes': cardNotes,
  'approval-card-warnings': warnings,
  'approval-full-keys': fullKeys,
  'approval-full-nav': fullNav,
  'approval-full-warnings': fullWarningStates,
  'approval-call-list': callList,
  'approval-unavailable': unavailable,
  'approval-key-roles': keyRoles,
  'approval-host': host,
} as const satisfies Readonly<Record<string, Recorder>>;
