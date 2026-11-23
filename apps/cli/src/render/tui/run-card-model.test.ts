/**
 * The human-gate card's model
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §4): the cursor over several gates, the
 * answer that applies to the gate under it only, what the host's reply does to the card, and an overdue gate answered in both orders.
 *
 * Every guard layer is off here (`run-card-keys.test.ts` owns them), so a test names one rule of the model. The run host is scripted: a
 * reply is a promise the test settles.
 */
import { describe, expect, it, vi } from 'vitest';

import { approvalDecision } from '../../gate/decision.js';
import type { RunGate } from '../../home/run-gates.js';
import type { HostedLaunch, HostedResumeRequest } from '../../home/run-host.js';
import {
  createGateResumer,
  createRunCard,
  projectRunCard,
  RUN_CARD_GUTTER,
  type RunCard,
  type RunCardSnapshot,
} from './run-card-model.js';
import type { ChatKey } from './chat-input.js';
import { flush } from './harness-util.js';

const RUN = 'run-0001';
const OFF = { settleMs: 0, quietMs: 0, typeaheadMs: 0, lockoutMs: 0 } as const;
const ctrl = (letter: 'y' | 'n'): [string, ChatKey] => [letter, { ctrl: true }];
const DOWN: ChatKey = { downArrow: true };
const UP: ChatKey = { upArrow: true };

function gate(id: string, over: Partial<RunGate> = {}): RunGate {
  return {
    runId: RUN,
    gateId: id,
    nodeId: `node-${id}`,
    gateType: 'approval',
    message: `Approve ${id}?`,
    accepts: ['approved', 'rejected'],
    ...over,
  };
}

interface Pending {
  readonly request: Omit<HostedResumeRequest, 'secrets'>;
  readonly reply: (launch: HostedLaunch) => void;
  readonly fail: (cause: unknown) => void;
}

/** A card whose host replies when the test says so. */
function rig(gates: readonly RunGate[], now: () => number = () => 0) {
  const pending: Pending[] = [];
  const resume = vi.fn((request: Omit<HostedResumeRequest, 'secrets'>) => {
    let reply: (launch: HostedLaunch) => void = () => undefined;
    let fail: (cause: unknown) => void = () => undefined;
    const promise = new Promise<HostedLaunch>((resolve, reject) => {
      reply = resolve;
      fail = reject;
    });
    pending.push({ request, reply, fail });
    return promise;
  });
  const card = createRunCard({
    runId: RUN,
    gates,
    resume,
    now,
    guard: OFF,
    painted: () => true,
  });
  return { card, resume, pending };
}

const press = (card: RunCard, chord: [string, ChatKey]) => card.input(...chord);
const startedLaunch: HostedLaunch = {
  kind: 'started',
  leg: 'resume',
  runId: RUN,
  ended: new Promise(() => undefined),
};
const state = (card: RunCard): RunCardSnapshot => card.getSnapshot();

describe('the cursor over the open gates', () => {
  it('starts on the first gate, moves with the arrows and wraps at both ends', () => {
    const { card } = rig([gate('a'), gate('b'), gate('c')]);
    expect(state(card).cursor).toBe(0);
    expect(card.input('', DOWN)).toEqual({ kind: 'moved' });
    expect(card.input('', DOWN)).toEqual({ kind: 'moved' });
    expect(state(card).cursor).toBe(2);
    card.input('', DOWN);
    expect(state(card).cursor, 'past the last gate is the first').toBe(0);
    card.input('', UP);
    expect(state(card).cursor, 'before the first gate is the last').toBe(2);
  });

  it('has nothing to move over with one gate, and says so', () => {
    const { card } = rig([gate('only')]);
    expect(card.input('', DOWN)).toEqual({ kind: 'ignored' });
    expect(card.input('', UP)).toEqual({ kind: 'ignored' });
    expect(state(card).cursor).toBe(0);
  });

  it('a chord with ctrl or meta is not a cursor key', () => {
    const { card } = rig([gate('a'), gate('b')]);
    card.input('', { downArrow: true, ctrl: true });
    card.input('', { downArrow: true, meta: true });
    expect(state(card).cursor).toBe(0);
  });
});

describe('the answer applies to the gate under the cursor only', () => {
  it('answers the second gate when the cursor is on it, and the other two stay open and untouched', async () => {
    const { card, resume, pending } = rig([gate('a'), gate('b'), gate('c')]);
    card.input('', DOWN);
    const outcome = press(card, ctrl('y'));
    expect(outcome).toMatchObject({ kind: 'answered', gateId: 'b' });
    expect(resume).toHaveBeenCalledOnce();
    expect(resume.mock.calls[0]?.[0]).toMatchObject({
      runId: RUN,
      gate: 'b',
      kind: 'human',
      decision: { decision: 'approved', decidedBy: 'cli' },
    });
    pending[0]?.reply(startedLaunch);
    await flush();
    expect(
      state(card).gates.map((entry) => entry.gateId),
      'the other gates are still open',
    ).toEqual(['a', 'c']);
    expect(state(card).phase).toBe('answered');
  });

  it('Ctrl+N is a rejection of that gate, with the same shape the shell records', () => {
    const { card, resume } = rig([gate('a'), gate('b')]);
    card.input('', UP);
    expect(press(card, ctrl('n'))).toMatchObject({ kind: 'answered', gateId: 'b' });
    expect(resume.mock.calls[0]?.[0]).toMatchObject({
      gate: 'b',
      decision: { decision: 'rejected', decidedBy: 'cli' },
    });
    expect(resume.mock.calls[0]?.[0].decision).not.toHaveProperty('payload');
  });

  it('offers only what the gate accepts: an input gate takes a rejection, and Ctrl+Y answers nothing there', () => {
    const input = gate('typed', { gateType: 'input', accepts: ['input_provided', 'rejected'] });
    const { card, resume } = rig([input]);
    expect(press(card, ctrl('y'))).toEqual({ kind: 'ignored' });
    expect(resume).not.toHaveBeenCalled();
    expect(state(card).phase, 'the card is still open').toBe('open');
    const words = projectRunCard(state(card), { columns: 80, rows: 24, nowMs: 0 });
    const text = words.rows.map((row) => row.text).join('\n');
    expect(text).toContain('Ctrl+N rejects');
    expect(text).not.toContain('Ctrl+Y');
    expect(text).toContain('takes a typed value');
    expect(press(card, ctrl('n'))).toMatchObject({ kind: 'answered', gateId: 'typed' });
    expect(resume).toHaveBeenCalledOnce();
  });
});

describe('one answer in flight', () => {
  it('takes no other answer until the host replies, so a gate is never answered twice', () => {
    const { card, resume } = rig([gate('a'), gate('b')]);
    expect(press(card, ctrl('y'))).toMatchObject({ kind: 'answered', gateId: 'a' });
    expect(state(card).phase).toBe('answering');
    expect(press(card, ctrl('y')), 'a second chord while the first is out').toEqual({
      kind: 'ignored',
    });
    expect(press(card, ctrl('n'))).toEqual({ kind: 'ignored' });
    expect(card.input('', DOWN)).toEqual({ kind: 'ignored' });
    expect(resume, 'one answer, sent once').toHaveBeenCalledOnce();
  });

  it('shows what the host refused and puts the gate back where it was, answerable again', async () => {
    const { card, resume, pending } = rig([gate('a'), gate('b')]);
    card.input('', DOWN);
    press(card, ctrl('y'));
    pending[0]?.reply({
      kind: 'refused',
      reason: 'busy',
      message: 'A run is already executing: run-9.',
    });
    await flush();
    expect(state(card)).toMatchObject({
      phase: 'open',
      refused: true,
      notice: 'A run is already executing: run-9.',
      cursor: 1,
    });
    expect(state(card).gates.map((entry) => entry.gateId)).toEqual(['a', 'b']);
    const words = projectRunCard(state(card), { columns: 80, rows: 24, nowMs: 0 });
    expect(words.state).toBe('not-answered');
    expect(words.rows.map((row) => row.text).join('\n')).toContain(
      'A run is already executing: run-9.',
    );
    expect(press(card, ctrl('y'))).toMatchObject({ kind: 'answered', gateId: 'b' });
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'throws',
      (): Promise<HostedLaunch> => {
        throw new Error('boom');
      },
    ],
    ['rejects', (): Promise<HostedLaunch> => Promise.reject(new Error('boom'))],
  ])('a host that %s is a refusal, never a card stuck answering', async (_how, resume) => {
    const card = createRunCard({
      runId: RUN,
      gates: [gate('a')],
      resume,
      guard: OFF,
      painted: () => true,
    });
    press(card, ctrl('y'));
    await flush();
    expect(state(card)).toMatchObject({
      phase: 'open',
      refused: true,
      notice: 'The answer could not be sent.',
    });
    expect(JSON.stringify(state(card))).not.toContain('boom');
  });

  it('a re-read that lands while the answer is out does not bring the answered gate back once the host accepted it', async () => {
    const { card, pending } = rig([gate('a'), gate('b')]);
    press(card, ctrl('y'));
    // The log has not recorded the decision yet, so the read still lists both.
    card.update([gate('a'), gate('b')]);
    expect(state(card).phase).toBe('answering');
    pending[0]?.reply(startedLaunch);
    await flush();
    expect(state(card).gates.map((entry) => entry.gateId)).toEqual(['b']);
  });
});

describe('an overdue gate, answered in both orders', () => {
  const OVERDUE_AT = '2026-11-23T12:00:00.000Z';
  const overdue = (id: string, over: Partial<RunGate> = {}): RunGate =>
    gate(id, { expiresAt: OVERDUE_AT, timeoutAction: 'reject', ...over });
  const afterDeadline = Date.parse(OVERDUE_AT) + 5_000;

  it('says it is overdue with its deadline and the timeout policy, and still answers', () => {
    const { card, resume } = rig([overdue('late')]);
    const before = projectRunCard(state(card), {
      columns: 80,
      rows: 24,
      nowMs: Date.parse(OVERDUE_AT) - 1,
    });
    expect(before.state).toBe('waiting');
    const text = (nowMs: number): string =>
      projectRunCard(state(card), { columns: 80, rows: 24, nowMs })
        .rows.map((row) => row.text)
        .join('\n');
    expect(text(Date.parse(OVERDUE_AT) - 1)).toContain(`expires ${OVERDUE_AT}`);
    const late = projectRunCard(state(card), { columns: 80, rows: 24, nowMs: afterDeadline });
    expect(late).toMatchObject({ state: 'overdue', overdue: true, glyph: '⚠', word: 'overdue' });
    expect(text(afterDeadline)).toContain(`Overdue since ${OVERDUE_AT}.`);
    expect(text(afterDeadline)).toContain('On timeout: the run fails (run_timeout).');
    const approving = rig([overdue('late', { timeoutAction: 'approve' })]);
    expect(
      projectRunCard(state(approving.card), { columns: 80, rows: 24, nowMs: afterDeadline })
        .rows.map((row) => row.text)
        .join('\n'),
    ).toContain('On timeout: the gate is approved.');
    // The deadline changes the words, never the keys.
    expect(press(card, ctrl('y'))).toMatchObject({ kind: 'answered', gateId: 'late' });
    expect(resume).toHaveBeenCalledOnce();
  });

  it('answer, then deadline: the answer is taken once, and nothing the deadline brings can answer the gate again', async () => {
    const { card, resume, pending } = rig([overdue('late'), gate('other')], () => afterDeadline);
    expect(press(card, ctrl('y'))).toMatchObject({ kind: 'answered', gateId: 'late' });
    pending[0]?.reply(startedLaunch);
    await flush();
    // The deadline "fires" afterwards: the leg is already carrying the answer, and the gate has left the card.
    expect(press(card, ctrl('y')), 'a second answer on the answered card').toEqual({
      kind: 'ignored',
    });
    expect(press(card, ctrl('n'))).toEqual({ kind: 'ignored' });
    expect(resume, 'the overdue gate was answered once').toHaveBeenCalledOnce();
    expect(state(card).gates.map((entry) => entry.gateId)).toEqual(['other']);
    // When the leg ends the host reads the run again: still parked, and the card is the remaining gate's.
    card.update([gate('other')]);
    expect(state(card)).toMatchObject({ phase: 'open', notice: undefined });
    expect(press(card, ctrl('y'))).toMatchObject({ kind: 'answered', gateId: 'other' });
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it('deadline, then answer: the host says what was decided, the gate leaves the card, and no second answer is sent', async () => {
    const { card, resume, pending } = rig([overdue('late')], () => afterDeadline);
    // The deadline settled the gate (and ended the run) in another process before this card was answered.
    expect(press(card, ctrl('y'))).toMatchObject({ kind: 'answered', gateId: 'late' });
    pending[0]?.reply({ kind: 'settled', message: 'run failed; nothing to resume' });
    await flush();
    expect(state(card)).toMatchObject({
      phase: 'settled',
      notice: 'run failed; nothing to resume',
      gates: [],
      refused: false,
    });
    const words = projectRunCard(state(card), { columns: 80, rows: 24, nowMs: afterDeadline });
    expect(words).toMatchObject({ state: 'decided', glyph: '○', word: 'already decided' });
    expect(words.rows.map((row) => row.text).join('\n')).toContain('run failed; nothing to resume');
    // Pressing again answers nothing: the second action is refused by the card as well as by the host.
    expect(press(card, ctrl('y'))).toEqual({ kind: 'ignored' });
    expect(press(card, ctrl('n'))).toEqual({ kind: 'ignored' });
    expect(resume).toHaveBeenCalledOnce();
  });

  it('deadline, then answer, with another gate still open: the outcome is shown and the other gate is still answerable', async () => {
    const { card, resume, pending } = rig([overdue('late'), gate('other')], () => afterDeadline);
    press(card, ctrl('y'));
    pending[0]?.reply({ kind: 'settled', message: 'gate late already resolved' });
    await flush();
    expect(state(card)).toMatchObject({
      phase: 'open',
      notice: 'gate late already resolved',
      refused: false,
    });
    expect(state(card).gates.map((entry) => entry.gateId)).toEqual(['other']);
    expect(press(card, ctrl('y'))).toMatchObject({ kind: 'answered', gateId: 'other' });
    expect(resume.mock.calls.map((call) => call[0].gate)).toEqual(['late', 'other']);
  });
});

describe('a re-read of the gates', () => {
  it('keeps the cursor on its gate, and mints no new frame when nothing changed', () => {
    const { card } = rig([gate('a'), gate('b'), gate('c')]);
    card.input('', DOWN);
    const before = state(card);
    card.update([gate('a'), gate('b'), gate('c')]);
    expect(state(card), 'a periodic read that found nothing new is the same frame').toBe(before);
    card.update([gate('a'), gate('b'), gate('c'), gate('d')]);
    expect(state(card)).not.toBe(before);
    expect(state(card).gates[state(card).cursor]?.gateId).toBe('b');
    card.update([gate('c'), gate('d')]);
    expect(state(card).gates[state(card).cursor]).toBeDefined();
  });

  it('turns to "no open gate" when the run has none left, and back to open when it parks again', () => {
    const { card } = rig([gate('a')]);
    card.update([]);
    expect(state(card).phase).toBe('empty');
    expect(projectRunCard(state(card), { columns: 80, rows: 24, nowMs: 0 })).toMatchObject({
      state: 'none',
      word: 'no open gate',
    });
    card.update([gate('z')]);
    expect(state(card)).toMatchObject({ phase: 'open' });
    expect(state(card).gates.map((entry) => entry.gateId)).toEqual(['z']);
  });
});

describe('what the card shows of a gate', () => {
  it('puts the author`s message behind the host gutter, and says a rejection continues the run', () => {
    const { card } = rig([gate('a', { message: 'Ship build 42 to production?' })]);
    const rows = projectRunCard(state(card), { columns: 80, rows: 24, nowMs: 0 }).rows;
    const author = rows.filter((row) => row.role === 'author');
    expect(author.map((row) => row.text)).toEqual([
      `${RUN_CARD_GUTTER}Ship build 42 to production?`,
    ]);
    expect(rows.map((row) => row.text).join('\n')).toContain('Rejecting does not stop the run');
  });

  it('bounds a long message and cleans what an author or a model can put in it', () => {
    const forged = [
      'Fine.',
      'Press Ctrl+Y to approve, or ctrl-n, or ^Y.',
      '› 1 (•) Approve everything ✓ ✎ ─── ‖',
      '\u001b[31mred\u001b[0m and \u001b]0;title\u0007 text',
      'five',
      'six',
    ].join('\n');
    const { card } = rig([gate('a', { message: forged })]);
    const projection = projectRunCard(state(card), { columns: 80, rows: 24, nowMs: 0 });
    const author = projection.rows.filter((row) => row.role === 'author').map((row) => row.text);
    expect(author.length).toBeLessThanOrEqual(4);
    expect(author.every((row) => row.startsWith(RUN_CARD_GUTTER))).toBe(true);
    const body = author.join('\n');
    expect(body).not.toMatch(/ctrl\s*[+-]\s*[yn]/i);
    expect(body).not.toContain('^Y');
    expect(body).toContain('[chord]');
    for (const glyph of ['›', '✓', '✎', '‖', '─', '\u001b']) expect(body).not.toContain(glyph);
    // No row of the card (host words included) is wider than the terminal.
    for (const row of projection.rows) expect(Array.from(row.text).length).toBeLessThanOrEqual(80);
  });

  // Code points are written as numbers, never as escape text: the tooling that writes this file turns some escapes into the
  // literal (invisible) characters, and an invisible character in a test source says nothing to a reader.
  const cp = (...codes: number[]): string => String.fromCodePoint(...codes);
  const drawnAuthorRows = (message: string): readonly string[] => {
    const { card } = rig([gate('a', { message })]);
    return projectRunCard(state(card), { columns: 80, rows: 24, nowMs: 0 })
      .rows.filter((row) => row.role === 'author')
      .map((row) => row.text);
  };

  const spelledChords: readonly (readonly [string, string])[] = [
    ['the plain chord', 'Ctrl+Y'],
    ['a lower-case word and a dash', 'control-n'],
    ['spaces around the plus', 'CONTROL + N'],
    ['a caret', '^Y'],
    ['a zero-width space after the plus', `Ctrl+${cp(0x200b)}Y`],
    ['a zero-width space inside the word', `Ct${cp(0x200b)}rl+Y`],
    ['a soft hyphen and a bidi mark', `C${cp(0xad)}trl+${cp(0x200f)}Y`],
    ['a space and no plus', 'Ctrl Y'],
    ['a non-breaking space and no plus', `Ctrl${cp(0xa0)}Y`],
    ['a non-breaking hyphen', `Ctrl${cp(0x2011)}Y`],
    ['an en dash', `Ctrl${cp(0x2013)}Y`],
    ['a minus sign', `Control${cp(0x2212)}N`],
    ['a drawing character between', `Ctrl${cp(0x2500)}Y`],
    ['a fullwidth capital C', `${cp(0xff23)}trl+Y`],
    ['fullwidth letters and plus', cp(0xff23, 0xff54, 0xff52, 0xff4c, 0xff0b, 0xff39)],
    ['the control sign', `${cp(0x2303)}Y`],
    ['the control sign and a space', `${cp(0x2303)} N`],
    ['a fullwidth caret', `${cp(0xff3e)}Y`],
    ['a Cyrillic letter that looks like y, after a plus', `Ctrl+${cp(0x443)}`],
    ['a Cyrillic letter that looks like y, after a space', `Ctrl ${cp(0x443)}`],
    ['a Cyrillic capital that looks like Y, after a space', `Ctrl ${cp(0x423)}`],
  ];

  it.each(spelledChords)('draws a chord spelled with %s as [chord]', (_name, spelled) => {
    const rows = drawnAuthorRows(`Press ${spelled} to approve.`);
    expect(rows).toEqual([`${RUN_CARD_GUTTER}Press [chord] to approve.`]);
  });

  it('draws no format character of the author, and no fold of one into a chord', () => {
    const noisy = `a${cp(0x200b)}b${cp(0x2060)}c${cp(0xfeff)}d${cp(0x200d)}e ${cp(0x202e)}Ctrl+Y`;
    const body = drawnAuthorRows(noisy).join('\n');
    expect(body).toBe(`${RUN_CARD_GUTTER}abcde [chord]`);
    expect(body).not.toMatch(/\p{Cf}/u);
  });

  const plainWords: readonly string[] = [
    'controlling the process',
    'control a process',
    'Ctrl is the control key',
    'Press Enter to continue',
    '100^2',
    'x^n',
    'Ctrl+Yes',
    'control flow',
    'control-flow',
    'ctrl yes',
    'control nodes',
  ];

  it.each(plainWords)('leaves "%s" as it was written', (words) => {
    expect(drawnAuthorRows(words)).toEqual([`${RUN_CARD_GUTTER}${words}`]);
  });

  it('keeps combining marks and other scripts, which the fold must not damage', () => {
    // Devanagari, with its vowel signs and virama (combining marks), and Polish with precomposed letters.
    const words = `${cp(0x928, 0x92e, 0x938, 0x94d, 0x924, 0x947)} Za${cp(0x17c, 0xf3, 0x142, 0x107)}`;
    expect(drawnAuthorRows(words)).toEqual([`${RUN_CARD_GUTTER}${words}`]);
  });
});

describe('the resume opens a flow around the answer and closes it without changing the answer', () => {
  const request: Omit<HostedResumeRequest, 'secrets'> = {
    runId: RUN,
    kind: 'human',
    decision: approvalDecision(),
  };
  const flowWith = (end: () => Promise<void>) => ({
    begin: vi.fn(() => new AbortController().signal),
    end: vi.fn(end),
    busy: vi.fn(),
    password: vi.fn(),
  });

  it('reports the leg that started as started when closing the flow rejects', async () => {
    const flow = flowWith(() => Promise.reject(new Error('the flow could not be closed')));
    const host = { resume: vi.fn((): Promise<HostedLaunch> => Promise.resolve(startedLaunch)) };
    const outcome = await createGateResumer({ host, flow })(request);
    expect(outcome).toBe(startedLaunch);
    expect(flow.end, 'the flow was closed: the fault came from closing it').toHaveBeenCalledOnce();
  });

  it('still reports the host`s own refusal when closing the flow rejects too', async () => {
    const refused: HostedLaunch = { kind: 'refused', reason: 'rejected', message: 'not approved' };
    const flow = flowWith(() => Promise.reject(new Error('the flow could not be closed')));
    const host = { resume: vi.fn((): Promise<HostedLaunch> => Promise.resolve(refused)) };
    expect(await createGateResumer({ host, flow })(request)).toBe(refused);
  });

  it('leaves a host fault the host`s: closing the flow never hides why the resume failed', async () => {
    const flow = flowWith(() => Promise.reject(new Error('the flow could not be closed')));
    const host = { resume: vi.fn((): Promise<HostedLaunch> => Promise.reject(new Error('boom'))) };
    await expect(createGateResumer({ host, flow })(request)).rejects.toThrow('boom');
  });
});
