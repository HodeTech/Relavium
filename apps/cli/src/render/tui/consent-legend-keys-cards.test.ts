import { describe, expect, it, vi } from 'vitest';

import type { AskUserRequest } from '@relavium/core';

import type { RunBudgetGate, RunCardGate, RunGate } from '../../home/run-gates.js';
import type { HostedLaunch, RunHostSnapshot } from '../../home/run-host.js';
import type { ChatKey } from './chat-input.js';
import { projectCheckpointCard, reduceCheckpointKey } from './checkpoint-card.js';
import { LEGEND_SEPARATOR } from './legend.js';
import { projectQuestionCard } from './question-card.js';
import {
  initialQuestionCard,
  reduceQuestionKey,
  type QuestionCardState,
  type QuestionKeyAction,
} from './question-card-model.js';
import { createRunCard, projectRunCard, type RunCardSnapshot } from './run-card-model.js';
import { exitGuardLines } from './home-projection.js';
import { runScreenModel } from './run-screen.js';
import type { ApprovalGuard } from './tool-review-model.js';

/**
 * Every key a consent surface's key line names does what the line says it does
 * ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §3): the question card, the checkpoint card, the
 * run's gate card, the run view and the exit guard. Each line is split into its items (the keys and the words), each item is looked up in
 * a table of what pressing it must do, and an item the table does not know fails the test: a hint cannot name a key the handler does not
 * act on, and a key cannot be added to a line without a press that checks it.
 */

const CTRL: ChatKey = { ctrl: true };
const ESC: ChatKey = { escape: true };

/** The items of a key line, in order. */
const itemsOf = (line: string): string[] => line.split(LEGEND_SEPARATOR);

/** Each item of `line` is checked by its entry in `effects`; returns the items so a test can say which it expected. */
function check(line: string, effects: Readonly<Record<string, () => void>>): string[] {
  const items = itemsOf(line);
  for (const item of items) {
    const effect = effects[item];
    if (effect === undefined)
      throw new Error(`the line names "${item}", which has no checked effect`);
    effect();
  }
  return items;
}

// ---------------------------------------------------------------------------------------------------------------------
// the question card
// ---------------------------------------------------------------------------------------------------------------------

const OPTIONS = [
  { label: 'Alpha', description: 'The first' },
  { label: 'Beta', description: 'The second' },
];
const SINGLE = { header: 'One', question: 'Which?', multiSelect: false, options: OPTIONS };
const MULTI = { header: 'Many', question: 'Which ones?', multiSelect: true, options: OPTIONS };
const REQUEST: AskUserRequest = { questions: [SINGLE, MULTI] };

function ask(state: QuestionCardState, input: string, key: ChatKey = {}): QuestionKeyAction {
  return reduceQuestionKey(state, input, key, true);
}

function stateOf(action: QuestionKeyAction): QuestionCardState {
  if (action.kind !== 'state') throw new Error(`expected a state change, got ${action.kind}`);
  return action.state;
}

describe('the question card: every key its lines name does what they say (ADR-0145 §3)', () => {
  const lines = (state: QuestionCardState) => projectQuestionCard(state, 80).keys;

  /** What the keys of the stop line do, on any state without an open field: both stop the turn. */
  const stops = (state: QuestionCardState) => ({
    'Esc / [Ctrl+C] stops the turn': () => {
      expect(ask(state, '', ESC)).toEqual({ kind: 'stop' });
      expect(ask(state, 'c', CTRL)).toEqual({ kind: 'stop' });
    },
  });

  it('on a single-select question: move, choose, type your own, questions, skip all; Esc and Ctrl+C stop', () => {
    const state = initialQuestionCard(REQUEST);
    const [answers, stop] = lines(state);
    expect(
      check(answers, {
        '↑/↓ move': () => {
          expect(stateOf(ask(state, '', { downArrow: true })).entries[0]?.highlight).toBe(1);
          expect(
            stateOf(ask(stateOf(ask(state, '', { downArrow: true })), '', { upArrow: true }))
              .entries[0]?.highlight,
          ).toBe(0);
        },
        'Enter choose': () => {
          const chosen = stateOf(ask(state, '', { return: true }));
          expect(chosen.entries[0]?.ticked).toEqual([0]);
          expect(chosen.index).toBe(1);
        },
        'type your own': () => expect(stateOf(ask(state, 'x')).field?.text).toBe('x'),
        '←/→ questions': () => expect(stateOf(ask(state, '', { rightArrow: true })).index).toBe(1),
        '[Ctrl+S] skip all': () => expect(ask(state, 's', CTRL)).toEqual({ kind: 'skip' }),
      }),
    ).toEqual(['↑/↓ move', 'Enter choose', 'type your own', '←/→ questions', '[Ctrl+S] skip all']);
    expect(check(stop, stops(state))).toEqual(['Esc / [Ctrl+C] stops the turn']);
  });

  it('on a multi-select question: move, tick, continue, questions, skip all', () => {
    const state = { ...initialQuestionCard(REQUEST), index: 1 };
    const [answers] = lines(state);
    expect(
      check(answers, {
        '↑/↓ move': () =>
          expect(stateOf(ask(state, '', { downArrow: true })).entries[1]?.highlight).toBe(1),
        'Space tick': () => expect(stateOf(ask(state, ' ')).entries[1]?.ticked).toEqual([0]),
        'Enter continue': () => {
          const ticked = stateOf(ask(state, ' '));
          const next = stateOf(ask(ticked, '', { return: true }));
          expect(next.index).toBe(2);
        },
        '←/→ questions': () => expect(stateOf(ask(state, '', { leftArrow: true })).index).toBe(0),
        '[Ctrl+S] skip all': () => expect(ask(state, 's', CTRL)).toEqual({ kind: 'skip' }),
      }),
    ).toEqual(['↑/↓ move', 'Space tick', 'Enter continue', '←/→ questions', '[Ctrl+S] skip all']);
  });

  it('with the own-answer field open: save, back to the list, skip all; Esc closes it and Ctrl+C stops', () => {
    const open = stateOf(ask(initialQuestionCard(REQUEST), 'x'));
    const [answers, stop] = lines(open);
    expect(
      check(answers, {
        'Enter save': () => {
          const saved = stateOf(ask(open, '', { return: true }));
          expect(saved.entries[0]?.own).toBe('x');
        },
        '↑ back to the list': () => {
          expect(stateOf(ask(open, '', { upArrow: true })).field).toBeUndefined();
        },
        '[Ctrl+S] skip all': () => expect(ask(open, 's', CTRL)).toEqual({ kind: 'skip' }),
      }),
    ).toEqual(['Enter save', '↑ back to the list', '[Ctrl+S] skip all']);
    expect(
      check(stop, {
        '[Ctrl+C] stops the turn': () => expect(ask(open, 'c', CTRL)).toEqual({ kind: 'stop' }),
        // Esc closes the field and stops nothing: the call stays pending, as the line says
        'Esc close': () => {
          expect(stateOf(ask(open, '', ESC)).field).toBeUndefined();
        },
      }),
    ).toEqual(['[Ctrl+C] stops the turn', 'Esc close']);
  });

  it('on the Review tab: send answers, questions, skip all; Esc and Ctrl+C stop', () => {
    const answered = initialQuestionCard(REQUEST);
    const review: QuestionCardState = {
      ...answered,
      index: 2,
      entries: answered.entries.map((entry) => ({ ...entry, ticked: [0] })),
    };
    const [answers, stop] = lines(review);
    expect(
      check(answers, {
        'Enter send answers': () => expect(ask(review, '', { return: true }).kind).toBe('submit'),
        '←/→ questions': () => expect(stateOf(ask(review, '', { leftArrow: true })).index).toBe(1),
        '[Ctrl+S] skip all': () => expect(ask(review, 's', CTRL)).toEqual({ kind: 'skip' }),
      }),
    ).toEqual(['Enter send answers', '←/→ questions', '[Ctrl+S] skip all']);
    check(stop, stops(review));
  });

  it('says only where a write needs no card that an answer guides and does not veto, and then still names the stop keys', () => {
    const state = initialQuestionCard(REQUEST);
    const [, guided] = projectQuestionCard(state, 80, { guideNote: true }).keys;
    expect(itemsOf(guided)).toEqual([
      'an answer is guidance, not a veto',
      'Esc / [Ctrl+C] stops the turn',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the checkpoint card
// ---------------------------------------------------------------------------------------------------------------------

describe('the checkpoint card: every key its lines name does what they say (ADR-0145 §3)', () => {
  const [answers, stop] = projectCheckpointCard(
    { rounds: 8, interval: 8, elapsedMs: 60_000 },
    80,
  ).keys;

  it('names Ctrl+Y to continue and Ctrl+N to stop here, and nothing else answers', () => {
    expect(
      check(answers, {
        '[Ctrl+Y] Continue': () =>
          expect(reduceCheckpointKey('y', CTRL)).toEqual({ kind: 'continue' }),
        '[Ctrl+N] Stop here': () =>
          expect(reduceCheckpointKey('n', CTRL)).toEqual({ kind: 'stop' }),
      }),
    ).toEqual(['[Ctrl+Y] Continue', '[Ctrl+N] Stop here']);
    for (const [input, key] of [
      ['y', {}],
      ['n', {}],
      ['', { return: true }],
      ['s', CTRL],
    ] as const)
      expect(reduceCheckpointKey(input, key), `${input} ${JSON.stringify(key)}`).toEqual({
        kind: 'none',
      });
  });

  it('names Esc and Ctrl+C as the keys that stop the turn, and both end it', () => {
    expect(
      check(stop, {
        'Esc / [Ctrl+C] stops the turn': () => {
          expect(reduceCheckpointKey('', ESC)).toEqual({ kind: 'stop' });
          // Ctrl+C stops too, and starts the interrupt keymap's window as well
          expect(reduceCheckpointKey('c', CTRL)).toEqual({ kind: 'interrupt' });
        },
      }),
    ).toEqual(['Esc / [Ctrl+C] stops the turn']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the run's gate card
// ---------------------------------------------------------------------------------------------------------------------

describe('the gate card: every key its line names does what it says (ADR-0145 §3)', () => {
  const RUN = 'run-0001';
  const OFF: ApprovalGuard = { settleMs: 0, quietMs: 0, typeaheadMs: 0, lockoutMs: 0 };
  const STARTED: HostedLaunch = {
    kind: 'started',
    leg: 'resume',
    runId: RUN,
    ended: new Promise(() => undefined),
  };
  const gate = (id: string, over: Partial<RunGate> = {}): RunGate => ({
    runId: RUN,
    gateId: id,
    nodeId: `node-${id}`,
    gateType: 'approval',
    message: `Approve ${id}?`,
    accepts: ['approved', 'rejected'],
    ...over,
  });
  const budget = (id: string): RunBudgetGate => ({
    runId: RUN,
    gateId: id,
    nodeId: `node-${id}`,
    allowance: { kind: 'amount', microcents: 4_200_000 },
    accepts: ['approved', 'rejected'],
  });

  function rig(gates: readonly RunCardGate[]) {
    const resume = vi.fn(() => Promise.resolve(STARTED));
    const card = createRunCard({
      runId: RUN,
      gates,
      resume,
      now: () => 10_000,
      guard: OFF,
      painted: () => true,
    });
    const line = (snapshot: RunCardSnapshot = card.getSnapshot()): string =>
      projectRunCard(snapshot, { columns: 80, rows: 24, nowMs: 0 }).rows.at(-1)?.text ?? '';
    card.shown(card.getSnapshot());
    return { card, line };
  }

  it('names the cursor, Approve, Reject and Esc leaves it pending, and each does it', () => {
    const { card, line } = rig([gate('a'), gate('b')]);
    expect(
      check(line(), {
        '↑/↓ choose a gate': () => {
          expect(card.input('', { downArrow: true })).toEqual({ kind: 'moved' });
          expect(card.getSnapshot().cursor).toBe(1);
          expect(card.input('', { upArrow: true })).toEqual({ kind: 'moved' });
          expect(card.getSnapshot().cursor).toBe(0);
        },
        '[Ctrl+Y] Approve': () => {
          const fresh = rig([gate('a'), gate('b')]).card;
          expect(fresh.input('y', CTRL)).toMatchObject({
            kind: 'answered',
            decision: { decision: 'approved' },
          });
        },
        '[Ctrl+N] Reject': () => {
          const fresh = rig([gate('a'), gate('b')]).card;
          expect(fresh.input('n', CTRL)).toMatchObject({
            kind: 'answered',
            decision: { decision: 'rejected' },
          });
        },
        'Esc leaves it pending': () => {
          // Esc decides nothing: the gate stays open and nothing was sent
          expect(card.input('', ESC)).toEqual({ kind: 'ignored' });
          expect(card.getSnapshot().phase).toBe('open');
        },
      }),
    ).toEqual([
      '↑/↓ choose a gate',
      '[Ctrl+Y] Approve',
      '[Ctrl+N] Reject',
      'Esc leaves it pending',
    ]);
  });

  it('names only Reject on a gate that takes a typed value, and Ctrl+Y answers nothing there', () => {
    const { card, line } = rig([gate('a', { gateType: 'input', accepts: ['rejected'] })]);
    expect(itemsOf(line())).toEqual(['[Ctrl+N] Reject', 'Esc leaves it pending']);
    expect(card.input('y', CTRL)).toEqual({ kind: 'ignored' });
    expect(card.input('n', CTRL)).toMatchObject({
      kind: 'answered',
      decision: { decision: 'rejected' },
    });
  });

  it('names Abort for a budget gate’s Ctrl+N, which rejects the step at the budget', () => {
    const { card, line } = rig([budget('b')]);
    expect(itemsOf(line())).toEqual([
      '[Ctrl+Y] Approve',
      '[Ctrl+N] Abort',
      'Esc leaves it pending',
    ]);
    expect(card.input('n', CTRL)).toMatchObject({
      kind: 'answered',
      decision: { decision: 'rejected' },
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the run view
// ---------------------------------------------------------------------------------------------------------------------

describe('the run view: the key line names only what the state has (ADR-0145 §3)', () => {
  const RUN = 'run-0001';
  const executing: RunHostSnapshot = {
    launching: false,
    active: { leg: 'start', runId: RUN, cancelling: false },
    last: undefined,
  };
  const model = (over: Partial<Parameters<typeof runScreenModel>[0]> = {}) =>
    runScreenModel({
      runId: RUN,
      snapshot: executing,
      notices: [],
      armed: false,
      columns: 80,
      rows: 24,
      ...over,
    });

  it('names Ctrl+C twice and Esc leaves it running, and says one more Ctrl+C once the first armed it', () => {
    expect(itemsOf(model().keys)).toEqual([
      '[Ctrl+C] cancel the run (twice)',
      'Esc leaves it running',
    ]);
    expect(itemsOf(model({ armed: true }).keys)).toEqual([
      '[Ctrl+C] cancel the run (again)',
      'Esc leaves it running',
    ]);
  });

  it('names no Ctrl+C that cancels once the run is stopping or gone: there is nothing it would cancel', () => {
    const cancelling = model({
      snapshot: { ...executing, active: { leg: 'start', runId: RUN, cancelling: true } },
    });
    expect(itemsOf(cancelling.keys)).toEqual([
      'Waiting for the run to stop',
      'Esc leaves the view',
    ]);
    expect(cancelling.leg).toBe('cancelling');
    const replaced = model({ snapshot: undefined });
    expect(replaced.keys).toBe('Esc / [Ctrl+C] close');
    expect(replaced.leg).toBe('none');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the exit guard
// ---------------------------------------------------------------------------------------------------------------------

describe('the exit guard: the keys its lines name are the keys that leave and the keys that stay', () => {
  const running: RunHostSnapshot = {
    launching: false,
    active: { leg: 'start', runId: 'run-0001', cancelling: false },
    last: undefined,
  };

  it('names Ctrl+Y as the one key that leaves, and Esc, Ctrl+C and Ctrl+N as the keys that stay', () => {
    const line = exitGuardLines('confirm', running, 13).at(-1) ?? '';
    expect(itemsOf(line)).toEqual([
      '[Ctrl+Y] stop the run and leave',
      'Esc / [Ctrl+C] / [Ctrl+N] stay',
    ]);
  });
});
