import { hintRowsOfFrame, settled } from '../frames.js';
import { label, type Producer, type Recorder } from '../golden.js';
import type { AskUserRequest } from '@relavium/core';
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import type { ChatKey } from '../../chat-input.js';
import { CheckpointCardHost } from '../../checkpoint-card-view.js';
import { projectCheckpointCard } from '../../checkpoint-card.js';
import { createChatStore } from '../../chat-store.js';
import {
  initialQuestionCard,
  reduceQuestionKey,
  type QuestionCardState,
} from '../../question-card-model.js';
import { projectQuestionCard } from '../../question-card.js';
import { QuestionCardHost } from '../../question-card-view.js';
import { FULLSCREEN_TRANSCRIPT_BOUND } from '../../session-view-model.js';

/**
 * The cards that ask the person for a decision besides an approval: the agent's question ([ADR-0132](../../../../../../../docs/decisions/0132-the-model-can-ask-the-user-a-structured-question.md))
 * and the continue checkpoint ([ADR-0136](../../../../../../../docs/decisions/0136-a-turn-asks-to-continue-at-a-checkpoint-instead-of-dying-at-a-ceiling.md)).
 * Each card's two key rows come from its own pure projection; the sentences only the view writes (the refusal below 80x24, the card
 * that could not be shown) come from the mounted host over the real store.
 */

export const QUESTION_PRODUCERS: readonly Producer[] = [
  {
    id: 'question-card-keys',
    file: 'render/tui/question-card.ts',
    describe:
      'the question card’s two key rows (the choosing keys, then the stop keys) by question kind x own-answer field x review tab x several questions x guidance note x width',
  },
  {
    id: 'question-card-body-hints',
    file: 'render/tui/question-card.ts',
    describe:
      'the review tab’s closing line and the hints the card shows under its options (Saved. Press Enter ...)',
  },
  {
    id: 'question-card-view',
    file: 'render/tui/question-card-view.tsx',
    describe:
      'the two sentences the host draws instead of the card: below 80x24, and a frame that could not be measured',
  },
  {
    id: 'checkpoint-card',
    file: 'render/tui/checkpoint-card.ts',
    describe:
      'the checkpoint card’s fact row, its key row ([Ctrl+Y] Continue / [Ctrl+N] Stop here) and its stop row, by width',
  },
  {
    id: 'checkpoint-card-view',
    file: 'render/tui/checkpoint-card-view.tsx',
    describe:
      'the card drawn, with and without colour, and the two sentences the host draws instead of it',
  },
  {
    id: 'question-card-model',
    file: 'render/tui/question-card-model.ts',
    describe: 'the hint the model puts under a saved multi-select answer',
  },
];

const OPTIONS = [
  { label: 'Alpha', description: 'The first choice.' },
  { label: 'Beta', description: 'The second choice.' },
] as const;

const request = (questions: readonly { multiSelect: boolean }[]): AskUserRequest => ({
  questions: questions.map((question, index) => ({
    header: `Q${String(index + 1)}`,
    question: `Question number ${String(index + 1)}?`,
    multiSelect: question.multiSelect,
    options: OPTIONS.map((option) => ({ ...option })),
  })),
});

const ENTER: ChatKey = { return: true };
const DOWN: ChatKey = { downArrow: true };
const RIGHT: ChatKey = { rightArrow: true };

/** `state` after the keys, each applied as a person at a visible card would; a key that does not move the card is an error here. */
function pressed(
  state: QuestionCardState,
  keys: readonly (readonly [string, ChatKey])[],
): QuestionCardState {
  let current = state;
  for (const [input, key] of keys) {
    const action = reduceQuestionKey(current, input, key, true);
    if (action.kind !== 'state')
      throw new Error(`the key ${JSON.stringify(input || key)} did not move the card`);
    current = action.state;
  }
  return current;
}

interface Case {
  readonly state: string;
  readonly card: QuestionCardState;
}

function questionCases(): readonly Case[] {
  const one = initialQuestionCard(request([{ multiSelect: false }]));
  const oneMulti = initialQuestionCard(request([{ multiSelect: true }]));
  const two = initialQuestionCard(request([{ multiSelect: false }, { multiSelect: false }]));
  const twoMulti = initialQuestionCard(request([{ multiSelect: true }, { multiSelect: false }]));
  const ownRow = (card: QuestionCardState): QuestionCardState =>
    pressed(card, [
      ['', DOWN],
      ['', DOWN],
    ]);
  return [
    { state: 'one question, single choice', card: one },
    { state: 'one question, single choice, own answer row highlighted', card: ownRow(one) },
    {
      state: 'one question, single choice, own answer field open',
      card: pressed(ownRow(one), [['x', {}]]),
    },
    { state: 'one question, multiple choice', card: oneMulti },
    { state: 'one question, multiple choice, one ticked', card: pressed(oneMulti, [[' ', {}]]) },
    {
      state: 'one question, multiple choice, own answer typed and saved',
      card: pressed(ownRow(oneMulti), [
        ['x', {}],
        ['', ENTER],
      ]),
    },
    {
      state: 'one question, multiple choice, nothing ticked, Enter',
      card: pressed(oneMulti, [['', ENTER]]),
    },
    { state: 'two questions, single choice', card: two },
    { state: 'two questions, multiple choice first', card: twoMulti },
    { state: 'two questions, own answer field open', card: pressed(ownRow(two), [['x', {}]]) },
    { state: 'two questions, second question', card: pressed(two, [['', RIGHT]]) },
    {
      state: 'two questions, the review tab',
      card: pressed(two, [
        ['', ENTER],
        ['', ENTER],
      ]),
    },
    {
      state: 'two questions, Enter on the review tab with a question not answered',
      card: pressed(two, [
        ['', RIGHT],
        ['', RIGHT],
        ['', ENTER],
      ]),
    },
  ];
}

const questionKeys: Recorder = () => {
  const out: Record<string, readonly string[]> = {};
  for (const { state, card } of questionCases()) {
    for (const columns of [80, 50]) {
      for (const guideNote of [false, true]) {
        const view = projectQuestionCard(card, columns, { guideNote });
        out[label({ state, columns, guideNote })] = [...view.keys];
      }
    }
  }
  return out;
};

const questionBody: Recorder = () => {
  const out: Record<string, readonly string[]> = {};
  for (const { state, card } of questionCases()) {
    const view = projectQuestionCard(card, 80);
    const rows = view.body
      .filter((row) => row.tone === 'hint' || row.tone === 'description')
      .map((row) => row.text)
      .filter((text) => /Press|Enter|←|→|↑|↓|Esc|Ctrl/u.test(text));
    if (rows.length > 0) out[state] = rows;
  }
  return out;
};

/**
 * The sizes a card is drawn at. The last is a card that is drawn but does not fit the terminal it was measured against (22 rows above it
 * leave it no room), which the host refuses to take keys for and says so.
 */
const SIZES = [
  ['80x24', { cols: 80, rows: 24 }, 0],
  ['70x20', { cols: 70, rows: 20 }, 0],
  ['80x24, no room for the card', { cols: 80, rows: 24 }, 22],
] as const;

/** `host` in a column that has `above` rows over it. */
const withRowsAbove = (above: number, size: { cols: number }, host: ReactElement): ReactElement => (
  <Box flexDirection="column" width={size.cols >= 80 ? size.cols : 100}>
    {Array.from({ length: above }, (_, row) => (
      <Text key={`above-${String(row)}`}>·</Text>
    ))}
    {host}
  </Box>
);

/** The question card's host over a store that holds this question, drawn at each size. */
const questionView: Recorder = async () => {
  const out: Record<string, readonly string[]> = {};
  for (const [name, size, above] of SIZES) {
    for (const color of [false, true]) {
      const store = createChatStore(color, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
      const view = render(
        withRowsAbove(
          above,
          size,
          <QuestionCardHost store={store} size={size} hasCustody={() => true} color={color} />,
        ),
      );
      void store.requestQuestion(request([{ multiSelect: false }])).catch(() => undefined);
      await settled(() => view.lastFrame() ?? '');
      out[`size=${name} colour=${color ? 'on' : 'off'}`] = hintRowsOfFrame(
        view.lastFrame() ?? '',
        color,
      );
      store.sealToolPreviews();
      view.unmount();
    }
  }
  return out;
};

const checkpointCard: Recorder = () => {
  const out: Record<string, readonly string[]> = {};
  for (const columns of [80, 40]) {
    for (const rounds of [1, 32]) {
      const view = projectCheckpointCard({ rounds, interval: 32, elapsedMs: 61_000 }, columns);
      out[label({ columns, rounds })] = [view.fact, ...view.keys];
    }
  }
  return out;
};

const checkpointView: Recorder = async () => {
  const out: Record<string, readonly string[]> = {};
  for (const [name, size, above] of SIZES) {
    for (const color of [false, true]) {
      const store = createChatStore(color, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
      const view = render(
        withRowsAbove(
          above,
          size,
          <CheckpointCardHost store={store} size={size} hasCustody={() => true} color={color} />,
        ),
      );
      void store.requestCheckpoint({ rounds: 32, interval: 32 }).catch(() => undefined);
      await settled(() => view.lastFrame() ?? '');
      out[`size=${name} colour=${color ? 'on' : 'off'}`] = hintRowsOfFrame(
        view.lastFrame() ?? '',
        color,
      );
      store.sealToolPreviews();
      view.unmount();
    }
  }
  return out;
};

const questionModel: Recorder = () => {
  const multi = initialQuestionCard(request([{ multiSelect: true }]));
  const saved = pressed(multi, [
    ['', DOWN],
    ['', DOWN],
    ['x', {}],
    ['', ENTER],
  ]);
  return { 'multiple choice, own answer typed and saved': saved.hint ?? '' };
};

export const CARDS_PRODUCERS: readonly Producer[] = QUESTION_PRODUCERS;
export const CARDS_RECORDERS = {
  'question-card-keys': questionKeys,
  'question-card-body-hints': questionBody,
  'question-card-view': questionView,
  'checkpoint-card': checkpointCard,
  'checkpoint-card-view': checkpointView,
  'question-card-model': questionModel,
} as const satisfies Readonly<Record<string, Recorder>>;
